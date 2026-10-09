// @ts-check
/** Hotel room sharing is off unless the event config turns it on. */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("hotel room sharing switched off", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  before(async () => {
    srv = await startTestServer();
  });
  after(async () => {
    await srv.close();
  });
  it("404s every hotel page", async () => {
    const { db } = await srv.mod("lib/db.js");
    const { createSession } = await srv.mod("lib/auth.js");
    const id = Number(
      db
        .prepare(
          "INSERT INTO users (email, created_at, last_seen_at) VALUES ('x@example.test', 0, 0)",
        )
        .run().lastInsertRowid,
    );
    const cookie = `rs_session=${createSession(id, "test")}`;
    assert.equal((await srv.fetch("/hotels", { headers: { cookie } })).status, 404);
    assert.equal((await srv.fetch("/hotels/new", { headers: { cookie } })).status, 404);
  });
});
