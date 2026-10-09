// @ts-check
/**
 * Live demo isolation: sign-in is open to anyone, so nothing one visitor
 * writes or is may reach another visitor. Visitors see synthetic attendees and
 * themselves only.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { withCookies } from "../helpers/cookies.js";
import { startTestServer } from "../helpers/server.js";

const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("live demo isolation", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  before(async () => {
    srv = await startTestServer({ DEMO_MODE: "true", EVENT_CONFIG: "event.config.demo.yaml" });
    (await srv.mod("lib/demo.js")).ensureDemoSeeded();
  });
  after(async () => {
    await srv.close();
  });

  async function visitor() {
    const client = withCookies(srv.fetch);
    await client.fetch("/demo/signin", {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ email: "attendee@demo.test" }).toString(),
    });
    // List yourself, so the only thing keeping you hidden is the demo rule.
    await client.fetch("/me", {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({
        display_name: `Visitor ${Math.random()}`,
        listed: "1",
      }).toString(),
    });
    return client;
  }

  it("shows synthetic attendees but never another visitor", async () => {
    const a = await visitor();
    const b = await visitor();
    const { db } = await srv.mod("lib/db.js");
    const aName = db
      .prepare(
        "SELECT display_name FROM users WHERE email LIKE '%@visitors.demo.test' ORDER BY id LIMIT 1",
      )
      .get().display_name;
    const page = await (await b.fetch("/people")).text();
    assert.match(page, /class="person-card"/, "synthetic attendees are listed");
    assert.ok(!page.includes(aName), "visitor B never sees visitor A");
    const aId = db.prepare("SELECT id FROM users WHERE display_name = ?").get(aName).id;
    assert.equal((await b.fetch(`/people/${aId}`)).status, 404);
    assert.equal((await a.fetch(`/people/${aId}`)).status, 200, "you can see yourself");
  });

  it("hides one visitor's rides and group membership from another", async () => {
    const a = await visitor();
    const b = await visitor();
    const { db } = await srv.mod("lib/db.js");
    const ids = db
      .prepare(
        "SELECT id FROM users WHERE email LIKE '%@visitors.demo.test' ORDER BY id DESC LIMIT 2",
      )
      .all()
      .map((r) => r.id);
    const [bId, aId] = ids;
    const { createRide, createClaim } = await srv.mod("lib/rides.js");
    const ride = createRide({
      userId: aId,
      kind: "offer",
      direction: "to_venue",
      airport: "SFO",
      otherPlace: null,
      departDate: "2026-10-23",
      departTime: "09:00",
      flexMinutes: 0,
      seats: 3,
      notes: "visitor A ride",
    });
    assert.doesNotMatch(await (await b.fetch("/rides")).text(), /visitor A ride/);
    assert.ok(!(await (await b.fetch("/map/data.json")).json()).rides.some((r) => r.id === ride));
    assert.equal((await b.fetch(`/rides/${ride}`)).status, 404);
    assert.equal(
      (await b.fetch(`/rides/${ride}/claim`, { method: "POST", headers: FORM, body: "seats=1" }))
        .status,
      404,
    );
    assert.equal((await a.fetch(`/rides/${ride}`)).status, 200);
    // Both join the same synthetic group: neither appears to the other.
    const ghostGroup = db
      .prepare(
        `SELECT r.id FROM rides r JOIN users u ON u.id = r.user_id
          WHERE u.email LIKE '%@ghost.demo.test' AND r.status = 'open' AND r.seats >= 3 LIMIT 1`,
      )
      .get().id;
    db.prepare("UPDATE rides SET mode = 'taxi' WHERE id = ?").run(ghostGroup);
    createClaim({ rideId: ghostGroup, claimerId: aId, seats: 1, message: null });
    createClaim({ rideId: ghostGroup, claimerId: bId, seats: 1, message: null });
    const aName = db.prepare("SELECT display_name FROM users WHERE id = ?").get(aId).display_name;
    const page = await (await b.fetch(`/rides/${ghostGroup}`)).text();
    assert.match(page, /Who.+s going/);
    assert.ok(!page.includes(aName), "visitor B never sees visitor A in a shared group");
  });
});
