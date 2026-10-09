// @ts-check
/**
 * The map-first shell: a signed-in visitor gets the full-screen map at /, the
 * pins come from /map/data.json (signed-in only), and every page the panel
 * loads still renders on its own for no-JS visitors and deep links.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { withCookies } from "../helpers/cookies.js";
import { startTestServer } from "../helpers/server.js";

describe("map-first shell", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {ReturnType<typeof withCookies>} */
  let client;

  before(async () => {
    srv = await startTestServer({ DEMO_MODE: "true", EVENT_CONFIG: "event.config.demo.yaml" });
    (await srv.mod("lib/demo.js")).ensureDemoSeeded();
    client = withCookies(srv.fetch);
    await client.fetch("/demo/signin", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=attendee%40demo.test",
    });
  });
  after(async () => {
    await srv.close();
  });

  it("serves the full-screen map with a panel to signed-in users", async () => {
    const page = await (await client.fetch("/")).text();
    assert.match(page, /class="is-shell"/);
    assert.match(page, /id="map-data"/);
    assert.match(page, /id="panel"[^>]*hidden/);
    assert.match(page, /src="\/shell\.js"/);
  });

  it("returns map pins only to signed-in users", async () => {
    assert.equal((await srv.fetch("/map/data.json")).status, 401);
    const data = await (await client.fetch("/map/data.json")).json();
    assert.ok(data.rides.length > 0);
    assert.ok(data.venue);
  });

  it("keeps every panel page renderable on its own", async () => {
    for (const path of ["/rides", "/rides/new", "/trust", "/verify", "/demo"]) {
      const res = await client.fetch(path);
      assert.equal(res.status, 200, path);
      assert.match(await res.text(), /<main id="main" class="container main-content">/, path);
    }
  });
});
