// @ts-check
/**
 * Minimal JOSE: compact JWS sign/verify for the two algorithms this app uses,
 * and public-JWK import with the checks a verifier needs.
 *
 *   ES256    ECDSA P-256 / SHA-256, raw r||s signature (RFC 7518 §3.4)
 *   Ed25519  EdDSA over Ed25519 (RFC 8037). RFC 9864 deprecates the JOSE name
 *            "EdDSA" in favour of "Ed25519"; new tokens use "Ed25519" and both
 *            names are accepted on input.
 *
 * Used by SD-JWT VC issuance, key-binding JWTs, OpenID4VCI proof JWTs and
 * OpenID4VP request objects. The VC-JWT path in lib/vc.js predates this and
 * keeps its own Ed25519 code.
 */

import { createPublicKey, sign, verify } from "node:crypto";

/** @param {Buffer | Uint8Array | string} data */
export function b64u(data) {
  return Buffer.from(data).toString("base64url");
}

/** @param {unknown} value */
export function b64uJson(value) {
  return b64u(JSON.stringify(value));
}

/** @param {string} s */
function b64uDecodeJson(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
}

const ED_ALGS = new Set(["Ed25519", "EdDSA"]);

/**
 * The JOSE `alg` for a private or public key.
 * @param {import("node:crypto").KeyObject} key
 */
export function algFor(key) {
  if (key.asymmetricKeyType === "ed25519") return "Ed25519";
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") {
    return "ES256";
  }
  throw new Error(`unsupported key type: ${key.asymmetricKeyType}`);
}

/**
 * @param {string} alg
 * @param {import("node:crypto").KeyObject} privateKey
 * @param {Buffer} input
 */
function signBytes(alg, privateKey, input) {
  if (alg === "ES256") return sign("sha256", input, { key: privateKey, dsaEncoding: "ieee-p1363" });
  if (ED_ALGS.has(alg)) return sign(null, input, privateKey);
  throw new Error(`unsupported alg: ${alg}`);
}

/**
 * Sign a compact JWS. `header.alg` is filled from the key when absent.
 * @param {Record<string, unknown>} header
 * @param {Record<string, unknown>} payload
 * @param {import("node:crypto").KeyObject} privateKey
 */
export function signJws(header, payload, privateKey) {
  const h = { alg: algFor(privateKey), ...header };
  const input = `${b64uJson(h)}.${b64uJson(payload)}`;
  return `${input}.${b64u(signBytes(String(h.alg), privateKey, Buffer.from(input, "ascii")))}`;
}

/**
 * Decode a compact JWS without verifying it.
 * @param {string} jws
 * @returns {{ header: Record<string, unknown>, payload: Record<string, unknown>, signingInput: string, signature: Buffer }}
 */
export function decodeJws(jws) {
  if (typeof jws !== "string") throw new Error("JWS must be a string");
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("JWS must have three parts");
  const header = b64uDecodeJson(parts[0]);
  const payload = b64uDecodeJson(parts[1]);
  if (!header || typeof header !== "object" || Array.isArray(header))
    throw new Error("bad JWS header");
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("bad JWS payload");
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) throw new Error("bad JWS signature encoding");
  return {
    header,
    payload,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], "base64url"),
  };
}

/**
 * Verify a compact JWS against a public key. The header's `alg` must be one the
 * key can produce and one the caller allows; "none" and MAC algorithms never
 * pass because they are never in the allowed set.
 * @param {string} jws
 * @param {import("node:crypto").KeyObject} publicKey
 * @param {string[]} allowedAlgs
 */
export function verifyJws(jws, publicKey, allowedAlgs) {
  const d = decodeJws(jws);
  const alg = String(d.header.alg);
  if (!allowedAlgs.includes(alg)) throw new Error(`alg ${alg} not allowed`);
  const keyAlg = algFor(publicKey);
  if (!(alg === keyAlg || (keyAlg === "Ed25519" && ED_ALGS.has(alg)))) {
    throw new Error(`alg ${alg} does not match the key`);
  }
  const input = Buffer.from(d.signingInput, "ascii");
  const ok =
    alg === "ES256"
      ? d.signature.length === 64 &&
        verify("sha256", input, { key: publicKey, dsaEncoding: "ieee-p1363" }, d.signature)
      : d.signature.length === 64 && verify(null, input, publicKey, d.signature);
  if (!ok) throw new Error("signature did not verify");
  return d;
}

/**
 * Import a public JWK. Only EC P-256 and OKP Ed25519 are accepted, and a JWK
 * carrying private material is refused rather than silently stripped: a holder
 * that sends its private key has made a mistake a verifier must not paper over.
 * @param {unknown} jwk
 */
export function publicKeyFromJwk(jwk) {
  if (!jwk || typeof jwk !== "object") throw new Error("JWK must be an object");
  const k = /** @type {Record<string, unknown>} */ (jwk);
  if ("d" in k) throw new Error("JWK contains private key material");
  if (k.kty === "EC" && k.crv === "P-256" && typeof k.x === "string" && typeof k.y === "string") {
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x: k.x, y: k.y }, format: "jwk" });
  }
  if (k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string") {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" });
  }
  throw new Error("unsupported JWK: expected EC P-256 or OKP Ed25519");
}

/**
 * The public JWK of a key, members limited to those that identify it.
 * @param {import("node:crypto").KeyObject} key
 */
export function publicJwk(key) {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  const j = /** @type {Record<string, string>} */ (pub.export({ format: "jwk" }));
  return j.kty === "EC"
    ? { kty: j.kty, crv: j.crv, x: j.x, y: j.y }
    : { kty: j.kty, crv: j.crv, x: j.x };
}
