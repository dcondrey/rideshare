#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// check-zero-runtime-deps.mjs
//
// Hard rule for this project: ZERO runtime npm dependencies.
// Dev-only tools (Biome, TypeScript) are fine; they live under `devDependencies`.
//
// This script asserts that `package.json#dependencies` is either absent or an empty object,
// and that `peerDependencies`, `optionalDependencies`, and `bundleDependencies` are likewise
// empty (those are also runtime-coupling). It exits non-zero with a descriptive error if any
// runtime dependency has snuck in — that error is what reviewers will see in CI logs.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(HERE, '..', 'package.json');

let pkg;
try {
  pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
} catch (err) {
  console.error(`[zero-runtime-deps] could not read ${PKG_PATH}: ${err.message}`);
  process.exit(2);
}

// Buckets we treat as "runtime-coupling" — anything that ends up loaded at `node entry.js` time,
// or that downstream consumers would be expected to install alongside us.
const RUNTIME_BUCKETS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
];

const violations = [];
for (const bucket of RUNTIME_BUCKETS) {
  const value = pkg[bucket];
  if (value === undefined || value === null) continue;

  if (Array.isArray(value)) {
    if (value.length > 0) {
      violations.push({ bucket, names: value });
    }
    continue;
  }

  if (typeof value !== 'object') {
    violations.push({ bucket, names: [`<malformed: ${typeof value}>`] });
    continue;
  }

  const names = Object.keys(value);
  if (names.length > 0) {
    violations.push({ bucket, names });
  }
}

if (violations.length > 0) {
  console.error('[zero-runtime-deps] FAIL: this project must ship with zero runtime dependencies.');
  console.error('');
  for (const { bucket, names } of violations) {
    console.error(`  - package.json#${bucket} is non-empty: ${names.join(', ')}`);
  }
  console.error('');
  console.error('If a tool is dev-only (linter, typechecker, test runner, build script),');
  console.error('move it to `devDependencies`. If it is genuinely required at runtime,');
  console.error('open an RFC issue first — adding a runtime dep changes the threat model.');
  process.exit(1);
}

console.log('[zero-runtime-deps] OK: no runtime dependencies declared.');
