// @ts-check
/**
 * OpenID for Verifiable Credential Issuance 1.0 (Final), pre-authorized code
 * flow, issuing the ride credential as an SD-JWT VC to any conforming wallet.
 *
 *   attendee on /trust ──▶ offer (QR: openid-credential-offer://?credential_offer_uri=…)
 *   wallet ──GET offer──▶ ──POST /oid4vci/token (pre-authorized_code + tx_code)──▶ access token
 *   wallet ──POST /oid4vci/nonce──▶ c_nonce
 *   wallet ──POST /oid4vci/credential (Bearer, proofs.jwt[])──▶ { credentials: [{ credential }] }
 *
 * The credential issuer is also its own authorization server (no
 * `authorization_servers` in the metadata), and token requests need no client
 * id (`pre-authorized_grant_anonymous_access_supported`). The SD-JWT VC is
 * bound to the key in the wallet's proof JWT, not to the attendee's did:key.
 *
 * Every code, PIN, token and nonce is random, stored only as a SHA-256 hash
 * where it grants access, single-use, and expires. Not implemented: the
 * authorization code flow, DPoP, key attestations and deferred issuance, so
 * this is not HAIP; see TRUST.md.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { config } from "./config.js";
import { db, tx } from "./db.js";
import { didKeyToPubKey } from "./did.js";
import { errorMessage } from "./errors.js";
import { getEventConfig } from "./event-config.js";
import { decodeJws, publicKeyFromJwk, verifyJws } from "./jose.js";
import { issueRideSdJwt, rideVct } from "./trust.js";
import { decodeJwt } from "./vc.js";
import { consumeVerifierNonce, issueVerifierNonce } from "./verifier.js";

export const CREDENTIAL_CONFIGURATION_ID = "RideAttendance_dc_sd_jwt";
const OFFER_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TX_CODE_ATTEMPTS = 5;
const PROOF_MAX_AGE_SEC = 300;
const PROOF_ALGS = ["ES256", "Ed25519", "EdDSA"];

db.exec(`
  CREATE TABLE IF NOT EXISTS oid4vci_offers (
    id               TEXT    PRIMARY KEY,   -- random, in the credential_offer_uri
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id    TEXT    NOT NULL,      -- credentials_issued.id the offer re-issues
    code_hash        TEXT    NOT NULL UNIQUE,
    pre_auth_code    TEXT    NOT NULL,      -- returned by the offer URI until redeemed, then cleared
    tx_code_hash     TEXT    NOT NULL,
    tx_attempts      INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,
    redeemed_at      INTEGER,
    token_hash       TEXT    UNIQUE,
    token_expires_at INTEGER,
    issued_at        INTEGER
  );
`);

/** @param {string} s */
const sha256 = (s) => createHash("sha256").update(s).digest("base64url");

