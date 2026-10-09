// @ts-check
/**
 * Meetings: pins and details reach only people invited; private notes are
 * readable by their author alone; you can only invite people you could
 * message.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("meetings", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {Record<string, { id: number, cookie: string }>} */
  const who = {};
  /** @type {any} */
  let db;
  let meetingId = 0;

  before(async () => {
    srv = await startTestServer();
    ({ db } = await srv.mod("lib/db.js"));
    const { createSession } = await srv.mod("lib/auth.js");
    for (const [name, listed] of [
      ["host", 1],
      ["guest", 1],
      ["outsider", 1],
      ["unlisted", 0],
    ]) {
      const r = db
        .prepare(
          "INSERT INTO users (email, display_name, listed, created_at, last_seen_at) VALUES (?, ?, ?, 0, 0)",
        )
        .run(`${name}@example.test`, `${name}-name`, listed);
      const id = Number(r.lastInsertRowid);
      who[name] = { id, cookie: `rs_session=${createSession(id, "test")}` };
    }
  });
  after(async () => {
    await srv.close();
  });

  /** @param {string} cookie @param {string} path @param {Record<string, string>} [body] */
  const post = (cookie, path, body = {}) =>
    srv.fetch(path, {
      method: "POST",
      headers: { cookie, ...FORM },
      body: new URLSearchParams(body).toString(),
      redirect: "manual",
    });
  const json = async (cookie, path) => (await srv.fetch(path, { headers: { cookie } })).json();

  it("creates a meeting at a picked spot and pins it only for the people on it", async () => {
    const res = await post(who.host.cookie, "/meetings", {
      title: "Wallet demo coffee",
      date: "2026-01-02",
      time: "10:30",
      place: "custom",
      place_name: "Gate B café",
      lat: "37.61",
      lng: "-122.38",
      [`invite_${who.guest.id}`]: "1",
    });
    assert.equal(res.status, 303);
    meetingId = Number((res.headers.get("location") || "").split("/").pop());
    assert.ok(meetingId > 0);
    assert.equal((await json(who.host.cookie, "/meetings/pins.json")).length, 1);
    assert.equal(
      (await json(who.guest.cookie, "/meetings/pins.json"))[0].title,
      "Wallet demo coffee",
    );
    assert.deepEqual(await json(who.outsider.cookie, "/meetings/pins.json"), []);
    const shared = await json(who.outsider.cookie, "/map/data.json");
    assert.doesNotMatch(JSON.stringify(shared), /Wallet demo coffee/);
    assert.equal(
      (await srv.fetch(`/meetings/${meetingId}`, { headers: { cookie: who.outsider.cookie } }))
        .status,
      404,
    );
  });

  it("keeps each person's notes to themselves", async () => {
    await post(who.host.cookie, `/meetings/${meetingId}/notes`, { body: "host private thought" });
    await post(who.guest.cookie, `/meetings/${meetingId}/notes`, { body: "guest private thought" });
    const hostPage = await (
      await srv.fetch(`/meetings/${meetingId}`, { headers: { cookie: who.host.cookie } })
    ).text();
    const guestPage = await (
      await srv.fetch(`/meetings/${meetingId}`, { headers: { cookie: who.guest.cookie } })
    ).text();
    assert.match(hostPage, /host private thought/);
    assert.doesNotMatch(hostPage, /guest private thought/);
    assert.match(guestPage, /guest private thought/);
    assert.doesNotMatch(guestPage, /host private thought/);
    assert.equal(
      (await post(who.outsider.cookie, `/meetings/${meetingId}/notes`, { body: "sneak" })).status,
      404,
    );
  });

  it("records answers and refuses invitations to people you can't message", async () => {
    assert.equal(
      (await post(who.guest.cookie, `/meetings/${meetingId}/respond`, { answer: "accepted" }))
        .status,
      303,
    );
    assert.equal(
      db
        .prepare("SELECT status FROM meeting_invites WHERE meeting_id = ? AND user_id = ?")
        .get(meetingId, who.guest.id).status,
      "accepted",
    );
    assert.equal(
      (await post(who.outsider.cookie, `/meetings/${meetingId}/respond`, { answer: "accepted" }))
        .status,
      404,
    );
    const bad = await post(who.host.cookie, "/meetings", {
      title: "x",
      date: "2026-01-02",
      time: "11:00",
      place: "custom",
      place_name: "y",
      lat: "1",
      lng: "1",
      [`invite_${who.unlisted.id}`]: "1",
    });
    assert.equal(bad.status, 400);
  });

  it("lets only the organizer cancel, and drops the pin when they do", async () => {
    await post(who.guest.cookie, `/meetings/${meetingId}/cancel`);
    assert.equal((await json(who.guest.cookie, "/meetings/pins.json")).length, 1);
    await post(who.host.cookie, `/meetings/${meetingId}/cancel`);
    assert.deepEqual(await json(who.guest.cookie, "/meetings/pins.json"), []);
  });
});
