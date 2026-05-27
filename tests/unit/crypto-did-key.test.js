// @ts-check
/**
 * Unit tests for did:key (Ed25519) round-trips.
 *
 * Spec references:
 *   - did:key   https://w3c-ccg.github.io/did-method-key/
 *   - multibase https://github.com/multiformats/multibase
 *   - multicodec for Ed25519 public key = 0xed → varint [0xed, 0x01]
 *
 * Wire format: "did:key:z" + base58btc( 0xed 0x01 || pubkey32 )
 *
 * Public-key bytes come from the RFC 8032 §7.1 vectors so the assertions
 * are anchored to a published reference.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { setupTestEnv } from "../helpers/env.js";
setupTestEnv();

import {
  pubKeyToDidKey,
  didKeyToPubKey,
  didKeyFingerprint,
  base58btcEncode,
} from "../../lib/did.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = join(__dirname, "..", "vectors", "ed25519-rfc8032.json");
const { vectors } = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));

describe("did:key — round-trip with RFC 8032 keys", () => {
  for (const v of vectors) {
    it(`encodes and decodes ${v.name} losslessly`, () => {
      const pub = Buffer.from(v.publicKey, "hex");
      const did = pubKeyToDidKey(pub);
      assert.match(did, /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);
      const back = didKeyToPubKey(did);
      assert.equal(Buffer.from(back).toString("hex"), v.publicKey);
    });
  }
});

describe("did:key — encoding shape", () => {
  it("starts with 'did:key:z' and contains the multicodec-prefixed key in base58btc", () => {
    const pub = Buffer.from(vectors[0].publicKey, "hex");
    const did = pubKeyToDidKey(pub);
    assert.ok(did.startsWith("did:key:z"));
    const expectedSuffix = base58btcEncode(
      Buffer.concat([Buffer.from([0xed, 0x01]), pub]),
    );
    assert.equal(did, `did:key:z${expectedSuffix}`);
  });

  it("encoding is deterministic across repeated calls", () => {
    const pub = Buffer.from(vectors[1].publicKey, "hex");
    const a = pubKeyToDidKey(pub);
    const b = pubKeyToDidKey(pub);
    const c = pubKeyToDidKey(Uint8Array.from(pub));
    assert.equal(a, b);
    assert.equal(a, c);
  });

  it("didKeyFingerprint returns just the 'z…' multibase part", () => {
    const pub = Buffer.from(vectors[2].publicKey, "hex");
    const did = pubKeyToDidKey(pub);
    const fp = didKeyFingerprint(did);
    assert.match(fp, /^z[1-9A-HJ-NP-Za-km-z]+$/);
    assert.equal(`did:key:${fp}`, did);
  });
});

describe("did:key — malformed input rejection", () => {
  it("rejects strings without the 'did:key:' prefix", () => {
    assert.throws(() => didKeyToPubKey("did:web:example.com"), /did:key/);
    assert.throws(() => didKeyToPubKey("not-a-did"), /did:key/);
    assert.throws(() => didKeyToPubKey(""), /did:key/);
  });

  it("rejects non-string inputs", () => {
    // @ts-expect-error testing runtime guard
    assert.throws(() => didKeyToPubKey(null), /string/);
    // @ts-expect-error testing runtime guard
    assert.throws(() => didKeyToPubKey(undefined), /string/);
    // @ts-expect-error testing runtime guard
    assert.throws(() => didKeyToPubKey(1234), /string/);
  });

  it("rejects did:key with multibase prefix other than 'z'", () => {
    // 'm' = base64, 'b' = base32 — neither is allowed for did:key Ed25519
    assert.throws(() => didKeyToPubKey("did:key:mAAAA"), /did:key/);
  });

  it("rejects did:key containing characters outside the base58btc alphabet", () => {
    // '0', 'O', 'I', 'l' are intentionally absent from base58btc.
    assert.throws(
      () => didKeyToPubKey("did:key:z0OIl"),
      /did:key/,
    );
  });

  it("rejects did:key with a non-Ed25519 multicodec prefix", () => {
    // Use 0x12 0x00 (sha2-256 multihash codec) instead of 0xed 0x01
    const fakePub = Buffer.from(vectors[0].publicKey, "hex");
    const wrong = base58btcEncode(
      Buffer.concat([Buffer.from([0x12, 0x00]), fakePub]),
    );
    assert.throws(
      () => didKeyToPubKey(`did:key:z${wrong}`),
      /Ed25519|multicodec/,
    );
  });

  it("rejects truncated did:key (length mismatch after multicodec)", () => {
    const truncated = Buffer.concat([
      Buffer.from([0xed, 0x01]),
      Buffer.from(vectors[0].publicKey, "hex").subarray(0, 16),
    ]);
    const did = `did:key:z${base58btcEncode(truncated)}`;
    assert.throws(() => didKeyToPubKey(did), /Ed25519|multicodec|length/);
  });

  it("pubKeyToDidKey rejects non-32-byte input", () => {
    assert.throws(() => pubKeyToDidKey(new Uint8Array(31)), /32 bytes/);
    assert.throws(() => pubKeyToDidKey(new Uint8Array(33)), /32 bytes/);
    assert.throws(() => pubKeyToDidKey(new Uint8Array(0)), /32 bytes/);
  });
});
