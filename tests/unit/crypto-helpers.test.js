// @ts-check
/**
 * Unit tests for lib/crypto.js — HMAC, constant-time comparison, random
 * tokens, email normalization, allowlist hashing, signed payloads.
 *
 * Spec references:
 *   - HMAC-SHA256: RFC 2104 + FIPS 180-4
 *   - timingSafeEqual: Node docs (constant-time string equality)
 */
import "../helpers/setup.js"; // sets process.env defaults before lib/config.js loads
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { setupTestEnv } from "../helpers/env.js";
setupTestEnv();

import {
  hmac,
  safeEqual,
  randomToken,
  normalizeEmail,
  hashEmailForAllowlist,
  signPayload,
  verifyPayload,
} from "../../lib/crypto.js";

describe("hmac", () => {
  it("produces a deterministic 64-char hex digest for a given message+key", () => {
    const a = hmac("hello", "key");
    const b = hmac("hello", "key");
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it("differs when the message changes (avalanche)", () => {
    const a = hmac("hello", "k");
    const b = hmac("hellp", "k");
    assert.notEqual(a, b);
  });

  it("differs when the key changes", () => {
    const a = hmac("msg", "k1");
    const b = hmac("msg", "k2");
    assert.notEqual(a, b);
  });
});

describe("safeEqual", () => {
  it("returns true for equal strings of equal length", () => {
    assert.equal(safeEqual("abcd", "abcd"), true);
  });

  it("returns false for unequal strings of equal length", () => {
    assert.equal(safeEqual("abcd", "abce"), false);
  });

  it("returns false for length mismatches without throwing", () => {
    assert.equal(safeEqual("abc", "abcd"), false);
    assert.equal(safeEqual("", "x"), false);
  });

  it("returns false for non-string inputs (defensive)", () => {
    // @ts-expect-error testing runtime guard
    assert.equal(safeEqual(null, "x"), false);
    // @ts-expect-error testing runtime guard
    assert.equal(safeEqual("x", undefined), false);
    // @ts-expect-error testing runtime guard
    assert.equal(safeEqual(123, 123), false);
  });
});

describe("randomToken", () => {
  it("default token is base64url and >= 32 bytes worth of entropy", () => {
    const t = randomToken();
    assert.match(t, /^[A-Za-z0-9_-]+$/);
    // 32 bytes → base64url ≈ 43 chars (no padding)
    assert.ok(t.length >= 40, `expected length ≥ 40, got ${t.length}`);
  });

  it("custom byte length scales the output", () => {
    const t16 = randomToken(16);
    const t64 = randomToken(64);
    assert.ok(t16.length < t64.length);
  });

  it("30 successive calls produce 30 distinct tokens (entropy check)", () => {
    const seen = new Set();
    for (let i = 0; i < 30; i++) seen.add(randomToken());
    assert.equal(seen.size, 30);
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims surrounding whitespace", () => {
    assert.equal(normalizeEmail("  Foo@Example.COM  "), "foo@example.com");
  });

  it("strips +tag from any provider's local-part", () => {
    assert.equal(normalizeEmail("alice+conf@example.com"), "alice@example.com");
    assert.equal(normalizeEmail("bob+a+b@proton.me"), "bob@proton.me");
  });

  it("strips dots in the local-part for gmail.com and googlemail.com", () => {
    assert.equal(normalizeEmail("a.l.i.c.e@gmail.com"), "alice@gmail.com");
    assert.equal(normalizeEmail("a.l.i.c.e@googlemail.com"), "alice@googlemail.com");
  });

  it("preserves dots in non-gmail local-parts", () => {
    assert.equal(normalizeEmail("a.l.i.c.e@example.com"), "a.l.i.c.e@example.com");
    assert.equal(normalizeEmail("a.l.i.c.e@proton.me"), "a.l.i.c.e@proton.me");
  });

  it("combines +tag stripping and gmail dot stripping", () => {
    assert.equal(
      normalizeEmail("Al.Ice+SignUp@Gmail.com"),
      "alice@gmail.com",
    );
  });

  it("returns empty string for non-string inputs (defensive)", () => {
    // @ts-expect-error
    assert.equal(normalizeEmail(null), "");
    // @ts-expect-error
    assert.equal(normalizeEmail(undefined), "");
    // @ts-expect-error
    assert.equal(normalizeEmail(42), "");
  });

  it("returns the trimmed/lowercased input when there is no '@'", () => {
    assert.equal(normalizeEmail("not-an-email"), "not-an-email");
    assert.equal(normalizeEmail("  WeIRD  "), "weird");
  });
});

describe("hashEmailForAllowlist", () => {
  it("is consistent across normalized variants of the same gmail address", () => {
    const a = hashEmailForAllowlist("Alice+Conference@Gmail.com");
    const b = hashEmailForAllowlist("a.l.i.c.e@gmail.com");
    const c = hashEmailForAllowlist("alice@gmail.com");
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it("returns a 64-char hex string (SHA-256 HMAC)", () => {
    assert.match(hashEmailForAllowlist("alice@example.com"), /^[0-9a-f]{64}$/);
  });

  it("differs for different normalized emails", () => {
    const a = hashEmailForAllowlist("alice@example.com");
    const b = hashEmailForAllowlist("bob@example.com");
    assert.notEqual(a, b);
  });
});

describe("signPayload / verifyPayload", () => {
  it("round-trips a JSON-serializable object", () => {
    const payload = { sub: "alice@example.com", purpose: "magic-link", n: 7 };
    const token = signPayload(payload);
    assert.equal(typeof token, "string");
    assert.match(token, /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    const back = verifyPayload(token);
    assert.deepEqual(back, payload);
  });

  it("returns null when the signature is wrong", () => {
    const token = signPayload({ x: 1 });
    const [body, sig] = token.split(".");
    const tampered = `${body}.${"0".repeat(sig.length)}`;
    assert.equal(verifyPayload(tampered), null);
  });

  it("returns null when the body has been tampered with", () => {
    const token = signPayload({ x: 1 });
    const [body, sig] = token.split(".");
    // Replace a char in the body so the body is still base64url-shaped but
    // the HMAC won't match.
    const flipped = body.charAt(0) === "A"
      ? "B" + body.slice(1)
      : "A" + body.slice(1);
    assert.equal(verifyPayload(`${flipped}.${sig}`), null);
  });

  it("returns null for non-string and structurally-invalid inputs", () => {
    // @ts-expect-error
    assert.equal(verifyPayload(null), null);
    // @ts-expect-error
    assert.equal(verifyPayload(undefined), null);
    assert.equal(verifyPayload(""), null);
    assert.equal(verifyPayload("nodothere"), null);
  });
});
