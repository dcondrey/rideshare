// @ts-check
/**
 * Spec-vector tests for Ed25519 (RFC 8032 §7.1).
 *
 * Vector source: tests/vectors/ed25519-rfc8032.json
 * Spec: https://datatracker.ietf.org/doc/html/rfc8032#section-7.1
 *
 * For every vector we:
 *   1. Build the Ed25519 private KeyObject from the raw 32-byte seed by
 *      wrapping it in the standard PKCS#8 DER prefix
 *      (302e020100300506032b657004220420 || seed).
 *   2. Derive the public key and assert it matches the spec's publicKey hex.
 *   3. Sign the spec message and assert the signature matches *byte-for-byte*
 *      (Ed25519 signatures are deterministic).
 *   4. Verify the signature against the public key.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

import { setupTestEnv } from "../helpers/env.js";
setupTestEnv();

import {
  ed25519Sign,
  ed25519Verify,
  pubKeyRawBytes,
  pubKeyFromRaw,
} from "../../lib/did.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = join(__dirname, "..", "vectors", "ed25519-rfc8032.json");
const { vectors } = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));

/** PKCS#8 prefix for Ed25519 (per RFC 8410); used to wrap the raw seed. */
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/**
 * Construct a node KeyObject for an Ed25519 private key from its 32-byte raw seed.
 * @param {string} seedHex
 */
function privateKeyFromSeed(seedHex) {
  const seed = Buffer.from(seedHex, "hex");
  assert.equal(seed.length, 32, "Ed25519 seed must be 32 bytes");
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

describe("Ed25519 — RFC 8032 §7.1 reference vectors", () => {
  for (const v of vectors) {
    describe(v.name, () => {
      const privateKey = privateKeyFromSeed(v.secretSeed);
      const publicKey = createPublicKey(privateKey);
      const message = Buffer.from(v.message, "hex");
      const expectedPub = Buffer.from(v.publicKey, "hex");
      const expectedSig = Buffer.from(v.signature, "hex");

      it("derives the spec-correct public key from the seed", () => {
        const raw = pubKeyRawBytes(publicKey);
        assert.equal(
          Buffer.from(raw).toString("hex"),
          expectedPub.toString("hex"),
        );
      });

      it("produces the spec-correct deterministic signature", () => {
        const sig = ed25519Sign(message, privateKey);
        assert.equal(sig.toString("hex"), expectedSig.toString("hex"));
      });

      it("verifies the spec signature against the spec public key", () => {
        assert.equal(
          ed25519Verify(message, expectedSig, publicKey),
          true,
        );
      });

      it("verifies through pubKeyFromRaw(rawPubKey) round-trip", () => {
        const rebuilt = pubKeyFromRaw(expectedPub);
        assert.equal(
          ed25519Verify(message, expectedSig, rebuilt),
          true,
          "verification must succeed when the public key is reconstructed from raw bytes",
        );
      });

      it("rejects a signature with one bit flipped", () => {
        const tampered = Buffer.from(expectedSig);
        tampered[0] ^= 0x01;
        assert.equal(
          ed25519Verify(message, tampered, publicKey),
          false,
        );
      });

      it("rejects the spec signature against a different message", () => {
        const wrongMsg = Buffer.concat([message, Buffer.from([0x00])]);
        assert.equal(
          ed25519Verify(wrongMsg, expectedSig, publicKey),
          false,
        );
      });
    });
  }
});

describe("Ed25519 — node:crypto interop sanity", () => {
  it("ed25519Sign matches node's crypto.sign with null algorithm", () => {
    // Pick TEST 2 (one-byte message) for simplicity
    const v = vectors[1];
    const privateKey = privateKeyFromSeed(v.secretSeed);
    const message = Buffer.from(v.message, "hex");
    const ourSig = ed25519Sign(message, privateKey);
    const refSig = cryptoSign(null, message, privateKey);
    assert.equal(ourSig.toString("hex"), refSig.toString("hex"));
  });

  it("ed25519Verify matches node's crypto.verify with null algorithm", () => {
    const v = vectors[2];
    const privateKey = privateKeyFromSeed(v.secretSeed);
    const publicKey = createPublicKey(privateKey);
    const message = Buffer.from(v.message, "hex");
    const sig = Buffer.from(v.signature, "hex");
    const ourOk = ed25519Verify(message, sig, publicKey);
    const refOk = cryptoVerify(null, message, publicKey, sig);
    assert.equal(ourOk, refOk);
    assert.equal(ourOk, true);
  });
});
