// @ts-check
/**
 * DIDComm Messaging v2.1 between deployments: each deployment's did:web is a
 * DIDComm agent with an X25519 keyAgreement key and a DIDCommMessaging
 * service at /didcomm. Supported protocols:
 *
 *   https://didcomm.org/trust-ping/2.0          ping → ping-response
 *   https://didcomm.org/discover-features/2.0   queries → disclose
 *
 * Messages are authcrypt (ECDH-1PU+A256KW, A256CBC-HS512; lib/didcomm-crypto.js)
 * and delivered by HTTPS POST to the peer's DIDCommMessaging uri through the
 * egress policy (lib/safe-fetch.js). Replies are sent only for authcrypt
 * messages, whose sender is proven by its keyAgreement key, and only to the
 * endpoint that sender's own DID document declares.
 */

import { randomUUID } from "node:crypto";

import { config } from "./config.js";
import { db } from "./db.js";
import { base58btcDecode, fetchDidWebDocument } from "./did.js";
import {
  ENCRYPTED_TYP,
  packEncrypted,
  unpackEncrypted,
  x25519PublicKey,
} from "./didcomm-crypto.js";
import { errorMessage } from "./errors.js";
import { loadX25519Key } from "./keys.js";
import { info, warn } from "./log.js";
import { rateLimit } from "./rate-limit.js";
import { safeFetch } from "./safe-fetch.js";
import { didcommDidDocumentParts, getDeploymentKey } from "./trust.js";

const PING = "https://didcomm.org/trust-ping/2.0/ping";
const PING_RESPONSE = "https://didcomm.org/trust-ping/2.0/ping-response";
const QUERIES = "https://didcomm.org/discover-features/2.0/queries";
const DISCLOSE = "https://didcomm.org/discover-features/2.0/disclose";
const PROTOCOLS = [
  "https://didcomm.org/trust-ping/2.0",
  "https://didcomm.org/discover-features/2.0",
];
const LOG_KEEP = 500;

db.exec(`
  CREATE TABLE IF NOT EXISTS didcomm_messages (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT    NOT NULL,
    direction  TEXT    NOT NULL CHECK (direction IN ('in','out')),
    peer       TEXT,
    type       TEXT    NOT NULL,
    thid       TEXT,
    body       TEXT,
    note       TEXT,
    created_at INTEGER NOT NULL
  );
`);

/** This deployment's DIDComm endpoint. */
export function endpointUri() {
  return `${config.appUrl}/didcomm`;
}
export { didcommDidDocumentParts };

/**
 * @typedef {{ did: string, keys: { kid: string, publicKey: import("node:crypto").KeyObject }[], uri: string }} Peer
 */

/**
 * Resolve a peer's keyAgreement keys and DIDComm endpoint from its DID document.
 * @param {string} did
 * @returns {Promise<Peer>}
 */
export async function resolvePeer(did) {
  if (!/^did:web:[A-Za-z0-9.%:-]+$/.test(did)) throw new Error("only did:web peers are supported");
  const own = getDeploymentKey().did;
  const doc = did === own ? localDidDoc() : await fetchDidWebDocument(did);
  const methods = doc.verificationMethod || [];
  /** @param {string} ref */
  const abs = (ref) => (ref.startsWith("#") ? `${did}${ref}` : ref);
  const keys = [];
  for (const entry of doc.keyAgreement || []) {
    const vm = typeof entry === "string" ? methods.find((m) => abs(m.id) === abs(entry)) : entry;
    if (!vm) continue;
    let x = null;
    if (vm.publicKeyJwk?.kty === "OKP" && vm.publicKeyJwk.crv === "X25519") x = vm.publicKeyJwk.x;
    else if (vm.publicKeyMultibase) {
      const b = base58btcDecode(vm.publicKeyMultibase.replace(/^z/, ""));
      if (b[0] === 0xec && b[1] === 0x01 && b.length === 34)
        x = Buffer.from(b.slice(2)).toString("base64url");
    }
    if (x) keys.push({ kid: abs(vm.id), publicKey: x25519PublicKey({ x }) });
  }
  if (keys.length === 0) throw new Error(`${did} publishes no X25519 keyAgreement key`);
  const svc = (doc.service || []).find((s) => s.type === "DIDCommMessaging");
  const ep = /** @type {unknown} */ (svc?.serviceEndpoint);
  const first = Array.isArray(ep) ? ep[0] : ep;
  const uri =
    typeof first === "string" ? first : /** @type {{ uri?: string } | undefined} */ (first)?.uri;
  if (!uri) throw new Error(`${did} publishes no DIDCommMessaging endpoint`);
  return { did, keys, uri };
}

/** @returns {import("./did.js").DidDocument} */
function localDidDoc() {
  const did = getDeploymentKey().did;
  const parts = didcommDidDocumentParts();
  return {
    id: did,
    verificationMethod: [parts.verificationMethod],
    keyAgreement: [parts.keyAgreement],
    service: [parts.service],
  };
}

/**
 * @param {"in" | "out"} direction
 * @param {Record<string, unknown>} m
 * @param {string | null} peer
 * @param {string} [note]
 */
function record(direction, m, peer, note) {
  db.prepare(
    "INSERT INTO didcomm_messages (id, direction, peer, type, thid, body, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    String(m.id ?? ""),
    direction,
    peer,
    String(m.type ?? ""),
    m.thid ? String(m.thid) : null,
    JSON.stringify(m.body ?? {}),
    note ?? null,
    Date.now(),
  );
  db.prepare(
    "DELETE FROM didcomm_messages WHERE seq <= (SELECT MAX(seq) FROM didcomm_messages) - ?",
  ).run(LOG_KEEP);
}

