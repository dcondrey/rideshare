// @ts-check
/**
 * Unit tests for the VC-JWT issuer/verifier pair in lib/vc.js.
 *
 * Spec references:
 *   - W3C VC Data Model 2.0 — https://www.w3.org/TR/vc-data-model-2.0/
 *   - VC-JWT 1.0           — https://www.w3.org/TR/vc-jwt/
 *   - JWT (RFC 7519)       — https://datatracker.ietf.org/doc/html/rfc7519
 *
 * Verifier semantics under test (per lib/vc.js):
 *   - alg must be EdDSA
 *   - typ may be "vc+jwt" or "JWT" (others rejected)
 *   - iss / sub presence + optional expected matching
 *   - nbf with 5-minute clock skew leeway
 *   - exp strictly enforced (no skew)
 *   - vc.type must include "VerifiableCredential"
 *   - vc.issuer must equal jwt.iss
 *   - signature must verify against the issuer DID's key
 *   - returns { ok, errors[], checks[], decoded? } so callers can show
 *     specific failure reasons in the verifier playground
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { setupTestEnv } from "../helpers/env.js";
setupTestEnv();

import {
  generateEd25519Keypair,
  pubKeyRawBytes,
  pubKeyToDidKey,
} from "../../lib/did.js";
import { signCredential, verifyCredential, decodeJwt } from "../../lib/vc.js";

/** Generate a fresh issuer + holder did:key pair for a single test. */
function freshIdentities() {
  const issuer = generateEd25519Keypair();
  const holder = generateEd25519Keypair();
  return {
    issuerPriv: issuer.privateKey,
    issuerDid: pubKeyToDidKey(pubKeyRawBytes(issuer.publicKey)),
    holderDid: pubKeyToDidKey(pubKeyRawBytes(holder.publicKey)),
  };
}

describe("VC-JWT — happy-path issue and verify", () => {
  it("verifies a freshly signed credential with all checks passing", async () => {
    const id = freshIdentities();
    const jwt = signCredential({
      issuerDid: id.issuerDid,
      subjectDid: id.holderDid,
      credentialId: "urn:uuid:happy",
      types: ["VerifiableCredential", "RideAttendanceCredential"],
      credentialSubject: { event: "DEFCON 33", role: "rider" },
      privateKey: id.issuerPriv,
    });
    const result = await verifyCredential(jwt);
    assert.equal(result.ok, true, `errors: ${JSON.stringify(result.errors)}`);
    assert.ok(result.checks.includes("alg=EdDSA"));
    assert.ok(result.checks.includes("signature_valid"));
    assert.ok(result.checks.some((c) => c.startsWith("issuer=")));
    assert.ok(result.checks.some((c) => c.startsWith("subject=")));
  });

  it("decodeJwt parses without verifying (header/payload/signature/signingInput)", () => {
    const id = freshIdentities();
    const jwt = signCredential({
      issuerDid: id.issuerDid,
      subjectDid: id.holderDid,
      credentialId: "urn:uuid:decode",
      types: ["VerifiableCredential"],
      credentialSubject: {},
      privateKey: id.issuerPriv,
    });
    const decoded = decodeJwt(jwt);
    assert.equal(decoded.header.alg, "EdDSA");
    assert.equal(decoded.header.typ, "vc+jwt");
    assert.equal(decoded.payload.iss, id.issuerDid);
    assert.equal(decoded.payload.sub, id.holderDid);
    assert.equal(decoded.payload.jti, "urn:uuid:decode");
    assert.ok(Array.isArray(decoded.payload.vc.type));
    assert.equal(decoded.signingInput.split(".").length, 2);
    assert.match(decoded.signature, /^[A-Za-z0-9_-]+$/);
  });

  it("decodeJwt throws on a JWT with the wrong number of segments", () => {
    assert.throws(() => decodeJwt("only.two"), /3 segments/);
    assert.throws(() => decodeJwt("a.b.c.d"), /3 segments/);
  });
});

describe("VC-JWT — tamper detection", () => {
  it("flipping a bit in the header segment fails verification with signature_invalid", async () => {
    const id = freshIdentities();
    const jwt = signCredential({
      issuerDid: id.issuerDid,
      subjectDid: id.holderDid,
      credentialId: "urn:uuid:tamper-h",
      types: ["VerifiableCredential"],
      credentialSubject: {},
      privateKey: id.issuerPriv,
    });
    const [h, p, s] = jwt.split(".");
    // Decode the header, mutate kid, re-encode (keeps it valid JSON so we get
    // a signature_invalid rather than malformed_jwt)
    const headerObj = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    headerObj.kid = headerObj.kid + "X";
    const tamperedH = Buffer.from(JSON.stringify(headerObj)).toString("base64url");
    const tampered = `${tamperedH}.${p}.${s}`;
    const r = await verifyCredential(tampered);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e === "signature_invalid"),
      `expected signature_invalid, got ${JSON.stringify(r.errors)}`,
    );
  });

  it("mutating the payload segment fails verification with signature_invalid", async () => {
    const id = freshIdentities();
    const jwt = signCredential({
      issuerDid: id.issuerDid,
      subjectDid: id.holderDid,
      credentialId: "urn:uuid:tamper-p",
      types: ["VerifiableCredential"],
      credentialSubject: { role: "rider" },
      privateKey: id.issuerPriv,
    });
    const [h, p, s] = jwt.split(".");
    const payloadObj = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payloadObj.vc.credentialSubject.role = "driver"; // privilege escalation attempt
    const tamperedP = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
    const tampered = `${h}.${tamperedP}.${s}`;
    const r = await verifyCredential(tampered);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e === "signature_invalid"));
  });

  it("mutating one byte of the signature fails verification with signature_invalid", async () => {
    const id = freshIdentities();
    const jwt = signCredential({
      issuerDid: id.issuerDid,
      subjectDid: id.holderDid,
      credentialId: "urn:uuid:tamper-s",
      types: ["VerifiableCredential"],
      credentialSubject: {},
      privateKey: id.issuerPriv,
    });
    const [h, p, s] = jwt.split(".");
    const sigBytes = Buffer.from(s, "base64url");
    sigBytes[0] ^= 0x01;
    const tampered = `${h}.${p}.${sigBytes.toString("base64url")}`;
    const r = await verifyCredential(tampered);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e === "signature_invalid"));
  });

  it("a malformed (non-3-segment) JWT fails with malformed_jwt", async () => {
    const r = await verifyCredential("not.a.valid.jwt");
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.startsWith("malformed_jwt")),
      `got ${JSON.stringify(r.errors)}`,
    );
  });
});

