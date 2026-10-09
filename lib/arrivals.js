// @ts-check
/**
 * Arrivals board: how many people are arriving at (or leaving from) each
 * airport, per hour. Aggregate counts only, never names, so it is safe to show
 * every signed-in attendee.
 */

import { db } from "./db.js";

/**
 * @typedef {{ date: string, hour: string, airport: string, rides: number,
 *   people: number, groups: number, delayed: number, missed: number }} BoardSlot
 */

/**
 * @param {'to_venue' | 'from_venue'} direction
 * @returns {BoardSlot[]} sorted by date, hour, airport
 */
export function boardSlots(direction) {
  return /** @type {BoardSlot[]} */ (
    db
      .prepare(
        // People on a ride: the poster plus accepted seats for offers and
        // groups; the seats asked for on a request. Delayed and missed count
        // rides whose latest report from anyone on them says so.
        `WITH latest AS (
           SELECT ride_id, status FROM ride_updates u
            WHERE id = (SELECT MAX(id) FROM ride_updates
                         WHERE ride_id = u.ride_id AND user_id = u.user_id)
         )
         SELECT r.depart_date AS date, substr(r.depart_time, 1, 2) || ':00' AS hour,
                r.airport,
                COUNT(*) AS rides,
                SUM(CASE WHEN r.kind = 'request' THEN r.seats
                         ELSE 1 + COALESCE((SELECT SUM(c.seats) FROM claims c
                                             WHERE c.ride_id = r.id AND c.status = 'accepted'), 0)
                    END) AS people,
                SUM(r.mode != 'car') AS groups,
                SUM(EXISTS (SELECT 1 FROM latest l WHERE l.ride_id = r.id AND l.status = 'late')) AS delayed,
                SUM(EXISTS (SELECT 1 FROM latest l WHERE l.ride_id = r.id AND l.status = 'missed')) AS missed
           FROM rides r
          WHERE r.direction = ? AND r.status != 'cancelled'
          GROUP BY date, hour, r.airport
          ORDER BY date, hour, r.airport`,
      )
      .all(direction)
  );
}
