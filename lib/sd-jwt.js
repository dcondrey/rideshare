// @ts-check
/**
 * SD-JWT (RFC 9901) issuance, presentation and verification, profiled for
 * SD-JWT VC (draft-ietf-oauth-sd-jwt-vc-19): `typ: dc+sd-jwt`, a `vct` claim,
 * and the claims that profile forbids disclosing kept permanently visible.
 *
 * Scope: selectively disclosable object properties at any depth. Array
 * elements (`{"...": digest}`) are verified but never produced, because no
 * credential this app issues has a disclosable array.
 *
 * Formats (RFC 9901 §4):
 *   SD-JWT     <issuer-jwt>~<disclosure>~...~<disclosure>~
 *   SD-JWT+KB  <issuer-jwt>~<disclosure>~...~<disclosure>~<kb-jwt>
 */

import { createHash, randomBytes } from "node:crypto";

import { b64u, decodeJws, publicKeyFromJwk, signJws, verifyJws } from "./jose.js";

export const SD_JWT_VC_TYP = "dc+sd-jwt";
const KB_TYP = "kb+jwt";

/** SD-JWT VC §2.2.2.3: these MUST NOT be selectively disclosed. */
const NEVER_DISCLOSABLE = new Set([
  "iss",
  "nbf",
  "exp",
  "cnf",
  "vct",
  "vct#integrity",
  "aka_vcts",
  "status",
  "_sd",
  "_sd_alg",
  "...",
]);

/** @param {string} disclosure */
function digest(disclosure) {
  return createHash("sha256").update(disclosure, "ascii").digest("base64url");
}

