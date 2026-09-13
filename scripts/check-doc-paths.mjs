#!/usr/bin/env node
// @ts-check
// SPDX-License-Identifier: MIT
//
// check-doc-paths.mjs
// -------------------
// Every repo-relative path named by the security documentation must exist.
//
// The documents scanned here describe security controls in enough implementation
// detail to be mistaken for a description of real code. Five of them named
// modules that had never existed in any commit — a reviewer reading
// THREAT_MODEL.md had no way to tell. This gate makes that failure loud.
//
// Scanned: THREAT_MODEL.md, README.md, RUNBOOK.md and docs/**/*.md.
// Recognised: inline-code spans (`lib/foo.js`) and markdown link targets
// ([text](../../lib/foo.js)) that look like repo paths.
//
// Run via: `node scripts/check-doc-paths.mjs`
//
// Exit codes:
//   0 — every referenced path exists
//   1 — one or more referenced paths are missing (printed to stderr)
//   2 — IO error

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOP_LEVEL_DOCS = ["THREAT_MODEL.md", "README.md", "RUNBOOK.md", "TRUST.md", "SECURITY.md"];
const DOC_DIRS = ["docs"];

// Paths that exist only on a running deployment, never in a checkout.
const RUNTIME_ONLY = [
  /^data\//,
  /^backups\//,
  /^secrets\//,
  /^event\.config\.(yaml|yml|json)$/,
  /^\.env$/,
  /^allowlist\.csv$/,
];

// A token is treated as a path when it has a directory separator or a known
// source-file extension. Anything else in backticks is prose, code, or a
// command, and is left alone.
const PATH_LIKE = /^[\w./-]+\.(js|mjs|cjs|ts|json|md|yaml|yml|sql|sh|toml|css|html)$|^[\w./-]+\/$/;

/** @param {string} dir @returns {Promise<string[]>} */
async function markdownFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await markdownFiles(full)));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * @param {string} text
 * @returns {string[]} candidate paths, as written
 */
function extractCandidates(text) {
  /** @type {string[]} */
  const found = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) found.push(m[1].trim());
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) found.push(m[1].trim());
  return found;
}

// Only these trees are checked when a path is written from the repo root. A
// token like `.well-known/did.json` or `trust/credentials.json` is a URL path
// on the running deployment, not a file, and `did.json` alone is a document
// name; none of those name a module a reviewer could go read.
const REPO_TREES = new Set(["lib", "routes", "public", "tests", "scripts", "docs", "bin"]);

/**
 * @param {string} docPath absolute path of the document
 * @param {string} candidate
 * @returns {string | null} repo-relative path to check, or null to ignore
 */
function toRepoPath(docPath, candidate) {
  const raw = candidate.split("#")[0].trim();
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // URLs, mailto:, did:
  if (raw.includes(" ") || raw.includes("*")) return null; // prose or a glob
  if (!PATH_LIKE.test(raw)) return null;

  // A sibling or relative link resolves against the document, the way a reader
  // following it would.
  const nearby = normalize(resolve(dirname(docPath), raw));
  if (nearby.startsWith(ROOT) && existsSync(nearby)) return null;
  if (raw.startsWith("./") || raw.startsWith("../")) {
    return nearby.startsWith(ROOT) ? relative(ROOT, nearby) : null;
  }

  const fromRoot = raw.replace(/^\//, "");
  if (!REPO_TREES.has(fromRoot.split("/")[0])) return null;
  const abs = normalize(resolve(ROOT, fromRoot));
  return abs.startsWith(ROOT) ? relative(ROOT, abs) : null;
}

async function main() {
  /** @type {string[]} */
  const docs = [...TOP_LEVEL_DOCS.map((f) => join(ROOT, f))];
  for (const dir of DOC_DIRS) docs.push(...(await markdownFiles(join(ROOT, dir))));

  /** @type {{ doc: string, path: string }[]} */
  const missing = [];
  for (const doc of docs) {
    if (!existsSync(doc)) continue;
    const text = await readFile(doc, "utf8");
    const seen = new Set();
    for (const candidate of extractCandidates(text)) {
      const relPath = toRepoPath(doc, candidate);
      if (!relPath || seen.has(relPath)) continue;
      seen.add(relPath);
      if (RUNTIME_ONLY.some((re) => re.test(relPath))) continue;
      if (!existsSync(join(ROOT, relPath))) {
        missing.push({ doc: relative(ROOT, doc), path: relPath });
      }
    }
  }

  if (missing.length > 0) {
    console.error("Documentation references paths that do not exist:\n");
    for (const m of missing) console.error(`  ${m.doc}: ${m.path}`);
    console.error(
      "\nEither build what the document describes or correct the document. " +
        "A named module that does not exist reads as a shipped control.",
    );
    process.exit(1);
  }
  console.log(`Checked ${docs.length} documents; every referenced path exists.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
