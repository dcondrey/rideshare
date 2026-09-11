// @ts-check
/**
 * Side-effect test environment setup. Sets process.env defaults if missing,
 * then re-exports `setupTestEnv` for tests that need to override during runtime.
 *
 * Usage:
 *   import "../helpers/setup.js";   // ← FIRST import in any test that needs config
 */

const TEST_DEFAULTS = {
  APP_URL: "http://localhost:9999",
  SESSION_SECRET: "a".repeat(64),
  ALLOWLIST_SALT: "b".repeat(64),
  ADMIN_EMAILS: "admin@example.test",
  EMAIL_FROM: "Test <noreply@example.test>",
  PORT: "9999",
  DATABASE_PATH: ":memory:",
  NODE_ENV: "test",
};

for (const [k, v] of Object.entries(TEST_DEFAULTS)) {
  if (!process.env[k]) process.env[k] = v;
}

export function setupTestEnv(overrides = {}) {
  Object.assign(process.env, TEST_DEFAULTS, overrides);
}
