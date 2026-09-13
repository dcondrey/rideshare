// @ts-check
/**
 * Operator-facing output.
 *
 * `console.log` is banned repo-wide (the linter allows only warn/error) because
 * debug logging kept leaking into request paths. Lifecycle messages are not
 * debug output, so they go to stdout through here instead.
 */

/**
 * @param {string} message
 * @returns {void}
 */
export function info(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Attendee addresses must never reach operator output. They arrive indirectly:
 * a mail relay echoes the recipient back in a bounce or validation error, that
 * text becomes an Error message, and the Error is logged whole by the retry in
 * lib/email.js, the catch in routes/auth.js, and the unhandled-error path in
 * lib/router.js. Redacting at the sink covers all three and anything added
 * later. The domain survives because relay problems are diagnosed by domain.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/**
 * Strip CR/LF so attacker- or caller-supplied values can't forge extra log
 * lines when interpolated into a structured line, and redact email addresses.
 * @param {unknown} value
 * @returns {string}
 */
function safe(value) {
  return String(value)
    .replace(/[\r\n]/g, "")
    .replace(EMAIL_RE, "[redacted]@$1");
}

/** @param {unknown} value @returns {string} */
function formatValue(value) {
  const s = safe(value instanceof Error ? value.message : value);
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/**
 * Structured fields are allowlisted, per THREAT_MODEL.md T-A4-I2: a log line
 * carries only names on this list, so key material, tokens, or a whole request
 * body cannot arrive as a new field somebody added at a call site. An
 * unrecognised name is dropped and its NAME (never its value) is reported on
 * the line, so a dropped field is visible rather than silent.
 */
const ALLOWED_FIELDS = new Set([
  "attempt",
  "component",
  "count",
  "duration_ms",
  "edit_at",
  "err",
  "error",
  "event",
  "fix",
  "host",
  "id",
  "in_config",
  "in_database",
  "kind",
  "limit",
  "method",
  "mode",
  "name",
  "path",
  "port",
  "reason",
  "retries",
  "status",
  "version",
]);

/**
 * @param {"warn" | "error"} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
function emit(level, msg, fields) {
  let line = `level=${level} msg="${safe(msg).replace(/"/g, '\\"')}"`;
  if (fields) {
    /** @type {string[]} */
    const dropped = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!ALLOWED_FIELDS.has(k)) {
        dropped.push(k);
        continue;
      }
      line += ` ${k}=${formatValue(v)}`;
    }
    if (dropped.length > 0) line += ` dropped_fields="${dropped.map(safe).join(",")}"`;
  }
  process.stderr.write(`${line}\n`);
}

/**
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 * @returns {void}
 */
export function warn(msg, fields) {
  emit("warn", msg, fields);
}

/**
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 * @returns {void}
 */
export function error(msg, fields) {
  emit("error", msg, fields);
}
