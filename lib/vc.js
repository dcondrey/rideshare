// @ts-check
/**
 * Verifiable Credentials, JWT form, signed with Ed25519/EdDSA.
 *
 * Spec references:
 *   - W3C VC Data Model 2.0 — https://www.w3.org/TR/vc-data-model-2.0/
 *   - VC-JWT 1.0           — https://www.w3.org/TR/vc-jwt/
 *   - JWT (RFC 7519)       — https://datatracker.ietf.org/doc/html/rfc7519
 *
 * We use the "sd-jwt-vc style" compact form: header.payload.signature
 * with payload conforming to VC-JWT (vc claim contains the credential).
 *
 * Header: { alg: "EdDSA", typ: "vc+jwt", kid: <issuer DID with key fragment> }
 * Payload (claim names per VC-JWT):
 *   iss   = issuer DID
 *   sub   = subject (holder) DID
 *   nbf   = issuance timestamp (seconds)
 *   exp   = expiry (seconds; optional)
 *   jti   = credential id (URI)
 *   vc    = the VerifiableCredential object (full VCDM)
 *
 * Pure node:crypto.
 */

import {
  ed25519Sign,
  ed25519Verify,
  pubKeyFromRaw,
  resolveDid,
} from "./did.js";

// ── Base64URL helpers ────────────────────────────────────────────────────────
function b64u(buf) {
  return Buffer.from(buf).toString("base64url");
}
function b64uDecode(s) {
  return Buffer.from(s, "base64url");
}

// ── Issue a VC-JWT ───────────────────────────────────────────────────────────
/**
 * Sign a Verifiable Credential as a compact JWT.
 *
 * @param {{
 *   issuerDid: string,                       // e.g. did:web:rideshare.example.com
 *   subjectDid: string,                      // e.g. did:key:z6Mk...
 *   credentialId: string,                    // unique URI for this credential
 *   types: string[],                         // e.g. ["VerifiableCredential","RideAttendanceCredential"]
 *   credentialSubject: Record<string, any>,  // claim object (must include id = subjectDid)
 *   issuanceDate?: Date,
 *   expirationDate?: Date,
 *   privateKey: import("node:crypto").KeyObject, // issuer's Ed25519 private key
 *   keyFragment?: string,                    // verificationMethod fragment, e.g. "#key-1"
 * }} args
 * @returns {string} compact JWT
 */
