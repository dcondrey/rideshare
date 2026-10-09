// @ts-check
/**
 * Groups (shared taxi / transit) join without approval up to their size;
 * trip status reaches only the people on the ride; the arrivals board shows
 * counts, never names.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("groups, trip status and the arrivals board", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {Record<string, { id: number, cookie: string }>} */
  const who = {};
  /** @type {any} */
  let rides;
  let groupId = 0;

  before(async () => {
    srv = await startTestServer();
    const { db } = await srv.mod("lib/db.js");
    const { createSession } = await srv.mod("lib/auth.js");
    rides = await srv.mod("lib/rides.js");
    for (const name of ["organizer", "ana", "ben", "cy", "stranger"]) {
      const r = db
        .prepare(
          "INSERT INTO users (email, display_name, created_at, last_seen_at) VALUES (?, ?, 0, 0)",
        )
        .run(`${name}@example.test`, `${name} Person`);
      const id = Number(r.lastInsertRowid);
      who[name] = { id, cookie: `rs_session=${createSession(id, "test")}` };
    }
    groupId = rides.createRide({
      userId: who.organizer.id,
      kind: "offer",
      direction: "to_venue",
      airport: "SFO",
      otherPlace: null,
      departDate: "2026-01-01",
      departTime: "14:20",
      flexMinutes: 0,
      seats: 2,
      notes: null,
      mode: "taxi",
    });
  });
  after(async () => {
    await srv.close();
  });

  const status = (id) => rides.getRide(id).status;

  it("lets people join a group without approval until it is full", () => {
    // Asking for more places than exist is refused outright.
    assert.throws(
      () => rides.createClaim({ rideId: groupId, claimerId: who.ana.id, seats: 3, message: null }),
      /only has 2 seats/,
    );
    // limit - 1: one place left, still open.
    rides.createClaim({ rideId: groupId, claimerId: who.ana.id, seats: 1, message: null });
    assert.equal(status(groupId), "open");
    // limit: the group fills and closes.
    rides.createClaim({ rideId: groupId, claimerId: who.ben.id, seats: 1, message: null });
    assert.equal(status(groupId), "full");
    const accepted = rides.claimsForRide(groupId).filter((c) => c.status === "accepted");
    assert.equal(accepted.length, 2);
    // limit + 1: nobody else gets in.
    assert.throws(
      () => rides.createClaim({ rideId: groupId, claimerId: who.cy.id, seats: 1, message: null }),
      /isn't open/,
    );
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
      stop: async () => {
        ac.abort();
        await done;
        return text;
      },
    };
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  /** @param {string} cookie @param {Record<string, string>} body */
  const postStatus = (cookie, body) =>
    srv.fetch(`/rides/${groupId}/status`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      redirect: "manual",
    });

  it("sends a trip status to the other people on the ride and nobody else", async () => {
    const organizer = listen(who.organizer.cookie);
    const ben = listen(who.ben.cookie);
    const ana = listen(who.ana.cookie);
    const stranger = listen(who.stranger.cookie);
    await pause(100);
    const res = await postStatus(who.ana.cookie, {
      status: "late",
      minutes: "25",
      note: "Flight held",
    });
    await pause(150);
    const [o, b, a, s] = await Promise.all([
      organizer.stop(),
      ben.stop(),
      ana.stop(),
      stranger.stop(),
    ]);
    assert.equal(res.status, 303);
    for (const text of [o, b]) {
      assert.match(
        text,
        /event: ride-status\ndata: .*"status":"late".*"text":"Running late \(25 min\)"/,
      );
    }
    assert.doesNotMatch(a, /ride-status/, "the sender is not told about their own update");
    assert.doesNotMatch(s, /ride-status/, "a stranger never sees it");
    const latest = rides.latestRideUpdates(groupId);
    assert.equal(latest[0].user_id, who.ana.id);
    assert.equal(latest[0].note, "Flight held");
  });

  it("refuses trip status from someone not on the ride, and bad input", async () => {
    assert.equal((await postStatus(who.stranger.cookie, { status: "late" })).status, 403);
    assert.equal((await postStatus(who.ana.cookie, { status: "teleported" })).status, 400);
    assert.equal(
      (await postStatus(who.ana.cookie, { status: "late", minutes: "9999" })).status,
      400,
    );
  });

  it("shows only the people on the ride the group's members and trip status", async () => {
    const page = await (
      await srv.fetch(`/rides/${groupId}`, { headers: { cookie: who.ben.cookie } })
    ).text();
    assert.match(page, /Who&#39;s going \(3\)|Who's going \(3\)/);
    assert.match(page, /Trip status/);
    const outside = await (
      await srv.fetch(`/rides/${groupId}`, { headers: { cookie: who.stranger.cookie } })
    ).text();
    assert.doesNotMatch(outside, /Trip status|Who.s going/);
    assert.doesNotMatch(outside, /Flight held/);
  });

  it("counts people on the arrivals board without naming anyone", async () => {
    const page = await (
      await srv.fetch("/arrivals", { headers: { cookie: who.stranger.cookie } })
    ).text();
    // Organizer + two members, one ride, one group, one late report.
    assert.match(
      page,
      /<td class="board-time">14:00<\/td>\s*<td>SFO<\/td>\s*<td class="board-num">3<\/td>/,
    );
    assert.match(page, /1 late/);
    assert.doesNotMatch(page, /Person|example\.test|Flight held/);
  });
});
