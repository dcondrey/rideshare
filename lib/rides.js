// @ts-check
/**
 * Ride + claim queries.
 */

import { db, audit, tx } from "./db.js";

/**
 * @typedef {Object} RideRow
 * @property {number} id
 * @property {number} user_id
 * @property {string} kind          'offer' | 'request'
 * @property {string} direction     'to_venue' | 'from_venue'
 * @property {string} airport
 * @property {string|null} other_place
 * @property {string} depart_date   YYYY-MM-DD
 * @property {string} depart_time   HH:MM
 * @property {number} flex_minutes
 * @property {number} seats
 * @property {string|null} notes
 * @property {string} status        'open' | 'full' | 'cancelled'
 * @property {number} created_at
 * @property {number} updated_at
 * @property {string} poster_email
 * @property {string|null} poster_name
 */

/**
 * Browse open rides with optional filters.
 *
 * @param {{
 *   kind?: 'offer' | 'request' | 'any',
 *   direction?: 'to_venue' | 'from_venue' | 'any',
 *   airport?: string | 'any',
 *   date?: string | 'any',     // YYYY-MM-DD
 *   excludeUserId?: number,
 * }} filters
 * @returns {RideRow[]}
 */
export function browseRides(filters = {}) {
  const where = ["r.status = 'open'"];
  /** @type {(string|number)[]} */
  const args = [];
  if (filters.kind && filters.kind !== "any") {
    where.push("r.kind = ?");
    args.push(filters.kind);
  }
  if (filters.direction && filters.direction !== "any") {
    where.push("r.direction = ?");
    args.push(filters.direction);
  }
  if (filters.airport && filters.airport !== "any") {
    where.push("r.airport = ?");
    args.push(filters.airport);
  }
  if (filters.date && filters.date !== "any") {
    where.push("r.depart_date = ?");
    args.push(filters.date);
  }
  if (filters.excludeUserId) {
    where.push("r.user_id != ?");
    args.push(filters.excludeUserId);
  }
  const sql = `
    SELECT r.*, u.email AS poster_email, u.display_name AS poster_name
      FROM rides r JOIN users u ON u.id = r.user_id
     WHERE ${where.join(" AND ")}
     ORDER BY r.depart_date ASC, r.depart_time ASC, r.created_at DESC
     LIMIT 200`;
  return /** @type {RideRow[]} */ (db.prepare(sql).all(...args));
}

