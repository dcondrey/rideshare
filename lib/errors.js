// @ts-check
/**
 * Narrowing helper for `catch` bindings.
 *
 * A catch binding is `unknown`, so `err.message` does not typecheck and a throw
 * of a non-Error still has to render sensibly.
 */

/**
 * @param {unknown} err
 * @returns {string}
 */
export function errorMessage(err) {
	return err instanceof Error ? err.message : String(err);
}
