// @ts-check
/**
 * Trust orchestration: deployment identity, ride confirmations, credential
 * issuance, cross-event credential verification.
 *
 * Concepts:
 *   - The DEPLOYMENT has a single Ed25519 keypair (table: signing_keys),
 *     generated at first boot. Its DID is did:web:<host-of-APP_URL>.
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

import { db } from "./db.js";
import { config } from "./config.js";
import {
  generateEd25519Keypair,
  pubKeyRawBytes,
  pubKeyToDidKey,
  keyToJwkString,
  keyFromJwkString,
  didWebFor,
  base58btcEncode,
  resolveDid,
  ed25519Sign,
  didKeyToPubKey,
  pubKeyFromRaw,
  ed25519Verify,
} from "./did.js";
import { signCredential, verifyCredential, decodeJwt } from "./vc.js";

// ── Deployment identity: boot-time keypair + DID document ───────────────────
let cachedDeploymentKey = null;

/**
 * Returns the deployment's signing key + DID. Generates and persists a fresh
 * Ed25519 keypair on first call if none exists.
 *
 * @returns {{
 *   privateKey: import("node:crypto").KeyObject,
 *   publicKey: import("node:crypto").KeyObject,
 *   did: string,
 *   keyFragment: string,
 * }}
 */
export function getDeploymentKey() {
  if (cachedDeploymentKey) return cachedDeploymentKey;

  const row = /** @type {any} */ (
    db.prepare("SELECT * FROM signing_keys WHERE id = 1").get()
  );
  if (row) {
    cachedDeploymentKey = {
      privateKey: keyFromJwkString(row.private_key_jwk, "private"),
      publicKey: keyFromJwkString(row.public_key_jwk, "public"),
      did: row.did,
      keyFragment: row.key_fragment || "key-1",
    };
    return cachedDeploymentKey;
  }

  const { publicKey, privateKey } = generateEd25519Keypair();
  const did = didWebFor(config.appUrl);
  db.prepare(
    `INSERT INTO signing_keys (id, algorithm, public_key_jwk, private_key_jwk, did, key_fragment, created_at)
     VALUES (1, 'Ed25519', ?, ?, ?, 'key-1', ?)`,
  ).run(keyToJwkString(publicKey), keyToJwkString(privateKey), did, Date.now());

  console.log(`[trust] generated deployment Ed25519 keypair; DID = ${did}`);

  cachedDeploymentKey = { privateKey, publicKey, did, keyFragment: "key-1" };
  return cachedDeploymentKey;
}

/**
 * Build the DID document for this deployment, served at /.well-known/did.json.
 * Conforms to the DID Core spec — verifies in any compliant resolver.
 */
export function getDeploymentDidDocument() {
  const { publicKey, did, keyFragment } = getDeploymentKey();
  const raw = pubKeyRawBytes(publicKey);
  const multibase = "z" + base58btcEncode(
    new Uint8Array([0xed, 0x01, ...raw]),
  );
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1",
    ],
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

/**
 * Issue a one-time challenge for the given user. The client must sign this
 * with the private key corresponding to the DID:key they want to bind.
 * @param {number} userId
 * @returns {{ challenge: string, expiresAt: number }}
 */
export function issueDidChallenge(userId) {
  const challenge = `rideshare-bind:${randomUUID()}`;
  const now = Date.now();
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
  const row = /** @type {any} */ (
    db
      .prepare(
        `SELECT user_id, expires_at, consumed_at FROM did_challenges WHERE challenge = ?`,
      )
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

  db.prepare(
    `UPDATE did_challenges SET consumed_at = ? WHERE challenge = ?`,
  ).run(Date.now(), args.challenge);

  // If the DID is already bound to another user, refuse.
  const existing = /** @type {any} */ (
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
  const row = /** @type {any} */ (
    db
      .prepare("SELECT did, bound_at FROM user_dids WHERE user_id = ?")
      .get(userId)
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
  const ride = /** @type {any} */ (
    db.prepare("SELECT id, user_id AS poster_id FROM rides WHERE id = ?").get(args.rideId)
  );
  if (!ride) throw new Error("Ride not found");

  // Identify which "side" the confirming user is: poster OR an accepted claimer.
  let claim = null;
  if (ride.poster_id === args.userId) {
    // Poster: there must be at least one accepted claim. Confirmation applies
    // to ALL accepted claims they have (they're saying "I drove" or "I rode").
    const claims = /** @type {any[]} */ (
      db
        .prepare(
          `SELECT id, claimer_id FROM claims WHERE ride_id = ? AND status = 'accepted'`,
        )
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
  claim = /** @type {any} */ (
    db
      .prepare(
        `SELECT id FROM claims WHERE ride_id = ? AND claimer_id = ? AND status = 'accepted'`,
      )
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
  const ride = /** @type {any} */ (
    db
      .prepare(
        `SELECT id, user_id AS poster_id, kind, direction, depart_date, depart_time, airport
           FROM rides WHERE id = ?`,
      )
      .get(rideId)
  );
  const acceptedClaims = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT id, claimer_id FROM claims WHERE ride_id = ? AND status = 'accepted'`,
      )
      .all(rideId)
  );
  /** @type {string[]} */
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
    const existing = /** @type {any} */ (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM credentials_issued WHERE ride_id = ?`,
        )
        .get(rideId)
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
         (id, ride_id, subject_user_id, subject_did, counterpart_did, jwt, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      credentialId,
      ride.id,
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
  return /** @type {any[]} */ (
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
    return { ok: false, error: `Malformed JWT: ${err.message}` };
  }
  const subjectDid = parts.payload.sub || parts.payload.vc?.credentialSubject?.id;
  if (subjectDid !== myDid) {
    return {
      ok: false,
      error: `This credential is for a different DID (${subjectDid}). Only the holder of that key can import it.`,
    };
  }

  const verification = await verifyCredential(args.jwt, { now: new Date() });
  if (!verification.ok) {
    return { ok: false, error: "Verification failed", errors: verification.errors };
  }

  const credentialId = parts.payload.jti || `urn:hash:${parts.signature.slice(0, 32)}`;
  // Idempotent: skip if already imported
  const existing = db
    .prepare(`SELECT id FROM imported_credentials WHERE id = ? AND user_id = ?`)
    .get(credentialId, args.userId);
  if (existing) return { ok: true, id: credentialId };

  const issuerDid = parts.payload.iss || parts.payload.vc?.issuer;
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
 * Cumulative trust profile for a user: count of valid credentials issued
 * here + imported, distinct counterparts, distinct issuers (events).
 *
 * @param {number} userId
 */
export function trustProfileFor(userId) {
  const issuedHere = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT subject_did, counterpart_did FROM credentials_issued WHERE subject_user_id = ?`,
      )
      .all(userId)
  );
  const imported = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT issuer_did, counterpart_did FROM imported_credentials
          WHERE user_id = ? AND verification_status = 'valid'`,
      )
      .all(userId)
  );
  const { did: deploymentDid } = getDeploymentKey();
  const issuers = new Set([deploymentDid, ...imported.map((r) => r.issuer_did)]);
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
