// @ts-check
/**
 * Full attendee journey, end to end: sign in via a real magic link, post a
 * ride, have it show up on /rides and /map, get claimed, and get accepted —
 * then confirm the match shows up in the admin funnel.
 *
 * The only thing stubbed is the outbound email network call (no real mail
 * provider in CI); everything else — token generation/hashing, the HTTP
 * routes, the DB writes — runs for real against an in-process server.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("full flow: sign in -> post ride -> claim -> accept", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {any} */
  let db;
  const originalFetch = globalThis.fetch;
  /** @type {string[]} */
  const capturedLinks = [];

  before(async () => {
    globalThis.fetch = async (url, init) => {
      if (String(url) === "https://api.resend.com/emails") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const match = /(https?:\/\/[^\s<"]+\/auth\/callback\?token=[^\s<"]+)/.exec(body.text);
        if (match) capturedLinks.push(match[1]);
        return new Response("{}", { status: 200 });
      }
      return originalFetch(url, init);
    };

    srv = await startTestServer({
      RESEND_API_KEY: "test_resend_key",
      ADMIN_EMAILS: "admin@example.test",
    });
    ({ db } = await srv.mod("lib/db.js"));
    const { appendAllowlist } = await srv.mod("lib/allowlist.js");
    appendAllowlist(["poster@example.test", "claimer@example.test", "admin@example.test"], {
      actorId: null,
      actorEmail: null,
      ip: "1.1.1.1",
    });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await srv.close();
  });

  /** @param {string} email */
  async function signIn(email) {
    capturedLinks.length = 0;
    const sendRes = await srv.fetch("/auth/send", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email }).toString(),
    });
    assert.equal(sendRes.status, 303);
    // startMagicLink is fire-and-forget from the route handler; give it a
    // moment to land before asserting on the captured link.
    for (let i = 0; i < 50 && capturedLinks.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(capturedLinks.length, 1, `expected one captured magic link for ${email}`);
    const token = new URL(capturedLinks[0]).searchParams.get("token");
    const cbRes = await srv.fetch(`/auth/callback?token=${encodeURIComponent(token ?? "")}`);
    assert.equal(cbRes.status, 303);
    const setCookie = cbRes.headers.getSetCookie().find((c) => c.startsWith("rs_session="));
    assert.ok(setCookie, "expected a session cookie to be set");
    return /** @type {string} */ (setCookie).split(";")[0];
  }

  /** @param {string} email */
  function directAdminSession(email) {
    const now = Date.now();
    db.prepare("INSERT INTO users (email, created_at, last_seen_at) VALUES (?, ?, ?)").run(
      email,
      now,
      now,
    );
    const uid = db.prepare("SELECT id FROM users WHERE email = ?").get(email).id;
    const sid = db.prepare("SELECT hex(randomblob(32)) AS t").get().t;
    db.prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
    ).run(sid, uid, now, now + 86_400_000, "test");
    return `rs_session=${sid}`;
  }

  let posterCookie = "";
  let claimerCookie = "";
  let rideId = 0;
  let claimId = 0;

  it("signs in the poster via a real magic link", async () => {
    posterCookie = await signIn("poster@example.test");
  });

  it("signs in the claimer via a real magic link", async () => {
    claimerCookie = await signIn("claimer@example.test");
  });

  it("lets the signed-in poster post a ride", async () => {
    const res = await srv.fetch("/rides/new", {
      method: "POST",
      headers: { cookie: posterCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        kind: "offer",
        direction: "to_venue",
        airport: "SFO",
        depart_date: "2026-01-02",
        depart_time: "14:00",
        seats: "2",
      }).toString(),
    });
    assert.equal(res.status, 303);
    rideId = Number((res.headers.get("location") || "").split("/").pop());
    assert.ok(rideId > 0, `expected a ride id in the redirect location`);
  });

  it("shows the ride on the browse page to another signed-in attendee", async () => {
    const body = await (await srv.fetch("/rides", { headers: { cookie: claimerCookie } })).text();
    assert.match(body, /SFO/);
  });

  it("shows the ride as a pin on the map", async () => {
    const body = await (await srv.fetch("/map", { headers: { cookie: claimerCookie } })).text();
    assert.match(body, /1 ride pin/);
  });

  it("lets the claimer claim the ride", async () => {
    const res = await srv.fetch(`/rides/${rideId}/claim`, {
      method: "POST",
      headers: { cookie: claimerCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ seats: "1" }).toString(),
    });
    assert.equal(res.status, 303);
    const row = db.prepare("SELECT id, status FROM claims WHERE ride_id = ?").get(rideId);
    assert.ok(row, "expected a claim row to exist");
    assert.equal(row.status, "pending");
    claimId = row.id;
  });

  it("lets the poster accept the claim, completing the match", async () => {
    const res = await srv.fetch(`/claims/${claimId}/accept`, {
      method: "POST",
      headers: { cookie: posterCookie, "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(res.status, 303);
    const row = db.prepare("SELECT status FROM claims WHERE id = ?").get(claimId);
    assert.equal(row.status, "accepted");
  });

  it("reflects the completed match in the admin funnel", async () => {
    const adminCookie = directAdminSession("admin@example.test");
    const body = await (await srv.fetch("/admin", { headers: { cookie: adminCookie } })).text();
    assert.equal(body.includes('<div class="stat-value">1</div>'), true, "expected 1 poster");
    assert.equal(body.includes('<div class="stat-value">2</div>'), true, "expected 2 matched");
  });
});
