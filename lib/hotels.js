// @ts-check
/**
 * Hotel room sharing, when `features.hotelSharing` is on in the event config.
 * A listing is either a room with space to share or a person looking for one.
 * Listings show area, dates, places, price split and preferences; the hotel's
 * name and both people's contacts appear only after the poster accepts a
 * request, the same request-then-reveal pattern as rides. There are no hotel
 * pins on the map: where someone sleeps is not for the whole event to see.
 */

import { blockedEitherWay } from "./chat.js";
import { audit, db, tx } from "./db.js";
import { getEventConfig } from "./event-config.js";
import { hiddenFrom } from "./visibility.js";

export const hotelSharingEnabled = () => getEventConfig().features?.hotelSharing === true;

/**
 * @typedef {{ id: number, user_id: number, poster: string | null, kind: 'room' | 'seeking',
 *   area: string, check_in: string, check_out: string, spots: number, price_each: number | null,
 *   prefs: string | null, hotel_name: string | null, status: string, created_at: number }} HotelListing
 */

const SELECT = `SELECT h.id, h.user_id, u.display_name AS poster, h.kind, h.area, h.check_in, h.check_out,
                       h.spots, h.price_each, h.prefs, h.hotel_name, h.status, h.created_at
                  FROM hotel_listings h JOIN users u ON u.id = h.user_id`;

/**
 * Open listings the viewer may see, with the hotel name removed.
 * @param {number} viewerId
 * @returns {HotelListing[]}
 */
export function openListings(viewerId) {
  return /** @type {HotelListing[]} */ (
    db
      .prepare(`${SELECT} WHERE h.status = 'open' ORDER BY h.check_in, h.created_at DESC LIMIT 200`)
      .all()
  )
    .filter(
      (l) =>
        l.user_id === viewerId ||
        (!hiddenFrom(viewerId, l.user_id) && !blockedEitherWay(viewerId, l.user_id)),
    )
    .map((l) => ({ ...l, hotel_name: l.user_id === viewerId ? l.hotel_name : null }));
}

/**
 * @param {{ userId: number, kind: 'room' | 'seeking', area: string, checkIn: string, checkOut: string,
 *   spots: number, priceEach: number | null, prefs: string | null, hotelName: string | null }} l
 */
