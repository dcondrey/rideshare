// @ts-check
/**
 * Deterministic clock. Tests that depend on time call `setNow(...)` to fix
 * the clock and `restoreClock()` in teardown.
 *
 * Patches `Date.now` and `Date` constructor globally — be sure to restore.
 */

const realDateNow = Date.now;
const RealDate = global.Date;

let frozenAt = null;

/** @param {number | string | Date} t */
export function setNow(t) {
  const ms = typeof t === "number" ? t : new RealDate(t).getTime();
  frozenAt = ms;
  Date.now = () => frozenAt;
  // Patch the Date constructor so `new Date()` (no args) returns frozen time
  /** @type {any} */
  const FakeDate = function (...args) {
    if (args.length === 0) return new RealDate(frozenAt);
    return new RealDate(...args);
  };
  FakeDate.now = () => frozenAt;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  // @ts-expect-error
  global.Date = FakeDate;
}

/** Advance the frozen clock by n milliseconds. */
export function advance(ms) {
  if (frozenAt == null) throw new Error("setNow() first");
  frozenAt += ms;
}

export function restoreClock() {
  Date.now = realDateNow;
  // @ts-expect-error
  global.Date = RealDate;
  frozenAt = null;
}
