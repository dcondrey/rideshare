// @ts-check
/**
 * Trip-safety links work without an account, show only the sharer's trip,
 * and stop working when revoked or expired. Ride features filter browse.
 * Estimates are sane.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("trip safety, features and estimates", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {Record<string, { id: number, cookie: string }>} */
  const who = {};
  /** @type {any} */
  let db;
  let rideId = 0;

  before(async () => {
    srv = await startTestServer();
    ({ db } = await srv.mod("lib/db.js"));
    const { createSession } = await srv.mod("lib/auth.js");
    const { createRide, createClaim, decideClaim, postRideUpdate } = await srv.mod("lib/rides.js");
    for (const name of ["driver", "rider", "stranger"]) {
      const r = db
        .prepare(
          "INSERT INTO users (email, display_name, contact_method, created_at, last_seen_at) VALUES (?, ?, ?, 0, 0)",
        )
        .run(`${name}@example.test`, `${name} Name`, `Signal: ${name}-handle`);
      const id = Number(r.lastInsertRowid);
      who[name] = { id, cookie: `rs_session=${createSession(id, "test")}` };
    }
    rideId = createRide({
      userId: who.driver.id,
      kind: "offer",
      direction: "to_venue",
      airport: "SFO",
      otherPlace: null,
      departDate: "2026-01-01",
      departTime: "10:00",
      flexMinutes: 0,
      seats: 2,
      notes: null,
      features: ["wheelchair", "big_luggage", "bogus"],
    });
    decideClaim(
      createClaim({ rideId, claimerId: who.rider.id, seats: 1, message: null }),
      who.driver.id,
      "accepted",
    );
    postRideUpdate({
      rideId,
      userId: who.rider.id,
      status: "late",
      minutes: 20,
      note: "Rider note",
    });
    postRideUpdate({
      rideId,
      userId: who.driver.id,
      status: "on_time",
      minutes: null,
      note: "Driver note",
    });
  });
  after(async () => {
    await srv.close();
  });

  /** @param {string} cookie */
  const share = async (cookie) => {
    const res = await srv.fetch(`/rides/${rideId}/share`, { method: "POST", headers: { cookie } });
    const page = await res.text();
    return {
      status: res.status,
      link: /value="(https?:\/\/[^"]+\/trip\/[^"]+)"/.exec(page)?.[1] ?? "",
    };
  };

  it("gives a working link that shows only the sharer's trip, to anyone with it", async () => {
    const { status, link } = await share(who.rider.cookie);
    assert.equal(status, 200);
    const path = new URL(link).pathname;
    const res = await srv.fetch(path); // no cookie
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /rider Name&#39;s trip|rider Name's trip/);
    assert.match(page, /Running late \(20 min\)/);
    assert.match(page, /Rider note/);
    assert.doesNotMatch(
      page,
      /Driver note|driver Name|handle|example\.test/,
      "no other people or contacts",
    );
    const stored = db.prepare("SELECT token_hash FROM trip_shares").all();
    assert.ok(
      stored.every((r) => !path.endsWith(r.token_hash)),
      "only a hash of the token is stored",
    );
  });

  it("refuses links for people not on the ride", async () => {
    assert.equal((await share(who.stranger.cookie)).status, 403);
  });

  it("stops working once revoked or expired", async () => {
    const a = new URL((await share(who.rider.cookie)).link).pathname;
    const b = new URL((await share(who.rider.cookie)).link).pathname;
    const [{ id }] = db
      .prepare("SELECT id FROM trip_shares ORDER BY id DESC LIMIT 1 OFFSET 1")
      .all();
    // Someone else can't revoke it.
    await srv.fetch(`/trip-shares/${id}/revoke`, {
      method: "POST",
      headers: { cookie: who.stranger.cookie },
    });
    assert.equal((await srv.fetch(a)).status, 200);
    await srv.fetch(`/trip-shares/${id}/revoke`, {
      method: "POST",
      headers: { cookie: who.rider.cookie },
    });
    assert.equal((await srv.fetch(a)).status, 404);
    db.prepare("UPDATE trip_shares SET expires_at = ? WHERE revoked_at IS NULL").run(
      Date.now() - 1,
    );
    assert.equal((await srv.fetch(b)).status, 404);
    assert.equal((await srv.fetch("/trip/not-a-real-token-at-all-xx")).status, 404);
  });

  it("stores known features only and filters browse by them", async () => {
    assert.equal(
      db.prepare("SELECT features FROM rides WHERE id = ?").get(rideId).features,
      "big_luggage,wheelchair",
    );
    const has = await (
      await srv.fetch("/rides?feature=wheelchair", { headers: { cookie: who.stranger.cookie } })
    ).text();
    const lacks = await (
      await srv.fetch("/rides?feature=child_seat", { headers: { cookie: who.stranger.cookie } })
    ).text();
    assert.match(has, new RegExp(`href="/rides/${rideId}"`));
    assert.doesNotMatch(lacks, new RegExp(`href="/rides/${rideId}"`));
  });

  it("estimates distance, cost split and CO2 sensibly", async () => {
    const { milesBetween, tripEstimate } = await srv.mod("lib/estimates.js");
    // SFO to SJC is about 30 miles as the crow flies.
    const d = milesBetween(37.6213, -122.379, 37.3639, -121.9289);
    assert.ok(d > 28 && d < 33, `got ${d}`);
    const car = tripEstimate({ airport: "SFO", kind: "offer", mode: "car" }, 3);
    assert.ok(car, "the test event has airport and venue coordinates");
    assert.equal(car.people, 3);
    assert.ok(car.co2SavedKg > 0 && car.costEach * 3 >= car.totalCost - 2);
    assert.equal(tripEstimate({ airport: "SFO", kind: "offer", mode: "car" }, 1).co2SavedKg, 0);
  });
});
