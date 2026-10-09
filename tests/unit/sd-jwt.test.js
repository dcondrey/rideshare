// @ts-check
/**
 * SD-JWT (RFC 9901) / SD-JWT VC: digests against the RFC's own examples, a
 * full issue → present → verify round trip with key binding, and each
 * rejection rule in RFC 9901 §7 that a forged or replayed presentation hits.
 */

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import { b64u, publicJwk, signJws } from "../../lib/jose.js";
import {
  decodeDisclosure,
  issueSdJwt,
  presentSdJwt,
  splitSdJwt,
  verifySdJwt,
} from "../../lib/sd-jwt.js";

const issuer = generateKeyPairSync("ec", { namedCurve: "P-256" });
const holder = generateKeyPairSync("ed25519");
const issuerKey = () => issuer.publicKey;

// RFC 9901 §4.2.1/§4.2.3 and §5.1: disclosure strings and their digests.
const RFC_VECTORS = [
  [
    "WyJfMjZiYzRMVC1hYzZxMktJNmNCVzVlcyIsICJmYW1pbHlfbmFtZSIsICJNw7ZiaXVzIl0",
    "X9yH0Ajrdm1Oij4tWso9UzzKJvPoDxwmuEcO3XAdRC0",
    "family_name",
    "Möbius",
  ],
  [
    "WyIyR0xDNDJzS1F2ZUNmR2ZyeU5STjl3IiwgImdpdmVuX25hbWUiLCAiSm9obiJd",
    "jsu9yVulwQQlhFlM_3JlzMaSFzglhQG0DpfayQwLUK4",
    "given_name",
    "John",
  ],
  [
    "WyI2SWo3dE0tYTVpVlBHYm9TNXRtdlZBIiwgImVtYWlsIiwgImpvaG5kb2VAZXhhbXBsZS5jb20iXQ",
    "JzYjH4svliH0R3PyEMfeZu6Jt69u5qehZo7F7EPYlSE",
    "email",
    "johndoe@example.com",
  ],
];

/** Sign an arbitrary issuer payload, for vectors and malformed cases. */
function signed(payload) {
  return signJws({ typ: "dc+sd-jwt" }, { vct: "urn:test", ...payload }, issuer.privateKey);
}

function ride() {
  return issueSdJwt({
    claims: {
      iss: "https://issuer.example",
      vct: "https://issuer.example/vct/ride-attendance",
      iat: Math.floor(Date.now() / 1000),
      cnf: { jwk: publicJwk(holder.publicKey) },
      role: "rider",
      counterpart: "did:key:z6MkCounterpart",
      ride: { date: "2026-10-23", airport: "SFO" },
    },
    disclosable: [["role"], ["counterpart"], ["ride", "date"], ["ride", "airport"]],
    privateKey: issuer.privateKey,
  });
}

describe("SD-JWT digests (RFC 9901 vectors)", () => {
  for (const [disclosure, dig, name, value] of RFC_VECTORS) {
    it(`resolves the RFC disclosure for ${name}`, () => {
      const jwt = signed({ _sd: [dig] });
      const { claims } = verifySdJwt(`${jwt}~${disclosure}~`, { issuerKey });
      assert.equal(claims[name], value);
      assert.equal(createHash("sha256").update(disclosure, "ascii").digest("base64url"), dig);
    });
  }
});

describe("SD-JWT VC round trip", () => {
  it("discloses only what the holder chose, bound to the holder key", () => {
    const { sdJwt } = ride();
    const pres = presentSdJwt(sdJwt, (d) => d.name === "role" || d.name === "airport", {
      aud: "https://verifier.example",
      nonce: "n-123",
      privateKey: holder.privateKey,
    });
    const r = verifySdJwt(pres, {
      issuerKey,
      requireKeyBinding: true,
      expectedAud: "https://verifier.example",
      expectedNonce: "n-123",
    });
    assert.equal(r.keyBound, true);
    assert.equal(r.claims.role, "rider");
    assert.deepEqual(r.claims.ride, { airport: "SFO" });
    assert.equal("counterpart" in r.claims, false);
    assert.equal("_sd" in r.claims, false);
    assert.equal("_sd_alg" in r.claims, false);
  });

  it("keeps cnf, vct and iss permanently visible and refuses to make them disclosable", () => {
    const { sdJwt } = ride();
    const payload = JSON.parse(
      Buffer.from(splitSdJwt(sdJwt).jwt.split(".")[1], "base64url").toString(),
    );
    assert.ok(payload.cnf && payload.vct && payload.iss);
    assert.throws(
      () =>
        issueSdJwt({
          claims: { vct: "x", cnf: {} },
          disclosable: [["cnf"]],
          privateKey: issuer.privateKey,
        }),
      /must not be selectively disclosable/,
    );
  });

  it("uses a fresh 128-bit salt per disclosure", () => {
    const a = ride().disclosures.map((d) => decodeDisclosure(d).salt);
    const b = ride().disclosures.map((d) => decodeDisclosure(d).salt);
    assert.equal(new Set([...a, ...b]).size, a.length + b.length);
    assert.equal(Buffer.from(a[0], "base64url").length, 16);
  });
});

