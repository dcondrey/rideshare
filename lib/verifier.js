// @ts-check
/**
 * Verifier side of selective disclosure: single-use nonces, SD-JWT VC issuer
 * key resolution, and a verification report the playground and OpenID4VP share.
 *
 * Issuer keys (SD-JWT VC draft-19 §2.5): an `iss` equal to this deployment's
 * origin uses the local ES256 key; any other https `iss` is resolved through
 * its JWT VC Issuer Metadata at /.well-known/jwt-vc-issuer, fetched under the
 * same egress policy as did:web (lib/safe-fetch.js). `x5c` chains are not
 * supported, so an X.509-only issuer is reported as unresolvable.
 */

import { randomBytes } from "node:crypto";

import { config } from "./config.js";
import { db } from "./db.js";
import { errorMessage } from "./errors.js";
import { decodeJws, publicKeyFromJwk } from "./jose.js";
import { loadEs256Key } from "./keys.js";
import { safeFetch } from "./safe-fetch.js";
import { splitSdJwt, verifySdJwt } from "./sd-jwt.js";

const NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_METADATA_BYTES = 32 * 1024;

/**
 * Issue a single-use nonce.
 * @param {string} purpose  e.g. "playground", "oid4vp"
 */
export function issueVerifierNonce(purpose) {
  const now = Date.now();
  db.prepare("DELETE FROM verifier_nonces WHERE expires_at < ?").run(now);
  const nonce = randomBytes(18).toString("base64url");
  db.prepare(
    "INSERT INTO verifier_nonces (nonce, purpose, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(nonce, purpose, now, now + NONCE_TTL_MS);
  return { nonce, expiresAt: now + NONCE_TTL_MS };
}

/**
 * Consume a nonce: true exactly once per live nonce of that purpose. The
 * UPDATE's WHERE clause is the atomic check, so two concurrent presentations
 * of the same nonce cannot both succeed.
 * @param {string} nonce @param {string} purpose
 */
export function consumeVerifierNonce(nonce, purpose) {
  const r = db
    .prepare(
      `UPDATE verifier_nonces SET consumed_at = ?
        WHERE nonce = ? AND purpose = ? AND consumed_at IS NULL AND expires_at >= ?`,
    )
    .run(Date.now(), nonce, purpose, Date.now());
  return r.changes === 1;
}

/** @param {string} iss */
export function jwtVcIssuerMetadataUrl(iss) {
  const u = new URL(iss);
  if (u.protocol !== "https:")
    throw new Error("SD-JWT VC iss must be an https URL to resolve its keys");
  const path = u.pathname.replace(/\/$/, "");
  return `${u.origin}/.well-known/jwt-vc-issuer${path}`;
}

/**
 * Resolve the public key an SD-JWT VC was signed with.
 * @param {Record<string, unknown>} header
 * @param {Record<string, unknown>} payload
 */
export async function resolveSdJwtIssuerKey(header, payload) {
  const iss = payload.iss;
  if (typeof iss !== "string" || !iss)
    throw new Error("iss missing; cannot resolve the issuer key");
  if (iss === config.appUrl) {
    return { key: loadEs256Key().publicKey, how: "this deployment's own ES256 key" };
  }
  if (header.x5c) throw new Error("x5c issuer certificates are not supported by this verifier");
  const url = jwtVcIssuerMetadataUrl(iss);
  const res = await safeFetch(url, {
    accept: "application/json",
    contentType: /^application\/json\b/i,
    maxBytes: MAX_METADATA_BYTES,
  });
  const meta = JSON.parse(res.body);
  if (!meta || meta.issuer !== iss) throw new Error("issuer metadata `issuer` does not equal iss");
  const keys = meta.jwks?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("issuer metadata has no inline jwks (jwks_uri is not supported)");
  }
  const kid = header.kid;
  const jwk =
    kid === undefined ? (keys.length === 1 ? keys[0] : null) : keys.find((k) => k.kid === kid);
  if (!jwk)
    throw new Error(`no key ${kid === undefined ? "(unnamed)" : String(kid)} in issuer metadata`);
  const { kid: _k, alg: _a, use: _u, key_ops: _o, ...bare } = jwk;
  return { key: publicKeyFromJwk(bare), how: `issuer metadata at ${url}` };
}

/**
 * Verify an SD-JWT VC (with or without key binding) and describe every check.
 * @param {string} combined
 * @param {{ aud: string, noncePurpose?: string, expectedNonce?: string, requireKeyBinding?: boolean }} opts
 *   noncePurpose: when set, the KB-JWT nonce must be a live nonce of this
 *   purpose and is consumed.
 */
export async function verifySdJwtVc(combined, opts) {
  /** @type {string[]} */
  const checks = [];
  /** @type {Record<string, unknown>} */
  let header = {};
  /** @type {Record<string, unknown>} */
  let payload = {};
  try {
    const d = decodeJws(splitSdJwt(combined).jwt);
    header = d.header;
    payload = d.payload;
    const { key, how } = await resolveSdJwtIssuerKey(header, payload);
    checks.push(`resolved issuer key: ${how}`);
    const r = verifySdJwt(combined, {
      issuerKey: () => key,
      issuerAlgs: ["ES256", "Ed25519", "EdDSA"],
      requireKeyBinding: opts.requireKeyBinding,
      expectedAud: opts.aud,
      expectedNonce: opts.expectedNonce,
    });
    checks.push(`issuer signature valid (${String(header.alg)})`);
    checks.push(
      `${r.disclosed.length} disclosure${r.disclosed.length === 1 ? "" : "s"} verified against their digests`,
    );
    if (r.keyBound && r.kb) {
      checks.push(
        `key binding valid: signed by the cnf key, aud=${String(r.kb.aud)}, sd_hash matches`,
      );
      if (opts.noncePurpose) {
        if (!consumeVerifierNonce(String(r.kb.nonce), opts.noncePurpose)) {
          return {
            ok: false,
            checks,
            errors: ["nonce unknown, expired or already used (replay)"],
            header,
            payload,
            result: r,
          };
        }
        checks.push("nonce fresh and now consumed");
      }
    } else {
      checks.push("no key binding: anyone holding this string can present it");
    }
    return { ok: true, checks, errors: [], header, payload, result: r };
  } catch (err) {
    return { ok: false, checks, errors: [errorMessage(err)], header, payload, result: null };
  }
}
