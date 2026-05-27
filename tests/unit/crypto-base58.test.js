// @ts-check
/**
 * Spec-vector tests for base58btc (Bitcoin alphabet).
 *
 * Vector source: tests/vectors/base58btc.json (curated subset of
 *   https://github.com/bitcoin/bitcoin/blob/master/src/test/data/base58_encode_decode.json
 *   plus W3C did:key examples).
 *
 * For every vector we assert:
 *   1. encode(bytes)        === expected_string
 *   2. decode(expected_string) === bytes
 * plus a randomized round-trip stress test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { setupTestEnv } from "../helpers/env.js";
setupTestEnv();

import { base58btcEncode, base58btcDecode } from "../../lib/did.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = join(__dirname, "..", "vectors", "base58btc.json");
const { vectors } = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));

/** @param {string} hex */
function hexToBytes(hex) {
  if (hex === "") return new Uint8Array(0);
  if (hex.length % 2 !== 0) throw new Error(`bad hex: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("base58btc — RFC/Bitcoin reference vectors", () => {
  for (const v of vectors) {
    const label = v.bytesHex === "" ? "<empty>" : v.bytesHex;
    it(`encodes hex ${label} to "${v.encoded}"`, () => {
      const bytes = hexToBytes(v.bytesHex);
      assert.equal(base58btcEncode(bytes), v.encoded);
    });
    it(`decodes "${v.encoded}" to hex ${label}`, () => {
      const expected = hexToBytes(v.bytesHex);
      const decoded = base58btcDecode(v.encoded);
      assert.ok(
        bytesEqual(decoded, expected),
        `expected ${v.bytesHex}, got ${Buffer.from(decoded).toString("hex")}`,
      );
    });
  }
});

describe("base58btc — randomized round-trip", () => {
  it("100 random inputs of varied lengths (0..256) round-trip", () => {
    for (let i = 0; i < 100; i++) {
      // Length distribution: 0..256, biased to include short and long
      const len = i === 0 ? 0 : Math.floor(Math.random() * 257);
      const bytes = new Uint8Array(randomBytes(len));
      const encoded = base58btcEncode(bytes);
      const decoded = base58btcDecode(encoded);
      assert.ok(
        bytesEqual(decoded, bytes),
        `round-trip failed at iter=${i} len=${len} encoded=${encoded}`,
      );
    }
  });

  it("preserves leading zero bytes (which encode as leading '1' chars)", () => {
    for (let zeros = 0; zeros <= 8; zeros++) {
      const tail = new Uint8Array(randomBytes(16));
      const bytes = new Uint8Array(zeros + tail.length);
      bytes.set(tail, zeros);
      const encoded = base58btcEncode(bytes);
      // Each leading zero byte must produce exactly one leading "1"
      assert.ok(
        encoded.slice(0, zeros) === "1".repeat(zeros),
        `expected ${zeros} leading "1" chars in "${encoded}"`,
      );
      const decoded = base58btcDecode(encoded);
      assert.ok(bytesEqual(decoded, bytes));
    }
  });
});

describe("base58btc — invalid input rejection", () => {
  it("decode throws on a character outside the base58 alphabet", () => {
    // '0', 'O', 'I', 'l' are intentionally absent from base58btc
    assert.throws(() => base58btcDecode("0OIl"), /base58/i);
    assert.throws(() => base58btcDecode("hello!"), /base58/i);
  });
});
