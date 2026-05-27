// @ts-check
/**
 * Unit tests for the in-house YAML loader (lib/yaml.js).
 *
 * This is intentionally a tiny, supported-subset parser — the goal is the
 * features needed by event.config.yaml, not the full YAML 1.2 spec. Tests
 * pin the supported subset (and the errors raised outside it) so reviewers
 * can quickly see what is and isn't accepted.
 *
 * Supported subset under test:
 *   - flat scalars: string, int, float, bool, null (`null`, `~`, `Null`, `NULL`)
 *   - quoted strings (single, double, embedded escape sequences)
 *   - mappings (flat, nested, deeply nested via indentation)
 *   - sequences (scalar items, "- key: value" items, mixed)
 *   - comments (full-line, end-of-line; '#' inside quoted strings is preserved)
 *   - empty values (`key:` → null)
 *   - BOM at start of file
 *
 * Errors:
 *   - tabs for indentation
 *   - ambiguous unquoted string containing ": "
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { setupTestEnv } from "../helpers/env.js";
setupTestEnv();

import { parseYaml } from "../../lib/yaml.js";

describe("yaml — flat scalars at top level", () => {
  it("parses string, int, float, bool, null in a flat mapping", () => {
    const out = parseYaml(
      [
        "name: DEFCON 33",
        "year: 2026",
        "ratio: 1.5",
        "active: true",
        "inactive: false",
        "explicit_null: null",
        "tilde_null: ~",
        "empty:",
      ].join("\n"),
    );
    assert.equal(out.name, "DEFCON 33");
    assert.equal(out.year, 2026);
    assert.equal(out.ratio, 1.5);
    assert.equal(out.active, true);
    assert.equal(out.inactive, false);
    assert.equal(out.explicit_null, null);
    assert.equal(out.tilde_null, null);
    assert.equal(out.empty, null);
  });
});

describe("yaml — quoted strings", () => {
  it("parses single-quoted strings as literal", () => {
    const out = parseYaml(`note: 'hello world'`);
    assert.equal(out.note, "hello world");
  });

  it("parses double-quoted strings", () => {
    const out = parseYaml(`note: "hello world"`);
    assert.equal(out.note, "hello world");
  });

  it("preserves embedded escape sequences in double-quoted strings", () => {
    const out = parseYaml(`note: "line1\\nline2\\t\\"quoted\\""`);
    assert.equal(out.note, 'line1\nline2\t"quoted"');
  });

  it("preserves '#' inside a quoted string (not treated as a comment)", () => {
    const out = parseYaml(`tag: "rideshare #defcon"`);
    assert.equal(out.tag, "rideshare #defcon");
  });

  it("preserves ': ' inside a quoted string", () => {
    const out = parseYaml(`url: "https://example.com:9999/path"`);
    assert.equal(out.url, "https://example.com:9999/path");
  });
});

describe("yaml — nested mappings", () => {
  it("parses two-level nested mapping", () => {
    const out = parseYaml(
      [
        "event:",
        "  name: DEFCON 33",
        "  year: 2026",
      ].join("\n"),
    );
    assert.deepEqual(out, { event: { name: "DEFCON 33", year: 2026 } });
  });

  it("parses deeply nested mappings (3+ levels)", () => {
    const out = parseYaml(
      [
        "a:",
        "  b:",
        "    c:",
        "      d: deep",
      ].join("\n"),
    );
    assert.deepEqual(out, { a: { b: { c: { d: "deep" } } } });
  });
});

describe("yaml — sequences", () => {
  it("parses a sequence of scalar items", () => {
    const out = parseYaml(["fruits:", "  - apple", "  - pear", "  - 1"].join("\n"));
    assert.deepEqual(out.fruits, ["apple", "pear", 1]);
  });

  it("parses a sequence of mapping items '- key: value'", () => {
    const out = parseYaml(
      [
        "rides:",
        "  - id: r1",
        "    seats: 3",
        "  - id: r2",
        "    seats: 4",
      ].join("\n"),
    );
    assert.deepEqual(out.rides, [
      { id: "r1", seats: 3 },
      { id: "r2", seats: 4 },
    ]);
  });

  it("parses sequences with multiple keys per mapping item", () => {
    const out = parseYaml(
      [
        "items:",
        "  - name: a",
        "    qty: 1",
        "    tag: x",
        "  - name: b",
        "    qty: 2",
      ].join("\n"),
    );
    assert.deepEqual(out.items, [
      { name: "a", qty: 1, tag: "x" },
      { name: "b", qty: 2 },
    ]);
  });
});

describe("yaml — comments", () => {
  it("ignores full-line comments", () => {
    const out = parseYaml(
      ["# this is a comment", "name: foo", "# another comment"].join("\n"),
    );
    assert.deepEqual(out, { name: "foo" });
  });

  it("ignores end-of-line comments after a value", () => {
    const out = parseYaml("name: foo  # inline comment");
    assert.equal(out.name, "foo");
  });

  it("does NOT strip '#' that appears inside a quoted string", () => {
    const out = parseYaml(`tag: "value #1"  # real comment`);
    assert.equal(out.tag, "value #1");
  });
});

describe("yaml — file-level concerns", () => {
  it("strips a leading UTF-8 BOM (\\uFEFF)", () => {
    const out = parseYaml("﻿name: bom-test\nyear: 2026");
    assert.equal(out.name, "bom-test");
    assert.equal(out.year, 2026);
  });

  it("throws on tab indentation", () => {
    const src = "event:\n\tname: nope";
    assert.throws(() => parseYaml(src), /tab/i);
  });

  it("throws on ambiguous unquoted string containing ': '", () => {
    // "https://x: y" looks like "key: value" embedded in a value — the parser
    // refuses rather than guessing.
    const src = `note: https://example.com: 9999`;
    assert.throws(() => parseYaml(src), /[Aa]mbiguous|':\s'/);
  });
});

describe("yaml — representative event.config.yaml-shaped input", () => {
  it("parses an event-config-like document into the expected shape", () => {
    const src = [
      "# Event configuration",
      "event:",
      "  name: DEFCON 33",
      "  city: Las Vegas",
      "  year: 2026",
      "venues:",
      "  - name: LVCC",
      "    address: '3150 Paradise Rd'",
      "  - name: Caesars Forum",
      "    address: '3911 Koval Ln'",
      "features:",
      "  rideshare: true",
      "  meetups: true",
      "  insights: false",
      "support_email: ops@example.com  # ops alias",
    ].join("\n");
    const out = parseYaml(src);
    assert.equal(out.event.name, "DEFCON 33");
    assert.equal(out.event.year, 2026);
    assert.equal(out.venues.length, 2);
    assert.equal(out.venues[0].name, "LVCC");
    assert.equal(out.venues[0].address, "3150 Paradise Rd");
    assert.equal(out.features.rideshare, true);
    assert.equal(out.features.insights, false);
    assert.equal(out.support_email, "ops@example.com");
  });
});
