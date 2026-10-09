// @ts-check
/**
 * DEMO_MODE is opt-in. Without it a deployment must expose no demo sign-in:
 * that route mints a session for anyone who asks.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("demo routes with DEMO_MODE unset", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;

  before(async () => {
    srv = await startTestServer();
  });
  after(async () => {
    await srv.close();
  });

  it("refuses demo sign-in and sets no session", async () => {
    const res = await srv.fetch("/demo/signin", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=attendee%40demo.test",
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("shows the email sign-in form, not demo accounts", async () => {
    const body = await (await srv.fetch("/")).text();
    assert.match(body, /action="\/auth\/send"/);
    assert.doesNotMatch(body, /demo\.test/);
  });
});
