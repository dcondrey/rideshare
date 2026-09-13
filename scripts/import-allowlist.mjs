#!/usr/bin/env node
// @ts-check
// SPDX-License-Identifier: MIT
//
// import-allowlist.mjs
// --------------------
// Populate the attendee allowlist from a CSV file, without a browser.
//
// The admin UI can already paste or upload a CSV; this is the same import path
// (lib/allowlist.js#importAllowlistCsv), reachable from a terminal or a deploy
// script. Addresses are hashed on the way in exactly as they are through the
// UI — the file itself is never stored.
//
// Usage:
//   node scripts/import-allowlist.mjs <file.csv> [--append] [--force]
//   npm run allowlist:import -- <file.csv> [--append]
//
// Default mode is replace, matching the admin form's default. --append keeps
// existing entries and adds only addresses not already present. A replace that
// would drop most of the current list is refused unless --force is given: the
// stored values are hashes, so what a wrong file overwrites cannot be read back.
//
// Exit codes:
//   0 — imported (including "0 added", when every address was already present)
//   1 — the file is missing, unreadable, contains no valid address, or the
//       replace was refused as implausible
//   2 — bad usage

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const append = args.includes("--append");
const force = args.includes("--force");
const files = args.filter((a) => !a.startsWith("--"));

if (files.length !== 1) {
  console.error("Usage: node scripts/import-allowlist.mjs <file.csv> [--append] [--force]");
  process.exit(2);
}

const path = resolve(process.cwd(), files[0]);
if (!existsSync(path)) {
  console.error(`No such file: ${path}`);
  process.exit(1);
}

let csv;
try {
  csv = readFileSync(path, "utf8");
} catch (err) {
  console.error(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Imported after the argument checks so a usage error does not pay for opening
// the database or running migrations.
const { importAllowlistCsv } = await import("../lib/allowlist.js");

const mode = append ? "append" : "replace";
const result = importAllowlistCsv(csv, {
  mode,
  force,
  actor: { actorId: null, actorEmail: `cli:${process.env.USER || "unknown"}`, ip: null },
});

if (result.totalRows === 0 || (result.added === 0 && result.total === 0)) {
  console.error(`No valid email addresses found in ${path}.`);
  process.exit(1);
}

if (result.refused) {
  console.error(
    `Refusing to replace ${result.refused.existing} allowlist entries with the ` +
      `${result.refused.parsed} parsed from ${path}.`,
  );
  console.error("Nothing was changed. Check the file, or pass --force if this is intended.");
  process.exit(1);
}

console.log(`${mode === "append" ? "Appended to" : "Replaced"} the allowlist from ${path}`);
console.log(`  parsed  ${result.totalRows} rows`);
console.log(`  skipped ${result.skippedInvalid} invalid`);
console.log(`  added   ${result.added}`);
console.log(`  total   ${result.total} entries now on the allowlist`);
