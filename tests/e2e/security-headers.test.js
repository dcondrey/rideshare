// @ts-check
/**
 * Security headers reach every response, not only the ones written through
 * ctx.html / ctx.json / ctx.redirect.
 *
 * routes/static.js writes bytes straight to ctx.res, so while the headers were
 * attached per-helper every static asset shipped with no CSP and no nosniff —
 * on exactly the responses where content sniffing matters most.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("security headers", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;

  before(async () => {
    srv = await startTestServer();
  });
  after(async () => {
    await srv.close();
  });

  const REQUIRED = [
    "content-security-policy",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "permissions-policy",
  ];

  for (const path of ["/", "/about", "/styles.css", "/brand.css", "/app.js", "/robots.txt"]) {
    it(`sets every security header on ${path}`, async () => {
      const res = await srv.fetch(path);
      assert.equal(res.status, 200, `${path} did not serve`);
      for (const h of REQUIRED) {
        assert.ok(res.headers.get(h), `${path} is missing ${h}`);
      }
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    });
  }

  it("keeps a handler's own stricter policy rather than the default one", async () => {
    // /logo is operator-uploaded and served unauthenticated, so it locks itself
    // down further. The default must not overwrite that.
    const { putAsset } = await srv.mod("lib/assets.js");
    putAsset("logo", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await srv.fetch("/logo");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-security-policy"), "default-src 'none'");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  it("refuses a request target that is not origin-form", async () => {
    // `//host/path` is an authority-form target: the WHATWG parser would read
    // the host and hand back /path, routing a target that should never match.
    const res = await fetch(`${srv.url}//evil.example/about`, { redirect: "manual" });
    assert.equal(res.status, 400);
  });

  it("does not disturb the cross-deployment resolution endpoint", async () => {
    // /.well-known/did.json is how every other deployment verifies credentials
    // we issued. It sets its own CORS and content type after dispatch's pass.
    const res = await srv.fetch("/.well-known/did.json");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("content-type") ?? "", /application\/did\+json/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await res.json()).id.startsWith("did:web:"), true);
  });

  it("sets them on a 404 too", async () => {
    const res = await srv.fetch("/no-such-path");
    assert.equal(res.status, 404);
    for (const h of REQUIRED) {
      assert.ok(res.headers.get(h), `404 is missing ${h}`);
    }
  });
});