/** A salt with 128 random bits, the RFC 9901 §9.3 recommended minimum. */
function salt() {
  return b64u(randomBytes(16));
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Issue an SD-JWT VC.
 *
 * `disclosable` lists claim paths to make selectively disclosable, e.g.
 * `[["role"], ["ride", "date"]]`. A path's parent objects stay visible unless
 * listed themselves; a listed object is disclosed after its own children are
 * processed, so its disclosure carries their digests (RFC 9901 §4.2.6).
 *
 * @param {{
 *   claims: Record<string, unknown>,
 *   disclosable: string[][],
 *   privateKey: import("node:crypto").KeyObject,
 *   kid?: string,
 *   decoys?: number,
 * }} args
 * @returns {{ sdJwt: string, disclosures: string[] }}
 */
export function issueSdJwt(args) {
  const disclosures = [];
  /** @param {Record<string, unknown>} obj @param {string[][]} paths @param {boolean} top */
  const process = (obj, paths, top) => {
    /** @type {Record<string, unknown>} */
    const out = {};
    /** @type {string[]} */
    const sd = [];
    for (const [key, value] of Object.entries(obj)) {
      const childPaths = paths.filter((p) => p[0] === key && p.length > 1).map((p) => p.slice(1));
      const v = isObject(value) && childPaths.length ? process(value, childPaths, false) : value;
      const listed = paths.some((p) => p.length === 1 && p[0] === key);
      if (listed) {
        if (NEVER_DISCLOSABLE.has(key) && top)
          throw new Error(`${key} must not be selectively disclosable`);
        if (key === "_sd" || key === "...") throw new Error(`${key} is a reserved claim name`);
        const d = b64u(JSON.stringify([salt(), key, v]));
        disclosures.push(d);
        sd.push(digest(d));
      } else {
        out[key] = v;
      }
    }
    // Decoys hide how many claims an object really has; only at the top level,
    // where the count is most telling.
    if (top) for (let i = 0; i < (args.decoys ?? 2); i++) sd.push(digest(b64u(randomBytes(32))));
    if (sd.length) out._sd = sd.sort();
    return out;
  };
  const payload = process(args.claims, args.disclosable, true);
  payload._sd_alg = "sha-256";
  const jwt = signJws(
    { typ: SD_JWT_VC_TYP, ...(args.kid ? { kid: args.kid } : {}) },
    payload,
    args.privateKey,
  );
  return { sdJwt: `${jwt}~${disclosures.map((d) => `${d}~`).join("")}`, disclosures };
}

/**
 * Split a combined SD-JWT or SD-JWT+KB string.
 * @param {string} combined
 */
export function splitSdJwt(combined) {
  if (typeof combined !== "string" || !combined.includes("~")) {
    throw new Error("not an SD-JWT: no ~ separator");
  }
  const parts = combined.split("~");
  const jwt = parts[0];
  const kb = parts[parts.length - 1];
  const disclosures = parts.slice(1, -1);
  if (disclosures.some((d) => d === "")) throw new Error("empty disclosure");
  return { jwt, disclosures, kbJwt: kb === "" ? null : kb };
}

/**
 * Decode a disclosure string into its parts.
 * @param {string} d
 * @returns {{ salt: string, name: string | null, value: unknown }}
 */
export function decodeDisclosure(d) {
  if (!/^[A-Za-z0-9_-]+$/.test(d)) throw new Error("disclosure is not base64url");
  const arr = JSON.parse(Buffer.from(d, "base64url").toString("utf8"));
  if (!Array.isArray(arr)) throw new Error("disclosure is not a JSON array");
  if (arr.length === 3 && typeof arr[0] === "string" && typeof arr[1] === "string") {
    return { salt: arr[0], name: arr[1], value: arr[2] };
  }
  if (arr.length === 2 && typeof arr[0] === "string")
    return { salt: arr[0], name: null, value: arr[1] };
  throw new Error("disclosure must be [salt, name, value] or [salt, value]");
}

/**
 * Holder: present an SD-JWT revealing only the chosen disclosures, optionally
 * with a key-binding JWT.
 * @param {string} sdJwt  the SD-JWT as issued
 * @param {(d: { name: string | null, value: unknown }) => boolean} keep
 * @param {{ aud: string, nonce: string, privateKey: import("node:crypto").KeyObject, iat?: number }} [kb]
 */
export function presentSdJwt(sdJwt, keep, kb) {
  const { jwt, disclosures } = splitSdJwt(sdJwt);
  const chosen = disclosures.filter((d) => keep(decodeDisclosure(d)));
  const presented = `${jwt}~${chosen.map((d) => `${d}~`).join("")}`;
  if (!kb) return presented;
  const kbJwt = signJws(
    { typ: KB_TYP },
    {
      iat: kb.iat ?? Math.floor(Date.now() / 1000),
      aud: kb.aud,
      nonce: kb.nonce,
      sd_hash: digest(presented),
    },
    kb.privateKey,
  );
  return presented + kbJwt;
}

/**
 * Verify an SD-JWT or SD-JWT+KB per RFC 9901 §7.1 and §7.3.
 *
 * @param {string} combined
 * @param {{
 *   issuerKey: (header: Record<string, unknown>, payload: Record<string, unknown>) => import("node:crypto").KeyObject,
 *   issuerAlgs?: string[],
 *   requireKeyBinding?: boolean,
 *   expectedAud?: string,
 *   expectedNonce?: string,
 *   now?: number,          // seconds
 *   maxKbAgeSec?: number,
 * }} opts
 * @returns {{ claims: Record<string, unknown>, header: Record<string, unknown>,
 *   disclosed: { name: string | null, value: unknown }[], keyBound: boolean, kb: Record<string, unknown> | null }}
 */
export function verifySdJwt(combined, opts) {
  const { jwt, disclosures, kbJwt } = splitSdJwt(combined);
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  // §7.1 step 2: the issuer-signed JWT.
  const decoded = decodeJws(jwt);
  if (decoded.header.typ !== SD_JWT_VC_TYP) throw new Error(`typ must be ${SD_JWT_VC_TYP}`);
  const issuerKey = opts.issuerKey(decoded.header, decoded.payload);
  verifyJws(jwt, issuerKey, opts.issuerAlgs ?? ["ES256", "Ed25519", "EdDSA"]);
  const payload = decoded.payload;
  const sdAlg = payload._sd_alg ?? "sha-256";
  if (sdAlg !== "sha-256") throw new Error(`unsupported _sd_alg: ${String(sdAlg)}`);

  // §7.1 step 3: replace digests with disclosed values.
  /** @type {Map<string, string>} */
  const byDigest = new Map();
  for (const d of disclosures) {
    const h = digest(d);
    if (byDigest.has(h)) throw new Error("the same disclosure appears twice");
    byDigest.set(h, d);
  }
  const seenDigests = new Set();
  const used = new Set();
  /** @type {{ name: string | null, value: unknown }[]} */
  const disclosed = [];

  /** @param {unknown} node @returns {unknown} */
  const resolve = (node) => {
    if (Array.isArray(node)) {
      const out = [];
      for (const el of node) {
        if (isObject(el) && Object.keys(el).length === 1 && typeof el["..."] === "string") {
          const h = el["..."];
          if (seenDigests.has(h)) throw new Error("a digest appears more than once");
          seenDigests.add(h);
          const d = byDigest.get(h);
          if (!d) continue; // §7.1 3d: undisclosed element is removed
          const dec = decodeDisclosure(d);
          if (dec.name !== null) throw new Error("array element disclosure must have two elements");
          used.add(h);
          disclosed.push(dec);
          out.push(resolve(dec.value));
        } else {
          out.push(resolve(el));
        }
      }
      return out;
    }
    if (!isObject(node)) return node;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "_sd" || k === "_sd_alg") continue;
      out[k] = resolve(v);
    }
    const sd = node._sd;
    if (sd !== undefined) {
      if (!Array.isArray(sd) || sd.some((x) => typeof x !== "string")) {
        throw new Error("_sd must be an array of strings");
      }
      for (const h of sd) {
        if (seenDigests.has(h)) throw new Error("a digest appears more than once");
        seenDigests.add(h);
        const d = byDigest.get(h);
        if (!d) continue; // decoy or withheld
        const dec = decodeDisclosure(d);
        if (dec.name === null)
          throw new Error("object property disclosure must have three elements");
        if (dec.name === "_sd" || dec.name === "...")
          throw new Error(`disclosed claim name ${dec.name} is reserved`);
        if (dec.name in out) throw new Error(`disclosed claim ${dec.name} already exists`);
        used.add(h);
        disclosed.push(dec);
        out[dec.name] = resolve(dec.value);
      }
    }
    return out;
  };
  const claims = /** @type {Record<string, unknown>} */ (resolve(payload));

  // §7.1 step 5: every disclosure must have been referenced.
  if (used.size !== byDigest.size) throw new Error("a disclosure is not referenced by the SD-JWT");

  // §7.1 step 6: validity window.
  if (typeof claims.nbf === "number" && now + 300 < claims.nbf)
    throw new Error("not yet valid (nbf)");
  if (typeof claims.exp === "number" && now >= claims.exp) throw new Error("expired (exp)");
  if (typeof claims.vct !== "string" || !claims.vct) throw new Error("vct is required");

  // §7.3: key binding.
  if (!kbJwt) {
    if (opts.requireKeyBinding) throw new Error("key binding required but no KB-JWT presented");
    return { claims, header: decoded.header, disclosed, keyBound: false, kb: null };
  }
  const cnf = claims.cnf;
  if (!isObject(cnf) || !isObject(cnf.jwk))
    throw new Error("KB-JWT presented but the SD-JWT has no cnf.jwk");
  const kb = verifyJws(kbJwt, publicKeyFromJwk(cnf.jwk), ["ES256", "Ed25519", "EdDSA"]);
  if (kb.header.typ !== KB_TYP) throw new Error(`KB-JWT typ must be ${KB_TYP}`);
  const p = kb.payload;
  if (typeof p.iat !== "number") throw new Error("KB-JWT iat missing");
  const maxAge = opts.maxKbAgeSec ?? 300;
  if (p.iat > now + 60 || p.iat < now - maxAge)
    throw new Error("KB-JWT iat outside the accepted window");
  if (typeof p.aud !== "string") throw new Error("KB-JWT aud must be a single string");
  if (opts.expectedAud !== undefined && p.aud !== opts.expectedAud)
    throw new Error("KB-JWT aud mismatch");
  if (typeof p.nonce !== "string") throw new Error("KB-JWT nonce must be a string");
  if (opts.expectedNonce !== undefined && p.nonce !== opts.expectedNonce)
    throw new Error("KB-JWT nonce mismatch");
  const presented = combined.slice(0, combined.length - kbJwt.length);
  if (p.sd_hash !== digest(presented))
    throw new Error("KB-JWT sd_hash does not match the presentation");
  return { claims, header: decoded.header, disclosed, keyBound: true, kb: p };
}

