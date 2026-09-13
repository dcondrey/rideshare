// @ts-check
// SPDX-License-Identifier: MIT
/**
 * Structured data, social cards, and crawler directives.
 *
 * The invariant worth pinning is not "the JSON-LD exists" — it is that the
 * markup never describes anything the visitor cannot see. Two ways that breaks:
 * a session-gated page starts emitting JSON-LD, or the landing page's Event
 * grows a field (the venue's address, the coordinates) that `/` does not
 * render. Both are silent, and both are what search engines treat as cloaking.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

/** @param {string} body */
function jsonLdBlocks(body) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m = re.exec(body);
  while (m) {
    out.push(JSON.parse(m[1]));
    m = re.exec(body);
  }
  return out;
}

describe("structured data and crawler directives", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {any} */
  let db;
  let sessionCookie = "";

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
    sessionCookie = `rs_session=${sid}`;
  });

  after(async () => {
    await srv.close();
  });

  it("serves one parseable JSON-LD graph on the landing page", async () => {
    const body = await (await srv.fetch("/")).text();
    const blocks = jsonLdBlocks(body);
    assert.equal(blocks.length, 1);
    const graph = blocks[0]["@graph"];
    assert.ok(Array.isArray(graph), "expected an @graph");
    const types = graph.map((n) => n["@type"]);
    assert.deepEqual(types.sort(), ["Event", "WebSite"]);
  });

  it("describes the event only with what the landing page renders", async () => {
    const body = await (await srv.fetch("/")).text();
    const event = jsonLdBlocks(body)[0]["@graph"].find((n) => n["@type"] === "Event");

    // Rendered in the hero: name, dates, venue name.
    assert.ok(body.includes(event.name));
    assert.ok(body.includes(event.startDate));
    assert.ok(body.includes(event.location.name));

    // NOT rendered anywhere public — the address and coordinates live on /map,
    // which redirects a signed-out visitor. Marking them up here would be
    // cloaking, so the Place carries a bare name.
    assert.deepEqual(Object.keys(event.location).sort(), ["@type", "name"]);
    const flat = JSON.stringify(event);
    assert.ok(!flat.includes("Shoreline"), "venue street address leaked into JSON-LD");
    assert.ok(!/-?\d{2}\.\d{4}/.test(flat), "venue coordinates leaked into JSON-LD");
  });

  it("maps about/mentions to resolvable Wikidata entities", async () => {
    const body = await (await srv.fetch("/")).text();
    const site = jsonLdBlocks(body)[0]["@graph"].find((n) => n["@type"] === "WebSite");
    assert.ok(site.mentions.length >= 2);
    for (const ref of site.mentions) {
      assert.match(ref["@id"], /^https:\/\/www\.wikidata\.org\/wiki\/Q[1-9][0-9]*$/);
    }
  });

  it("emits an absolute og:url and omits og:image when none is configured", async () => {
    const body = await (await srv.fetch("/")).text();
    const url = body.match(/<meta property="og:url" content="([^"]+)"/)?.[1] ?? "";
    assert.match(url, /^https?:\/\//);
    assert.ok(body.includes('<meta name="twitter:card" content="summary">'));
    assert.ok(!body.includes("og:image"), "claimed an image that is not configured");
  });

  it("leaves session-gated pages out of the index and free of structured data", async () => {
    for (const path of ["/rides", "/rides/new", "/trust", "/me", "/admin"]) {
      const body = await (await srv.fetch(path, { headers: { cookie: sessionCookie } })).text();
      assert.ok(
        body.includes('<meta name="robots" content="noindex, nofollow">'),
        `${path} is missing noindex`,
      );
      assert.equal(jsonLdBlocks(body).length, 0, `${path} emitted structured data`);
      assert.ok(!body.includes("og:title"), `${path} emitted an Open Graph card`);
    }
  });

  it("prefetches in-app navigation but never prerenders it, and skips /admin", async () => {
    const body = await (await srv.fetch("/rides", { headers: { cookie: sessionCookie } })).text();
    const rules = JSON.parse(
      body.match(/<script type="speculationrules">([\s\S]*?)<\/script>/)?.[1] ?? "null",
    );
    assert.ok(rules, "no speculation rules on a signed-in page");
    assert.ok(!("prerender" in rules), "prerender would run a gated page's side effects");
    assert.equal(rules.prefetch[0].eagerness, "moderate");
    const excluded = JSON.stringify(rules.prefetch[0].where);
    assert.ok(excluded.includes("/admin/*"), "admin pages are not excluded from prefetch");
    // /trust/credentials.json is a real <a href> in routes/trust.js; prefetching
    // it would build a credential payload on hover.
    assert.ok(excluded.includes("/*.json"), "json downloads are not excluded from prefetch");
  });

  it("prerenders only the one public page reachable from the landing page", async () => {
    const body = await (await srv.fetch("/")).text();
    const rules = JSON.parse(
      body.match(/<script type="speculationrules">([\s\S]*?)<\/script>/)?.[1] ?? "null",
    );
    assert.equal(rules.prerender[0].where.href_matches, "/about");
  });

  it("keeps robots.txt default-deny, allowing back only the public pages", async () => {
    const txt = await (await srv.fetch("/robots.txt")).text();
    const directives = txt
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));

    // Default-deny is the whole policy: a route added later is private to
    // crawlers without anyone remembering to edit this file.
    assert.ok(directives.includes("Disallow: /"), "robots.txt is not default-deny");

    const allowed = directives
      .filter((l) => l.startsWith("Allow:"))
      .map((l) => l.slice("Allow:".length).trim());
    // The two stylesheets lib/html.js puts in every layout are allowed too:
    // without them a crawler renders the two public pages unstyled.
    assert.deepEqual(allowed.sort(), [
      "/$",
      "/.well-known/",
      "/about",
      "/brand.css",
      "/styles.css",
    ]);

    // An Allow that named a session-gated prefix would silently release it.
    for (const gated of ["/admin", "/rides", "/map", "/trust", "/me", "/auth"]) {
      assert.ok(
        !allowed.some((a) => a.startsWith(gated)),
        `robots.txt allows the gated path ${gated}`,
      );
    }
    // "/$" is anchored, so the browse filters (/rides?…) and even /?utm=… stay
    // under Disallow: / rather than needing a rule per filter dimension.
    assert.ok(allowed.includes("/$"), "landing-page allow must be anchored with $");
  });
});
