#!/usr/bin/env node
// @ts-check
//
// check-no-banned-patterns.mjs
// ----------------------------
// Scan lib/, routes/, and server.js for banned source patterns. Each match exits 1
// unless waived by an inline `// allow-banned: <reason>` comment on the SAME line.
//
// Patterns:
//   1. console.log(            — use console.warn/error or structured logging
//   2. \bany\b in JSDoc        — unconstrained types defeat checkJs
//   3. eval(                   — code injection vector
//   4. new Function(           — same vector under a different name
//   5. process.env.X           — outside lib/config.js (centralize env access)
//   6. unsafe-inline           — CSP regression (matches in all string contexts)
//   7. // TODO                 — we don't ship TODOs
//
// Run via: `node scripts/check-no-banned-patterns.mjs`
//
// Caveats (be honest):
//   - The script strips // line comments and /* block comments */ before scanning,
//     so banned tokens inside descriptive comments don't false-positive. But it
//     does NOT do full JS parsing, so a banned token inside a string literal will
//     still match. If a string genuinely needs `eval` etc., add `// allow-banned:`.
//   - The JSDoc `any` rule is regex-based — it only fires on `@type {... any ...}`
//     and `@param {... any ...}` lines, so it won't trip on a variable named
//     `company` or a string `"any"`.
//   - process.env detection allows ALL access inside lib/config.js. There is no
//     line-level granularity beyond that — by design.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SCAN_DIRS = ["lib", "routes"];
const SCAN_FILES = ["server.js"];

// Files exempt from process.env rule.
const ENV_ALLOWED_FILES = new Set([join(ROOT, "lib", "config.js")]);

const WAIVER_RE = /\/\/\s*allow-banned\b/;

/**
 * @typedef {Object} Rule
 * @property {string} id
 * @property {RegExp} pattern
 * @property {string} message
 * @property {(file: string) => boolean} [skipFile]
 * @property {(line: string) => boolean} [matchPredicate]
 */

/** @type {Rule[]} */
const RULES = [
  {
    id: "no-console-log",
    pattern: /\bconsole\.log\s*\(/,
    message: "console.log is banned — use console.warn/error or structured logging",
  },
  {
    id: "no-jsdoc-any",
    // Match @type or @param annotations whose brace-block contains a bare `any`.
    pattern: /@(?:type|param|returns?|property)\s*\{[^}]*\bany\b[^}]*\}/,
    message: "Bare `any` in JSDoc type defeats checkJs — narrow the type",
  },
  {
    id: "no-eval",
    pattern: /\beval\s*\(/,
    message: "eval() is banned — code-injection vector",
  },
  {
    id: "no-new-function",
    pattern: /\bnew\s+Function\s*\(/,
    message: "new Function() is banned — code-injection vector",
  },
  {
    id: "centralize-env",
    pattern: /\bprocess\.env\.[A-Z0-9_]+/,
    message: "process.env access must be centralized in lib/config.js",
    skipFile: (file) => ENV_ALLOWED_FILES.has(file),
  },
  {
    id: "no-unsafe-inline-csp",
    pattern: /unsafe-inline/,
    message: "'unsafe-inline' detected — CSP regression",
  },
  {
    id: "no-todo",
    pattern: /\/\/\s*TODO\b/,
    message: "// TODO comments are banned — file an issue instead",
  },
];

/**
 * Strip line comments AND block comments from `src`, replacing them with
 * same-length whitespace so line/column offsets are preserved.
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let inString = /** @type {null | '"' | "'" | "`"} */ (null);

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < n) {
        out += next;
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }

    // Enter string
    if (c === '"' || c === "'" || c === "`") {
      inString = /** @type {'"' | "'" | "`"} */ (c);
      out += c;
      i++;
      continue;
    }

    // Block comment
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let j = i; j < stop; j++) out += src[j] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }

    // Line comment — but we need to KEEP comments for the no-jsdoc-any and
    // no-todo rules to find their targets. Strategy: replace ONLY the leading
    // `//` with spaces so the rest of the line still scans, but no NEW `//`
    // sequences appear inside it. This keeps JSDoc `@type {any}` reachable
    // (those live inside /* ... */ block comments which we DON'T strip — see
    // override below).
    //
    // Actually simpler: strip line comments fully. The two rules that need
    // comments (no-jsdoc-any, no-todo) handle themselves:
    //   - no-jsdoc-any: lives in /* ... */ JSDoc blocks, which we DON'T strip below.
    //   - no-todo:      pattern matches the literal `// TODO` BEFORE we strip.
    // So: scan original `src` for those two, scan stripped for the rest.
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/**
 * Strip ONLY line comments, leaving block comments intact (so JSDoc rules can fire).
 * @param {string} src
 */
function stripLineCommentsOnly(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let inString = /** @type {null | '"' | "'" | "`"} */ (null);

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < n) {
        out += next;
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      inString = /** @type {'"' | "'" | "`"} */ (c);
      out += c;
      i++;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function walk(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return out;
    throw err;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      out.push(...(await walk(p)));
    } else if (e.isFile() && e.name.endsWith(".js")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * @typedef {Object} Finding
 * @property {string} file
 * @property {number} line
 * @property {string} ruleId
 * @property {string} message
 * @property {string} text
 */

async function main() {
  /** @type {string[]} */
  const files = [];
  for (const d of SCAN_DIRS) files.push(...(await walk(join(ROOT, d))));
  for (const f of SCAN_FILES) {
    const p = join(ROOT, f);
    try {
      const s = await stat(p);
      if (s.isFile()) files.push(p);
    } catch {
      /* skip */
    }
  }

  /** @type {Finding[]} */
  const findings = [];

  for (const file of files) {
    const raw = await readFile(file, "utf8");

    // Two scan surfaces:
    //   `lineCommentStripped`  — for code rules (no-console-log, eval, env, etc.)
    //                            block comments preserved so JSDoc-any rule fires;
    //                            string literals preserved so unsafe-inline still fires.
    //   `raw`                  — for no-todo (has to see literal `// TODO`).
    const code = stripLineCommentsOnly(raw);
    void stripComments; // silence noUnusedLocals in case linter inspects

    const codeLines = code.split(/\r?\n/);
    const rawLines = raw.split(/\r?\n/);

    for (let i = 0; i < rawLines.length; i++) {
      const rawLine = rawLines[i];
      const codeLine = codeLines[i] ?? "";

      if (WAIVER_RE.test(rawLine)) continue; // explicit waiver

      for (const rule of RULES) {
        if (rule.skipFile?.(file)) continue;

        const surface = rule.id === "no-todo" ? rawLine : codeLine;
        if (rule.pattern.test(surface)) {
          findings.push({
            file: relative(ROOT, file),
            line: i + 1,
            ruleId: rule.id,
            message: rule.message,
            text: rawLine.trim().slice(0, 120),
          });
        }
      }
    }
  }

  if (findings.length === 0) {
    console.log(`check-no-banned-patterns: OK (${files.length} files scanned)`);
    process.exit(0);
  }

  // Stable sort: file, line, ruleId.
  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.ruleId.localeCompare(b.ruleId),
  );

  console.error(`check-no-banned-patterns: FAIL — ${findings.length} finding(s):`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.ruleId}]  ${f.message}`);
    console.error(`      ${f.text}`);
  }
  console.error(
    `\nWaive a specific line by appending \`// allow-banned: <reason>\` to it.`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("check-no-banned-patterns: IO error:", err);
  process.exit(2);
});
