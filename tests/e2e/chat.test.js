// @ts-check
/**
 * Chat invariants: a direct message reaches only its recipient; blocking stops
 * messages both ways; people can't be messaged out of the blue unless they're
 * listed; muted users can't post; reports reach organizers, who can remove a
 * message; organizer tools refuse everyone else.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("chat and direct messages", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {Record<string, { id: number, cookie: string }>} */
  const who = {};
  /** @type {any} */
  let db;

  before(async () => {
    srv = await startTestServer({ ADMIN_EMAILS: "admin@example.test" });
    ({ db } = await srv.mod("lib/db.js"));
    const { createSession } = await srv.mod("lib/auth.js");
    for (const [name, listed] of [
      ["ann", 1],
      ["bob", 1],
      ["eve", 0],
      ["admin", 0],
    ]) {
      const r = db
        .prepare(
          "INSERT INTO users (email, display_name, listed, created_at, last_seen_at) VALUES (?, ?, ?, 0, 0)",
        )
        .run(`${name}@example.test`, `${name}-name`, listed);
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

  function listen(cookie) {
    const ac = new AbortController();
    let text = "";
    const done = srv
      .fetch("/live/stream", { headers: { cookie }, signal: ac.signal })
      .then(async (res) => {
        const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          text += dec.decode(value);
        }
      })
      .catch(() => {});
    return { stop: async () => (ac.abort(), await done, text) };
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  it("delivers a direct message to its recipient and nobody else", async () => {
    const bob = listen(who.bob.cookie);
    const eve = listen(who.eve.cookie);
    await pause(100);
    const res = await post(who.ann.cookie, `/messages/${who.bob.id}`, { body: "secret plan" });
    await pause(150);
    const [b, e] = await Promise.all([bob.stop(), eve.stop()]);
    assert.equal(res.status, 303);
    assert.match(b, /event: dm\ndata: .*secret plan/);
    assert.doesNotMatch(e, /secret plan/);
    assert.match(await page(who.bob.cookie, `/messages/${who.ann.id}`), /secret plan/);
    assert.doesNotMatch(await page(who.eve.cookie, `/messages/${who.ann.id}`), /secret plan/);
    assert.doesNotMatch(await page(who.eve.cookie, "/messages"), /ann-name/);
  });

  it("refuses unsolicited messages to unlisted strangers, but allows replies", async () => {
    assert.equal(
      (await post(who.ann.cookie, `/messages/${who.eve.id}`, { body: "hi" })).status,
      403,
    );
    // Eve may write to a listed person, and then that person can reply.
    assert.equal(
      (await post(who.eve.cookie, `/messages/${who.ann.id}`, { body: "hello ann" })).status,
      303,
    );
    assert.equal(
      (await post(who.ann.cookie, `/messages/${who.eve.id}`, { body: "hi eve" })).status,
      303,
    );
  });

  it("blocks messages both ways and hides the blocked person's room posts", async () => {
    await post(who.eve.cookie, "/chat", { body: "eve says hi to the room" });
    assert.match(await page(who.bob.cookie, "/chat"), /eve says hi to the room/);
    await post(who.bob.cookie, `/people/${who.eve.id}/block`);
    assert.doesNotMatch(await page(who.bob.cookie, "/chat"), /eve says hi to the room/);
    assert.equal(
      (await post(who.eve.cookie, `/messages/${who.bob.id}`, { body: "let me in" })).status,
      403,
    );
    assert.equal(
      (await post(who.bob.cookie, `/messages/${who.eve.id}`, { body: "x" })).status,
      403,
    );
    await post(who.bob.cookie, `/people/${who.eve.id}/unblock`);
    assert.match(await page(who.bob.cookie, "/chat"), /eve says hi to the room/);
  });

  it("routes reports to organizers, who can delete and mute", async () => {
    await post(who.eve.cookie, "/chat", { body: "something nasty" });
    const msg = db.prepare("SELECT id FROM chat_messages WHERE body = 'something nasty'").get();
    assert.equal((await post(who.ann.cookie, `/chat/${msg.id}/report`)).status, 200);
    assert.equal(
      (await srv.fetch("/admin/reports", { headers: { cookie: who.ann.cookie } })).status,
      403,
    );
    const queue = await page(who.admin.cookie, "/admin/reports");
    assert.match(queue, /something nasty/);
    const rep = db.prepare("SELECT id FROM reports WHERE message_id = ?").get(msg.id);
    assert.equal(
      (await post(who.ann.cookie, `/admin/reports/${rep.id}`, { action: "mute" })).status,
      403,
    );
    assert.equal(
      (await post(who.admin.cookie, `/admin/reports/${rep.id}`, { action: "mute" })).status,
      303,
    );
    assert.doesNotMatch(await page(who.bob.cookie, "/chat"), /something nasty/);
    assert.equal(
      (await post(who.eve.cookie, "/chat", { body: "again" })).status,
      400,
      "muted users can't post",
    );
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'report.mute'").get());
  });
});
