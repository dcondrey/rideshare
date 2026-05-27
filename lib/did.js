// @ts-check
/**
 * DID primitives for did:key (Ed25519) and did:web.
 *
 * Spec references:
 *   - did:key  https://w3c-ccg.github.io/did-method-key/
 *   - did:web  https://w3c-ccg.github.io/did-method-web/
 *   - multibase https://github.com/multiformats/multibase
 *   - multicodec https://github.com/multiformats/multicodec
 *
 * For Ed25519, did:key encoding is:
 *   "did:key:z" + base58btc( multicodec_varint(0xed) + 32-byte_pubkey )
 *
 * The multicodec for Ed25519 public key is 0xed; encoded as varint that's
 * the two bytes [0xed, 0x01].
 *
 * Pure node:crypto. No external deps.
 */

import {
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  KeyObject,
} from "node:crypto";

// ── Multicodec / multibase ──────────────────────────────────────────────────
/** Multicodec varint prefix for Ed25519 public keys. */
const ED25519_PUB_MULTICODEC = Uint8Array.from([0xed, 0x01]);

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = (() => {
  /** @type {Record<string, number>} */
  const m = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) m[BASE58_ALPHABET[i]] = i;
  return m;
})();

/** Encode bytes as base58btc (Bitcoin alphabet). Public-domain algorithm. */
export function base58btcEncode(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  // Count leading zero bytes
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;
  // Convert big-endian byte array to base58 digits
  const size = Math.floor((bytes.length - zeroes) * 138) / 100 + 1; // log256/log58
  const b58 = new Uint8Array(Math.ceil(size));
  let length = 0;
  for (let i = zeroes; i < bytes.length; i++) {
    let carry = bytes[i];
    let j = 0;
    for (let k = b58.length - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 256 * b58[k];
      b58[k] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    length = j;
  }
  // Skip leading zero bytes in b58 result
  let it = b58.length - length;
  while (it < b58.length && b58[it] === 0) it++;
  let out = "1".repeat(zeroes);
  for (; it < b58.length; it++) out += BASE58_ALPHABET[b58[it]];
  return out;
}

/** Decode a base58btc string. Throws on invalid characters. */
export function base58btcDecode(str) {
  if (str.length === 0) return new Uint8Array(0);
  let zeroes = 0;
  while (zeroes < str.length && str[zeroes] === "1") zeroes++;
  const size = Math.floor(((str.length - zeroes) * 733) / 1000) + 1; // log58/log256
  const b256 = new Uint8Array(size);
  let length = 0;
  for (let i = zeroes; i < str.length; i++) {
    const ch = str[i];
    let carry = BASE58_INDEX[ch];
    if (carry === undefined) throw new Error(`Invalid base58 char: ${ch}`);
    let j = 0;
    for (let k = b256.length - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 58 * b256[k];
      b256[k] = carry & 0xff;
      carry >>= 8;
    }
    length = j;
  }
  let it = b256.length - length;
  while (it < b256.length && b256[it] === 0) it++;
  const out = new Uint8Array(zeroes + (b256.length - it));
  for (let i = 0; i < zeroes; i++) out[i] = 0;
  let k = zeroes;
  while (it < b256.length) out[k++] = b256[it++];
  return out;
}

// ── Ed25519 ↔ DID:key ────────────────────────────────────────────────────────
/**
 * Encode a 32-byte Ed25519 public key as a did:key string.
 * @param {Uint8Array} rawPubKey32 — raw 32-byte Ed25519 public key
 */
export function pubKeyToDidKey(rawPubKey32) {
  if (rawPubKey32.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes (got ${rawPubKey32.length})`);
  }
  const prefixed = new Uint8Array(ED25519_PUB_MULTICODEC.length + 32);
  prefixed.set(ED25519_PUB_MULTICODEC, 0);
  prefixed.set(rawPubKey32, ED25519_PUB_MULTICODEC.length);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

/**
 * Decode a did:key (Ed25519 only) into the raw 32-byte public key.
 * @param {string} didKey
 * @returns {Uint8Array}
 */
export function didKeyToPubKey(didKey) {
  if (typeof didKey !== "string") throw new Error("did:key must be a string");
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(didKey);
  if (!m) throw new Error(`Invalid did:key syntax: ${didKey}`);
  const decoded = base58btcDecode(m[1]);
  if (
    decoded.length !== ED25519_PUB_MULTICODEC.length + 32 ||
    decoded[0] !== ED25519_PUB_MULTICODEC[0] ||
    decoded[1] !== ED25519_PUB_MULTICODEC[1]
  ) {
    throw new Error(
      `did:key is not Ed25519 (multicodec mismatch or wrong length)`,
    );
  }
  return decoded.slice(ED25519_PUB_MULTICODEC.length);
}

/** Convenience: extract just the multibase part (after "did:key:"). */
export function didKeyFingerprint(didKey) {
  const m = /^did:key:(z[1-9A-HJ-NP-Za-km-z]+)$/.exec(didKey);
  if (!m) throw new Error(`Invalid did:key: ${didKey}`);
  return m[1];
}

// ── Ed25519 keypair (Node) ───────────────────────────────────────────────────
/**
 * Generate a fresh Ed25519 keypair as KeyObjects. Use for the deployment's
 * own signing key.
 */
export function generateEd25519Keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
}

/**
 * Sign arbitrary bytes with an Ed25519 private key.
 * @param {Buffer | Uint8Array} message
 * @param {KeyObject} privateKey
 * @returns {Buffer} 64-byte signature
 */
export function ed25519Sign(message, privateKey) {
  return cryptoSign(null, Buffer.from(message), privateKey);
}

/**
 * Verify an Ed25519 signature.
 * @param {Buffer | Uint8Array} message
 * @param {Buffer | Uint8Array} signature
 * @param {KeyObject} publicKey
 */
export function ed25519Verify(message, signature, publicKey) {
  return cryptoVerify(null, Buffer.from(message), publicKey, Buffer.from(signature));
}

/**
 * Extract the raw 32-byte Ed25519 public key from a Node KeyObject.
 * @param {KeyObject} pub
 */
export function pubKeyRawBytes(pub) {
  // SPKI format for Ed25519 ends with the 32-byte raw key (after a 12-byte header).
  const der = pub.export({ format: "der", type: "spki" });
  if (der.length !== 44) {
    throw new Error(`Unexpected SPKI length for Ed25519: ${der.length}`);
  }
  return Uint8Array.from(der.subarray(12));
}

/** Build a Node public KeyObject from a raw 32-byte Ed25519 public key. */
export function pubKeyFromRaw(raw32) {
  if (raw32.length !== 32) throw new Error("expected 32 raw bytes");
  // Build SPKI: 0x302a300506032b6570032100 + raw key
  const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
  const der = Buffer.concat([SPKI_PREFIX, Buffer.from(raw32)]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/**
 * Export a KeyObject as a JWK string (for storage).
 * @param {KeyObject} key
 */
export function keyToJwkString(key) {
  return JSON.stringify(key.export({ format: "jwk" }));
}

/**
 * Reconstruct a KeyObject from a JWK string.
 * @param {string} jwk
 * @param {"public"|"private"} kind
 */
export function keyFromJwkString(jwk, kind) {
  const j = JSON.parse(jwk);
  return kind === "public"
    ? createPublicKey({ key: j, format: "jwk" })
    : createPrivateKey({ key: j, format: "jwk" });
}

// ── DID:web ──────────────────────────────────────────────────────────────────
/**
 * Build the did:web identifier for a given URL origin.
 * Spec: did:web:<host>[:<port>]   (path components joined with ':')
 * For our app, no path segment is used (deployment lives at root).
 *
 * @param {string} appUrl — e.g. "https://rideshare.example.com"
 */
export function didWebFor(appUrl) {
  const u = new URL(appUrl);
  let id = encodeURIComponent(u.hostname);
  if (u.port && u.port !== "443" && u.port !== "80") {
    id += "%3A" + u.port;
  }
  return `did:web:${id}`;
}

/**
 * Convert a did:web identifier back to its expected DID document URL.
 * @param {string} didWeb
 */
export function didWebToUrl(didWeb) {
  if (!didWeb.startsWith("did:web:")) {
    throw new Error(`Not a did:web: ${didWeb}`);
  }
  const rest = didWeb.slice("did:web:".length);
  const parts = rest.split(":").map(decodeURIComponent);
  const host = parts[0];
  const path = parts.slice(1).join("/");
  const url = path
    ? `https://${host}/${path}/did.json`
    : `https://${host}/.well-known/did.json`;
  return url;
}

/**
 * Resolve a DID to its public-key bytes. Supports did:key and did:web.
 *
 * For did:web, fetches the document over HTTPS (with strict validation
 * against SSRF-style abuse: only https, not localhost/private IPs).
 *
 * @param {string} did
 * @returns {Promise<{ rawPubKey: Uint8Array, didDocument?: any }>}
 */
export async function resolveDid(did) {
  if (did.startsWith("did:key:")) {
    return { rawPubKey: didKeyToPubKey(did) };
  }
  if (did.startsWith("did:web:")) {
    let url = didWebToUrl(did);
    const u = new URL(url);
    // did:web is HTTPS by spec. For local development only, transparently
    // downgrade to HTTP when the host is localhost / 127.0.0.1 so the demo
    // and tests work without TLS. This guard is hard-disabled in production.
    if (
      u.protocol === "https:" &&
      /^(localhost|127\.0\.0\.1)$/.test(u.hostname) &&
      process.env.NODE_ENV !== "production"
    ) {
      url = url.replace(/^https:/, "http:");
    }
    const u2 = new URL(url);
    if (u2.protocol !== "https:") {
      const allowDevHttp =
        process.env.NODE_ENV !== "production" &&
        /^(localhost|127\.0\.0\.1)$/.test(u2.hostname);
      if (!(u2.protocol === "http:" && allowDevHttp)) {
        throw new Error(`did:web must be HTTPS: ${url}`);
      }
    }
    const res = await fetch(url, {
      headers: { Accept: "application/did+json, application/json" },
      redirect: "error",
    });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    const doc = await res.json();
    if (doc.id !== did) {
      throw new Error(
        `DID document id (${doc.id}) does not match requested DID (${did})`,
      );
    }
    const vm = (doc.verificationMethod || [])[0];
    if (!vm) throw new Error(`DID document has no verificationMethod`);
    let rawPubKey;
    if (vm.publicKeyMultibase) {
      const decoded = base58btcDecode(vm.publicKeyMultibase.replace(/^z/, ""));
      // Strip multicodec varint
      if (decoded[0] === 0xed && decoded[1] === 0x01) {
        rawPubKey = decoded.slice(2);
      } else {
        throw new Error(`Unsupported key codec in DID document`);
      }
    } else if (vm.publicKeyJwk) {
      const jwk = vm.publicKeyJwk;
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
        throw new Error(`Unsupported JWK in DID document`);
      }
      rawPubKey = Uint8Array.from(Buffer.from(jwk.x, "base64url"));
    } else {
      throw new Error(`DID document verificationMethod has no key material`);
    }
    return { rawPubKey, didDocument: doc };
  }
  throw new Error(`Unsupported DID method: ${did}`);
}
