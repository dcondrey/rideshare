// @ts-check
/**
 * OpenID4VP 1.0 verifier, cross-device, as a wallet sees it: fetch the request
 * object, check its signature against the key the DID document publishes
 * (P-256 Multikey), answer with an SD-JWT VC presentation by direct_post, and
 * watch the status flip. A replay and a presentation for another verifier fail.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("OpenID4VP verifier", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {any} */
  let lib;
  const wallet = generateKeyPairSync("ec", { namedCurve: "P-256" });
  /** @type {string} */
  let credential;

  before(async () => {
    srv = await startTestServer({ DEMO_MODE: "true", EVENT_CONFIG: "event.config.demo.yaml" });
    lib = {
      ...(await srv.mod("lib/oid4vp.js")),
      ...(await srv.mod("lib/jose.js")),
      ...(await srv.mod("lib/sd-jwt.js")),
      ...(await srv.mod("lib/did.js")),
      ...(await srv.mod("lib/trust.js")),
    };
    credential = lib.issueRideSdJwt({
      holderJwk: lib.publicJwk(wallet.publicKey),
      role: "rider",
      counterpart: "did:key:z6MkCounterpart",
      ride: { date: "2026-10-23", airport: "SFO" },
      event: { name: "IDW", startDate: "2026-10-23", endDate: "2026-10-25" },
    });
  });
  after(async () => {
    await srv.close();
  });

  /** Fetch and verify the request object exactly as a wallet must. */
  async function walletOpens(walletUrl) {
    const u = new URL(walletUrl);
    const clientId = u.searchParams.get("client_id") ?? "";
    const res = await srv.fetch(new URL(u.searchParams.get("request_uri") ?? "").pathname);
    assert.equal(res.headers.get("content-type"), "application/oauth-authz-req+jwt");
    const jwt = await res.text();
    const { header, payload } = lib.decodeJws(jwt);
    assert.equal(header.typ, "oauth-authz-req+jwt");
    const doc = await (await srv.fetch("/.well-known/did.json")).json();
    const vm = doc.verificationMethod.find((m) => m.id === header.kid);
    assert.ok(doc.assertionMethod.includes(header.kid), "request key is an assertionMethod");
    lib.verifyJws(jwt, lib.verificationMethodKey(vm), ["ES256"]);
    assert.equal(payload.client_id, clientId);
    assert.equal(clientId, `decentralized_identifier:${doc.id}`);
    return payload;
  }

  /** @param {Record<string, string>} form */
  const post = (form) =>
    srv.fetch("/oid4vp/response", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });

  it("verifies a selectively disclosed, key-bound ride credential", async () => {
    const req = lib.createPresentationRequest();
    const p = await walletOpens(req.walletUrl);
    const q = p.dcql_query.credentials[0];
    assert.deepEqual(
      q.claims.map((c) => c.path),
      [["event", "name"], ["role"]],
    );
    // Disclose exactly event.name and role; "name" exists only under event.
    const pres = lib.presentSdJwt(credential, (d) => d.name === "role" || d.name === "name", {
      aud: p.client_id,
      nonce: p.nonce,
      privateKey: wallet.privateKey,
    });
    const res = await post({ vp_token: JSON.stringify({ [q.id]: [pres] }), state: p.state });
    assert.equal(res.status, 200);
    const s = await (await srv.fetch(`/oid4vp/status/${req.statusToken}`)).json();
    assert.equal(s.status, "verified", JSON.stringify(s.errors));
    assert.equal(s.claims.role, "rider");
    assert.equal(s.claims.event.name, "IDW");
    assert.equal("counterpart" in s.claims, false);
    assert.equal("airport" in s.claims.ride, false);

    const replay = await post({ vp_token: JSON.stringify({ [q.id]: [pres] }), state: p.state });
    assert.equal(replay.status, 400);
    assert.equal(
      (await srv.fetch(new URL(req.requestUri).pathname)).status,
      404,
      "answered request is gone",
    );
    assert.equal(
      (await srv.fetch(`/oid4vp/status/${req.id}`)).status,
      404,
      "the id in the QR does not unlock the result",
    );
  });

  it("rejects a presentation bound to another verifier and stays pending", async () => {
    const req = lib.createPresentationRequest();
    const p = await walletOpens(req.walletUrl);
    const pres = lib.presentSdJwt(credential, () => true, {
      aud: "decentralized_identifier:did:web:elsewhere.example",
      nonce: p.nonce,
      privateKey: wallet.privateKey,
    });
    await post({
      vp_token: JSON.stringify({ [p.dcql_query.credentials[0].id]: [pres] }),
      state: p.state,
    });
    const s = await (await srv.fetch(`/oid4vp/status/${req.statusToken}`)).json();
    assert.equal(
      s.status,
      "pending",
      "a bad response must not void the request for the real wallet",
    );
    assert.match(s.errors.join(" "), /aud mismatch/);
    await post({ vp_token: "junk", state: p.state });
    assert.equal(
      (await (await srv.fetch(`/oid4vp/status/${req.statusToken}`)).json()).status,
      "pending",
    );
  });

  it("lets the in-app holder inspect a request, signature checked", async () => {
    const req = lib.createPresentationRequest();
    const info = await lib.inspectRequest(req.walletUrl);
    assert.equal(info.clientId, lib.clientId());
    assert.deepEqual(info.claims, [["event", "name"], ["role"]]);
    assert.ok(info.responseUri.endsWith("/oid4vp/response"));
  });
});