describe("VC-JWT — issuer/subject expectation matching", () => {
  it("fails with issuer_mismatch when expectedIssuer differs from jwt.iss", async () => {
    const id = freshIdentities();
    const jwt = signCredential({
      issuerDid: id.issuerDid,
      subjectDid: id.holderDid,
      credentialId: "urn:uuid:iss-mm",
      types: ["VerifiableCredential"],
      credentialSubject: {},
      privateKey: id.issuerPriv,
    });
    const r = await verifyCredential(jwt, {
      expectedIssuer: "did:web:other.example.com",
    });
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.startsWith("issuer_mismatch")),
      `got ${JSON.stringify(r.errors)}`,
    );
  });

  it("fails with subject_mismatch when expectedSubject differs from jwt.sub", async () => {
    const id = freshIdentities();
    const jwt = signCredential({
      issuerDid: id.issuerDid,
      subjectDid: id.holderDid,
      credentialId: "urn:uuid:sub-mm",
      types: ["VerifiableCredential"],
      credentialSubject: {},
      privateKey: id.issuerPriv,
    });
    const r = await verifyCredential(jwt, {
      expectedSubject: "did:key:zSomeOtherSubject",
    });
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.startsWith("subject_mismatch")),
      `got ${JSON.stringify(r.errors)}`,
    );
  });

  it("passes when expectedIssuer and expectedSubject match the JWT", async () => {
    const id = freshIdentities();
    const jwt = signCredential({
      issuerDid: id.issuerDid,
      subjectDid: id.holderDid,
      credentialId: "urn:uuid:exp-match",
      types: ["VerifiableCredential"],
      credentialSubject: {},
      privateKey: id.issuerPriv,
    });
    const r = await verifyCredential(jwt, {
      expectedIssuer: id.issuerDid,
      expectedSubject: id.holderDid,
    });
    assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  });
});

describe("VC-JWT — time bounds (nbf / exp)", () => {
  it("a credential with nbf far in the future is not_yet_valid", async () => {
    const id = freshIdentities();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000); // +1 day
    const jwt = signCredential({
      issuerDid: id.issuerDid,
      subjectDid: id.holderDid,
      credentialId: "urn:uuid:future",
      types: ["VerifiableCredential"],
      credentialSubject: {},
      issuanceDate: future,
      privateKey: id.issuerPriv,
    });
    const r = await verifyCredential(jwt);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.startsWith("not_yet_valid")),
      `got ${JSON.stringify(r.errors)}`,
    );
  });

  it("a credential past its exp is rejected with 'expired'", async () => {
    const id = freshIdentities();
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000); // -2h
    const expired = new Date(Date.now() - 60 * 60 * 1000); // -1h
    const jwt = signCredential({
      issuerDid: id.issuerDid,
      subjectDid: id.holderDid,
      credentialId: "urn:uuid:expired",
      types: ["VerifiableCredential"],
      credentialSubject: {},
      issuanceDate: past,
      expirationDate: expired,
      privateKey: id.issuerPriv,
    });
    const r = await verifyCredential(jwt);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.startsWith("expired")),
      `got ${JSON.stringify(r.errors)}`,
    );
  });

  it("nbf within the documented 5-minute leeway is accepted", async () => {
    const id = freshIdentities();
    // 60s in the future — well inside the 300s leeway, should still validate
    const slightlyFuture = new Date(Date.now() + 60 * 1000);
    const jwt = signCredential({
      issuerDid: id.issuerDid,
      subjectDid: id.holderDid,
      credentialId: "urn:uuid:leeway",
      types: ["VerifiableCredential"],
      credentialSubject: {},
      issuanceDate: slightlyFuture,
      privateKey: id.issuerPriv,
    });
    const r = await verifyCredential(jwt);
    assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  });

  it("opts.now lets the verifier evaluate at a specific point in time", async () => {
    const id = freshIdentities();
    const issuance = new Date("2026-04-01T00:00:00Z");
    const expiry = new Date("2026-04-30T00:00:00Z");
    const jwt = signCredential({
      issuerDid: id.issuerDid,
      subjectDid: id.holderDid,
      credentialId: "urn:uuid:opts-now",
      types: ["VerifiableCredential"],
      credentialSubject: {},
      issuanceDate: issuance,
      expirationDate: expiry,
      privateKey: id.issuerPriv,
    });
    // Inside window
    const inside = await verifyCredential(jwt, {
      now: new Date("2026-04-15T00:00:00Z"),
    });
    assert.equal(inside.ok, true, `errors: ${JSON.stringify(inside.errors)}`);
    // After window
    const after = await verifyCredential(jwt, {
      now: new Date("2026-05-01T00:00:00Z"),
    });
    assert.equal(after.ok, false);
    assert.ok(after.errors.some((e) => e.startsWith("expired")));
  });
});
