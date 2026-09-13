// @ts-check
/**
 * Minimal YAML parser — handles the subset used by event.config.yaml.
 *
 * SUPPORTED
 * ---------
 * - `# comments` (whole-line and end-of-line)
 * - Mappings:        `key: value`
 * - Nested mappings: indentation
 * - Sequences:       `- value` or `- key: value` followed by more keys
 * - Scalars:         strings (quoted and unquoted), numbers, booleans, null
 * - Empty values:    `key:` → null
 * - Both single- and double-quoted strings (with `""` / `''` escape inside)
 *
 * NOT SUPPORTED (use JSON if you need any of these)
 * -------------
 * - Anchors / aliases (`&`, `*`)
 * - Tags (`!`, `!!str`)
 * - Flow style (`{a: 1}`, `[1, 2]`)
 * - Multi-line literals (`|`, `>`)
 * - Document separators (`---`, `...`)
 * - Merge keys (`<<`)
 *
 * The grammar is tight enough that ambiguous YAML (e.g. unquoted strings
 * containing colons) will throw. Better than parsing it wrong.
 */

export class YamlError extends Error {
  /** @param {string} message @param {number} [line] */
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message);
    this.name = "YamlError";
    this.line = line;
  }
}

/**
 * Parse a YAML string into a plain JS value (object, array, or scalar).
 * @param {string} text
 * @returns {unknown}
 */
export function parseYaml(text) {
  if (typeof text !== "string") throw new YamlError("Input must be a string");
  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = preprocess(text);
  if (lines.length === 0) return null;

  const cursor = { i: 0, lines, depth: 0 };
  const result = parseValue(cursor, -1);
  if (cursor.i < lines.length) {
    throw new YamlError(`Unexpected content`, lines[cursor.i].lineNum);
  }
  return result;
}

/**
 * Tokenize input into significant lines. Returns lines with stripped trailing
 * whitespace, comments removed, blank lines dropped. Preserves indent and
 * original line numbers (for error messages).
 *
 * @typedef {{ indent: number, content: string, lineNum: number }} YamlLine
 * @typedef {{ i: number, lines: YamlLine[], depth: number }} YamlCursor
 *
 * @param {string} text
 * @returns {YamlLine[]}
 */
function preprocess(text) {
  /** @type {YamlLine[]} */
  const out = [];
  const rawLines = text.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const lineNum = i + 1;
    const raw = rawLines[i];
    // Reject TAB indentation — YAML disallows tabs and silently parsing them
    // tends to produce surprises.
    const indentMatch = raw.match(/^[ \t]*/);
    const indentStr = indentMatch ? indentMatch[0] : "";
    if (indentStr.includes("\t")) {
      throw new YamlError("Tabs are not allowed for indentation", lineNum);
    }
    const indent = indentStr.length;
    const rest = raw.slice(indent);
    const stripped = stripComment(rest);
    if (stripped.trim() === "") continue;
    out.push({ indent, content: stripped.trimEnd(), lineNum });
  }
  return out;
}

/**
 * Strip a `#` comment from the line, respecting single- and double-quoted
 * strings (so `desc: "use # signs"` keeps its content).
 * @param {string} s
 */
function stripComment(s) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
    } else if (inDouble) {
      if (c === "\\" && i + 1 < s.length) {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
    } else if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === "#") {
      // # is a comment only if preceded by whitespace or at start
      if (i === 0 || /\s/.test(s[i - 1])) return s.slice(0, i);
    }
  }
  return s;
}

// A nesting cap, so a deeply nested document throws a YamlError with a line
// number rather than a bare RangeError from the recursion itself.
const MAX_DEPTH = 100;

/**
 * Parse a value starting at the current cursor position.
 * @param {YamlCursor} c
 * @param {number} parentIndent — value indent must be > parentIndent
 */
function parseValue(c, parentIndent) {
  const line = c.lines[c.i];
  if (!line || line.indent <= parentIndent) return null;

  if (c.depth >= MAX_DEPTH) {
    throw new YamlError(`Nesting deeper than ${MAX_DEPTH} levels`, line.lineNum);
  }
  c.depth++;
  try {
    return parseValueAtLine(c, line);
  } finally {
    c.depth--;
  }
}

/**
 * @param {YamlCursor} c
 * @param {YamlLine} line
 */
function parseValueAtLine(c, line) {
  if (line.content.startsWith("- ") || line.content === "-") {
    return parseSequence(c, line.indent);
  }
  if (looksLikeKey(line.content)) {
    return parseMapping(c, line.indent);
  }
  // Bare scalar at this position is unusual but supported (e.g. file is just `42`).
  c.i++;
  return parseScalar(line.content, line.lineNum);
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z_][\w.-]*)\s*:(?:\s+(.*))?$/;

/** True if a content string starts with `key:` (not `key:value`). */
function looksLikeKey(s) {
  return KEY_RE.test(s) || /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z_][\w.-]*)\s*:$/.test(s);
}

