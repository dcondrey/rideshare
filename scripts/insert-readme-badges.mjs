#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// insert-readme-badges.mjs
//
// Idempotently inserts the project's CI / quality badges into README.md, immediately
// after the first H1 line ("# ..."). Safe to run multiple times — if the marker
// `<!-- BADGES:START -->` already exists in the file, the existing block is replaced
// in place rather than duplicated.
//
// Usage:
//   node scripts/insert-readme-badges.mjs                  # uses ./README.md
//   node scripts/insert-readme-badges.mjs path/to/README   # custom path
//
// The badge block is intentionally short (5 badges) so it doesn't dominate the page.
// If you need to change the GitHub owner/repo or the package name, edit the constants
// at the top of this file — they are inferred best-effort from package.json#repository
// when present, otherwise fall back to placeholders the maintainer can search-replace.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const README_PATH = resolve(REPO_ROOT, process.argv[2] ?? 'README.md');
const PKG_PATH = resolve(REPO_ROOT, 'package.json');

// --- Try to infer owner/repo from package.json#repository --------------------------
let owner = 'OWNER';
let repo = 'REPO';
try {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const r = pkg?.repository;
  const url = typeof r === 'string' ? r : r?.url;
  if (typeof url === 'string') {
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
    if (m) {
      owner = m[1];
      repo = m[2];
    }
  }
} catch {
  // Best-effort only — placeholders are fine.
}

// --- Build the block ---------------------------------------------------------------
const BADGES = [
  // Build status — points at the CI workflow we just defined.
  `[![CI](https://github.com/${owner}/${repo}/actions/workflows/ci.yml/badge.svg)](https://github.com/${owner}/${repo}/actions/workflows/ci.yml)`,
  // License — reads from the LICENSE file in the repo root.
  `[![License](https://img.shields.io/github/license/${owner}/${repo})](./LICENSE)`,
  // Node version requirement.
  `[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?logo=node.js&logoColor=white)](https://nodejs.org/)`,
  // Custom shields.io badge advertising the zero-dependencies invariant.
  `[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success)](./package.json)`,
  // Audited badge — links to the disclosure policy.
  `[![Audited](https://img.shields.io/badge/security-audited-blue)](./SECURITY.md)`,
].join('\n');

const START = '<!-- BADGES:START -->';
const END = '<!-- BADGES:END -->';
const BLOCK = `${START}\n${BADGES}\n${END}`;

// --- Read existing README ----------------------------------------------------------
let readme;
try {
  readme = readFileSync(README_PATH, 'utf8');
} catch (err) {
  console.error(`[insert-readme-badges] could not read ${README_PATH}: ${err.message}`);
  process.exit(2);
}

// --- Replace existing block (idempotent path) --------------------------------------
const startIdx = readme.indexOf(START);
const endIdx = readme.indexOf(END);
if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
  const before = readme.slice(0, startIdx);
  const after = readme.slice(endIdx + END.length);
  const next = `${before}${BLOCK}${after}`;
  if (next === readme) {
    console.log('[insert-readme-badges] no changes needed (badges already up to date).');
    process.exit(0);
  }
  writeFileSync(README_PATH, next);
  console.log('[insert-readme-badges] replaced existing badge block in place.');
  process.exit(0);
}

// --- First-time insertion: drop the block right after the first H1 line -----------
const lines = readme.split('\n');
const h1Index = lines.findIndex((l) => /^#\s+\S/.test(l));
if (h1Index === -1) {
  // No H1: prepend at the very top so badges still land "above the existing tagline".
  const next = `${BLOCK}\n\n${readme}`;
  writeFileSync(README_PATH, next);
  console.log('[insert-readme-badges] no H1 found; inserted badges at the top.');
  process.exit(0);
}

const head = lines.slice(0, h1Index + 1).join('\n');
const tail = lines.slice(h1Index + 1).join('\n');
const next = `${head}\n\n${BLOCK}\n${tail}`;
writeFileSync(README_PATH, next);
console.log(`[insert-readme-badges] inserted badges after H1 on line ${h1Index + 1}.`);
