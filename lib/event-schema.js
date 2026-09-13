// @ts-check
// SPDX-License-Identifier: MIT
/**
 * Boot-time validation for event.config.{yaml,json}.
 *
 * Without this, a mistyped or missing field is not an error — it is `undefined`
 * threading through the config object until some route dereferences it. Writing
 * `airprots:` for `airports:` starts the server cleanly and then throws a
 * TypeError the first time somebody opens /rides/new. Six files read nested
 * config fields without a guard, which is the correct way to read a field that
 * is required; it only works if "required" is actually enforced somewhere, and
 * this is that somewhere.
 *
 * Every problem in the file is reported at once, by dotted path, with what was
 * expected. Reporting only the first would mean one restart per typo.
 */

/** @typedef {{ path: string, problem: string, hint?: string }} ConfigProblem */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const QID = /^Q[1-9][0-9]*$/;

/** Top-level keys the app reads. Used for "did you mean" on an unknown key. */
const KNOWN_TOP_LEVEL = [
  "name",
  "longName",
  "tagline",
  "dates",
  "venue",
  "airports",
  "meetups",
  "map",
  "brand",
  "registrationUrl",
  "supportEmail",
  "seo",
];

/**
 * Levenshtein distance, capped — only used to suggest a correction for an
 * unrecognised key, so an exact value past the cap is not interesting.
 * @param {string} a
 * @param {string} b
 */
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{ min: number, max: number, what: string }} spec
 * @param {ConfigProblem[]} out
 */