/** @param {number} id */
export function getRide(id) {
  return /** @type {RideRow|undefined} */ (
    db
      .prepare(
        `SELECT r.*, u.email AS poster_email, u.display_name AS poster_name
           FROM rides r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
      )
      .get(id)
  );
}

/** @param {number} userId */
export function ridesPostedBy(userId) {
  return /** @type {RideRow[]} */ (
    db
      .prepare(
        `SELECT r.*, u.email AS poster_email, u.display_name AS poster_name
           FROM rides r JOIN users u ON u.id = r.user_id
          WHERE r.user_id = ?
          ORDER BY r.depart_date ASC, r.depart_time ASC`,
      )
      .all(userId)
  );
}

/** @param {number} userId */
export function claimsByUser(userId) {
  return /** @type {any[]} */ (
    db
      .prepare(
        `SELECT c.*, r.airport, r.direction, r.depart_date, r.depart_time,
                r.kind, r.status AS ride_status,
                u.email AS poster_email, u.display_name AS poster_name,
                u.contact_method AS poster_contact
           FROM claims c
           JOIN rides r ON r.id = c.ride_id
           JOIN users u ON u.id = r.user_id
          WHERE c.claimer_id = ?
          ORDER BY r.depart_date ASC, r.depart_time ASC`,
      )
      .all(userId)
  );
}

/** @param {number} rideId */
export function claimsForRide(rideId) {
  return /** @type {any[]} */ (
    db
      .prepare(
        `SELECT c.*, u.email AS claimer_email, u.display_name AS claimer_name,
                u.contact_method AS claimer_contact
           FROM claims c JOIN users u ON u.id = c.claimer_id
          WHERE c.ride_id = ?
          ORDER BY c.created_at ASC`,
      )
      .all(rideId)
  );
}

/**
 * @param {{
 *   userId: number,
 *   kind: 'offer'|'request',
 *   direction: 'to_venue'|'from_venue',
 *   airport: string,
 *   otherPlace: string|null,
 *   departDate: string,
 *   departTime: string,
 *   flexMinutes: number,
 *   seats: number,
 *   notes: string|null,
 *   meetupId?: number|null,
 *   pickupLat?: number|null,
 *   pickupLng?: number|null,
 * }} input
 */
export function createRide(input) {
  const now = Date.now();
  const r = db
    .prepare(
      `INSERT INTO rides (user_id, kind, direction, airport, other_place,
                          depart_date, depart_time, flex_minutes, seats, notes,
                          status, pickup_lat, pickup_lng, meetup_id,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    )
    .run(
      input.userId,
      input.kind,
      input.direction,
      input.airport,
      input.otherPlace,
      input.departDate,
      input.departTime,
      input.flexMinutes,
      input.seats,
      input.notes,
      input.pickupLat ?? null,
      input.pickupLng ?? null,
      input.meetupId ?? null,
      now,
      now,
    );
  return Number(r.lastInsertRowid);
}

/**
 * @param {number} rideId
 * @param {number} userId — must be the poster
 * @param {'open'|'full'|'cancelled'} status
 */
export function updateRideStatus(rideId, userId, status) {
  const r = db
    .prepare(
      `UPDATE rides SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    )
    .run(status, Date.now(), rideId, userId);
  return r.changes > 0;
}

/**
 * Create a claim. Atomic against double-claims via the UNIQUE(ride_id, claimer_id) index.
 * @param {{ rideId: number, claimerId: number, seats: number, message: string|null }} input
 */
export function createClaim(input) {
  return tx(() => {
    const ride = /** @type {any} */ (
      db.prepare("SELECT id, user_id, status FROM rides WHERE id = ?").get(input.rideId)
    );
    if (!ride) throw new Error("Ride not found");
    if (ride.user_id === input.claimerId) {
      throw new Error("You can't claim your own ride");
    }
    if (ride.status !== "open") throw new Error("This ride isn't open");
    const r = db
      .prepare(
        `INSERT INTO claims (ride_id, claimer_id, seats, message, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        input.rideId,
        input.claimerId,
        input.seats,
        input.message,
        Date.now(),
      );
    return Number(r.lastInsertRowid);
  });
}

/**
 * @param {number} claimId
 * @param {number} actingUserId — must be the ride poster (verified inline)
 * @param {'accepted'|'declined'} decision
 */
export function decideClaim(claimId, actingUserId, decision) {
  return tx(() => {
    const row = /** @type {any} */ (
      db
        .prepare(
          `SELECT c.id, c.ride_id, c.claimer_id, c.status, r.user_id AS poster_id
             FROM claims c JOIN rides r ON r.id = c.ride_id WHERE c.id = ?`,
        )
        .get(claimId)
    );
    if (!row) throw new Error("Claim not found");
    if (row.poster_id !== actingUserId) throw new Error("Not allowed");
    if (row.status !== "pending") throw new Error("Already decided");
    db.prepare(
      `UPDATE claims SET status = ?, decided_at = ? WHERE id = ?`,
    ).run(decision, Date.now(), claimId);
    audit({
      actorId: actingUserId,
      action: `claim.${decision}`,
      detail: `claim ${claimId} on ride ${row.ride_id}`,
    });
    return row;
  });
}

/**
 * @param {number} claimId
 * @param {number} claimerId — must be the claim's owner
 */
export function withdrawClaim(claimId, claimerId) {
  const r = db
    .prepare(
      `UPDATE claims SET status = 'withdrawn', decided_at = ?
        WHERE id = ? AND claimer_id = ? AND status = 'pending'`,
    )
    .run(Date.now(), claimId, claimerId);
  return r.changes > 0;
}

/**
 * Update the user's display name and contact method (revealed on accept).
 * @param {number} userId
 * @param {{ displayName: string|null, contactMethod: string|null }} fields
 */
export function updateUserProfile(userId, fields) {
  db.prepare(
    `UPDATE users SET display_name = ?, contact_method = ? WHERE id = ?`,
  ).run(fields.displayName, fields.contactMethod, userId);
}
