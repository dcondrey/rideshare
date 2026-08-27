// @ts-check
/**
 * Unit tests for lib/rate-limit.js — fixed-window per-key rate limiter used
 * by the magic-link and admin endpoints to throttle abuse.
 *
 * Properties under test:
 *   - exactly N successes per window, N+1th rejected
 *   - separate keys are isolated
 *   - bucket resets once the window has elapsed
 *
 * Uses tests/helpers/clock.js to freeze time so the assertions are
 * deterministic.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupTestEnv } from "../helpers/env.js";
setupTestEnv();

import { setNow, advance, restoreClock } from "../helpers/clock.js";
import { rateLimit } from "../../lib/rate-limit.js";

describe("rate-limit — fixed-window per-key counter", () => {
  beforeEach(() => setNow("2026-04-30T12:00:00Z"));
  afterEach(() => restoreClock());

  it("allows exactly `limit` calls in the window and rejects the next", () => {
    const limit = 3;
    const windowMs = 60_000;
    const key = "ip:1.2.3.4";
    for (let i = 0; i < limit; i++) {
      assert.equal(rateLimit(key, limit, windowMs).ok, true, `call ${i + 1} should pass`);
    }
    assert.equal(rateLimit(key, limit, windowMs).ok, false, "the (limit+1)-th call must be rejected");
  });

  it("resets the bucket after the window elapses", () => {
    const limit = 2;
    const windowMs = 60_000;
    const key = "k";
    assert.equal(rateLimit(key, limit, windowMs).ok, true);
    assert.equal(rateLimit(key, limit, windowMs).ok, true);
    assert.equal(rateLimit(key, limit, windowMs).ok, false);
    advance(windowMs + 1); // past the window
    assert.equal(rateLimit(key, limit, windowMs).ok, true);
    assert.equal(rateLimit(key, limit, windowMs).ok, true);
    assert.equal(rateLimit(key, limit, windowMs).ok, false);
  });

  it("isolates buckets across different keys", () => {
    const limit = 1;
    const windowMs = 60_000;
    assert.equal(rateLimit("alice", limit, windowMs).ok, true);
    assert.equal(rateLimit("alice", limit, windowMs).ok, false);
    // bob has his own bucket
    assert.equal(rateLimit("bob", limit, windowMs).ok, true);
    assert.equal(rateLimit("bob", limit, windowMs).ok, false);
  });

  it("reports remaining and retryAfterMs", () => {
    const limit = 2;
    const windowMs = 60_000;
    const key = "quota";
    const first = rateLimit(key, limit, windowMs);
    assert.equal(first.ok, true);
    assert.equal(first.remaining, 1);
    const second = rateLimit(key, limit, windowMs);
    assert.equal(second.ok, true);
    assert.equal(second.remaining, 0);
    const third = rateLimit(key, limit, windowMs);
    assert.equal(third.ok, false);
    assert.equal(third.remaining, 0);
    assert.ok(third.retryAfterMs > 0);
  });
});