// IMPORTANT: assigning any of these with `obj[key] =` changes the parsed
// object's prototype instead of adding a key. Object.keys() then does not see
// the value, so lib/event-schema.js's unknown-key report misses it while
// direct property reads in validateEventConfig resolve straight through it.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * @param {YamlCursor} c
 * @param {number} indent
 */
function parseMapping(c, indent) {
  const obj = {};
  while (true) {
    const line = c.lines[c.i];
    if (!line || line.indent !== indent) break;
    if (line.content.startsWith("-")) break;
    const m = line.content.match(KEY_RE);
    if (!m) {
      throw new YamlError(`Expected "key: value" mapping`, line.lineNum);
    }
    const key = unquoteKey(m[1]);
    if (UNSAFE_KEYS.has(key)) {
      throw new YamlError(`Refusing mapping key "${key}"`, line.lineNum);
    }
    const rest = (m[2] ?? "").trim();
    c.i++;
    if (rest === "") {
      // Block value follows — could be a mapping, sequence, or null
      obj[key] = parseValue(c, indent);
    } else {
      obj[key] = parseScalar(rest, line.lineNum);
    }
  }
  return obj;
}

/**
 * @param {YamlCursor} c
 * @param {number} indent
 */
function parseSequence(c, indent) {
  /** @type {unknown[]} */
  const arr = [];
  while (true) {
    const line = c.lines[c.i];
    if (!line || line.indent !== indent) break;
    if (!line.content.startsWith("-")) break;

    // Compute spacing after the dash
    let after = line.content.slice(1);
    if (after !== "" && !after.startsWith(" ")) {
      throw new YamlError(`Expected space after "-"`, line.lineNum);
    }
    const dashGap = after.length - after.trimStart().length;
    after = after.trimStart();
    c.i++;

    if (after === "") {
      // Block-style item: value on subsequent lines, indented past `indent`
      arr.push(parseValue(c, indent));
    } else if (looksLikeKey(after)) {
      // Inline mapping start: "- key: value"
      // The key sits at column = indent + 1 (dash) + dashGap
      const keyIndent = indent + 1 + dashGap;
      // Re-inject the rest of the line as a virtual line at keyIndent and
      // parse the (possibly multi-key) mapping that begins it.
      c.lines.splice(c.i, 0, {
        indent: keyIndent,
        content: after,
        lineNum: line.lineNum,
      });
      arr.push(parseMapping(c, keyIndent));
    } else {
      arr.push(parseScalar(after, line.lineNum));
    }
  }
  return arr;
}

/** Strip surrounding quotes from a key. */
function unquoteKey(k) {
  if (k.length >= 2) {
    if (k[0] === '"' && k[k.length - 1] === '"') {
      return JSON.parse(k);
    }
    if (k[0] === "'" && k[k.length - 1] === "'") {
      return k.slice(1, -1).replace(/''/g, "'");
    }
  }
  return k;
}

/**
 * Convert a scalar literal to its JS value.
 * Recognises null/true/false (case-insensitive), integers, floats, and
 * single/double-quoted strings. Anything else is a plain string.
 * @param {string} raw
 * @param {number} lineNum
 */
function parseScalar(raw, lineNum) {
  const s = raw.trim();
  if (s === "" || s === "~" || /^null$/i.test(s)) return null;
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (s[0] === '"') {
    if (s[s.length - 1] !== '"') {
      throw new YamlError(`Unterminated double-quoted string`, lineNum);
    }
    try {
      return JSON.parse(s);
    } catch {
      throw new YamlError(`Invalid double-quoted string`, lineNum);
    }
  }
  if (s[0] === "'") {
    if (s[s.length - 1] !== "'") {
      throw new YamlError(`Unterminated single-quoted string`, lineNum);
    }
    return s.slice(1, -1).replace(/''/g, "'");
  }
  // Empty flow collections. These are the one piece of flow syntax worth
  // supporting: `key: []` is how everyone writes "none of these", this repo's
  // own event.config.yaml uses it, and without it the value silently becomes
  // the two-character string "[]" — which then hits an Array.isArray() guard
  // downstream and reads as "not configured" instead of as a mistake.
  if (s === "[]") return [];
  if (s === "{}") return {};
  // Any other flow collection is NOT supported, and must say so. Returning
  // "[SFO, SJC]" as a plain string would be a silently wrong parse.
  if (s[0] === "[" || s[0] === "{") {
    throw new YamlError(
      `Flow style (${s[0]}...${s[0] === "[" ? "]" : "}"}) is not supported — use block style, ` +
        `one "- item" or "key: value" per line. Only the empty forms [] and {} are accepted.`,
      lineNum,
    );
  }
  // Number?
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(s)) return parseFloat(s);
  // Plain string. Reject if it contains a `: ` because that's almost certainly
  // a mistake (intended as a mapping but written without indentation).
  if (/:\s/.test(s)) {
    throw new YamlError(`Ambiguous unquoted string contains ": " — quote it`, lineNum);
  }
  return s;
}
