// @ts-check
/**
 * Unit tests for the seat-capacity invariant in lib/rides.js.
 *
 * The invariant: the seats of a ride's accepted claims never exceed the ride's
 * own seat count. Nothing outside decideClaim enforces it — several riders may
 * hold pending claims on one ride, and /rides/:id/full is a manual action — so
 * these drive the accept path directly rather than a route.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { setupTestEnv } from "../helpers/env.js";

setupTestEnv();

import { db } from "../../lib/db.js";
import { createClaim, createRide, decideClaim } from "../../lib/rides.js";

let nextEmail = 0;

/** @returns {number} a fresh user id */
function makeUser() {
  nextEmail++;
  const now = Date.now();
  const r = db
    .prepare(
      "INSERT INTO users (email, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
    )
    .run(`rider${nextEmail}@example.com`, `Rider ${nextEmail}`, now, now);
  return Number(r.lastInsertRowid);
}

/**
 * @param {number} posterId
 * @param {number} seats
 * @returns {number} ride id
 */
function makeRide(posterId, seats) {
  return createRide({
    userId: posterId,
    kind: "offer",
    direction: "to_venue",
    airport: "SFO",
    otherPlace: null,
    departDate: "2026-08-07",
    departTime: "09:00",
    flexMinutes: 30,
    seats,
    notes: null,
  });
}

describe("ride capacity — accepted seats never exceed the ride's seats", () => {
  beforeEach(() => {
    db.exec("DELETE FROM claims; DELETE FROM rides; DELETE FROM users;");
    nextEmail = 0;
  });

  it("refuses a second accept on a one-seat ride", () => {
    const poster = makeUser();
    const ride = makeRide(poster, 1);
    const first = createClaim({ rideId: ride, claimerId: makeUser(), seats: 1, message: null });
    const second = createClaim({ rideId: ride, claimerId: makeUser(), seats: 1, message: null });

    decideClaim(first, poster, "accepted");
    assert.throws(
      () => decideClaim(second, poster, "accepted"),
      /Only 0 seats left/,
      "the second rider must not also get the only seat",
    );

    const accepted = /** @type {{ n: number }} */ (
      db
        .prepare("SELECT COALESCE(SUM(seats),0) AS n FROM claims WHERE ride_id = ? AND status = ?")
        .get(ride, "accepted")
    ).n;
    assert.equal(accepted, 1);
  });

  it("closes the ride once the last seat is taken, so no new claim can be made", () => {
    const poster = makeUser();
    const ride = makeRide(poster, 2);
    const claim = createClaim({ rideId: ride, claimerId: makeUser(), seats: 2, message: null });
    decideClaim(claim, poster, "accepted");

    const status = /** @type {{ status: string }} */ (
      db.prepare("SELECT status FROM rides WHERE id = ?").get(ride)
    ).status;
    assert.equal(status, "full");
    assert.throws(
      () => createClaim({ rideId: ride, claimerId: makeUser(), seats: 1, message: null }),
      /isn't open/,
    );
  });

  it("accepts claims that exactly fill the ride, one at a time", () => {
    const poster = makeUser();
    const ride = makeRide(poster, 3);
    const a = createClaim({ rideId: ride, claimerId: makeUser(), seats: 2, message: null });
    const b = createClaim({ rideId: ride, claimerId: makeUser(), seats: 1, message: null });
    decideClaim(a, poster, "accepted");
    decideClaim(b, poster, "accepted");
    const accepted = /** @type {{ n: number }} */ (
      db
        .prepare("SELECT COALESCE(SUM(seats),0) AS n FROM claims WHERE ride_id = ? AND status = ?")
        .get(ride, "accepted")
    ).n;
    assert.equal(accepted, 3);
  });

  it("refuses a claim for more seats than the ride offers", () => {
    const poster = makeUser();
    const ride = makeRide(poster, 1);
    assert.throws(
      () => createClaim({ rideId: ride, claimerId: makeUser(), seats: 8, message: null }),
      /only has 1 seat/,
      "a direct POST must not book 8 seats on a 1-seat ride",
    );
  });

  it("declining does not consume capacity", () => {
    const poster = makeUser();
    const ride = makeRide(poster, 1);
    const a = createClaim({ rideId: ride, claimerId: makeUser(), seats: 1, message: null });
    const b = createClaim({ rideId: ride, claimerId: makeUser(), seats: 1, message: null });
    decideClaim(a, poster, "declined");
    decideClaim(b, poster, "accepted");
    const status = /** @type {{ status: string }} */ (
      db.prepare("SELECT status FROM rides WHERE id = ?").get(ride)
    ).status;
    assert.equal(status, "full");
  });
});