function checkNumber(value, path, spec, out) {
  if (value == null) {
    out.push({ path, problem: "missing", hint: `expected ${spec.what}` });
    return;
  }
  // Strictly a number, not a numeric string. YAML already yields a number for
  // `lat: 37.4`, so a quoted "37.4" is a mistake — and accepting it here would
  // disagree with lib/meetups.js, which tests Number.isFinite and silently
  // skips any entry that fails.
  if (typeof value !== "number" || !Number.isFinite(value)) {
    out.push({
      path,
      problem: `${JSON.stringify(value)} is not a number`,
      hint: typeof value === "string" ? `${spec.what} — remove the quotes` : spec.what,
    });
    return;
  }
  const n = value;
  if (n < spec.min || n > spec.max) {
    out.push({
      path,
      problem: `${n} is out of range`,
      hint: `${spec.what} (${spec.min} to ${spec.max})`,
    });
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ConfigProblem[]} out
 * @param {{ required?: boolean }} [opts]
 */
function checkString(value, path, out, opts = {}) {
  if (value == null || value === "") {
    if (opts.required !== false) out.push({ path, problem: "missing", hint: "expected text" });
    return;
  }
  if (typeof value !== "string") {
    out.push({ path, problem: `${JSON.stringify(value)} is not text` });
  }
}

/**
 * Validate a parsed event config. Returns every problem found; an empty array
 * means the config is usable.
 * @param {unknown} cfg
 * @returns {ConfigProblem[]}
 */
export function validateEventConfig(cfg) {
  /** @type {ConfigProblem[]} */
  const out = [];
  if (!isObject(cfg)) {
    return [{ path: "(root)", problem: "the file did not parse to a mapping of keys to values" }];
  }

  for (const key of Object.keys(cfg)) {
    if (KNOWN_TOP_LEVEL.includes(key)) continue;
    const near = KNOWN_TOP_LEVEL.map((k) => ({ k, d: editDistance(key, k) })).sort(
      (a, b) => a.d - b.d,
    )[0];
    out.push({
      path: key,
      problem: "is not a setting this app reads",
      hint: near && near.d <= 3 ? `did you mean "${near.k}"?` : "check the spelling",
    });
  }

  checkString(cfg.name, "name", out);
  checkString(cfg.longName, "longName", out);
  checkString(cfg.tagline, "tagline", out, { required: false });
  checkString(cfg.registrationUrl, "registrationUrl", out, { required: false });
  checkString(cfg.supportEmail, "supportEmail", out, { required: false });

  // ── dates ──
  if (!isObject(cfg.dates)) {
    out.push({ path: "dates", problem: "missing", hint: "expected start: and end: keys" });
  } else {
    for (const k of ["start", "end"]) {
      const v = cfg.dates[k];
      if (v == null) {
        out.push({ path: `dates.${k}`, problem: "missing", hint: "expected YYYY-MM-DD" });
      } else if (!ISO_DATE.test(String(v))) {
        out.push({
          path: `dates.${k}`,
          problem: `${JSON.stringify(v)} is not a date`,
          // A bare 2026-01-01 parses as a string in this YAML subset, but an
          // operator writing 01/02/2026 gets a silently broken date input.
          hint: "expected YYYY-MM-DD, e.g. 2026-01-01",
        });
      }
    }
    const { start, end } = cfg.dates;
    if (ISO_DATE.test(String(start)) && ISO_DATE.test(String(end)) && String(end) < String(start)) {
      out.push({
        path: "dates.end",
        problem: `${JSON.stringify(end)} is before dates.start (${JSON.stringify(start)})`,
        hint: "ride dates are bounded by this range, so nothing could be posted",
      });
    }
  }

  // ── venue ──
  if (!isObject(cfg.venue)) {
    out.push({ path: "venue", problem: "missing", hint: "expected name:, lat: and lng: keys" });
  } else {
    checkString(cfg.venue.name, "venue.name", out);
    checkString(cfg.venue.address, "venue.address", out, { required: false });
    checkNumber(cfg.venue.lat, "venue.lat", { min: -90, max: 90, what: "a latitude" }, out);
    checkNumber(cfg.venue.lng, "venue.lng", { min: -180, max: 180, what: "a longitude" }, out);
  }

  // ── airports / meetups ──
  checkPlaceList(cfg.airports, "airports", out, { codes: true });
  if (cfg.meetups != null) checkPlaceList(cfg.meetups, "meetups", out, { codes: false });

  // ── seo (all optional) ──
  if (cfg.seo != null) {
    if (!isObject(cfg.seo)) {
      out.push({ path: "seo", problem: "is not a mapping" });
    } else if (cfg.seo.wikidata != null) {
      if (!isObject(cfg.seo.wikidata)) {
        out.push({ path: "seo.wikidata", problem: "is not a mapping" });
      } else {
        for (const [k, v] of Object.entries(cfg.seo.wikidata)) {
          const values = Array.isArray(v) ? v : [v];
          for (const one of values) {
            if (one === "" || one == null) continue;
            if (typeof one !== "string" || !QID.test(one)) {
              out.push({
                path: `seo.wikidata.${k}`,
                problem: `${JSON.stringify(one)} is not a Wikidata id`,
                hint: 'expected a Q-number like "Q749649" — look it up, never guess',
              });
            }
          }
        }
      }
    }
  }

  return out;
}

/**
 * @param {unknown} list
 * @param {string} path
 * @param {ConfigProblem[]} out
 * @param {{ codes: boolean }} opts
 */
function checkPlaceList(list, path, out, opts) {
  if (list == null) {
    out.push({
      path,
      problem: "missing",
      hint: `expected a list (write "${path}: []" if there are none)`,
    });
    return;
  }
  if (!Array.isArray(list)) {
    out.push({ path, problem: "is not a list", hint: `each entry needs name:, lat:, lng:` });
    return;
  }
  list.forEach((entry, i) => {
    const at = `${path}[${i}]`;
    if (!isObject(entry)) {
      out.push({ path: at, problem: "is not a mapping" });
      return;
    }
    if (opts.codes) checkString(entry.code, `${at}.code`, out);
    checkString(entry.name, `${at}.name`, out);
    checkNumber(entry.lat, `${at}.lat`, { min: -90, max: 90, what: "a latitude" }, out);
    checkNumber(entry.lng, `${at}.lng`, { min: -180, max: 180, what: "a longitude" }, out);
  });
}

/**
 * Render problems as an operator-facing report. Kept separate from the check so
 * tests can assert on structure rather than on formatting.
 * @param {ConfigProblem[]} problems
 * @param {string} file
 */
export function formatConfigProblems(problems, file) {
  const width = Math.max(...problems.map((p) => p.path.length));
  const lines = problems.map((p) => {
    const head = `  ${p.path.padEnd(width)}  ${p.problem}`;
    return p.hint ? `${head}\n  ${" ".repeat(width)}  ${p.hint}` : head;
  });
  return [
    `[config] ${file} has ${problems.length} problem${problems.length === 1 ? "" : "s"}:`,
    "",
    ...lines,
    "",
    "Fix these and restart. See the comments in event.config.yaml for each field.",
  ].join("\n");
}
