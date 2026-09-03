// @ts-check
/**
 * Environment setup for tests. Sets all required env vars to deterministic
 * values BEFORE any module under test is imported.
 *
 * IMPORTANT: the defaults are applied as a module *side effect*, at import
 * time. They have to be. `import` declarations are hoisted and every imported
 * module is evaluated before the first statement of the importing file runs,
 * so the older documented pattern —
 *
 *     import { setupTestEnv } from "../helpers/env.js";
 *     setupTestEnv();                    // ← runs too late
 *     import { thing } from "../../lib/thing.js";
 *
 * — could never work: lib/thing.js (and lib/config.js under it) was already
 * evaluated, and lib/config.js exits the process when APP_URL is missing.
 * Importing this module at all is now what sets the env, and ESM evaluates
 * dependencies in source order, so listing it above the modules under test is
 * sufficient.
 *
 * Usage:
 *   import { setupTestEnv } from "../helpers/env.js";   // ← env is set here
 *   setupTestEnv({ NODE_ENV: "production" });           // optional overrides
 *
 * `setupTestEnv` is still exported for tests that need to override a value at
 * runtime. Re-exported from helpers/setup.js so there is exactly one copy of
 * the defaults.
 */
export { setupTestEnv } from "./setup.js";