/**
 * @typedef {{ seq: number, id: string, direction: string, peer: string | null, type: string,
 *   thid: string | null, body: string, note: string | null, created_at: number }} MessageRow
 */

/** @returns {MessageRow[]} */
export function recentMessages(limit = 30) {
  return /** @type {MessageRow[]} */ (
    db.prepare("SELECT * FROM didcomm_messages ORDER BY seq DESC LIMIT ?").all(limit)
  );
}

/**
 * Send an authcrypt message to a peer DID.
 * @param {string} peerDid
 * @param {string} type
 * @param {Record<string, unknown>} body
 * @param {string} [thid]
 */
export async function send(peerDid, type, body, thid) {
  const peer = await resolvePeer(peerDid);
  const me = getDeploymentKey().did;
  const key = loadX25519Key();
  const message = {
    id: randomUUID(),
    typ: "application/didcomm-plain+json",
    type,
    from: me,
    to: [peer.did],
    created_time: Math.floor(Date.now() / 1000),
    ...(thid ? { thid } : {}),
    body,
  };
  const jwe = packEncrypted(message, peer.keys, {
    kid: `${me}#${key.keyFragment}`,
    privateKey: key.privateKey,
  });
  record("out", message, peer.did);
  const payload = JSON.stringify(jwe);
  if (peer.uri === endpointUri()) {
    // Addressed to this deployment: deliver in-process instead of a network
    // round trip to our own URL (which plain-http development could not make).
    setImmediate(() =>
      receive(jwe).catch((err) =>
        warn("didcomm self-delivery failed", { component: "didcomm", err }),
      ),
    );
  } else if (
    config.allowInsecureDidWeb &&
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(peer.uri)
  ) {
    // ALLOW_INSECURE_DID_WEB only: a plaintext loopback peer for local
    // interop testing, mirroring the same exception in did:web resolution.
    const res = await fetch(peer.uri, {
      method: "POST",
      headers: { "Content-Type": ENCRYPTED_TYP },
      body: payload,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`peer answered ${res.status}`);
  } else {
    await safeFetch(peer.uri, {
      post: { contentType: ENCRYPTED_TYP, body: payload },
      accept: "*/*",
    });
  }
  return message.id;
}

/**
 * Process an inbound encrypted message. Throws if it cannot be decrypted.
 * @param {unknown} jwe
 */
export async function receive(jwe) {
  const key = loadX25519Key();
  const me = getDeploymentKey().did;
  const { message, authcrypt, senderKid } = await unpackEncrypted(
    jwe,
    new Map([[`${me}#${key.keyFragment}`, key.privateKey]]),
    async (skid) => {
      const peer = await resolvePeer(skid.split("#")[0]);
      const k = peer.keys.find((p) => p.kid === skid);
      if (!k) throw new Error(`${skid} is not a keyAgreement key of its DID`);
      return k.publicKey;
    },
  );
  const from = authcrypt && senderKid ? senderKid.split("#")[0] : null;
  record(
    "in",
    message,
    from,
    authcrypt ? undefined : "anoncrypt: sender unknown, no reply possible",
  );

  if (!from) return;
  // One reply per sender per few seconds: a DID whose endpoint names a victim
  // must not turn this agent into a cheap reflector.
  if (!rateLimit(`didcomm-reply:${from}`, 20, 60 * 1000).ok) {
    info(`[didcomm] reply to ${from} rate-limited`);
    return;
  }
  const body = /** @type {Record<string, unknown>} */ (message.body ?? {});
  const thid = String(message.id);
  try {
    if (message.type === PING && body.response_requested !== false) {
      await send(from, PING_RESPONSE, {}, thid);
    } else if (message.type === QUERIES) {
      const queries = Array.isArray(body.queries) ? body.queries : [];
      const disclosures = PROTOCOLS.filter((p) =>
        queries.some((q) => {
          if (q?.["feature-type"] !== "protocol" || typeof q.match !== "string") return false;
          return wildcardMatch(q.match, p);
        }),
      ).map((id) => ({ "feature-type": "protocol", id }));
      await send(from, DISCLOSE, { disclosures }, thid);
    }
  } catch (err) {
    warn("didcomm reply failed", { component: "didcomm", err: errorMessage(err) });
  }
}

/**
 * Discover Features `match`: `*` stands for any run of characters. Plain
 * string scanning, so a peer-supplied pattern can never backtrack.
 * @param {string} pattern @param {string} value
 */
export function wildcardMatch(pattern, value) {
  if (pattern.length > 200) return false;
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === value;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (
    value.length < first.length + last.length ||
    !value.startsWith(first) ||
    !value.endsWith(last)
  )
    return false;
  let at = first.length;
  for (const mid of parts.slice(1, -1)) {
    const found = value.indexOf(mid, at);
    if (found === -1 || found + mid.length > value.length - last.length) return false;
    at = found + mid.length;
  }
  return true;
}

/** Shorthands for the UI. @param {string} did */
export const sendPing = (did) => send(did, PING, { response_requested: true });
/** @param {string} did */
export const sendQuery = (did) =>
  send(did, QUERIES, { queries: [{ "feature-type": "protocol", match: "https://didcomm.org/*" }] });
