// @ts-check
/**
 * Hotel room sharing: hidden unless the event turns it on; the hotel name and
 * contacts appear only after the poster accepts; a listing takes no more
 * people than it has places; nothing reaches the shared map.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("hotel room sharing", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {Record<string, { id: number, cookie: string }>} */
  const who = {};
  let listingId = 0;

  before(async () => {
    srv = await startTestServer({ EVENT_CONFIG: "event.config.demo.yaml" });
    const { db } = await srv.mod("lib/db.js");
    const { createSession } = await srv.mod("lib/auth.js");
    for (const name of ["host", "ana", "ben"]) {
      const r = db
        .prepare(
          "INSERT INTO users (email, display_name, contact_method, created_at, last_seen_at) VALUES (?, ?, ?, 0, 0)",
        )
        .run(`${name}@example.test`, `${name}-name`, `Signal: ${name}-handle`);
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
  const page = async (cookie, path) => (await srv.fetch(path, { headers: { cookie } })).text();

  it("keeps the hotel and contacts hidden until the poster accepts", async () => {
    const res = await post(who.host.cookie, "/hotels", {
      kind: "room",
      area: "Near the venue",
      check_in: "2026-10-23",
      check_out: "2026-10-25",
      spots: "1",
      price_each: "90",
      prefs: "two beds",
      hotel_name: "Secret Plaza Hotel",
    });
    assert.equal(res.status, 303);
    listingId = Number((res.headers.get("location") || "").split("/").pop());
    const list = await page(who.ana.cookie, "/hotels");
    assert.match(list, /Near the venue/);
    assert.doesNotMatch(list, /Secret Plaza/);
    await post(who.ana.cookie, `/hotels/${listingId}/request`, { message: "quiet roommate" });
    await post(who.ben.cookie, `/hotels/${listingId}/request`, { message: "me too" });
    const before = await page(who.ana.cookie, `/hotels/${listingId}`);
    assert.doesNotMatch(before, /Secret Plaza|host-handle/);
    const hostView = await page(who.host.cookie, `/hotels/${listingId}`);
    assert.doesNotMatch(hostView, /ana-handle/, "no contact before accept");

    const { db } = await srv.mod("lib/db.js");
    const anaReq = db
      .prepare("SELECT id FROM hotel_requests WHERE requester_id = ?")
      .get(who.ana.id).id;
    const benReq = db
      .prepare("SELECT id FROM hotel_requests WHERE requester_id = ?")
      .get(who.ben.id).id;
    assert.equal(
      (await post(who.ana.cookie, `/hotel-requests/${anaReq}/accept`)).status,
      400,
      "only the poster accepts",
    );
    assert.equal((await post(who.host.cookie, `/hotel-requests/${anaReq}/accept`)).status, 303);
    const after = await page(who.ana.cookie, `/hotels/${listingId}`);
    assert.match(after, /Secret Plaza Hotel/);
    assert.match(after, /host-handle/);
    assert.match(await page(who.host.cookie, `/hotels/${listingId}`), /ana-handle/);
    assert.doesNotMatch(await page(who.ben.cookie, `/hotels/${listingId}`), /Secret Plaza/);

    // One place: the listing is now closed and a second accept fails.
    assert.equal(
      db.prepare("SELECT status FROM hotel_listings WHERE id = ?").get(listingId).status,
      "closed",
    );
    assert.equal((await post(who.host.cookie, `/hotel-requests/${benReq}/accept`)).status, 400);
  });

  it("never puts hotels on the shared map", async () => {
    const data = await (
      await srv.fetch("/map/data.json", { headers: { cookie: who.ben.cookie } })
    ).text();
    assert.doesNotMatch(data, /Near the venue|Secret Plaza/);
  });
});