export function createListing(l) {
  if (l.checkOut <= l.checkIn) throw new Error("Check-out has to be after check-in.");
  const id = Number(
    db
      .prepare(
        `INSERT INTO hotel_listings (user_id, kind, area, check_in, check_out, spots, price_each, prefs, hotel_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        l.userId,
        l.kind,
        l.area,
        l.checkIn,
        l.checkOut,
        l.spots,
        l.priceEach,
        l.prefs,
        l.hotelName,
        Date.now(),
      ).lastInsertRowid,
  );
  audit({ actorId: l.userId, action: "hotel.post", detail: `listing ${id}` });
  return id;
}

/** True when the viewer posted the listing or has an accepted request on it. */
function isMatched(listingId, viewerId) {
  return !!db
    .prepare(
      `SELECT 1 FROM hotel_listings h WHERE h.id = ?1 AND (h.user_id = ?2 OR EXISTS (
         SELECT 1 FROM hotel_requests r WHERE r.listing_id = h.id AND r.requester_id = ?2 AND r.status = 'accepted'))`,
    )
    .get(listingId, viewerId);
}

/**
 * One listing for the viewer. The hotel name is included only for the poster
 * and people they accepted.
 * @param {number} id @param {number} viewerId
 * @returns {HotelListing | null}
 */
export function getListing(id, viewerId) {
  const l = /** @type {HotelListing | undefined} */ (
    db.prepare(`${SELECT} WHERE h.id = ?`).get(id)
  );
  if (!l || hiddenFrom(viewerId, l.user_id) || blockedEitherWay(viewerId, l.user_id)) return null;
  return isMatched(id, viewerId) ? l : { ...l, hotel_name: null };
}

/** @param {number} listingId @param {number} requesterId @param {string | null} message */
export function requestListing(listingId, requesterId, message) {
  const l = getListing(listingId, requesterId);
  if (l?.status !== "open") throw new Error("That listing isn't open.");
  if (l.user_id === requesterId) throw new Error("That's your own listing.");
  const id = Number(
    db
      .prepare(
        "INSERT INTO hotel_requests (listing_id, requester_id, message, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(listingId, requesterId, message, Date.now()).lastInsertRowid,
  );
  audit({ actorId: requesterId, action: "hotel.request", detail: `listing ${listingId}` });
  return id;
}

/**
 * The poster accepts or declines a request. Accepting fills a place; the
 * listing closes when the last place goes.
 * @param {number} requestId @param {number} posterId @param {'accepted' | 'declined'} decision
 */
export function decideRequest(requestId, posterId, decision) {
  return tx(() => {
    const r =
      /** @type {{ listing_id: number, status: string, poster: number, spots: number } | undefined} */ (
        db
          .prepare(
            `SELECT q.listing_id, q.status, h.user_id AS poster, h.spots FROM hotel_requests q
             JOIN hotel_listings h ON h.id = q.listing_id WHERE q.id = ?`,
          )
          .get(requestId)
      );
    if (!r || r.poster !== posterId) throw new Error("Not allowed");
    if (r.status !== "pending") throw new Error("Already decided");
    if (decision === "accepted") {
      const taken = /** @type {{ n: number }} */ (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM hotel_requests WHERE listing_id = ? AND status = 'accepted'",
          )
          .get(r.listing_id)
      ).n;
      if (taken >= r.spots) throw new Error("No places left on this listing.");
      if (taken + 1 >= r.spots) {
        db.prepare("UPDATE hotel_listings SET status = 'closed' WHERE id = ?").run(r.listing_id);
      }
    }
    db.prepare("UPDATE hotel_requests SET status = ?, decided_at = ? WHERE id = ?").run(
      decision,
      Date.now(),
      requestId,
    );
    audit({ actorId: posterId, action: `hotel.${decision}`, detail: `request ${requestId}` });
    return r.listing_id;
  });
}

/** @param {number} requestId @param {number} requesterId */
export function withdrawRequest(requestId, requesterId) {
  return (
    db
      .prepare(
        "UPDATE hotel_requests SET status = 'withdrawn', decided_at = ? WHERE id = ? AND requester_id = ? AND status IN ('pending','accepted')",
      )
      .run(Date.now(), requestId, requesterId).changes > 0
  );
}

/** @param {number} listingId @param {number} posterId */
export function closeListing(listingId, posterId) {
  return (
    db
      .prepare("UPDATE hotel_listings SET status = 'closed' WHERE id = ? AND user_id = ?")
      .run(listingId, posterId).changes > 0
  );
}

/**
 * @typedef {{ id: number, requester_id: number, name: string | null, message: string | null,
 *   status: string, contact: string | null }} HotelRequestRow
 */

/**
 * Requests on a listing as the poster sees them; contacts only for accepted.
 * @param {number} listingId @param {number} posterId
 */
export function requestsFor(listingId, posterId) {
  return /** @type {HotelRequestRow[]} */ (
    db
      .prepare(
        `SELECT q.id, q.requester_id, u.display_name AS name, q.message, q.status,
                CASE WHEN q.status = 'accepted' THEN COALESCE(u.contact_method, u.email) END AS contact
           FROM hotel_requests q JOIN hotel_listings h ON h.id = q.listing_id
           JOIN users u ON u.id = q.requester_id
          WHERE q.listing_id = ? AND h.user_id = ? ORDER BY q.created_at`,
      )
      .all(listingId, posterId)
  ).filter((q) => !hiddenFrom(posterId, q.requester_id));
}

/**
 * The viewer's own request on a listing, with the poster's contact once accepted.
 * @param {number} listingId @param {number} viewerId
 */
export function myRequest(listingId, viewerId) {
  return /** @type {{ id: number, status: string, contact: string | null } | undefined} */ (
    db
      .prepare(
        `SELECT q.id, q.status,
                CASE WHEN q.status = 'accepted' THEN COALESCE(u.contact_method, u.email) END AS contact
           FROM hotel_requests q JOIN hotel_listings h ON h.id = q.listing_id
           JOIN users u ON u.id = h.user_id
          WHERE q.listing_id = ? AND q.requester_id = ?`,
      )
      .get(listingId, viewerId)
  );
}
