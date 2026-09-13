// @ts-check
/**
 * Signed double-submit CSRF on the admin POST routes.
 *
 * Forms under /admin carry a `_csrf` hidden field holding the `rs_csrf` cookie
 * nonce plus an HMAC binding it to the session. POST routes outside /admin
 * (sign-out, ride confirmation) deliberately carry no token, so this also pins
 * that they keep working.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("admin CSRF", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {any} */
  let db;
  let sessionId = "";
  let sessionCookie = "";
  let cookieToken = "";
  let fieldToken = "";

  before(async () => {
    srv = await startTestServer({ ADMIN_EMAILS: "admin@example.test" });
    ({ db } = await srv.mod("lib/db.js"));
    const { randomToken } = await srv.mod("lib/crypto.js");
    const { appendAllowlist } = await srv.mod("lib/allowlist.js");

    appendAllowlist(["admin@example.test"], { actorId: null, actorEmail: null, ip: "1.1.1.1" });
    const now = Date.now();
    db.prepare("INSERT INTO users (email, created_at, last_seen_at) VALUES (?, ?, ?)").run(
      "admin@example.test",
      now,
      now,
    );
    const uid = db.prepare("SELECT id FROM users WHERE email = ?").get("admin@example.test").id;
    const sid = randomToken(32);
    db.prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
    ).run(sid, uid, now, now + 86_400_000, "test");
    sessionId = sid;
    sessionCookie = `rs_session=${sid}`;

    const page = await srv.fetch("/admin/allowlist", { headers: { cookie: sessionCookie } });
    const body = await page.text();
    fieldToken = body.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
    const setCookie = page.headers.getSetCookie().find((c) => c.startsWith("rs_csrf=")) ?? "";
    cookieToken = setCookie.match(/rs_csrf=([^;]+)/)?.[1] ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
  });

  after(async () => {
    await srv.close();
  });

  /**
   * @param {string} path
   * @param {Record<string,string>} params
   * @param {string} [cookie]
   */
  const post = (path, params, cookie = `${sessionCookie}; rs_csrf=${cookieToken}`) =>
    srv.fetch(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });

  it("renders a token that carries the cookie nonce plus a binding signature", () => {
    // Plain double-submit would make these equal. The field is `<nonce>.<sig>`,
    // so an attacker who can write the cookie still cannot produce the field.
    assert.notEqual(fieldToken, cookieToken);
    const cut = fieldToken.lastIndexOf(".");
    assert.ok(cut > 0, `no signature separator in ${fieldToken}`);
    assert.equal(fieldToken.slice(0, cut), cookieToken);
    // Structure checked by decoding, not by pattern: 32 random bytes and a
    // SHA-256 HMAC, each of which round-trips through its own encoding.
    assert.equal(Buffer.from(cookieToken, "base64url").length, 32);
    const sig = fieldToken.slice(cut + 1);
    const sigBytes = Buffer.from(sig, "hex");
    assert.equal(sigBytes.length, 32);
    assert.equal(sigBytes.toString("hex"), sig);
  });

  it("rejects an injected cookie nonce the attacker chose", async () => {
    // The sibling-subdomain vector: an attacker who can set `rs_csrf` for the
    // parent domain controls the nonce, but cannot sign it.
    const { randomToken } = await srv.mod("lib/crypto.js");
    const injected = randomToken(32);
    const r = await post(
      "/admin/allowlist/check",
      { email: "a@b.test", _csrf: `${injected}.${"0".repeat(64)}` },
      `${sessionCookie}; rs_csrf=${injected}`,
    );
    assert.equal(r.status, 403);
  });

  it("rejects a valid token replayed into a different session", async () => {
    const { randomToken } = await srv.mod("lib/crypto.js");
    const uid = db.prepare("SELECT user_id AS u FROM sessions WHERE id = ?").get(sessionId).u;
    const other = randomToken(32);
    const now = Date.now();
    db.prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
    ).run(other, uid, now, now + 86_400_000, "test");
    const r = await post(
      "/admin/allowlist/check",
      { email: "admin@example.test", _csrf: fieldToken },
      `rs_session=${other}; rs_csrf=${cookieToken}`,
    );
    assert.equal(r.status, 403);
  });

  it("tokenises every /admin form on every page reachable from the dashboard", async () => {
    // A meetup row makes the per-row delete form render; it is generated inside
    // a .map() and so is the easiest tokenised form to miss.
    db.prepare(
      "INSERT INTO meetups (name, address, lat, lng, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("Hotel Avante", null, 37.4, -122.1, Date.now());

    // Crawl the dashboard's subnav rather than hardcoding paths, so a new admin
    // page cannot be added without this test reaching it.
    const dash = await (await srv.fetch("/admin", { headers: { cookie: sessionCookie } })).text();
    const links = [...dash.matchAll(/<a href="(\/admin[^"]*)"/g)].map((m) => m[1]);
    const pages = [...new Set(["/admin", ...links])].filter((p) => !p.endsWith(".csv"));
    assert.ok(pages.length >= 5, `only found ${pages.length} admin pages: ${pages.join(", ")}`);

    for (const path of pages) {
      const body = await (await srv.fetch(path, { headers: { cookie: sessionCookie } })).text();
      const forms = (body.match(/<form method="post" action="\/admin[^"]*"/g) || []).length;
      const tokens = (body.match(/name="_csrf"/g) || []).length;
      assert.equal(tokens, forms, `${path}: ${forms} admin form(s) but ${tokens} token(s)`);
    }
  });

  it("accepts a matching token", async () => {
    const r = await post("/admin/allowlist/check", {
      email: "admin@example.test",
      _csrf: fieldToken,
    });
    assert.equal(r.status, 200);
  });

  it("rejects a missing token", async () => {
    assert.equal((await post("/admin/allowlist/check", { email: "a@b.test" })).status, 403);
  });

  it("rejects a token that does not match the cookie", async () => {
    const { randomToken } = await srv.mod("lib/crypto.js");
    const r = await post("/admin/allowlist/check", { email: "a@b.test", _csrf: randomToken(32) });
    assert.equal(r.status, 403);
  });

  it("rejects a request with no rs_csrf cookie", async () => {
    const r = await post(
      "/admin/allowlist/check",
      { email: "a@b.test", _csrf: fieldToken },
      sessionCookie,
    );
    assert.equal(r.status, 403);
  });

  it("rejects a multibyte token of the same JS length without crashing", async () => {
    // 43 chars but 86 bytes. safeEqual compares encoded buffers, so this is a
    // plain length mismatch; comparing String.length instead would hand
    // timingSafeEqual two different buffer sizes and raise a RangeError,
    // surfacing as a 500 rather than a 403.
    const r = await post("/admin/allowlist/check", { email: "a@b.test", _csrf: "é".repeat(43) });
    assert.equal(r.status, 403);
  });

  it("blocks the destructive routes and leaves state untouched", async () => {
    const before = db.prepare("SELECT count(*) c FROM allowlist_hashes").get().c;
    assert.equal((await post("/admin/allowlist/wipe", {})).status, 403);
    assert.equal(db.prepare("SELECT count(*) c FROM allowlist_hashes").get().c, before);

    assert.equal((await post("/admin/meetups", { name: "X", lat: "1", lng: "1" })).status, 403);
    assert.equal(db.prepare("SELECT count(*) c FROM meetups").get().c, 1); // only the seeded row
  });

  it("leaves non-admin POST routes unprotected", async () => {
    const r = await srv.fetch("/auth/signout", {
      method: "POST",
      headers: { cookie: sessionCookie },
    });
    assert.ok(r.status < 400, `sign-out returned ${r.status}`);
  });
});
