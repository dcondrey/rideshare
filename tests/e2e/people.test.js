// @ts-check
/**
 * The attendee directory lists only people who opted in, never shows email or
 * contact method, and keeps profile links to http(s).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("attendee directory", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {Record<string, { id: number, cookie: string }>} */
  const who = {};

  before(async () => {
    srv = await startTestServer();
    const { db } = await srv.mod("lib/db.js");
    const { createSession } = await srv.mod("lib/auth.js");
    for (const [name, listed] of [
      ["listed", 1],
      ["hidden", 0],
      ["viewer", 0],
    ]) {
      const r = db
        .prepare(
          `INSERT INTO users (email, display_name, contact_method, bio, listed, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, 0, 0)`,
        )
        .run(
          `${name}@example.test`,
          `${name} Person`,
          `Signal: ${name}-secret`,
          `${name} bio`,
          listed,
        );
      const id = Number(r.lastInsertRowid);
      who[name] = { id, cookie: `rs_session=${createSession(id, "test")}` };
    }
  });
  after(async () => {
    await srv.close();
  });

  const get = (path, cookie) => srv.fetch(path, { headers: { cookie } });

  it("lists only opted-in attendees and never their email or contact", async () => {
    const page = await (await get("/people", who.viewer.cookie)).text();
    assert.match(page, /listed Person/);
    assert.doesNotMatch(page, /hidden Person|viewer Person/);
    assert.doesNotMatch(page, /example\.test|secret/);
    const search = await (await get("/people?q=nobody-like-this", who.viewer.cookie)).text();
    assert.doesNotMatch(search, /listed Person/);
  });

  it("shows a listed profile, hides an unlisted one, and keeps links to http(s)", async () => {
    assert.equal((await get(`/people/${who.listed.id}`, who.viewer.cookie)).status, 200);
    assert.equal((await get(`/people/${who.hidden.id}`, who.viewer.cookie)).status, 404);
    await srv.fetch("/me", {
      method: "POST",
      headers: { cookie: who.viewer.cookie, ...FORM },
      body: new URLSearchParams({ listed: "1", link: "javascript:alert(1)", bio: "hi" }).toString(),
    });
    const { db } = await srv.mod("lib/db.js");
    const row = db.prepare("SELECT listed, link FROM users WHERE id = ?").get(who.viewer.id);
    assert.equal(row.listed, 1);
    assert.equal(row.link, null);
  });
});
