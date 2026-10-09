// @ts-check
/**
 * Trip-safety links. Someone on a ride makes a link that shows a trusted
 * contact (who has no account) the ride's route and time and the sharer's own
 * trip updates. Links expire 12 hours after departure and can be revoked.
 * Only an HMAC of the token is stored, so a database leak yields no working
 * links.
 */

import { config } from "./config.js";
import { hmac, randomToken } from "./crypto.js";
import { audit, db } from "./db.js";
import { rideParticipants } from "./rides.js";

const AFTER_DEPARTURE_MS = 12 * 60 * 60 * 1000;
const MIN_LIFETIME_MS = 6 * 60 * 60 * 1000;
const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_PER_RIDE = 5;

const hashToken = (token) => hmac(`trip-share:${token}`, config.sessionSecret);

/**
 * @param {number} rideId @param {number} userId
 * @returns {{ id: number, token: string, expiresAt: number }}
 */
export function createTripShare(rideId, userId) {
  if (!rideParticipants(rideId).has(userId))
    throw new Error("Only people on this ride can share it");
  const ride = /** @type {{ depart_date: string, depart_time: string } | undefined} */ (
    db.prepare("SELECT depart_date, depart_time FROM rides WHERE id = ?").get(rideId)
  );
  if (!ride) throw new Error("Ride not found");
  const now = Date.now();
  const active = /** @type {{ n: number }} */ (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM trip_shares
          WHERE ride_id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(rideId, userId, now)
  ).n;
  if (active >= MAX_ACTIVE_PER_RIDE) throw new Error("Revoke an old link before making another");
  // Departure is stored as local wall-clock time; reading it as UTC is off by
  // the venue's offset at most, which the 12-hour margin absorbs.
  const departs = Date.parse(`${ride.depart_date}T${ride.depart_time}:00Z`);
  const expiresAt = Math.min(
    now + MAX_LIFETIME_MS,
    Math.max(
      now + MIN_LIFETIME_MS,
      (Number.isFinite(departs) ? departs : now) + AFTER_DEPARTURE_MS,
    ),
  );
  const token = randomToken(24);
  const r = db
    .prepare(
      `INSERT INTO trip_shares (token_hash, ride_id, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(hashToken(token), rideId, userId, now, expiresAt);
  audit({ actorId: userId, action: "trip.share", detail: `ride ${rideId}` });
  return { id: Number(r.lastInsertRowid), token, expiresAt };
}

/** @param {number} shareId @param {number} userId @returns {boolean} */
export function revokeTripShare(shareId, userId) {
  const r = db
    .prepare(
      "UPDATE trip_shares SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .run(Date.now(), shareId, userId);
  if (r.changes > 0) audit({ actorId: userId, action: "trip.unshare", detail: `share ${shareId}` });
  return r.changes > 0;
}

/**
 * @param {number} rideId @param {number} userId
 * @returns {{ id: number, created_at: number, expires_at: number }[]}
 */
export function activeTripShares(rideId, userId) {
  return /** @type {{ id: number, created_at: number, expires_at: number }[]} */ (
    db
      .prepare(
        `SELECT id, created_at, expires_at FROM trip_shares
          WHERE ride_id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY created_at DESC`,
      )
      .all(rideId, userId, Date.now())
  );
}

/**
 * Resolve a token to what the trusted contact may see, or null when it is
 * unknown, revoked or expired.
 * @param {string} token
 */
export function lookupTripShare(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 64) return null;
  const row = /** @type {{ ride_id: number, user_id: number, expires_at: number } | undefined} */ (
    db
      .prepare(
        `SELECT ride_id, user_id, expires_at FROM trip_shares
          WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(hashToken(token), Date.now())
  );
  if (!row) return null;
  const ride = /** @type {{ airport: string, other_place: string | null, direction: string,
   *   depart_date: string, depart_time: string, mode: string, kind: string, status: string } | undefined} */ (
    db
      .prepare(
        `SELECT airport, other_place, direction, depart_date, depart_time, mode, kind, status
           FROM rides WHERE id = ?`,
      )
      .get(row.ride_id)
  );
  if (!ride) return null;
  const sharer = /** @type {{ display_name: string | null }} */ (
    db.prepare("SELECT display_name FROM users WHERE id = ?").get(row.user_id)
  );
  const updates =
    /** @type {{ status: string, minutes: number | null, note: string | null, created_at: number }[]} */ (
      db
        .prepare(
          `SELECT status, minutes, note, created_at FROM ride_updates
          WHERE ride_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 10`,
        )
        .all(row.ride_id, row.user_id)
    );
  return {
    ride,
    sharerName: sharer?.display_name || "Your contact",
    updates,
    expiresAt: row.expires_at,
  };
}
