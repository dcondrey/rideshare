// @ts-check
/**
 * Tiny input validation helpers. No schemas, no reflection — just functions
 * that throw `ValidationError` (caught by the router, returned as 400).
 */

export class ValidationError extends Error {
  /**
   * @param {string} field
   * @param {string} message
   */
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = "ValidationError";
    this.field = field;
    this.userMessage = message;
  }
}

/**
 * @param {unknown} v
 * @param {string} field
 * @returns {string}
 */
export function reqString(v, field, { max = 500, min = 1 } = {}) {
  if (typeof v !== "string") throw new ValidationError(field, "is required");
  const s = v.trim();
  if (s.length < min) throw new ValidationError(field, "is required");
  if (s.length > max) throw new ValidationError(field, `must be ≤ ${max} chars`);
  return s;
}

/** @param {unknown} v @param {string} field */
export function optString(v, field, { max = 500 } = {}) {
  if (v == null || v === "") return null;
  if (typeof v !== "string") throw new ValidationError(field, "must be text");
  const s = v.trim();
  if (s.length === 0) return null;
  if (s.length > max) throw new ValidationError(field, `must be ≤ ${max} chars`);
  return s;
}

/** @param {unknown} v @param {string} field */
export function reqInt(v, field, { min = 0, max = 1000 } = {}) {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) throw new ValidationError(field, "must be a number");
  if (n < min) throw new ValidationError(field, `must be ≥ ${min}`);
  if (n > max) throw new ValidationError(field, `must be ≤ ${max}`);
  return n;
}

/** @param {unknown} v @param {string} field @param {string[]} allowed */
export function oneOf(v, field, allowed) {
  if (typeof v !== "string" || !allowed.includes(v)) {
    throw new ValidationError(field, `must be one of: ${allowed.join(", ")}`);
  }
  return v;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** @param {unknown} v @param {string} field */
export function email(v, field = "email") {
  const s = reqString(v, field, { max: 254 });
  if (!EMAIL_RE.test(s)) throw new ValidationError(field, "looks invalid");
  return s.toLowerCase();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** @param {unknown} v @param {string} field */
export function isoDate(v, field) {
  const s = reqString(v, field, { max: 10 });
  if (!DATE_RE.test(s)) throw new ValidationError(field, "must be YYYY-MM-DD");
  // Validate it parses
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw new ValidationError(field, "is not a real date");
  }
  return s;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** @param {unknown} v @param {string} field */
export function hhmm(v, field) {
  const s = reqString(v, field, { max: 5 });
  if (!TIME_RE.test(s)) throw new ValidationError(field, "must be HH:MM (24h)");
  return s;
}
