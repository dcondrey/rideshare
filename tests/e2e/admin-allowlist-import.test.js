// @ts-check
/**
 * POST /admin/allowlist with malformed, oversized, and duplicate-email CSV
 * input. lib/allowlist.js's parseAllowlistCsv already has unit coverage for
 * parsing edge cases; these tests exercise the full route — validation,
 * the 9MB body cap, and replace-vs-append dedup — which parsing alone can't.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("POST /admin/allowlist — malformed, huge, duplicate input", () => {
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

    const page = await srv.fetch("/admin/allowlist", { headers: { cookie: adminCookie } });
    csrfField = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
    csrfCookie = (page.headers.getSetCookie().find((c) => c.startsWith("rs_csrf=")) ?? "").split(
      ";",
    )[0];
    assert.ok(csrfField && csrfCookie, "expected to capture a CSRF token pair from the page");
  });

  after(async () => {
    await srv.close();
  });

  /** @param {{csv: string, mode?: string, confirm_shrink?: string}} params */
  const importCsv = ({ csv, mode = "replace", confirm_shrink = "" }) =>
    srv.fetch("/admin/allowlist", {
      method: "POST",
      headers: {
        cookie: `${adminCookie}; ${csrfCookie}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csv, mode, confirm_shrink, _csrf: csrfField }).toString(),
    });

  it("imports valid rows and skips malformed ones, reporting both counts", async () => {
    const csv = [
      "email",
      "alice@example.test",
      "not-an-email",
      "",
      "bob@example.test",
      "@example.test",
    ].join("\n");
    const res = await importCsv({ csv });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Imported 2 entries/);
    // Blank lines aren't counted as rows (see lib/allowlist.js), so the 5-line
    // body (4 data rows + 1 blank) parses as 4 rows, 2 skipped, 2 added.
    assert.match(body, /Parsed 4 rows · skipped 2 invalid · 2 added/);
  });

  it("rejects a CSV over the 9MB admin-field cap with a clean 400, without touching the allowlist", async () => {
    // Sized to land between the app-level 9MB validation cap (lib/validate.js
    // reqString) and the router's 10MB raw-body stream cap (lib/router.js) —
    // the body is fully received, so the rejection is a clean validation
    // error rather than a stream abort. A body past the 10MB stream cap is
    // not exercised here: the router destroys the socket mid-read for that
    // case, which races the client's own write and isn't a stable assertion
    // over HTTP (it surfaces as a 413 or a raw connection reset depending on
    // timing) — the server-side unit behavior for that cap is what matters,
    // not this route's response shape.
    const before = db.prepare("SELECT COUNT(*) c FROM allowlist_hashes").get().c;
    const overCap = `email\n${"x".repeat(9 * 1024 * 1024 + 1024)}@example.test\n`;
    const res = await importCsv({ csv: overCap, mode: "append" });
    assert.equal(res.status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM allowlist_hashes").get().c, before);
  });

  it("append mode re-importing the same addresses adds zero new entries", async () => {
    const before = db.prepare("SELECT COUNT(*) c FROM allowlist_hashes").get().c;
    const csv = ["email", "alice@example.test", "bob@example.test"].join("\n");
    const res = await importCsv({ csv, mode: "append" });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Imported 0 new entries/);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM allowlist_hashes").get().c, before);
  });

  it("append mode deduplicates addresses that differ only by gmail +tag/dots within one file", async () => {
    const csv = ["email", "carol+conf@gmail.com", "c.a.r.o.l@gmail.com", "CAROL@gmail.com"].join(
      "\n",
    );
    const res = await importCsv({ csv, mode: "append" });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Parsed 3 rows · skipped 0 invalid · 1 added/);
  });

  it("refuses an unconfirmed replace that would drop most of the allowlist", async () => {
    const countBefore = db.prepare("SELECT COUNT(*) c FROM allowlist_hashes").get().c;
    assert.ok(countBefore > 1, "expected prior entries from earlier tests in this file");
    const res = await importCsv({ csv: "email\nsolo@example.test", mode: "replace" });
    assert.equal(res.status, 400);
    assert.equal(
      db.prepare("SELECT COUNT(*) c FROM allowlist_hashes").get().c,
      countBefore,
      "a refused replace must leave the allowlist exactly as it was",
    );
  });

  it("replace mode wipes prior entries before importing the new set", async () => {
    const countBefore = db.prepare("SELECT COUNT(*) c FROM allowlist_hashes").get().c;
    assert.ok(countBefore > 1, "expected prior entries from earlier tests in this file");
    const res = await importCsv({
      csv: "email\nsolo@example.test",
      mode: "replace",
      confirm_shrink: "1",
    });
    assert.equal(res.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM allowlist_hashes").get().c, 1);
  });
});