export function signCredential(args) {
  const issuanceDate = args.issuanceDate || new Date();
  const issuanceSec = Math.floor(issuanceDate.getTime() / 1000);
  const expSec = args.expirationDate
    ? Math.floor(args.expirationDate.getTime() / 1000)
    : undefined;

  const fragment = args.keyFragment || "key-1";
  const kid = `${args.issuerDid}#${fragment}`;

  const header = {
    alg: "EdDSA",
    typ: "vc+jwt",
    kid,
  };

  const credentialSubject = { ...args.credentialSubject };
  if (!credentialSubject.id) credentialSubject.id = args.subjectDid;

  const vc = {
    "@context": [
      "https://www.w3.org/ns/credentials/v2",
      "https://eventrideshare.org/contexts/v1",
    ],
    id: args.credentialId,
    type: args.types,
    issuer: args.issuerDid,
    validFrom: issuanceDate.toISOString(),
    ...(args.expirationDate ? { validUntil: args.expirationDate.toISOString() } : {}),
    credentialSubject,
  };

  /** @type {Record<string, any>} */
  const payload = {
    iss: args.issuerDid,
    sub: args.subjectDid,
    nbf: issuanceSec,
    iat: issuanceSec,
    jti: args.credentialId,
    vc,
  };
  if (expSec) payload.exp = expSec;

  const headerB64 = b64u(JSON.stringify(header));
  const payloadB64 = b64u(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = ed25519Sign(Buffer.from(signingInput, "ascii"), args.privateKey);
  return `${signingInput}.${b64u(sig)}`;
}

// ── Decode (without verification) ────────────────────────────────────────────
/**
 * Parse a JWT into its parts without verifying. Useful for inspection.
 * @param {string} jwt
 */
export function decodeJwt(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("JWT must have 3 segments");
  const header = JSON.parse(b64uDecode(parts[0]).toString("utf8"));
  const payload = JSON.parse(b64uDecode(parts[1]).toString("utf8"));
  return { header, payload, signature: parts[2], signingInput: `${parts[0]}.${parts[1]}` };
}

// ── Verify ───────────────────────────────────────────────────────────────────
/**
 * Verify a compact VC-JWT. Resolves the issuer DID, verifies the signature,
 * checks consistency of iss/sub/nbf/exp/vc, and returns the decoded credential.
 *
 * Returns a structured result with reason codes so the verifier playground
 * can show specific failures.
 *
 * @param {string} jwt
 * @param {{ now?: Date, expectedIssuer?: string, expectedSubject?: string }} [opts]
 */
export async function verifyCredential(jwt, opts = {}) {
  const now = opts.now || new Date();
  /** @type {string[]} */
  const checks = [];
  /** @type {string[]} */
  const errors = [];

  let parts;
  try {
    parts = decodeJwt(jwt);
  } catch (err) {
    return { ok: false, errors: [`malformed_jwt: ${err.message}`], checks };
  }
  const { header, payload, signature, signingInput } = parts;

  if (header.alg !== "EdDSA") {
    errors.push(`unsupported_alg: ${header.alg}`);
  } else {
    checks.push("alg=EdDSA");
  }
  if (header.typ && header.typ !== "vc+jwt" && header.typ !== "JWT") {
    errors.push(`unexpected_typ: ${header.typ}`);
  }

  const issuer = payload.iss || (payload.vc && payload.vc.issuer);
  if (!issuer) errors.push("missing_issuer");
  else checks.push(`issuer=${issuer}`);

  if (opts.expectedIssuer && issuer !== opts.expectedIssuer) {
    errors.push(`issuer_mismatch: ${issuer} != ${opts.expectedIssuer}`);
  }

  const subject = payload.sub || (payload.vc?.credentialSubject?.id);
  if (!subject) errors.push("missing_subject");
  else checks.push(`subject=${subject}`);

  if (opts.expectedSubject && subject !== opts.expectedSubject) {
    errors.push(`subject_mismatch: ${subject} != ${opts.expectedSubject}`);
  }

  // Time bounds
  const nowSec = Math.floor(now.getTime() / 1000);
  if (payload.nbf && nowSec < payload.nbf - 300) {
    errors.push(`not_yet_valid: nbf=${payload.nbf} now=${nowSec}`);
  }
  if (payload.exp && nowSec > payload.exp) {
    errors.push(`expired: exp=${payload.exp} now=${nowSec}`);
  }

  // VC consistency
  if (!payload.vc) errors.push("missing_vc_claim");
  else {
    if (!Array.isArray(payload.vc.type) || !payload.vc.type.includes("VerifiableCredential")) {
      errors.push("vc.type_missing_VerifiableCredential");
    }
    if (payload.vc.issuer !== issuer) {
      errors.push(`vc.issuer_mismatch: ${payload.vc.issuer} vs jwt.iss ${issuer}`);
    }
  }

  // Resolve issuer DID + verify signature
  if (issuer && errors.length === 0) {
    let rawPubKey;
    try {
      const r = await resolveDid(issuer);
      rawPubKey = r.rawPubKey;
      checks.push(`resolved_issuer_did`);
    } catch (err) {
      return {
        ok: false,
        errors: [`issuer_resolution_failed: ${err.message}`],
        checks,
        decoded: { header, payload },
      };
    }
    const pubKey = pubKeyFromRaw(rawPubKey);
    let sigOk = false;
    try {
      sigOk = ed25519Verify(
        Buffer.from(signingInput, "ascii"),
        b64uDecode(signature),
        pubKey,
      );
    } catch (err) {
      errors.push(`signature_verify_threw: ${err.message}`);
    }
    if (!sigOk) errors.push("signature_invalid");
    else checks.push("signature_valid");
  }

  return {
    ok: errors.length === 0,
    errors,
    checks,
    decoded: { header, payload },
  };
}