/**
 * Label each disclosure of an issued SD-JWT with its claim path, e.g.
 * `["ride", "date"]`, by matching digests against the issuer payload. For the
 * holder's own UI; it does not verify anything.
 * @param {string} sdJwt
 * @returns {{ disclosure: string, path: string[], value: unknown }[]}
 */
export function describeDisclosures(sdJwt) {
  const { jwt, disclosures } = splitSdJwt(sdJwt);
  const payload = decodeJws(jwt).payload;
  /** @type {Map<string, { d: string, name: string | null, value: unknown }>} */
  const byDigest = new Map(
    disclosures.map((d) => {
      const dec = decodeDisclosure(d);
      return [digest(d), { d, name: dec.name, value: dec.value }];
    }),
  );
  /** @type {{ disclosure: string, path: string[], value: unknown }[]} */
  const out = [];
  /** @param {unknown} node @param {string[]} at */
  const walk = (node, at) => {
    if (!isObject(node)) return;
    for (const [k, v] of Object.entries(node)) if (k !== "_sd") walk(v, [...at, k]);
    if (Array.isArray(node._sd)) {
      for (const h of node._sd) {
        const hit = byDigest.get(String(h));
        if (!hit || hit.name === null) continue;
        out.push({ disclosure: hit.d, path: [...at, hit.name], value: hit.value });
        walk(hit.value, [...at, hit.name]);
      }
    }
  };
  walk(payload, []);
  return out;
}
