// @ts-check
// SPDX-License-Identifier: MIT
/**
 * Boot-time event config validation (lib/event-schema.js).
 *
 * The load-bearing case is the last one: the event.config.example.yaml this
 * repo ships must validate clean. It is also what the loader falls back to on a
 * fresh checkout, so a regression there breaks CI's boot smoke test. That file
 * predates the validator and was not written to satisfy it, so it is the one
 * fixture here with independent provenance — and it caught two real defects
 * when the validator first ran against it.
 */

import "../helpers/setup.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { setupTestEnv } from "../helpers/env.js";

setupTestEnv();

const { validateEventConfig, formatConfigProblems } = await import("../../lib/event-schema.js");
const { parseYaml } = await import("../../lib/yaml.js");

/** A config with nothing wrong with it. */
const VALID = {
  name: "Test",
  longName: "Test Event",
  tagline: "hi",
  dates: { start: "2026-01-01", end: "2026-01-03" },
  venue: { name: "V", address: "1 Main St", lat: 37.4, lng: -122.1 },
  airports: [{ code: "SFO", name: "San Francisco", lat: 37.6, lng: -122.4 }],
  meetups: [],
};

/** @param {Record<string, unknown>} patch */
const withPatch = (patch) => validateEventConfig({ ...VALID, ...patch });
/** @param {ReturnType<typeof validateEventConfig>} problems */
const paths = (problems) => problems.map((p) => p.path);

describe("validateEventConfig", () => {
  it("accepts a complete config", () => {
    assert.deepEqual(validateEventConfig(VALID), []);
  });

  it("names a missing required field by its dotted path", () => {
    const problems = withPatch({ venue: { name: "V", lat: 37.4 } });
    assert.ok(paths(problems).includes("venue.lng"));
  });

  it("suggests the intended key for a near-miss typo", () => {
    const { airports, ...rest } = VALID;
    const problems = validateEventConfig({ ...rest, airprots: airports });
    const typo = problems.find((p) => p.path === "airprots");
    assert.ok(typo, "unknown key was not reported");
    assert.match(String(typo.hint), /airports/);
  });

  it("reports every problem at once rather than the first", () => {
    const problems = validateEventConfig({ name: "T" });
    assert.ok(problems.length >= 4, `only reported ${problems.length}`);
  });

  it("catches a reversed date range, which nothing else would", () => {
    const problems = withPatch({ dates: { start: "2026-01-05", end: "2026-01-01" } });
    assert.ok(paths(problems).includes("dates.end"));
  });

  it("rejects out-of-range and non-numeric coordinates", () => {
    assert.ok(paths(withPatch({ venue: { ...VALID.venue, lat: 137.4 } })).includes("venue.lat"));
    assert.ok(paths(withPatch({ venue: { ...VALID.venue, lng: "west" } })).includes("venue.lng"));
    // A quoted number passes YAML but fails lib/meetups.js's Number.isFinite
    // check, which skips the entry without saying so. Caught here instead.
    const quoted = withPatch({ venue: { ...VALID.venue, lat: "37.4" } });
    assert.ok(paths(quoted).includes("venue.lat"));
    assert.match(String(quoted[0].hint), /remove the quotes/);
  });

  it("validates entries inside airports by index", () => {
    const problems = withPatch({ airports: [{ code: "SFO", name: "x", lat: 37.6 }] });
    assert.ok(paths(problems).includes("airports[0].lng"));
  });

  it("accepts an empty airports list but not a missing one", () => {
    assert.deepEqual(withPatch({ airports: [] }), []);
    const { airports, ...rest } = VALID;
    assert.ok(paths(validateEventConfig(rest)).includes("airports"));
  });

  it("rejects a Wikidata id that is not a Q-number", () => {
    const problems = withPatch({ seo: { wikidata: { event: "749649" } } });
    assert.ok(paths(problems).includes("seo.wikidata.event"));
    assert.deepEqual(withPatch({ seo: { wikidata: { event: "Q749649", topics: [] } } }), []);
  });

  it("formats a report naming each path and its hint", () => {
    const text = formatConfigProblems(withPatch({ airports: undefined }), "event.config.yaml");
    assert.match(text, /event\.config\.yaml has 1 problem:/);
    assert.match(text, /airports/);
  });

  it("validates the event.config.example.yaml this repo ships", () => {
    const parsed = parseYaml(
      readFileSync(new URL("../../event.config.yaml", import.meta.url), "utf8"),
    );
    const problems = validateEventConfig(parsed);
    assert.deepEqual(
      problems,
      [],
      problems.length > 0 ? formatConfigProblems(problems, "event.config.example.yaml") : "",
    );
  });
});
