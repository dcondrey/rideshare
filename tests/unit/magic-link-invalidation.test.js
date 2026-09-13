// @ts-check
/**
 * Requesting a magic link invalidates every outstanding link for that address,
 * so a link captured from an older email cannot still be redeemed.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { setupTestEnv } from "../helpers/env.js";

// A high rate limit: startMagicLink returns { sent: false } without sending once
// the per-email limit trips, which would silently reuse a stale captured token.
setupTestEnv({
  RESEND_API_KEY: "re_test",
  DATABASE_PATH: ":memory:",
  MAGIC_LINK_RATE_LIMIT: "100",
});

const { appendAllowlist } = await import("../../lib/allowlist.js");
const { consumeMagicLink, startMagicLink } = await import("../../lib/auth.js");
const { db } = await import("../../lib/db.js");

/** Intercept the Resend call and pull the token out of the email body. */
const realFetch = globalThis.fetch;
/** @type {string[]} */
const tokens = [];

/** @param {string} email */
async function requestLink(email) {
  await startMagicLink(email, "1.1.1.1");
  return tokens.at(-1);
}

describe("magic link invalidation", () => {
  before(() => {
    globalThis.fetch = /** @type {typeof fetch} */ (
      async (url, init) => {
        if (!String(url).includes("resend.com")) return realFetch(url, init);
        const body = JSON.parse(String(init?.body));
        const link = String(body.text).match(/https?:\/\/\S+/)?.[0] ?? "";
        tokens.push(new URL(link).searchParams.get("token") ?? "");
        return new Response("{}", { status: 200 });
      }
    );
    appendAllowlist(["a@example.test", "b@example.test"], {
      actorId: null,
      actorEmail: null,
      ip: "1.1.1.1",
    });
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  it("rejects a link superseded by a newer request", async () => {
    const first = await requestLink("a@example.test");
    const second = await requestLink("a@example.test");
    assert.notEqual(first, second);

    const stale = consumeMagicLink(String(first), "1.1.1.1", "ua");
    assert.equal(stale.ok, false);
    // Marked used rather than deleted, so the message stays specific.
    assert.equal(stale.ok === false && stale.reason, "Link already used");

    const fresh = consumeMagicLink(String(second), "1.1.1.1", "ua");
    assert.equal(fresh.ok, true);
  });

  it("leaves other addresses' outstanding links alone", async () => {
    const mine = await requestLink("b@example.test");
    await requestLink("a@example.test");
    assert.equal(consumeMagicLink(String(mine), "1.1.1.1", "ua").ok, true);
  });

  it("marks the superseded rows used rather than deleting them", async () => {
    const email = "a@example.test";
    const countRow = /** @type {{ c: number }} */ (
      db.prepare("SELECT count(*) c FROM magic_links WHERE email = ?").get(email)
    );
    await requestLink(email);
    const rows = /** @type {{ used_at: number | null }[]} */ (
      db.prepare("SELECT used_at FROM magic_links WHERE email = ? ORDER BY created_at").all(email)
    );
    assert.equal(rows.length, countRow.c + 1, "prior rows are retained for audit");
    assert.equal(rows.filter((r) => r.used_at == null).length, 1, "exactly one link is redeemable");
  });
});
