// @ts-check
/**
 * Resolved event config = file defaults (event.config.json) + DB overrides.
 *
 * Admins can edit individual fields at runtime via /admin/config; those edits
 * are stored in the config_overrides table and shadow the file values.
 */

import { config } from "./config.js";
import { db, tx } from "./db.js";
import { validateEventConfig } from "./event-schema.js";

/** Field allowlist — only these can be overridden via the admin UI. */
const OVERRIDABLE = new Set([
  "name",
  "longName",
  "tagline",
  "dates.start",
  "dates.end",
  "venue.name",
  "venue.address",
  "venue.lat",
  "venue.lng",
  "brand.primaryColor",
  "brand.logoPath",
  "map.style",
  "map.defaultZoom",
  "map.customTileUrl",
  "map.customAttribution",
  "registrationUrl",
  "supportEmail",
]);

export function isOverridable(key) {
  return OVERRIDABLE.has(key);
}

export function listOverridableKeys() {
  return [...OVERRIDABLE];
}

/** @returns {Record<string, unknown>} */
function loadOverrides() {
  const rows = /** @type {{ key: string, value: string }[]} */ (
    db.prepare("SELECT key, value FROM config_overrides").all()
  );
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/** Deep-clone a JSON-safe object. */
function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Apply a "dot.path" override into a nested object. Rejects __proto__/constructor/prototype segments so this stays safe even if reused with an unvalidated path. */
function setPath(obj, path, value) {
  const parts = path.split(".");
  if (parts.some((k) => UNSAFE_KEYS.has(k))) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Resolve the merged event config. Cheap (single SELECT + clone) so we
 * call it per-request rather than caching, to keep admin edits instant.
 */
export function getEventConfig() {
  const merged = clone(config.event);
  const overrides = loadOverrides();
  for (const [key, value] of Object.entries(overrides)) {
    if (OVERRIDABLE.has(key)) setPath(merged, key, value);
  }
  return merged;
}

/** @param {import("./event-schema.js").ConfigProblem} p */
function problemKey(p) {
  return `${p.path}: ${p.problem}`;
}

/**
 * Reject a set of overrides that would make the resolved config fail the same
 * schema lib/config.js runs the boot file through. Compared against the
 * problems the config already has, so a deployment that booted with a warning
 * can still edit an unrelated field.
 *
 * @param {[string, unknown][]} entries
 */
function assertOverridesValidate(entries) {
  const before = new Set(validateEventConfig(getEventConfig()).map(problemKey));
  const candidate = getEventConfig();
  for (const [key, value] of entries) {
    if (value != null) setPath(candidate, key, value);
  }
  const introduced = validateEventConfig(candidate)
    .filter((p) => !before.has(problemKey(p)))
    .map((p) => (p.hint ? `${problemKey(p)} — ${p.hint}` : problemKey(p)));
  if (introduced.length > 0) {
    throw new Error(introduced.join("; "));
  }
}

/**
 * Set or clear a single override.
 * @param {string} key
 * @param {unknown} value — pass null to clear
 */
export function setOverride(key, value) {
  setOverrides([[key, value]]);
}

/**
 * Set or clear several overrides as one unit. The admin form submits every
 * field at once, so they are validated together and written together: a
 * partial write would leave the config in a state neither the operator nor the
 * schema asked for.
 *
 * @param {[string, unknown][]} entries
 */
export function setOverrides(entries) {
  for (const [key] of entries) {
    if (!OVERRIDABLE.has(key)) {
      throw new Error(`Field "${key}" is not overridable`);
    }
  }
  assertOverridesValidate(entries);
  const del = db.prepare("DELETE FROM config_overrides WHERE key = ?");
  const put = db.prepare(
    `INSERT INTO config_overrides (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  tx(() => {
    for (const [key, value] of entries) {
      if (value == null) del.run(key);
      else put.run(key, JSON.stringify(value));
    }
  });
}
