// @ts-check
/**
 * Trust orchestration: deployment identity, ride confirmations, credential
 * issuance, cross-event credential verification.
 *
 * Concepts:
 *   - The DEPLOYMENT has a single Ed25519 keypair (file: secrets/deployment.key,
 *     see lib/keys.js), generated at first boot. Its DID is did:web:<host-of-APP_URL>.
 *   - Each USER may bind their own DID:key (held in their browser via
 *     IndexedDB). This is a portable identity.
 *   - When two users complete an accepted claim AND both confirm the ride
 *     happened, the deployment issues a Verifiable Credential to each side
 *     attesting the ride.
 *   - When a user joins a NEW deployment, they import credentials from past
 *     deployments. The new deployment fetches each issuer's did:web doc,
 *     verifies signatures, and shows a cumulative trust profile.
 */

import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import {
  base58btcEncode,
  didKeyToPubKey,
  ed25519Verify,
  pubKeyFromRaw,
  pubKeyRawBytes,
} from "./did.js";
import { errorMessage } from "./errors.js";
import { loadDeploymentKey } from "./keys.js";
import { decodeJwt, signCredential, verifyCredential } from "./vc.js";

/**
 * @typedef {{ id: number, claimer_id: number }} ClaimRow
 * @typedef {{ id: number, poster_id: number, kind: string, direction: string,
 *   depart_date: string, depart_time: string, airport: string }} IssuanceRideRow
 * @typedef {{ id: string, jwt: string, subject_did: string,
 *   counterpart_did: string | null, ride_id: number | null,
 *   issued_at: number }} IssuedCredentialRow
 */

// ── Deployment identity: boot-time keypair + DID document ───────────────────
/**
 * Returns the deployment's signing key + DID. Custody lives in lib/keys.js:
 * the private key is a file outside the database.
 *
 * @returns {{
 *   privateKey: import("node:crypto").KeyObject,
 *   publicKey: import("node:crypto").KeyObject,
 *   did: string,
 *   keyFragment: string,
 * }}
 */
export function getDeploymentKey() {
  return loadDeploymentKey();
}

/**
 * Build the DID document for this deployment, served at /.well-known/did.json.
 * Conforms to the DID Core spec — verifies in any compliant resolver.
 */
export function getDeploymentDidDocument() {
  const { publicKey, did, keyFragment } = getDeploymentKey();
  const raw = pubKeyRawBytes(publicKey);
  const multibase = `z${base58btcEncode(new Uint8Array([0xed, 0x01, ...raw]))}`;
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    id: did,
    verificationMethod: [
      {
        id: `${did}#${keyFragment}`,
        type: "Multikey",
        controller: did,
        publicKeyMultibase: multibase,
      },
    ],
    assertionMethod: [`${did}#${keyFragment}`],
    authentication: [`${did}#${keyFragment}`],
    service: [
      {
        id: `${did}#rideshare`,
        type: "EventRideshareTrust",
        serviceEndpoint: config.appUrl,
      },
    ],
  };
}

// ── User DID bind (challenge–response) ──────────────────────────────────────
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const REVALIDATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Issue a one-time challenge for the given user. The client must sign this
 * with the private key corresponding to the DID:key they want to bind.
 * @param {number} userId
 * @returns {{ challenge: string, expiresAt: number }}
 */
