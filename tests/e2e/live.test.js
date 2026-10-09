// @ts-check
/**
 * Live location privacy: a shared position reaches the sharer and their ride
 * partners over /live/stream, and never reaches anyone else. Stopping removes
 * it for the partner too.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("live location channel", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {Record<string, { id: number, cookie: string }>} */
  const who = {};

  before(async () => {
    srv = await startTestServer();
    const { db } = await srv.mod("lib/db.js");
    const { createSession } = await srv.mod("lib/auth.js");
    const { createRide, createClaim, decideClaim } = await srv.mod("lib/rides.js");
    for (const name of ["driver", "rider", "stranger"]) {
      const r = db
        .prepare(
          "INSERT INTO users (email, display_name, created_at, last_seen_at) VALUES (?, ?, 0, 0)",
        )
        .run(`${name}@example.test`, name);
      const id = Number(r.lastInsertRowid);
      who[name] = { id, cookie: `rs_session=${createSession(id, "test")}` };
    }
    const ride = createRide({
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
    });
    decideClaim(
      createClaim({ rideId: ride, claimerId: who.rider.id, seats: 1, message: null }),
      who.driver.id,
      "accepted",
    );
  });
  after(async () => {
    await srv.close();
  });

  /** Open a stream and collect its text until `stop()` resolves it. */
  function listen(cookie) {
    const ac = new AbortController();
    let text = "";
    const done = srv
      .fetch("/live/stream", { headers: { cookie }, signal: ac.signal })
      .then(async (res) => {
        const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          text += dec.decode(value);
        }
      })
      .catch(() => {});
    return {
      text: () => text,
      stop: async () => {
        ac.abort();
        await done;
        return text;
      },
    };
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  /** @param {string} cookie @param {string} path @param {unknown} [body] */
  const post = (cookie, path, body) =>
    srv.fetch(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

  it("delivers a shared position to the partner and never to a stranger", async () => {
    const rider = listen(who.rider.cookie);
    const stranger = listen(who.stranger.cookie);
    await pause(100);
    const res = await post(who.driver.cookie, "/live/position", {
      lat: 37.6,
      lng: -122.3,
      accuracy: 12,
    });
    assert.equal(res.status, 200);
    await pause(150);
    await post(who.driver.cookie, "/live/stop");
    await pause(150);
    const riderText = await rider.stop();
    const strangerText = await stranger.stop();

    assert.match(riderText, new RegExp(`"userId":${who.driver.id},"name":"driver","lat":37.6`));
    assert.match(
      riderText,
      new RegExp(`"userId":${who.driver.id},"gone":true`),
      "stop reaches the partner",
    );
    assert.doesNotMatch(
      strangerText,
      new RegExp(`"userId":${who.driver.id}`),
      "a stranger never sees it",
    );
  });

  it("refuses unauthenticated streams and out-of-range points", async () => {
    assert.equal((await srv.fetch("/live/stream")).status, 401);
    assert.equal(
      (await post(who.driver.cookie, "/live/position", { lat: 91, lng: 0 })).status,
      400,
    );
    assert.equal((await post("rs_session=nope", "/live/position", { lat: 1, lng: 1 })).status, 401);
  });
});