/** @param {string} a @param {string} b */
function sameHash(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Credential Issuer Metadata (§12.2), at /.well-known/openid-credential-issuer. */
export function issuerMetadata() {
  const event = getEventConfig();
  return {
    credential_issuer: config.appUrl,
    credential_endpoint: `${config.appUrl}/oid4vci/credential`,
    nonce_endpoint: `${config.appUrl}/oid4vci/nonce`,
    display: [{ name: `${event.longName || event.name} Rideshare`, locale: "en" }],
    credential_configurations_supported: {
      [CREDENTIAL_CONFIGURATION_ID]: {
        format: "dc+sd-jwt",
        scope: "ride_attendance",
        vct: rideVct(),
        cryptographic_binding_methods_supported: ["jwk"],
        credential_signing_alg_values_supported: ["ES256"],
        proof_types_supported: { jwt: { proof_signing_alg_values_supported: PROOF_ALGS } },
        credential_metadata: {
          display: [
            {
              name: "Ride attendance",
              locale: "en",
              description: "A ride shared with another attendee",
            },
          ],
        },
      },
    },
  };
}

/** OAuth 2.0 Authorization Server Metadata (RFC 8414) for the token endpoint. */
export function authorizationServerMetadata() {
  return {
    issuer: config.appUrl,
    token_endpoint: `${config.appUrl}/oid4vci/token`,
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:pre-authorized_code"],
    response_types_supported: [],
    token_endpoint_auth_methods_supported: ["none"],
    "pre-authorized_grant_anonymous_access_supported": true,
  };
}

/**
 * Create an offer to re-issue one of the user's ride credentials to a wallet.
 * Returns the PIN in clear exactly once, for the attendee to type into the wallet.
 * @param {number} userId
 * @param {string} credentialId
 */
export function createOffer(userId, credentialId) {
  const owned = db
    .prepare("SELECT 1 FROM credentials_issued WHERE id = ? AND subject_user_id = ?")
    .get(credentialId, userId);
  if (!owned) throw new Error("No such credential");
  const now = Date.now();
  db.prepare(
    "DELETE FROM oid4vci_offers WHERE expires_at < ? AND (token_expires_at IS NULL OR token_expires_at < ?)",
  ).run(now, now);
  const id = randomBytes(16).toString("base64url");
  const code = randomBytes(32).toString("base64url");
  const txCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
  db.prepare(
    `INSERT INTO oid4vci_offers (id, user_id, credential_id, code_hash, pre_auth_code, tx_code_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, credentialId, sha256(code), code, sha256(txCode), now, now + OFFER_TTL_MS);
  const offerUri = `${config.appUrl}/oid4vci/offer/${id}`;
  return {
    id,
    txCode,
    expiresAt: now + OFFER_TTL_MS,
    offerUri,
    walletUrl: `openid-credential-offer://?credential_offer_uri=${encodeURIComponent(offerUri)}`,
  };
}

/**
 * The Credential Offer object (§4.1) a wallet fetches from credential_offer_uri.
 * @param {string} id
 */
export function getOffer(id) {
  const row =
    /** @type {{ pre_auth_code: string, expires_at: number, redeemed_at: number | null } | undefined} */ (
      db
        .prepare("SELECT pre_auth_code, expires_at, redeemed_at FROM oid4vci_offers WHERE id = ?")
        .get(id)
    );
  if (!row || row.redeemed_at || row.expires_at < Date.now()) return null;
  return {
    credential_issuer: config.appUrl,
    credential_configuration_ids: [CREDENTIAL_CONFIGURATION_ID],
    grants: {
      "urn:ietf:params:oauth:grant-type:pre-authorized_code": {
        "pre-authorized_code": row.pre_auth_code,
        tx_code: {
          input_mode: "numeric",
          length: 6,
          description: "The 6-digit PIN shown next to the QR code on the rideshare site",
        },
      },
    },
  };
}

/** An OAuth-style error carrying its HTTP status and `error` code. */
export class OAuthError extends Error {
  /** @param {number} status @param {string} code @param {string} description */
  constructor(status, code, description) {
    super(description);
    this.status = status;
    this.code = code;
  }
}

/**
 * Token endpoint (§6) for the pre-authorized code grant.
 * @param {Record<string, string>} form
 */
export function exchangeToken(form) {
  if (form.grant_type !== "urn:ietf:params:oauth:grant-type:pre-authorized_code") {
    throw new OAuthError(
      400,
      "unsupported_grant_type",
      "only the pre-authorized code grant is supported",
    );
  }
  const code = form["pre-authorized_code"];
  if (!code) throw new OAuthError(400, "invalid_request", "pre-authorized_code is required");
  const txCode = form.tx_code;
  if (!txCode) throw new OAuthError(400, "invalid_request", "tx_code is required for this offer");

  // The wrong-PIN path must commit its attempt counter, so it returns from the
  // transaction and throws after: throwing inside tx() would roll it back.
  const result = tx(() => {
    const row =
      /** @type {{ id: string, tx_code_hash: string, tx_attempts: number, expires_at: number, redeemed_at: number | null } | undefined} */ (
        db
          .prepare(
            "SELECT id, tx_code_hash, tx_attempts, expires_at, redeemed_at FROM oid4vci_offers WHERE code_hash = ?",
          )
          .get(sha256(code))
      );
    if (
      !row ||
      row.redeemed_at ||
      row.expires_at < Date.now() ||
      row.tx_attempts >= MAX_TX_CODE_ATTEMPTS
    ) {
      throw new OAuthError(
        400,
        "invalid_grant",
        "the pre-authorized code is invalid, used or expired",
      );
    }
    if (!sameHash(sha256(txCode), row.tx_code_hash)) {
      db.prepare("UPDATE oid4vci_offers SET tx_attempts = tx_attempts + 1 WHERE id = ?").run(
        row.id,
      );
      return null;
    }
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    db.prepare(
      `UPDATE oid4vci_offers SET redeemed_at = ?, pre_auth_code = '', token_hash = ?, token_expires_at = ?
        WHERE id = ?`,
    ).run(now, sha256(token), now + TOKEN_TTL_MS, row.id);
    return { access_token: token, token_type: "Bearer", expires_in: TOKEN_TTL_MS / 1000 };
  });
  if (!result) throw new OAuthError(400, "invalid_grant", "wrong transaction code");
  return result;
}

/** Nonce endpoint (§7). */
export function issueCNonce() {
  return { c_nonce: issueVerifierNonce("oid4vci").nonce };
}

/**
 * Verify a key proof JWT (Appendix F) and return the wallet's public JWK.
 * @param {string} proof
 */
export function verifyProofJwt(proof) {
  let d;
  try {
    d = decodeJws(proof);
  } catch (err) {
    throw new OAuthError(400, "invalid_proof", `proof is not a JWS: ${errorMessage(err)}`);
  }
  if (d.header.typ !== "openid4vci-proof+jwt") {
    throw new OAuthError(400, "invalid_proof", "proof typ must be openid4vci-proof+jwt");
  }
  const keyRefs = ["jwk", "kid", "x5c"].filter((k) => d.header[k] !== undefined);
  if (keyRefs.length !== 1)
    throw new OAuthError(400, "invalid_proof", "proof header needs exactly one of jwk, kid, x5c");
  /** @type {Record<string, string>} */
  let jwk;
  if (d.header.jwk) {
    jwk = /** @type {Record<string, string>} */ (d.header.jwk);
  } else if (typeof d.header.kid === "string" && d.header.kid.startsWith("did:key:")) {
    const didKey = d.header.kid.split("#")[0];
    jwk = {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(didKeyToPubKey(didKey)).toString("base64url"),
    };
  } else {
    throw new OAuthError(400, "invalid_proof", "proof key must be a jwk or a did:key kid");
  }
  try {
    verifyJws(proof, publicKeyFromJwk(jwk), PROOF_ALGS);
  } catch (err) {
    throw new OAuthError(400, "invalid_proof", errorMessage(err));
  }
  const p = d.payload;
  if (p.aud !== config.appUrl)
    throw new OAuthError(400, "invalid_proof", "proof aud must be the credential issuer");
  const now = Math.floor(Date.now() / 1000);
  if (typeof p.iat !== "number" || p.iat > now + 60 || p.iat < now - PROOF_MAX_AGE_SEC) {
    throw new OAuthError(400, "invalid_proof", "proof iat missing or outside the accepted window");
  }
  if (typeof p.nonce !== "string" || !consumeVerifierNonce(p.nonce, "oid4vci")) {
    throw new OAuthError(
      400,
      "invalid_nonce",
      "proof nonce is unknown, expired or used; fetch a new c_nonce",
    );
  }
  const { kty, crv, x, y } = jwk;
  /** @type {Record<string, string>} */
  const bare = { kty, crv, x };
  if (y) bare.y = y;
  return bare;
}

/**
 * Credential endpoint (§8).
 * @param {string | undefined} authorization  the Authorization header
 * @param {unknown} body
 */
export function issueCredential(authorization, body) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(authorization || "");
  if (!m) throw new OAuthError(401, "invalid_token", "a Bearer access token is required");
  const req = /** @type {Record<string, unknown>} */ (body && typeof body === "object" ? body : {});
  if (req.credential_identifier !== undefined) {
    throw new OAuthError(
      400,
      "invalid_credential_request",
      "credential_identifier is not used by this issuer",
    );
  }
  if (req.credential_configuration_id !== CREDENTIAL_CONFIGURATION_ID) {
    throw new OAuthError(
      400,
      "unknown_credential_configuration",
      `expected ${CREDENTIAL_CONFIGURATION_ID}`,
    );
  }
  const proofs = /** @type {Record<string, unknown>} */ (
    req.proofs && typeof req.proofs === "object" ? req.proofs : {}
  );
  const jwts = proofs.jwt;
  if (
    !Array.isArray(jwts) ||
    jwts.length !== 1 ||
    typeof jwts[0] !== "string" ||
    Object.keys(proofs).length !== 1
  ) {
    throw new OAuthError(400, "invalid_proof", "send proofs.jwt with exactly one proof JWT");
  }

  const row =
    /** @type {{ id: string, credential_id: string, token_expires_at: number, issued_at: number | null } | undefined} */ (
      db
        .prepare(
          "SELECT id, credential_id, token_expires_at, issued_at FROM oid4vci_offers WHERE token_hash = ?",
        )
        .get(sha256(m[1]))
    );
  if (!row || row.issued_at || row.token_expires_at < Date.now()) {
    throw new OAuthError(401, "invalid_token", "the access token is invalid, used or expired");
  }
  const holderJwk = verifyProofJwt(jwts[0]);

  const cred = /** @type {{ jwt: string } | undefined} */ (
    db.prepare("SELECT jwt FROM credentials_issued WHERE id = ?").get(row.credential_id)
  );
  if (!cred)
    throw new OAuthError(
      400,
      "credential_request_denied",
      "the credential behind this offer no longer exists",
    );
  const subject = /** @type {Record<string, unknown>} */ (
    /** @type {Record<string, unknown>} */ (decodeJwt(cred.jwt).payload.vc).credentialSubject
  );
  const claim = db
    .prepare("UPDATE oid4vci_offers SET issued_at = ? WHERE id = ? AND issued_at IS NULL")
    .run(Date.now(), row.id);
  if (claim.changes !== 1)
    throw new OAuthError(401, "invalid_token", "the access token was already used");
  const credential = issueRideSdJwt({
    holderJwk,
    role: String(subject.role),
    counterpart: typeof subject.counterpart === "string" ? subject.counterpart : null,
    ride: /** @type {Record<string, unknown>} */ (subject.ride),
    event: /** @type {Record<string, unknown>} */ (subject.event),
  });
  return { credentials: [{ credential }] };
}
