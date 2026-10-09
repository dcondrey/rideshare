// @ts-check
/**
 * Ride + claim queries.
 */

import { audit, db, tx } from "./db.js";

/**
 * @typedef {{ id: number, ride_id: number, claimer_id: number, seats: number,
 *   message: string | null, status: string, created_at: number,
 *   decided_at: number | null }} ClaimRow
 */

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
 * @property {number|null} pickup_lat
 * @property {number|null} pickup_lng
 * @property {number|null} meetup_id
 * @property {'car'|'taxi'|'transit'} mode  groups ('taxi', 'transit') are joined without approval
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
  return /** @type {(ClaimRow & { airport: string, other_place: string | null, direction: string, depart_date: string, depart_time: string, kind: string, ride_status: string, poster_email: string, poster_name: string | null, poster_contact: string | null })[]} */ (
    db
      .prepare(
        `SELECT c.*, r.airport, r.other_place, r.direction, r.depart_date, r.depart_time,
                r.kind, r.mode, r.status AS ride_status,
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
  return /** @type {(ClaimRow & { claimer_email: string, claimer_name: string | null, claimer_contact: string | null })[]} */ (
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
 *   mode?: 'car'|'taxi'|'transit',
 * }} input
 */
export function createRide(input) {
  const now = Date.now();
  const r = db
    .prepare(
      `INSERT INTO rides (user_id, kind, direction, airport, other_place,
                          depart_date, depart_time, flex_minutes, seats, notes,
                          status, pickup_lat, pickup_lng, meetup_id, mode,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
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
      input.mode ?? "car",
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
    .prepare(`UPDATE rides SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(status, Date.now(), rideId, userId);
  return r.changes > 0;
}

/**
 * Create a claim. Atomic against double-claims via the UNIQUE(ride_id, claimer_id) index.
 * Joining a group (mode 'taxi' or 'transit') needs no approval: the claim is
 * accepted at once if the seats are free, and the group closes when it fills.
 * @param {{ rideId: number, claimerId: number, seats: number, message: string|null }} input
 */
export function createClaim(input) {
  return tx(() => {
    const ride =
      /** @type {{ id: number, user_id: number, status: string, seats: number, mode: string } | undefined} */ (
        db
          .prepare("SELECT id, user_id, status, seats, mode FROM rides WHERE id = ?")
          .get(input.rideId)
      );
    if (!ride) throw new Error("Ride not found");
    if (ride.user_id === input.claimerId) {
      throw new Error("You can't claim your own ride");
    }
    if (ride.status !== "open") throw new Error("This ride isn't open");
    // The form's max attribute is the ride's seat count, but a direct POST is
    // validated only against a fixed ceiling in routes/rides.js, so the ride's
    // own capacity has to be checked here.
    if (input.seats > ride.seats) {
      throw new Error(`This ride only has ${ride.seats} seat${ride.seats === 1 ? "" : "s"}`);
    }
    const now = Date.now();
    if (ride.mode !== "car") {
      const remaining = ride.seats - acceptedSeats(ride.id);
      if (input.seats > remaining) {
        throw new Error(`Only ${remaining} place${remaining === 1 ? "" : "s"} left in this group`);
      }
      const r = db
        .prepare(
          `INSERT INTO claims (ride_id, claimer_id, seats, message, status, created_at, decided_at)
           VALUES (?, ?, ?, ?, 'accepted', ?, ?)`,
        )
        .run(input.rideId, input.claimerId, input.seats, input.message, now, now);
      if (input.seats === remaining) {
        db.prepare(`UPDATE rides SET status = 'full', updated_at = ? WHERE id = ?`).run(
          now,
          ride.id,
        );
      }
      audit({
        actorId: input.claimerId,
        action: "group.joined",
        detail: `ride ${ride.id}`,
      });
      return Number(r.lastInsertRowid);
    }
    const r = db
      .prepare(
        `INSERT INTO claims (ride_id, claimer_id, seats, message, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(input.rideId, input.claimerId, input.seats, input.message, now);
    return Number(r.lastInsertRowid);
  });
}

/** Seats already taken by accepted claims. @param {number} rideId */
function acceptedSeats(rideId) {
  return /** @type {{ n: number }} */ (
    db
      .prepare(
        "SELECT COALESCE(SUM(seats), 0) AS n FROM claims WHERE ride_id = ? AND status = 'accepted'",
      )
      .get(rideId)
  ).n;
}

/**
 * The poster and every accepted rider of a ride: the people who see each
 * other's trip status and live position.
 * @param {number} rideId
 * @returns {Set<number>}
 */
export function rideParticipants(rideId) {
  const rows = /** @type {{ uid: number }[]} */ (
    db
      .prepare(
        `SELECT user_id AS uid FROM rides WHERE id = ?1
         UNION SELECT claimer_id FROM claims WHERE ride_id = ?1 AND status = 'accepted'`,
      )
      .all(rideId)
  );
  return new Set(rows.map((r) => r.uid));
}

export const TRIP_STATUSES = /** @type {const} */ ([
  "on_time",
  "early",
  "late",
  "missed",
  "arrived",
]);
/** @typedef {typeof TRIP_STATUSES[number]} TripStatus */

/**
 * Record a trip status. Only a participant of a ride with at least one
 * accepted rider may post one.
 * @param {{ rideId: number, userId: number, status: typeof TRIP_STATUSES[number],
 *   minutes: number | null, note: string | null }} input
 * @returns {number} the update id
 */
export function postRideUpdate(input) {
  const people = rideParticipants(input.rideId);
  if (!people.has(input.userId) || people.size < 2) {
    throw new Error("Only people on this ride can post its status");
  }
  const r = db
    .prepare(
      `INSERT INTO ride_updates (ride_id, user_id, status, minutes, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.rideId, input.userId, input.status, input.minutes, input.note, Date.now());
  return Number(r.lastInsertRowid);
}

/**
 * @typedef {{ id: number, ride_id: number, user_id: number, name: string | null,
 *   status: string, minutes: number | null, note: string | null, created_at: number }} RideUpdateRow
 */

/**
 * Each participant's latest status on a ride, newest first.
 * @param {number} rideId
 * @returns {RideUpdateRow[]}
 */
export function latestRideUpdates(rideId) {
  return /** @type {RideUpdateRow[]} */ (
    db
      .prepare(
        `SELECT u.id, u.ride_id, u.user_id, us.display_name AS name, u.status, u.minutes, u.note, u.created_at
           FROM ride_updates u JOIN users us ON us.id = u.user_id
          WHERE u.ride_id = ?1 AND u.id = (SELECT MAX(id) FROM ride_updates
                                            WHERE ride_id = ?1 AND user_id = u.user_id)
          ORDER BY u.created_at DESC`,
      )
      .all(rideId)
  );
}

/**
 * @param {number} claimId
 * @param {number} actingUserId — must be the ride poster (verified inline)
 * @param {'accepted'|'declined'} decision
 */
export function decideClaim(claimId, actingUserId, decision) {
  return tx(() => {
    const row =
      /** @type {{ id: number, ride_id: number, claimer_id: number, status: string, poster_id: number } | undefined} */ (
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

    // IMPORTANT: accepted seats must never exceed the ride's capacity. Nothing
    // else enforces it — createClaim lets several people hold pending claims on
    // the same ride, and /rides/:id/full is a manual action with no caller — so
    // without this a 1-seat ride can accept three riders who each believe they
    // have the seat. Computed inside the transaction so two concurrent accepts
    // cannot both read the pre-accept total.
    if (decision === "accepted") {
      const capacity = /** @type {{ seats: number, taken: number }} */ (
        db
          .prepare(
            `SELECT r.seats AS seats,
                    COALESCE((SELECT SUM(c.seats) FROM claims c
                               WHERE c.ride_id = r.id AND c.status = 'accepted'), 0) AS taken
               FROM rides r WHERE r.id = ?`,
          )
          .get(row.ride_id)
      );
      const wanted = /** @type {{ seats: number }} */ (
        db.prepare("SELECT seats FROM claims WHERE id = ?").get(claimId)
      ).seats;
      const remaining = capacity.seats - capacity.taken;
      if (wanted > remaining) {
        throw new Error(
          `Only ${remaining} seat${remaining === 1 ? "" : "s"} left on this ride; this claim asks for ${wanted}`,
        );
      }
      // Close the ride once it is full so no further claims can be created.
      // Pending claims are left for the poster to decline explicitly: a rider
      // may still withdraw, and silently declining on their behalf would hide
      // that the seat reopened.
      if (wanted === remaining) {
        db.prepare(`UPDATE rides SET status = 'full', updated_at = ? WHERE id = ?`).run(
          Date.now(),
          row.ride_id,
        );
      }
    }

    db.prepare(`UPDATE claims SET status = ?, decided_at = ? WHERE id = ?`).run(
      decision,
      Date.now(),
      claimId,
    );
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
  db.prepare(`UPDATE users SET display_name = ?, contact_method = ? WHERE id = ?`).run(
    fields.displayName,
    fields.contactMethod,
    userId,
  );
}
