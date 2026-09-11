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
 * Strip CR/LF so attacker- or caller-supplied values can't forge extra log
 * lines when interpolated into a structured line.
 * @param {unknown} value
 * @returns {string}
 */
function safe(value) {
  return String(value).replace(/[\r\n]/g, "");
}

/** @param {unknown} value @returns {string} */
function formatValue(value) {
  const s = safe(value instanceof Error ? value.message : value);
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/**
 * @param {"warn" | "error"} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
function emit(level, msg, fields) {
  let line = `level=${level} msg="${safe(msg).replace(/"/g, '\\"')}"`;
  if (fields) {
    for (const [k, v] of Object.entries(fields)) line += ` ${safe(k)}=${formatValue(v)}`;
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
