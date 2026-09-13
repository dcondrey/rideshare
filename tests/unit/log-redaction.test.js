// @ts-check
/**
 * Unit tests for lib/log.js — operator output must never carry an attendee's
 * email address.
 *
 * Addresses reach the logger indirectly: a mail relay echoes the recipient in a
 * bounce, that text becomes an Error message, and the Error is logged whole.
 * The fixtures below are real SMTP and Resend reply shapes, not strings written
 * to match the regex.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { error as logError, warn as logWarn } from "../../lib/log.js";

/**
 * @param {() => void} fn
 * @returns {string}
 */
function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

describe("log redaction — email addresses never reach stderr", () => {
  it("redacts the recipient echoed back in an SMTP bounce", () => {
    const err = new Error(
      "SMTP unexpected response: 550 5.1.1 Recipient address rejected: alice.smith+conf@example.com",
    );
    const out = captureStderr(() => logError("magic-link send failed", { component: "auth", err }));
    assert.ok(!out.includes("alice.smith"), `local part leaked: ${out}`);
    assert.ok(!out.includes("+conf"), `plus tag leaked: ${out}`);
    assert.match(out, /\[redacted\]@example\.com/);
    // The domain and the SMTP code survive, or the line is useless to an operator.
    assert.match(out, /550 5\.1\.1/);
  });

  it("redacts an address inside a Resend JSON error body", () => {
    const err = new Error(
      'Resend send failed (422): {"message":"Invalid `to` field: bob@sub.domain.co.uk"}',
    );
    const out = captureStderr(() =>
      logWarn("transient email send failure, retrying", { component: "email", attempt: 1, err }),
    );
    assert.ok(!out.includes("bob@"), `address leaked: ${out}`);
    assert.match(out, /\[redacted\]@sub\.domain\.co\.uk/);
  });

  it("redacts every address when a message carries more than one", () => {
    const out = captureStderr(() =>
      logError("relay rejected batch", { err: new Error("a@x.com and b@y.org both rejected") }),
    );
    assert.ok(!/\ba@x\.com\b/.test(out), `first address leaked: ${out}`);
    assert.ok(!/\bb@y\.org\b/.test(out), `second address leaked: ${out}`);
  });

  it("still strips CR/LF so a redacted value cannot forge a log line", () => {
    const out = captureStderr(() =>
      logError("boom", { err: new Error('x@y.com\r\nlevel=error msg="forged"') }),
    );
    assert.equal(out.split("\n").filter(Boolean).length, 1);
  });
});

describe("log field allowlist — only named fields reach stderr", () => {
  it("writes an allowlisted field", () => {
    const out = captureStderr(() => logWarn("boot", { component: "config" }));
    assert.match(out, /component=config/);
  });

  it("drops an unknown field and names it without its value", () => {
    const out = captureStderr(() =>
      logWarn("key loaded", { component: "keys", private_key_jwk: '{"d":"AAAAsecret"}' }),
    );
    assert.match(out, /component=keys/);
    assert.doesNotMatch(out, /AAAAsecret/);
    assert.match(out, /dropped_fields="private_key_jwk"/);
  });

  it("cannot be used to forge a log line through a field name", () => {
    const out = captureStderr(() => logError("x", { 'a\nlevel=error msg="forged"': 1 }));
    assert.equal(out.split("\n").filter(Boolean).length, 1);
  });
});