describe("SD-JWT rejections (RFC 9901 §7)", () => {
  const kb = { aud: "https://verifier.example", nonce: "n-1", privateKey: holder.privateKey };
  const verify = (s, extra = {}) =>
    verifySdJwt(s, {
      issuerKey,
      requireKeyBinding: true,
      expectedAud: kb.aud,
      expectedNonce: kb.nonce,
      ...extra,
    });

  it("rejects a missing KB-JWT when key binding is required", () => {
    const pres = presentSdJwt(ride().sdJwt, () => true);
    assert.throws(() => verify(pres), /key binding required/);
  });

  it("rejects a replay to another verifier or with another nonce", () => {
    const pres = presentSdJwt(ride().sdJwt, () => true, kb);
    assert.throws(() => verify(pres, { expectedAud: "https://other.example" }), /aud mismatch/);
    assert.throws(() => verify(pres, { expectedNonce: "n-2" }), /nonce mismatch/);
  });

  it("rejects a disclosure added after the KB-JWT was signed", () => {
    const { sdJwt, disclosures } = ride();
    const pres = presentSdJwt(sdJwt, (d) => d.name === "role", kb);
    const { jwt, kbJwt } = splitSdJwt(pres);
    const tampered = `${jwt}~${disclosures.map((d) => `${d}~`).join("")}${kbJwt}`;
    assert.throws(() => verify(tampered), /sd_hash/);
  });

  it("rejects a KB-JWT signed by a key other than cnf", () => {
    const other = generateKeyPairSync("ed25519");
    const pres = presentSdJwt(ride().sdJwt, () => true, { ...kb, privateKey: other.privateKey });
    assert.throws(() => verify(pres), /signature did not verify/);
  });

  it("rejects a disclosure the issuer never referenced", () => {
    const stray = b64u(JSON.stringify(["c2FsdHNhbHRzYWx0c2FsdA", "admin", true]));
    const pres = presentSdJwt(ride().sdJwt, () => true);
    assert.throws(() => verifySdJwt(`${pres}${stray}~`, { issuerKey }), /not referenced/);
  });

  it("rejects a repeated disclosure and a repeated digest", () => {
    const [d, dig] = RFC_VECTORS[1];
    assert.throws(
      () => verifySdJwt(`${signed({ _sd: [dig] })}~${d}~${d}~`, { issuerKey }),
      /twice/,
    );
    assert.throws(
      () => verifySdJwt(`${signed({ _sd: [dig], x: { _sd: [dig] } })}~${d}~`, { issuerKey }),
      /more than once/,
    );
  });

  it("rejects a disclosure that would overwrite a visible claim", () => {
    const [d, dig] = RFC_VECTORS[1]; // given_name
    assert.throws(
      () => verifySdJwt(`${signed({ given_name: "Mallory", _sd: [dig] })}~${d}~`, { issuerKey }),
      /already exists/,
    );
  });

  it("rejects a forged issuer signature, alg none and the wrong typ", () => {
    const forger = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const forged = signJws({ typ: "dc+sd-jwt" }, { vct: "x" }, forger.privateKey);
    assert.throws(() => verifySdJwt(`${forged}~`, { issuerKey }), /signature did not verify/);
    const none = `${b64u(JSON.stringify({ alg: "none", typ: "dc+sd-jwt" }))}.${b64u(JSON.stringify({ vct: "x" }))}.AA`;
    assert.throws(() => verifySdJwt(`${none}~`, { issuerKey }), /not allowed/);
    const wrongTyp = signJws({ typ: "JWT" }, { vct: "x" }, issuer.privateKey);
    assert.throws(() => verifySdJwt(`${wrongTyp}~`, { issuerKey }), /typ must be dc\+sd-jwt/);
  });

  it("rejects an expired credential", () => {
    const jwt = signed({ exp: Math.floor(Date.now() / 1000) - 10 });
    assert.throws(() => verifySdJwt(`${jwt}~`, { issuerKey }), /expired/);
  });
});
