// @ts-check
/**
 * Resolved event config = file defaults (event.config.json) + DB overrides.
 *
 * Admins can edit individual fields at runtime via /admin/config; those edits
 * are stored in the config_overrides table and shadow the file values.
 */

import { config } from "./config.js";
import { db } from "./db.js";

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
  const rows = db.prepare("SELECT key, value FROM config_overrides").all();
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

/** Apply a "dot.path" override into a nested object. */
function setPath(obj, path, value) {
  const parts = path.split(".");
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

/**
 * Set or clear a single override.
 * @param {string} key
 * @param {unknown} value — pass null to clear
 */
export function setOverride(key, value) {
  if (!OVERRIDABLE.has(key)) {
    throw new Error(`Field "${key}" is not overridable`);
  }
  if (value == null) {
    db.prepare("DELETE FROM config_overrides WHERE key = ?").run(key);
  } else {
    db.prepare(
      `INSERT INTO config_overrides (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, JSON.stringify(value));
  }
}
