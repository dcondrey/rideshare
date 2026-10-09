// @ts-check
/**
 * The live demo end to end: a visitor signs in with a published demo account,
 * confirms the ride a ghost driver already confirmed, binds a did:key, and
 * ends up holding a credential that verifies. Also pins the two guards that
 * keep a public demo usable for the next visitor: each attendee sign-in is a
 * separate account, and the shared organizer account cannot write.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { withCookies } from "../helpers/cookies.js";
import { startTestServer } from "../helpers/server.js";

const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("live demo (DEMO_MODE=true)", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {any} */
  let db;

  before(async () => {
    srv = await startTestServer({ DEMO_MODE: "true", EVENT_CONFIG: "event.config.demo.yaml" });
    ({ db } = await srv.mod("lib/db.js"));
    (await srv.mod("lib/demo.js")).ensureDemoSeeded();
  });
  after(async () => {
    await srv.close();
  });

  /** @param {string} email */
  async function signIn(email) {
    const client = withCookies(srv.fetch);
    const res = await client.fetch("/demo/signin", {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ email }).toString(),
    });
    return { client, res };
  }

  /** @param {ReturnType<typeof withCookies>} client */
  async function currentUserId(client) {
    const res = await client.fetch("/trust/profile.json");
    assert.equal(res.status, 200);
    const sid = client.jar.jar.get("rs_session");
    const row = db.prepare("SELECT user_id FROM sessions WHERE id = ?").get(sid);
    return Number(row.user_id);
  }

  it("lists both demo accounts on the landing page", async () => {
    const body = await (await srv.fetch("/")).text();
    assert.match(body, /attendee@demo\.test/);
    assert.match(body, /organizer@demo\.test/);
    assert.doesNotMatch(body, /action="\/auth\/send"/);
  });

  it("refuses an address that is not a demo account", async () => {
    const { res } = await signIn("someone@example.com");
    assert.equal(res.status, 400);
    assert.ok(!(res.headers.get("set-cookie") ?? "").includes("rs_session="));
  });

  it("gives each attendee sign-in its own account", async () => {
    const a = await signIn("attendee@demo.test");
    const b = await signIn("attendee@demo.test");
    assert.equal(a.res.status, 303);
    assert.equal(a.res.headers.get("location"), "/?panel=%2Fdemo");
    assert.notEqual(await currentUserId(a.client), await currentUserId(b.client));
  });

  it("issues a verifiable credential once the visitor confirms and binds a DID", async () => {
    const { client } = await signIn("attendee@demo.test");
    const userId = await currentUserId(client);
    const { tourState } = await srv.mod("lib/demo.js");
    const t = tourState(userId);
    assert.ok(t.seatRideId, "visitor starts with an accepted seat");

    // Confirm before any DID exists: dual-confirmed, nothing issued yet.
    const confirm = await client.fetch(`/rides/${t.seatRideId}/confirm`, { method: "POST" });
    const c = await confirm.json();
    assert.equal(c.recorded, true);
    assert.equal(c.dualConfirmed, true);
    assert.deepEqual(c.issuedCredentialIds, []);

    // Bind a did:key through the real challenge-response.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const { pubKeyRawBytes, pubKeyToDidKey } = await srv.mod("lib/did.js");
    const did = pubKeyToDidKey(pubKeyRawBytes(publicKey));
    const { challenge } = await (
      await client.fetch("/trust/bind/challenge", { method: "POST" })
    ).json();
    const signature = sign(null, Buffer.from(challenge, "utf8"), privateKey).toString("base64url");
    const bind = await client.fetch("/trust/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ did, challenge, signature }),
    });
    assert.equal((await bind.json()).ok, true);

    // Binding mints the credential the earlier confirmation could not.
    const cred = db
      .prepare("SELECT jwt, subject_did FROM credentials_issued WHERE subject_user_id = ?")
      .get(userId);
    assert.ok(cred, "binding the DID issued the pending credential");
    assert.equal(cred.subject_did, did);

    const report = await (
      await srv.fetch("/trust/verify", {
        method: "POST",
        headers: FORM,
        body: new URLSearchParams({ jwt: cred.jwt }).toString(),
      })
    ).text();
    assert.match(report, /signature_valid/);
    assert.doesNotMatch(report, /issuer_resolution_failed/);

    // The SD-JWT VC twin: present two claims with key binding, then replay it.
    const twin = db
      .prepare("SELECT sd_jwt FROM sd_jwt_credentials WHERE subject_user_id = ?")
      .get(userId);
    assert.ok(twin, "an SD-JWT VC was issued beside the VC-JWT");
    const { presentSdJwt } = await srv.mod("lib/sd-jwt.js");
    const { nonce, aud } = await (
      await srv.fetch("/trust/verify/nonce", { method: "POST" })
    ).json();
    const presentation = presentSdJwt(
      twin.sd_jwt,
      (d) => d.name === "role" || d.name === "airport",
      {
        aud,
        nonce,
        privateKey,
      },
    );
    const verifyPresentation = async () =>
      (
        await srv.fetch("/trust/verify", {
          method: "POST",
          headers: FORM,
          body: new URLSearchParams({ jwt: presentation }).toString(),
        })
      ).text();
    const first = await verifyPresentation();
    assert.match(first, /key binding valid/);
    assert.match(first, /nonce fresh and now consumed/);
    assert.match(first, /&quot;role&quot;/);
    assert.doesNotMatch(first, /&quot;counterpart&quot;/);
    assert.match(await verifyPresentation(), /replay/);
  });

  it("keeps the shared organizer account read-only", async () => {
    const { client, res } = await signIn("organizer@demo.test");
    assert.equal(res.headers.get("location"), "/?panel=%2Fadmin");
    const page = await client.fetch("/admin/banner");
    assert.equal(page.status, 200);
    const token = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
    const write = await client.fetch("/admin/banner", {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ _csrf: token, message: "defaced", severity: "info" }).toString(),
    });
    assert.equal(write.status, 403);
    assert.match(await write.text(), /turned off in the live demo/);
    const { getBanner } = await srv.mod("lib/banner.js");
    assert.equal(getBanner(), null);
  });

  it("refuses to run against a database with real attendees", async () => {
    const { ensureDemoSeeded } = await srv.mod("lib/demo.js");
    db.prepare(
      "INSERT INTO users (email, created_at, last_seen_at) VALUES ('real@example.com', 0, 0)",
    ).run();
    try {
      assert.throws(() => ensureDemoSeeded(), /DEMO_MODE refused/);
    } finally {
      db.prepare("DELETE FROM users WHERE email = 'real@example.com'").run();
    }
  });
});
