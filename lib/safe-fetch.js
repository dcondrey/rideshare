// @ts-check
/**
 * Egress wrapper for outbound requests whose destination is influenced by user
 * input — today that is `did:web` resolution on the unauthenticated
 * `POST /trust/verify` path.
 *
 * Policies implemented here are the ones documented in docs/security/ssrf.md:
 * https-only, resolve-then-pin the IP, public address space only, no redirects,
 * byte cap, timeout, per-host concurrency cap, fixed header set, content-type
 * check.
 *
 * Built on node:https rather than global fetch because the DNS result has to be
 * validated and then *used* for the connection. fetch offers no hook for that,
 * so a rebinding resolver could answer once for the check and again for the
 * socket.
 */

import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 16 * 1024;
const DEFAULT_HOST_CONCURRENCY = 2;
const USER_AGENT = "rideshare/0.1 (+https://github.com/davidcondrey/rideshare)";

/** @type {Map<string, number>} */
const inFlightByHost = new Map();

/**
 * @param {string} ip
 * @returns {boolean} true when the address is outside public address space
 */
export function isPrivateAddress(ip) {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true; // not an address we can reason about
}

/** @param {string} ip */
function isPrivateV4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8 this-network
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * Expand an IPv6 literal to its 16 bytes, including "::" compression and a
 * trailing dotted-quad. Returns null if it is not parseable.
 *
 * IMPORTANT: the hex and dotted spellings of the same address must reach the
 * same verdict. `::ffff:7f00:1` and `::ffff:127.0.0.1` are one address, and a
 * check written against the dotted form alone lets the hex form dial loopback.
 *
 * @param {string} ip
 * @returns {Uint8Array | null}
 */
function v6Bytes(ip) {
  let addr = ip.toLowerCase().split("%")[0];
  const dotted = addr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  /** @type {number[]} */
  let tail = [];
  if (dotted) {
    const parts = dotted[1].split(".").map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    tail = parts;
    addr = addr.slice(0, dotted.index);
    // The quad occupied the last two groups; keep the separator shape valid.
    addr = addr.replace(/:$/, addr.endsWith("::") ? ":" : "");
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const toGroups = (/** @type {string} */ part) =>
    part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if ([...head, ...rest].some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;

  const tailGroups = tail.length === 4 ? 2 : 0;
  const total = head.length + rest.length + tailGroups;
  if (total > 8) return null;
  const zeros = halves.length === 2 ? 8 - total : 0;
  if (halves.length === 1 && total !== 8) return null;

  const groups = [...head, ...new Array(zeros).fill(0), ...rest];
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = (g >> 8) & 0xff;
    bytes[i * 2 + 1] = g & 0xff;
  });
  if (tail.length === 4) bytes.set(tail, 12);
  return bytes;
}

