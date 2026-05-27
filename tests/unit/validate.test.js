// @ts-check
/**
 * Boundary tests for lib/validate.js validators.
 *
 * API (real, double-checked against source):
 *   reqString(value, field, { min=1, max=500 } = {})
 *   optString(value, field, { max=500 } = {})  → returns null when empty
 *   reqInt   (value, field, { min=0, max=1000 } = {})
 *   oneOf    (value, field, allowed[])
 *   email    (value, field="email")
 *   isoDate  (value, field)
 *   hhmm     (value, field)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  reqString,
  optString,
  reqInt,
  oneOf,
  email,
  isoDate,
  hhmm,
  ValidationError,
} from "../../lib/validate.js";

/** Assert that fn throws a ValidationError carrying the given field name. */
function throwsValidation(fn, field) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ValidationError, `not a ValidationError: ${err}`);
    assert.equal(err.field, field, `field mismatch: ${err.field}`);
    assert.ok(typeof err.userMessage === "string" && err.userMessage.length > 0);
    return true;
  });
}

describe("reqString", () => {
  it("returns the trimmed string on happy path", () => {
    assert.equal(reqString("  alice  ", "name"), "alice");
  });

  it("rejects empty string", () => {
    throwsValidation(() => reqString("", "name"), "name");
    throwsValidation(() => reqString("   ", "name"), "name");
  });

  it("rejects non-string types", () => {
    throwsValidation(() => reqString(undefined, "name"), "name");
    throwsValidation(() => reqString(null, "name"), "name");
    throwsValidation(() => reqString(123, "name"), "name");
  });

  it("enforces max length", () => {
    throwsValidation(() => reqString("x".repeat(11), "name", { max: 10 }), "name");
    assert.equal(reqString("x".repeat(10), "name", { max: 10 }), "x".repeat(10));
  });

  it("enforces min length", () => {
    throwsValidation(() => reqString("ab", "name", { min: 3 }), "name");
    assert.equal(reqString("abc", "name", { min: 3 }), "abc");
  });
});

describe("optString", () => {
  it("returns null for missing/empty values", () => {
    assert.equal(optString(undefined, "note"), null);
    assert.equal(optString(null, "note"), null);
    assert.equal(optString("", "note"), null);
    assert.equal(optString("   ", "note"), null);
  });

  it("returns the trimmed string when present", () => {
    assert.equal(optString("  hi  ", "note"), "hi");
  });

  it("rejects non-string non-empty types", () => {
    throwsValidation(() => optString(123, "note"), "note");
  });

  it("enforces max length", () => {
    throwsValidation(() => optString("x".repeat(11), "note", { max: 10 }), "note");
  });
});

describe("reqInt", () => {
  it("parses integer-shaped strings and numbers", () => {
    assert.equal(reqInt("4", "seats"), 4);
    assert.equal(reqInt(7, "seats"), 7);
    assert.equal(reqInt("0", "seats", { min: 0 }), 0);
  });

  it("rejects non-numeric inputs", () => {
    throwsValidation(() => reqInt("abc", "seats"), "seats");
    throwsValidation(() => reqInt(NaN, "seats"), "seats");
    throwsValidation(() => reqInt(Infinity, "seats"), "seats");
    throwsValidation(() => reqInt(undefined, "seats"), "seats");
  });

  it("enforces inclusive min/max bounds", () => {
    throwsValidation(() => reqInt(-1, "seats", { min: 0 }), "seats");
    throwsValidation(() => reqInt(11, "seats", { max: 10 }), "seats");
    assert.equal(reqInt(0, "seats", { min: 0, max: 10 }), 0);
    assert.equal(reqInt(10, "seats", { min: 0, max: 10 }), 10);
  });
});

describe("oneOf", () => {
  it("accepts a value present in the choices", () => {
    assert.equal(oneOf("offer", "kind", ["offer", "request"]), "offer");
  });

  it("rejects a value not present in the choices", () => {
    throwsValidation(() => oneOf("nope", "kind", ["offer", "request"]), "kind");
  });

  it("rejects missing/non-string values", () => {
    throwsValidation(() => oneOf(undefined, "kind", ["a", "b"]), "kind");
    throwsValidation(() => oneOf(null, "kind", ["a", "b"]), "kind");
    throwsValidation(() => oneOf(1, "kind", ["a", "b"]), "kind");
  });
});

describe("email", () => {
  it("accepts well-formed addresses and lowercases", () => {
    assert.equal(email("alice@example.com"), "alice@example.com");
    assert.equal(email("ALICE@Example.COM"), "alice@example.com");
    assert.equal(email("alice+tag@example.co.uk"), "alice+tag@example.co.uk");
  });

  it("rejects malformed addresses", () => {
    throwsValidation(() => email("not-an-email"), "email");
    throwsValidation(() => email("a@b"), "email");
    throwsValidation(() => email("@b.com"), "email");
    throwsValidation(() => email("a@@b.com"), "email");
    throwsValidation(() => email("a b@example.com"), "email");
  });

  it("rejects empty input", () => {
    throwsValidation(() => email(""), "email");
    throwsValidation(() => email(undefined), "email");
  });

  it("uses the supplied field name", () => {
    throwsValidation(() => email("nope", "contactEmail"), "contactEmail");
  });
});

describe("isoDate", () => {
  it("accepts a well-formed YYYY-MM-DD and returns it", () => {
    assert.equal(isoDate("2026-04-21", "depart_date"), "2026-04-21");
  });

  it("rejects strings that don't match YYYY-MM-DD", () => {
    throwsValidation(() => isoDate("2026/04/21", "depart_date"), "depart_date");
    throwsValidation(() => isoDate("21-04-2026", "depart_date"), "depart_date");
    throwsValidation(() => isoDate("2026-4-21", "depart_date"), "depart_date");
    throwsValidation(() => isoDate("", "depart_date"), "depart_date");
  });

  it("rejects calendar-impossible dates", () => {
    throwsValidation(() => isoDate("2026-02-30", "depart_date"), "depart_date");
    throwsValidation(() => isoDate("2026-13-01", "depart_date"), "depart_date");
  });
});

describe("hhmm", () => {
  it("accepts well-formed HH:MM (24h)", () => {
    assert.equal(hhmm("00:00", "time"), "00:00");
    assert.equal(hhmm("09:30", "time"), "09:30");
    assert.equal(hhmm("23:59", "time"), "23:59");
  });

  it("rejects out-of-range hours/minutes", () => {
    throwsValidation(() => hhmm("24:00", "time"), "time");
    throwsValidation(() => hhmm("12:60", "time"), "time");
  });

  it("rejects ill-formed strings", () => {
    throwsValidation(() => hhmm("9:30", "time"), "time");   // not zero-padded
    throwsValidation(() => hhmm("9:3", "time"), "time");
    throwsValidation(() => hhmm("nope", "time"), "time");
  });
});

describe("ValidationError", () => {
  it("carries the field name and a non-empty user message", () => {
    try {
      reqString("", "myField");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.field, "myField");
      assert.ok(typeof err.userMessage === "string" && err.userMessage.length > 0);
    }
  });
});
