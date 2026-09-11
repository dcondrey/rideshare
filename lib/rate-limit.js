// @ts-check
/**
 * In-memory token-bucket rate limiter. Resets on process restart.
 *
 * For an event-scale app (single instance, ~hundreds of users) this is
 * sufficient. If you ever scale horizontally, replace with a DB-backed
 * counter — the call surface here is the only thing to change.
 */

const buckets = new Map();

/**
 * @param {string} key — anything unique (e.g. "magic:user@x.com" or "ip:1.2.3.4")
 * @param {number} limit — max events per window
 * @param {number} windowMs — window length in milliseconds
 * @returns {{ ok: boolean, remaining: number, retryAfterMs: number }}
 */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterMs: 0 };
  }
  if (bucket.count >= limit) {
    return { ok: false, remaining: 0, retryAfterMs: bucket.resetAt - now };
  }
  bucket.count += 1;
  return { ok: true, remaining: limit - bucket.count, retryAfterMs: 0 };
}

// Periodic cleanup so the Map can't grow unbounded on a long-running process.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}, CLEANUP_INTERVAL_MS).unref();
