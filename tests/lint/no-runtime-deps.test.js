// @ts-check
// Trust signal: zero runtime dependencies.
//
// This test asserts the project ships with no `dependencies` block in package.json
// (or an explicitly empty one). devDependencies are permitted because Biome and
// TypeScript run only at build/CI time — they never enter the production runtime.
//
// If this test starts failing, an npm package was added to runtime. Reviewers
// (DEFCON / IIW) inspect the supply-chain footprint here, so removal of this
// guarantee requires explicit sign-off.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(__dirname, "..", "..", "package.json");

test("package.json has no runtime dependencies", async () => {
  const raw = await readFile(PKG_PATH, "utf8");
  /** @type {{ dependencies?: Record<string, string> }} */
  const pkg = JSON.parse(raw);

  const deps = pkg.dependencies;
  const empty = deps === undefined || (typeof deps === "object" && Object.keys(deps).length === 0);

  assert.ok(
    empty,
    `Expected zero runtime dependencies, found: ${JSON.stringify(deps, null, 2)}`,
  );
});
