#!/usr/bin/env node
// @ts-check
// SPDX-License-Identifier: MIT
//
// check-license-headers.mjs
// -------------------------
// Walk lib/, routes/, public/, scripts/, and the top-level server.js. For every
// .js and .mjs file,
// require either a `// @ts-check` directive in the first 5 lines (our standard
// top-of-file marker — also enables TypeScript checking) OR a license header
// comment. Files missing both cause a non-zero exit and are listed.
//
// Run via: `node scripts/check-license-headers.mjs`
//
// Exit codes:
//   0 — all files pass
//   1 — one or more files missing both markers (printed to stderr)
//   2 — IO error (e.g., directory missing)

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SCAN_DIRS = ["lib", "routes", "public", "scripts"];
const SCAN_FILES = ["server.js"];

// Heuristic: a license header comment mentions one of these tokens in the first
// ~20 lines. Keep the list short and well-known to minimize false positives.
const LICENSE_TOKENS = [
  "Copyright",
  "SPDX-License-Identifier",
  "Licensed under",
  "MIT License",
  "Apache License",
  "ISC License",
  "BSD License",
  "GPL",
  "Proprietary",
];

const TS_CHECK_RE = /^\s*\/\/\s*@ts-check\b/;

/**
 * Recursively collect *.js files under `dir`.
 * @param {string} dir absolute path
 * @returns {Promise<string[]>}
 */
async function walk(dir) {
  /** @type {string[]} */
  const out = [];
  // IMPORTANT: a missing scan root is a gate failure, not an empty list. This
  // used to swallow ENOENT, so moving a scanned directory made the gate scan
  // nothing and report success.
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip vendored / build / data dirs.
      if (entry.name === "node_modules" || (entry.name === "lib" && dir.endsWith("public"))) {
        continue;
      }
      out.push(...(await walk(full)));
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * @param {string} file absolute path
 * @returns {Promise<boolean>} true if file passes
 */
async function check(file) {
  const text = await readFile(file, "utf8");
  const head = text.split(/\r?\n/, 20).join("\n");

  // First 5 lines must contain @ts-check OR first 20 lines must mention a license token.
  const headFive = text.split(/\r?\n/, 5).join("\n");
  if (TS_CHECK_RE.test(headFive)) return true;
  for (const tok of LICENSE_TOKENS) {
    if (head.includes(tok)) return true;
  }
  return false;
}

async function main() {
  /** @type {string[]} */
  const targets = [];

  for (const d of SCAN_DIRS) {
    targets.push(...(await walk(join(ROOT, d))));
  }
  for (const f of SCAN_FILES) {
    const p = join(ROOT, f);
    const s = await stat(p);
    if (!s.isFile()) throw new Error(`scan target is not a file: ${f}`);
    targets.push(p);
  }

  /** @type {string[]} */
  const missing = [];
  for (const file of targets) {
    if (!(await check(file))) {
      missing.push(relative(ROOT, file));
    }
  }

  if (missing.length === 0) {
    console.log(`check-license-headers: OK (${targets.length} files scanned)`);
    process.exit(0);
  }

  console.error(
    `check-license-headers: FAIL — ${missing.length} file(s) missing both \`// @ts-check\` and a license header:`,
  );
  for (const m of missing.sort()) {
    console.error(`  ${m}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("check-license-headers: IO error:", err);
  process.exit(2);
});
