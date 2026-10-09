// @ts-check
/**
 * DIDComm v2.1 agent: the DID document advertises an X25519 keyAgreement key
 * and a DIDCommMessaging service; a trust ping to this deployment's own DID
 * makes the full ping → ping-response round trip; discover-features discloses
 * both protocols; an anoncrypt message over HTTP is accepted without a reply
 * and a tampered one is refused.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("DIDComm agent", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {any} */
  let dc;
  /** @type {any} */
  let doc;

  before(async () => {
    srv = await startTestServer();
    dc = { ...(await srv.mod("lib/didcomm.js")), ...(await srv.mod("lib/didcomm-crypto.js")) };
    doc = await (await srv.fetch("/.well-known/did.json")).json();
  });
  after(async () => {
    await srv.close();
  });

  /** Wait for the in-process deliveries queued by setImmediate to settle. */
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const ofType = (suffix) => dc.recentMessages(50).filter((m) => m.type.endsWith(suffix));

  it("publishes a keyAgreement key and a DIDCommMessaging service", () => {
    const kid = doc.keyAgreement[0];
    const vm = doc.verificationMethod.find((m) => m.id === kid);
    assert.equal(vm.type, "JsonWebKey2020");
    assert.equal(vm.publicKeyJwk.crv, "X25519");
    const svc = doc.service.find((s) => s.type === "DIDCommMessaging");
    assert.deepEqual(svc.serviceEndpoint.accept, ["didcomm/v2"]);
    assert.ok(svc.serviceEndpoint.uri.endsWith("/didcomm"));
  });

  it("answers a trust ping with a ping-response on the same thread", async () => {
    const id = await dc.sendPing(doc.id);
    await settle();
    const response = ofType("/trust-ping/2.0/ping-response").find(
      (m) => m.thid === id && m.direction === "in",
    );
    assert.ok(response, "ping-response arrived");
    assert.equal(response.peer, doc.id);
  });

  it("matches Discover Features wildcards without regular expressions", () => {
    const ping = "https://didcomm.org/trust-ping/2.0";
    assert.equal(dc.wildcardMatch("https://didcomm.org/*", ping), true);
    assert.equal(dc.wildcardMatch("*trust-ping*", ping), true);
    assert.equal(dc.wildcardMatch(ping, ping), true);
    assert.equal(dc.wildcardMatch("https://didcomm.org/*/1.0", ping), false);
    assert.equal(dc.wildcardMatch("*a*a*a*a*a*a*a*a*b", "a".repeat(40)), false);
  });

  it("discloses the protocols it supports", async () => {
    const id = await dc.sendQuery(doc.id);
    await settle();
    const disclose = ofType("/discover-features/2.0/disclose").find(
      (m) => m.thid === id && m.direction === "in",
    );
    const ids = JSON.parse(disclose.body).disclosures.map((d) => d.id);
    assert.deepEqual(ids.sort(), [
      "https://didcomm.org/discover-features/2.0",
      "https://didcomm.org/trust-ping/2.0",
    ]);
  });

  it("accepts anoncrypt over HTTP without replying, and refuses a tampered message", async () => {
    const vm = doc.verificationMethod.find((m) => m.id === doc.keyAgreement[0]);
    const jwe = dc.packEncrypted(
      {
        id: "anon-1",
        type: "https://didcomm.org/trust-ping/2.0/ping",
        to: [doc.id],
        body: { response_requested: true },
      },
      [{ kid: vm.id, publicKey: dc.x25519PublicKey(vm.publicKeyJwk) }],
    );
    const post = (body) =>
      srv.fetch("/didcomm", {
        method: "POST",
        headers: { "content-type": "application/didcomm-encrypted+json" },
        body: JSON.stringify(body),
      });
    assert.equal((await post(jwe)).status, 202);
    await settle();
    const logged = dc.recentMessages(50).find((m) => m.id === "anon-1");
    assert.match(logged.note, /anoncrypt/);
    assert.equal(
      ofType("/ping-response").some((m) => m.thid === "anon-1"),
      false,
      "no reply to an unknown sender",
    );

    const forged = dc.packEncrypted({ id: "x", type: "t", to: [doc.id], body: {} }, [
      { kid: vm.id, publicKey: generateKeyPairSync("x25519").publicKey },
    ]);
    assert.equal((await post(forged)).status, 400);
    assert.equal(
      (
        await srv.fetch("/didcomm", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "hi",
        })
      ).status,
      415,
    );
  });
});
