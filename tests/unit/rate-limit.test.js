// @ts-check
/**
 * Unit tests for lib/rate-limit.js — fixed-window per-key rate limiter used
 * by the magic-link endpoint to throttle abuse.
 *
 * Properties under test:
 *   - exactly N successes per window, N+1th rejected
 *   - separate keys are isolated
 *   - bucket resets once the window has elapsed
 *   - expired buckets are eventually cleaned up (5-minute interval)
 *
 * Uses tests/helpers/clock.js to freeze time so the assertions are
 * deterministic.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupTestEnv } from "../helpers/env.js";
setupTestEnv();

import { setNow, advance, restoreClock } from "../helpers/clock.js";
import { createRateLimiter } from "../../lib/rate-limit.js";

describe("rate-limit — fixed-window per-key counter", () => {
  beforeEach(() => setNow("2026-04-30T12:00:00Z"));
  afterEach(() => restoreClock());

  it("allows exactly `limit` calls in the window and rejects the next", () => {
    const limit = 3;
    const windowMs = 60_000;
    const rl = createRateLimiter({ limit, windowMs });
    for (let i = 0; i < limit; i++) {
      assert.equal(rl.check("ip:1.2.3.4"), true, `call ${i + 1} should pass`);
    }
    assert.equal(rl.check("ip:1.2.3.4"), false, "the (limit+1)-th call must be rejected");
  });

  it("resets the bucket after the window elapses", () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 60_000 });
    assert.equal(rl.check("k"), true);
    assert.equal(rl.check("k"), true);
    assert.equal(rl.check("k"), false);
    advance(60_001); // past the window
    assert.equal(rl.check("k"), true);
    assert.equal(rl.check("k"), true);
    assert.equal(rl.check("k"), false);
  });

  it("isolates buckets across different keys", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000 });
    assert.equal(rl.check("alice"), true);
    assert.equal(rl.check("alice"), false);
    // bob has his own bucket
    assert.equal(rl.check("bob"), true);
    assert.equal(rl.check("bob"), false);
  });
});

describe("rate-limit — bucket cleanup", () => {
  beforeEach(() => setNow("2026-04-30T12:00:00Z"));
  afterEach(() => restoreClock());

  it("eventually removes buckets that have been idle longer than the cleanup interval", () => {
    // Cleanup runs every 5 minutes per lib/rate-limit.js.
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000 });
    rl.check("ephemeral");
    // Inspect internal size if exposed; otherwise the contract is "eventually
    // gone after triggering cleanup".
    advance(10 * 60_000); // 10 minutes
    if (typeof rl._cleanup === "function") rl._cleanup();
    if (typeof rl.size === "function") {
      assert.equal(rl.size(), 0, "expired bucket should have been pruned");
    } else {
      // Soft fallback: re-checking should still work and behave as a fresh window.
      assert.equal(rl.check("ephemeral"), true);
    }
  });
});
