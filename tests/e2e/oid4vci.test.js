// @ts-check
/**
 * OpenID4VCI 1.0 pre-authorized code flow, driven over HTTP the way a wallet
 * would: metadata → offer → token (with PIN) → nonce → credential with a proof
 * JWT. The issued SD-JWT VC must verify against /.well-known/jwt-vc-issuer and
 * be bound to the wallet's key. Each single-use value is replayed once.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/server.js";

describe("OpenID4VCI issuer", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let srv;
  /** @type {any} */
  let db;
  /** @type {any} */
  let lib;
  const wallet = generateKeyPairSync("ec", { namedCurve: "P-256" });

  before(async () => {
    srv = await startTestServer({ DEMO_MODE: "true", EVENT_CONFIG: "event.config.demo.yaml" });
    ({ db } = await srv.mod("lib/db.js"));
    (await srv.mod("lib/demo.js")).ensureDemoSeeded();
    lib = {
      ...(await srv.mod("lib/oid4vci.js")),
      ...(await srv.mod("lib/jose.js")),
      ...(await srv.mod("lib/sd-jwt.js")),
    };
  });
  after(async () => {
    await srv.close();
  });

  /** A fresh offer for one of the seeded credentials, fetched as a wallet would. */
  async function newOffer() {
    const row = db.prepare("SELECT id, subject_user_id FROM credentials_issued LIMIT 1").get();
    const made = lib.createOffer(row.subject_user_id, row.id);
    const offerUri = new URL(made.walletUrl).searchParams.get("credential_offer_uri") ?? "";
    const offer = await (await srv.fetch(new URL(offerUri).pathname)).json();
    return { made, offer };
  }

  /** @param {Record<string, string>} form */
  const token = (form) =>
    srv.fetch("/oid4vci/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });

  /** @param {string} aud @param {string} nonce */
  const proof = (aud, nonce) =>
    lib.signJws(
      { typ: "openid4vci-proof+jwt", jwk: lib.publicJwk(wallet.publicKey) },
      { aud, iat: Math.floor(Date.now() / 1000), nonce },
      wallet.privateKey,
    );

  /** @param {string} accessToken @param {string} proofJwt */
  const credential = (accessToken, proofJwt) =>
    srv.fetch("/oid4vci/credential", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        credential_configuration_id: lib.CREDENTIAL_CONFIGURATION_ID,
        proofs: { jwt: [proofJwt] },
      }),
    });

  const cNonce = async () =>
    (await (await srv.fetch("/oid4vci/nonce", { method: "POST" })).json()).c_nonce;

  it("publishes issuer and authorization server metadata", async () => {
    const meta = await (await srv.fetch("/.well-known/openid-credential-issuer")).json();
    const cfg = meta.credential_configurations_supported[lib.CREDENTIAL_CONFIGURATION_ID];
    assert.equal(cfg.format, "dc+sd-jwt");
    assert.deepEqual(cfg.credential_signing_alg_values_supported, ["ES256"]);
    assert.ok(meta.nonce_endpoint.endsWith("/oid4vci/nonce"));
    const as = await (await srv.fetch("/.well-known/oauth-authorization-server")).json();
    assert.equal(as.issuer, meta.credential_issuer);
    assert.equal(as["pre-authorized_grant_anonymous_access_supported"], true);
  });

  it("issues an SD-JWT VC bound to the wallet key, end to end", async () => {
    const { made, offer } = await newOffer();
    const grant = offer.grants["urn:ietf:params:oauth:grant-type:pre-authorized_code"];
    assert.equal(grant.tx_code.length, 6);
    const base = {
      grant_type: "urn:ietf:params:oauth:grant-type:pre-authorized_code",
      "pre-authorized_code": grant["pre-authorized_code"],
    };

    const wrong = await token({ ...base, tx_code: made.txCode === "000000" ? "111111" : "000000" });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).error, "invalid_grant");

    const ok = await token({ ...base, tx_code: made.txCode });
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const { access_token } = await ok.json();
    assert.ok(access_token);
    assert.equal(
      (await (await token({ ...base, tx_code: made.txCode })).json()).error,
      "invalid_grant",
      "code is single-use",
    );

    const res = await credential(access_token, proof(offer.credential_issuer, await cNonce()));
    assert.equal(res.status, 200);
    const sdJwt = (await res.json()).credentials[0].credential;

    const meta = await (await srv.fetch("/.well-known/jwt-vc-issuer")).json();
    const issuerKey = lib.publicKeyFromJwk(
      (({ kid: _k, alg: _a, use: _u, ...k }) => k)(meta.jwks.keys[0]),
    );
    const pres = lib.presentSdJwt(sdJwt, () => true, {
      aud: "https://verifier.test",
      nonce: "n",
      privateKey: wallet.privateKey,
    });
    const v = lib.verifySdJwt(pres, {
      issuerKey: () => issuerKey,
      requireKeyBinding: true,
      expectedAud: "https://verifier.test",
      expectedNonce: "n",
    });
    assert.deepEqual(v.claims.cnf.jwk, lib.publicJwk(wallet.publicKey));
    assert.equal(v.claims.iss, meta.issuer);
    assert.ok(v.claims.ride.airport);

    const again = await credential(access_token, proof(offer.credential_issuer, await cNonce()));
    assert.equal(again.status, 401, "access token is single-use");
  });

  it("rejects a proof with the wrong audience or a replayed nonce", async () => {
    const run = async (makeProof) => {
      const { made, offer } = await newOffer();
      const grant = offer.grants["urn:ietf:params:oauth:grant-type:pre-authorized_code"];
      const { access_token } = await (
        await token({
          grant_type: "urn:ietf:params:oauth:grant-type:pre-authorized_code",
          "pre-authorized_code": grant["pre-authorized_code"],
          tx_code: made.txCode,
        })
      ).json();
      return (await credential(access_token, await makeProof(offer.credential_issuer))).json();
    };
    assert.equal(
      (await run(async () => proof("https://evil.test", await cNonce()))).error,
      "invalid_proof",
    );
    const spent = await cNonce();
    await run(async (aud) => proof(aud, spent));
    assert.equal((await run(async (aud) => proof(aud, spent))).error, "invalid_nonce");
  });

  it("burns the code after five wrong PINs", async () => {
    const { made, offer } = await newOffer();
    const code =
      offer.grants["urn:ietf:params:oauth:grant-type:pre-authorized_code"]["pre-authorized_code"];
    const form = (pin) => ({
      grant_type: "urn:ietf:params:oauth:grant-type:pre-authorized_code",
      "pre-authorized_code": code,
      tx_code: pin,
    });
    const bad = made.txCode === "999999" ? "999998" : "999999";
    for (let i = 0; i < 5; i++) await token(form(bad));
    assert.equal((await (await token(form(made.txCode))).json()).error, "invalid_grant");
  });
});
