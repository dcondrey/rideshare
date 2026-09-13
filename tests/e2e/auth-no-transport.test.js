// @ts-check
/**
 * Magic-link behavior when no email transport is configured (no
 * RESEND_API_KEY and no SMTP_HOST). This must fail loudly at the point of
 * send — not silently swallow the address, and not claim success to the
 * operator — while still giving the anti-enumeration response to the user.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("magic-link send with no email transport configured", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {any} */
  let db;

  before(async () => {
    // startTestServer's defaults carry no RESEND_API_KEY/SMTP_HOST already
    // (see tests/helpers/setup.js), so no override is needed to hit this path.
    srv = await startTestServer();
    ({ db } = await srv.mod("lib/db.js"));
    const { appendAllowlist } = await srv.mod("lib/allowlist.js");
    appendAllowlist(["attendee@example.test"], {
      actorId: null,
      actorEmail: null,
      ip: "1.1.1.1",
    });
  });

  after(async () => {
    await srv.close();
  });

  it("still gives the user the same anti-enumeration redirect", async () => {
    const res = await srv.fetch("/auth/send", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "attendee@example.test" }).toString(),
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/auth/check");
  });

  it("persisted the magic-link row before the send failure (the token issuance itself succeeded)", async () => {
    const row = db
      .prepare("SELECT email FROM magic_links WHERE email = ?")
      .get("attendee@example.test");
    assert.ok(row, "expected a magic_links row even though delivery failed");
  });

  it("rejects loudly when called directly, with a message an operator can act on", async () => {
    const { startMagicLink } = await srv.mod("lib/auth.js");
    await assert.rejects(
      () => startMagicLink("attendee@example.test", "1.1.1.1"),
      /No email transport configured/,
    );
  });
});
