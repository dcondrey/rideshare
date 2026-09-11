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