/** @param {string} ip */
function isPrivateV6(ip) {
  const b = v6Bytes(ip);
  if (!b) return true;

  const leadingZero = (/** @type {number} */ n) => b.slice(0, n).every((x) => x === 0);
  const trailingV4 = () => `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;

  // ::ffff:0:0/96 (IPv4-mapped) and ::/96 (IPv4-compatible) alias v4 space.
  if (leadingZero(10) && b[10] === 0xff && b[11] === 0xff) return isPrivateV4(trailingV4());
  if (leadingZero(12)) {
    const last = b[12] | b[13] | b[14] | b[15];
    if (last === 0 || (last === 1 && b[15] === 1)) return true; // :: and ::1
    return isPrivateV4(trailingV4());
  }
  // 64:ff9b::/96 — NAT64, wraps v4 space the same way.
  if (
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    leadingZeroRange(b, 4, 12)
  )
    return isPrivateV4(trailingV4());

  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  return false;
}

/**
 * @param {Uint8Array} b
 * @param {number} from
 * @param {number} to
 */
function leadingZeroRange(b, from, to) {
  for (let i = from; i < to; i++) if (b[i] !== 0) return false;
  return true;
}

/**
 * Resolve a hostname to public addresses, refusing the whole lookup if any
 * answer is private: a resolver that mixes one public and one private answer is
 * a rebinding attempt, not a multi-homed host.
 *
 * @param {string} hostname
 * @returns {Promise<{ address: string, family: number }>}
 */
function resolvePublic(hostname) {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { family: 0, all: true }, (err, addresses) => {
      if (err) return reject(new Error(`DNS lookup failed for ${hostname}`));
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0)
        return reject(new Error(`DNS lookup returned nothing for ${hostname}`));
      for (const a of list) {
        if (isPrivateAddress(a.address)) {
          return reject(new Error(`refusing non-public address for ${hostname}`));
        }
      }
      resolve({ address: list[0].address, family: list[0].family });
    });
  });
}

/** @param {string} host */
async function acquireHostSlot(host, limit) {
  for (let waited = 0; ; waited += 25) {
    const n = inFlightByHost.get(host) || 0;
    if (n < limit) {
      inFlightByHost.set(host, n + 1);
      return;
    }
    if (waited >= 2000) throw new Error(`too many concurrent requests to ${host}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** @param {string} host */
function releaseHostSlot(host) {
  const n = (inFlightByHost.get(host) || 1) - 1;
  if (n <= 0) inFlightByHost.delete(host);
  else inFlightByHost.set(host, n);
}

/**
 * @typedef {object} SafeFetchOptions
 * @property {number} [timeoutMs]
 * @property {number} [maxBytes]
 * @property {number} [hostConcurrency]
 * @property {string} [accept] value of the Accept header
 * @property {RegExp} [contentType] response Content-Type must match
 */

/**
 * GET a URL under the documented egress policy.
 *
 * @param {string} rawUrl
 * @param {SafeFetchOptions} [options]
 * @returns {Promise<{ status: number, contentType: string, body: string }>}
 */
export async function safeFetch(rawUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const hostConcurrency = options.hostConcurrency ?? DEFAULT_HOST_CONCURRENCY;

  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new Error(`refusing non-https URL: ${url.protocol}//`);
  }
  if (url.username || url.password) {
    throw new Error("refusing URL with embedded credentials");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(hostname);
  if (literal && isPrivateAddress(hostname)) {
    throw new Error(`refusing non-public address ${hostname}`);
  }
  const pinned = literal ? { address: hostname, family: literal } : await resolvePublic(hostname);

  await acquireHostSlot(url.host, hostConcurrency);
  try {
    return await new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          protocol: "https:",
          host: hostname,
          servername: literal ? undefined : hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          // IMPORTANT: the connection uses this address, not a second
          // resolution. Re-checked here because it is the value the socket
          // actually dials.
          lookup: (_host, opts, cb) => {
            if (isPrivateAddress(pinned.address)) {
              cb(new Error(`refusing non-public address ${pinned.address}`), "", 0);
              return;
            }
            // The agent may ask for all addresses, in which case the callback
            // takes an array rather than (address, family).
            if (opts && /** @type {{ all?: boolean }} */ (opts).all) {
              const cbAll =
                /** @type {(e: Error | null, a: { address: string, family: number }[]) => void} */ (
                  /** @type {unknown} */ (cb)
                );
              cbAll(null, [{ address: pinned.address, family: pinned.family }]);
              return;
            }
            cb(null, pinned.address, pinned.family);
          },
          headers: {
            Accept: options.accept || "application/json",
            "Accept-Language": "en",
            "User-Agent": USER_AGENT,
          },
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400) {
            res.destroy();
            reject(new Error(`refusing redirect (${status}) from ${url.host}`));
            return;
          }
          if (status < 200 || status >= 300) {
            res.destroy();
            reject(new Error(`Failed to fetch ${url.href}: ${status}`));
            return;
          }
          const contentType = String(res.headers["content-type"] || "");
          if (options.contentType && !options.contentType.test(contentType)) {
            res.destroy();
            reject(new Error(`unexpected content-type: ${contentType || "(none)"}`));
            return;
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy();
            reject(new Error(`response too large: ${declared} > ${maxBytes} bytes`));
            return;
          }
          let total = 0;
          /** @type {Buffer[]} */
          const chunks = [];
          res.on("data", (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
              res.destroy();
              reject(new Error(`response too large: exceeds ${maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8") });
          });
          res.on("error", reject);
        },
      );
      const deadline = setTimeout(() => {
        req.destroy(new Error(`request to ${url.host} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      deadline.unref?.();
      req.on("timeout", () => {
        req.destroy(new Error(`request to ${url.host} timed out after ${timeoutMs}ms`));
      });
      req.on("close", () => clearTimeout(deadline));
      req.on("error", reject);
      req.end();
    });
  } finally {
    releaseHostSlot(url.host);
  }
}