export function issueDidChallenge(userId) {
  const challenge = `rideshare-bind:${randomUUID()}`;
  const now = Date.now();
  // The route needs only a session, so without this the table grows one row per
  // request forever. Expired rows are dead either way: bindDid only accepts a
  // challenge whose expires_at is still in the future.
  db.prepare("DELETE FROM did_challenges WHERE expires_at < ?").run(now);
  db.prepare(
    `INSERT INTO did_challenges (challenge, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(challenge, userId, now, now + CHALLENGE_TTL_MS);
  return { challenge, expiresAt: now + CHALLENGE_TTL_MS };
}

/**
 * Bind a DID:key to the current user, given a signed challenge.
 *
 * @param {{
 *   userId: number,
 *   did: string,         // did:key:z...
 *   challenge: string,
 *   signatureB64u: string, // base64url 64-byte Ed25519 signature
 * }} args
 */
export function bindDid(args) {
  const row =
    /** @type {{ user_id: number, expires_at: number, consumed_at: number | null } | undefined} */ (
      db
        .prepare(`SELECT user_id, expires_at, consumed_at FROM did_challenges WHERE challenge = ?`)
        .get(args.challenge)
    );
  if (!row) throw new Error("Unknown challenge");
  if (row.consumed_at) throw new Error("Challenge already used");
  if (row.expires_at < Date.now()) throw new Error("Challenge expired");
  if (row.user_id !== args.userId) throw new Error("Challenge user mismatch");

  // Verify signature: prove the user controls the private key for this DID
  const raw = didKeyToPubKey(args.did);
  const pub = pubKeyFromRaw(raw);
  const sig = Buffer.from(args.signatureB64u, "base64url");
  const ok = ed25519Verify(Buffer.from(args.challenge, "utf8"), sig, pub);
  if (!ok) throw new Error("Signature did not verify");

  db.prepare(`UPDATE did_challenges SET consumed_at = ? WHERE challenge = ?`).run(
    Date.now(),
    args.challenge,
  );

  // If the DID is already bound to another user, refuse.
  const existing = /** @type {{ user_id: number } | undefined} */ (
    db.prepare("SELECT user_id FROM user_dids WHERE did = ?").get(args.did)
  );
  if (existing && existing.user_id !== args.userId) {
    throw new Error("This DID is already bound to a different account");
  }

  db.prepare(
    `INSERT INTO user_dids (user_id, did, bound_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET did = excluded.did, bound_at = excluded.bound_at`,
  ).run(args.userId, args.did, Date.now());
}

/** @param {number} userId */
export function getUserDid(userId) {
  const row = /** @type {{ did: string, bound_at: number } | undefined} */ (
    db.prepare("SELECT did, bound_at FROM user_dids WHERE user_id = ?").get(userId)
  );
  return row || null;
}

// ── Ride confirmation flow ──────────────────────────────────────────────────
/**
 * Mark a ride as "I made it" by the given user. Returns whether this caused
 * dual-confirmation (both poster and accepted-claimer confirmed).
 *
 * Issues credentials to both parties when dual-confirmation is reached.
 *
 * @param {{ rideId: number, userId: number }} args
 * @returns {{
 *   recorded: boolean,
 *   dualConfirmed: boolean,
 *   issuedCredentialIds: string[],
 * }}
 */
export function confirmRide(args) {
  // Find the accepted claim for this ride. There can be multiple accepted
  // claims; for simplicity v1 issues separate credentials per (poster, claimer)
  // pair when both that pair confirms.
  const ride = /** @type {{ id: number, poster_id: number } | undefined} */ (
    db.prepare("SELECT id, user_id AS poster_id FROM rides WHERE id = ?").get(args.rideId)
  );
  if (!ride) throw new Error("Ride not found");

  // Identify which "side" the confirming user is: poster OR an accepted claimer.
  let claim = null;
  if (ride.poster_id === args.userId) {
    // Poster: there must be at least one accepted claim. Confirmation applies
    // to ALL accepted claims they have (they're saying "I drove" or "I rode").
    const claims = /** @type {ClaimRow[]} */ (
      db
        .prepare(`SELECT id, claimer_id FROM claims WHERE ride_id = ? AND status = 'accepted'`)
        .all(args.rideId)
    );
    if (claims.length === 0) {
      throw new Error("No accepted claim on this ride yet");
    }
    // Record poster confirmation against EACH accepted claim
    const now = Date.now();
    const ins = db.prepare(
      `INSERT OR IGNORE INTO ride_confirmations (ride_id, user_id, claim_id, confirmed_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const c of claims) {
      ins.run(args.rideId, args.userId, c.id, now);
    }
    return runIssuanceForRide(args.rideId);
  }

  // Otherwise, find an accepted claim where this user is the claimer.
  claim = /** @type {{ id: number } | undefined} */ (
    db
      .prepare(`SELECT id FROM claims WHERE ride_id = ? AND claimer_id = ? AND status = 'accepted'`)
      .get(args.rideId, args.userId)
  );
  if (!claim) {
    throw new Error("You don't have an accepted claim on this ride");
  }
  db.prepare(
    `INSERT OR IGNORE INTO ride_confirmations (ride_id, user_id, claim_id, confirmed_at)
     VALUES (?, ?, ?, ?)`,
  ).run(args.rideId, args.userId, claim.id, Date.now());
  return runIssuanceForRide(args.rideId);
}

/**
 * After any confirmation is recorded, scan the ride's accepted claims and
 * issue credentials for any (poster, claimer) pair that is now dual-confirmed
 * AND hasn't already been issued.
 *
 * @param {number} rideId
 */
function runIssuanceForRide(rideId) {
  const ride = /** @type {IssuanceRideRow | undefined} */ (
    db
      .prepare(
        `SELECT id, user_id AS poster_id, kind, direction, depart_date, depart_time, airport
           FROM rides WHERE id = ?`,
      )
      .get(rideId)
  );
  if (!ride) return { recorded: false, dualConfirmed: false, issuedCredentialIds: [] };
  const acceptedClaims = /** @type {ClaimRow[]} */ (
    db
      .prepare(`SELECT id, claimer_id FROM claims WHERE ride_id = ? AND status = 'accepted'`)
      .all(rideId)
  );
  // One entry per dual-confirmed pair; flattened on return.
  /** @type {string[][]} */
  const issued = [];
  let dualConfirmed = false;
  for (const c of acceptedClaims) {
    const posterConfirmed = !!db
      .prepare(
        `SELECT 1 FROM ride_confirmations WHERE ride_id = ? AND user_id = ? AND claim_id = ?`,
      )
      .get(rideId, ride.poster_id, c.id);
    const claimerConfirmed = !!db
      .prepare(
        `SELECT 1 FROM ride_confirmations WHERE ride_id = ? AND user_id = ? AND claim_id = ?`,
      )
      .get(rideId, c.claimer_id, c.id);
    if (!posterConfirmed || !claimerConfirmed) continue;
    dualConfirmed = true;
    // Idempotent: skip if credentials for this (ride, claim) already exist.
    // Scoped by claim_id, not ride_id: a ride with several accepted claims
    // issues one pair per claim, and a ride-wide count stops at the first.
    // IMPORTANT: rows written before claim_id existed carry NULL, and the guard
    // they were written under allowed at most one pair per ride — so a NULL row
    // on this ride still means "already issued", for every claim on it. Without
    // that arm an upgraded database re-mints a pair on the next confirmation.
    const existing = /** @type {{ c: number }} */ (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM credentials_issued
            WHERE ride_id = ? AND (claim_id = ? OR claim_id IS NULL)`,
        )
        .get(rideId, c.id)
    );
    if (existing.c >= 2) continue;

    const posterDid = getUserDid(ride.poster_id)?.did;
    const claimerDid = getUserDid(c.claimer_id)?.did;
    if (!posterDid || !claimerDid) {
      // Can't issue without DIDs on both sides. Confirmations are still recorded.
      continue;
    }

    issued.push(
      issuePairCredentials({
        ride,
        claimId: c.id,
        posterUserId: ride.poster_id,
        claimerUserId: c.claimer_id,
        posterDid,
        claimerDid,
      }),
    );
  }
  return {
    recorded: true,
    dualConfirmed,
    issuedCredentialIds: issued.flat(),
  };
}

/**
 * Mint a pair of RideAttendanceCredentials — one for each side — and
 * persist them.
 *
 * @returns {string[]} the credential IDs issued
 */
function issuePairCredentials({
  ride,
  claimId,
  posterUserId,
  claimerUserId,
  posterDid,
  claimerDid,
}) {
  const { privateKey, did: issuerDid, keyFragment } = getDeploymentKey();
  const eventConfig = config.event;

  /** @param {{ subjectUserId: number, subjectDid: string, counterpartDid: string, role: string }} args */
  const mint = (args) => {
    const credentialId = `urn:uuid:${randomUUID()}`;
    const subject = {
      id: args.subjectDid,
      type: "RideParticipant",
      role: args.role,
      counterpart: args.counterpartDid,
      ride: {
        date: ride.depart_date,
        time: ride.depart_time,
        airport: ride.airport,
        direction: ride.direction,
      },
      event: {
        name: eventConfig.name,
        startDate: eventConfig.dates?.start,
        endDate: eventConfig.dates?.end,
      },
    };
    const jwt = signCredential({
      issuerDid,
      subjectDid: args.subjectDid,
      credentialId,
      types: ["VerifiableCredential", "RideAttendanceCredential"],
      credentialSubject: subject,
      privateKey,
      keyFragment,
    });
    db.prepare(
      `INSERT INTO credentials_issued
         (id, ride_id, claim_id, subject_user_id, subject_did, counterpart_did, jwt, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      credentialId,
      ride.id,
      claimId,
      args.subjectUserId,
      args.subjectDid,
      args.counterpartDid,
      jwt,
      Date.now(),
    );
    return credentialId;
  };

  return [
    mint({
      subjectUserId: posterUserId,
      subjectDid: posterDid,
      counterpartDid: claimerDid,
      role: ride.kind === "offer" ? "driver" : "rider",
    }),
    mint({
      subjectUserId: claimerUserId,
      subjectDid: claimerDid,
      counterpartDid: posterDid,
      role: ride.kind === "offer" ? "rider" : "driver",
    }),
  ];
}

/**
 * List credentials this deployment has issued to the given user.
 * @param {number} userId
 */
export function credentialsIssuedTo(userId) {
  return /** @type {IssuedCredentialRow[]} */ (
    db
      .prepare(
        `SELECT id, jwt, subject_did, counterpart_did, ride_id, issued_at
           FROM credentials_issued
          WHERE subject_user_id = ?
          ORDER BY issued_at DESC`,
      )
      .all(userId)
  );
}

// ── Cross-event import + verification ────────────────────────────────────────
/**
 * Import a credential the user is presenting from a previous event. Verifies
 * the signature against the issuer DID. Refuses credentials whose subject
 * does not match the user's bound DID (prevents stealing credentials).
 *
 * @param {{ userId: number, jwt: string }} args
 * @returns {Promise<{ ok: boolean, id?: string, error?: string, errors?: string[] }>}
 */
export async function importCredential(args) {
  const myDid = getUserDid(args.userId)?.did;
  if (!myDid) return { ok: false, error: "Bind your DID first" };

  let parts;
  try {
    parts = decodeJwt(args.jwt);
  } catch (err) {
    return { ok: false, error: `Malformed JWT: ${errorMessage(err)}` };
  }
  const subjectDid = parts.payload.sub || parts.payload.vc?.credentialSubject?.id;
  if (subjectDid !== myDid) {
    return {
      ok: false,
      error: `This credential is for a different DID (${subjectDid}). Only the holder of that key can import it.`,
    };
  }

  const issuerDid = parts.payload.iss || parts.payload.vc?.issuer;
  // IMPORTANT: only a deployment can vouch for a ride. A did:key resolves from
  // the DID string alone, so accepting one would let the holder sign their own
  // credentials with a key they just generated and mint an unlimited trust
  // score. Every real issuer in this system is a did:web deployment.
  if (typeof issuerDid !== "string" || !issuerDid.startsWith("did:web:")) {
    return {
      ok: false,
      error: "Only credentials issued by an event deployment (did:web) can be imported.",
    };
  }
  if (issuerDid === myDid) {
    return { ok: false, error: "A credential cannot be issued by its own subject." };
  }

  const verification = await verifyCredential(args.jwt, { now: new Date() });
  if (!verification.ok) {
    return {
      ok: false,
      error: "Verification failed",
      errors: verification.errors,
    };
  }

  const credentialId = parts.payload.jti || `urn:hash:${parts.signature.slice(0, 32)}`;
  // Idempotent: skip if already imported
  const existing = db
    .prepare(`SELECT id FROM imported_credentials WHERE id = ? AND user_id = ?`)
    .get(credentialId, args.userId);
  if (existing) return { ok: true, id: credentialId };

  const counterpartDid = parts.payload.vc?.credentialSubject?.counterpart || null;
  const issuedAtIso = parts.payload.vc?.validFrom || null;

  db.prepare(
    `INSERT INTO imported_credentials
       (id, user_id, issuer_did, subject_did, counterpart_did, issued_at_iso, jwt,
        imported_at, last_verified_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid')`,
  ).run(
    credentialId,
    args.userId,
    issuerDid,
    subjectDid,
    counterpartDid,
    issuedAtIso,
    args.jwt,
    Date.now(),
    Date.now(),
  );
  return { ok: true, id: credentialId };
}

/**
 * Re-verify imported credentials whose last verification is older than
 * `maxAgeMs`. `verification_status` is written once at import and read forever
 * by trustProfileFor, so without this a credential stays counted after the
 * issuing deployment rotates its key, takes its did:web document offline, or
 * the credential passes `exp`.
 *
 * @param {{ userId?: number, maxAgeMs?: number, limit?: number }} [opts]
 * @returns {Promise<{ checked: number, invalidated: number }>}
 */
export async function revalidateImportedCredentials(opts = {}) {
  const maxAgeMs = opts.maxAgeMs ?? REVALIDATE_MAX_AGE_MS;
  const limit = opts.limit ?? 50;
  const cutoff = Date.now() - maxAgeMs;
  const rows = /** @type {{ id: string, user_id: number, jwt: string }[]} */ (
    opts.userId === undefined
      ? db
          .prepare(
            `SELECT id, user_id, jwt FROM imported_credentials
              WHERE verification_status = 'valid'
                AND (last_verified_at IS NULL OR last_verified_at < ?)
              ORDER BY last_verified_at IS NOT NULL, last_verified_at
              LIMIT ?`,
          )
          .all(cutoff, limit)
      : db
          .prepare(
            `SELECT id, user_id, jwt FROM imported_credentials
              WHERE user_id = ? AND verification_status = 'valid'
                AND (last_verified_at IS NULL OR last_verified_at < ?)
              ORDER BY last_verified_at IS NOT NULL, last_verified_at
              LIMIT ?`,
          )
          .all(opts.userId, cutoff, limit)
  );

  let invalidated = 0;
  for (const row of rows) {
    /** @type {Awaited<ReturnType<typeof verifyCredential>>} */
    let verification;
    try {
      verification = await verifyCredential(row.jwt, { now: new Date() });
    } catch {
      // Left alone deliberately — see below.
      continue;
    }
    // IMPORTANT: a resolver failure is not proof the credential is bad, and
    // verifyCredential reports one as ok:false rather than by throwing. DNS
    // failure, connection refused or a TLS mismatch must leave the row alone:
    // 'invalid' is terminal, since this query only ever reads 'valid' rows, so
    // one outage would permanently destroy a user's imported credentials. The
    // stale last_verified_at means the next sweep retries it.
    if (verification.errors.some((e) => e.startsWith("issuer_resolution_failed"))) continue;
    const ok = verification.ok;
    db.prepare(
      `UPDATE imported_credentials
          SET verification_status = ?, last_verified_at = ?
        WHERE id = ? AND user_id = ?`,
    ).run(ok ? "valid" : "invalid", Date.now(), row.id, row.user_id);
    if (!ok) invalidated += 1;
  }
  return { checked: rows.length, invalidated };
}

/**
 * Cumulative trust profile for a user: count of valid credentials issued
 * here + imported, distinct counterparts, distinct issuers (events).
 *
 * @param {number} userId
 */
export function trustProfileFor(userId) {
  const issuedHere = /** @type {{ subject_did: string, counterpart_did: string | null }[]} */ (
    db
      .prepare(
        `SELECT subject_did, counterpart_did FROM credentials_issued WHERE subject_user_id = ?`,
      )
      .all(userId)
  );
  const imported = /** @type {{ issuer_did: string, counterpart_did: string | null }[]} */ (
    db
      .prepare(
        `SELECT issuer_did, counterpart_did FROM imported_credentials
          WHERE user_id = ? AND verification_status = 'valid'`,
      )
      .all(userId)
  );
  // Seed with this deployment only when it has actually issued to this user:
  // a newcomer holding one imported credential and nothing local is at one
  // event, not two.
  const issuers = new Set(imported.map((r) => r.issuer_did));
  if (issuedHere.length > 0) issuers.add(getDeploymentKey().did);
  const counterparts = new Set([
    ...issuedHere.map((r) => r.counterpart_did).filter(Boolean),
    ...imported.map((r) => r.counterpart_did).filter(Boolean),
  ]);
  return {
    totalCredentials: issuedHere.length + imported.length,
    fromThisEvent: issuedHere.length,
    fromOtherEvents: imported.length,
    distinctEvents: issuers.size,
    distinctCounterparts: counterparts.size,
  };
}

/**
 * Look up trust profile by user id (used to decorate ride listings).
 * @param {number} userId
 */
export function trustBadgeFor(userId) {
  const p = trustProfileFor(userId);
  if (p.totalCredentials === 0) return null;
  return p;
}
