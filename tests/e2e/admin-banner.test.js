// @ts-check
/**
 * /admin/banner: set/clear the site-wide operator banner and confirm it
 * actually renders on an attendee-facing page, not just the admin form.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("admin banner", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {any} */
  let db;
  let adminCookie = "";
  let csrfCookie = "";
  let csrfField = "";

  before(async () => {
    srv = await startTestServer({ ADMIN_EMAILS: "admin@example.test" });
    ({ db } = await srv.mod("lib/db.js"));
    const { appendAllowlist } = await srv.mod("lib/allowlist.js");
    appendAllowlist(["admin@example.test"], { actorId: null, actorEmail: null, ip: "1.1.1.1" });

    const now = Date.now();
    db.prepare("INSERT INTO users (email, created_at, last_seen_at) VALUES (?, ?, ?)").run(
      "admin@example.test",
      now,
      now,
    );
    const uid = db.prepare("SELECT id FROM users WHERE email = ?").get("admin@example.test").id;
    const sid = db.prepare("SELECT hex(randomblob(32)) AS t").get().t;
    db.prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
    ).run(sid, uid, now, now + 86_400_000, "test");
    adminCookie = `rs_session=${sid}`;

    const page = await srv.fetch("/admin/banner", { headers: { cookie: adminCookie } });
    csrfField = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
    csrfCookie = (page.headers.getSetCookie().find((c) => c.startsWith("rs_csrf=")) ?? "").split(
      ";",
    )[0];
  });

  after(async () => {
    await srv.close();
  });

  it("shows no banner anywhere before one is set", async () => {
    const body = await (await srv.fetch("/", { headers: { cookie: adminCookie } })).text();
    assert.doesNotMatch(body, /flash-warning|flash-info/);
  });

  it("lets an admin set a banner and shows it on an unrelated attendee page", async () => {
    const res = await srv.fetch("/admin/banner", {
      method: "POST",
      headers: {
        cookie: `${adminCookie}; ${csrfCookie}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        message: "Email delivery is delayed.",
        severity: "warning",
        _csrf: csrfField,
      }).toString(),
    });
    assert.equal(res.status, 303);

    const row = db.prepare("SELECT message, severity FROM site_banner WHERE id = 1").get();
    assert.equal(row.message, "Email delivery is delayed.");
    assert.equal(row.severity, "warning");

    const body = await (await srv.fetch("/rides", { headers: { cookie: adminCookie } })).text();
    assert.match(body, /flash-warning/);
    assert.match(body, /Email delivery is delayed\./);
  });

  it("logs the change to the audit log", () => {
    const row = db
      .prepare(
        "SELECT action, detail FROM audit_log WHERE action = 'banner.set' ORDER BY id DESC LIMIT 1",
      )
      .get();
    assert.ok(row, "expected a banner.set audit_log row");
    assert.equal(row.detail, "Email delivery is delayed.");
  });

  it("rejects a set attempt with no CSRF token", async () => {
    const res = await srv.fetch("/admin/banner", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message: "no token", severity: "info" }).toString(),
    });
    assert.equal(res.status, 403);
    const row = db.prepare("SELECT message FROM site_banner WHERE id = 1").get();
    assert.equal(row.message, "Email delivery is delayed.", "banner must be unchanged");
  });

  it("lets an admin clear the banner and it disappears from attendee pages", async () => {
    const res = await srv.fetch("/admin/banner/clear", {
      method: "POST",
      headers: {
        cookie: `${adminCookie}; ${csrfCookie}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrfField }).toString(),
    });
    assert.equal(res.status, 303);
    assert.equal(db.prepare("SELECT * FROM site_banner WHERE id = 1").get(), undefined);

    const body = await (await srv.fetch("/rides", { headers: { cookie: adminCookie } })).text();
    assert.doesNotMatch(body, /Email delivery is delayed\./);
  });
});
