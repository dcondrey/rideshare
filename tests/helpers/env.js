// @ts-check
/**
 * Environment setup for tests. Sets all required env vars to deterministic
 * values BEFORE any module under test is imported.
 *
 * Tests that need lib/config.js or anything that imports it must call
 * `setupTestEnv()` before any other import that touches config.
 *
 * Usage:
 *   import { setupTestEnv } from "../helpers/env.js";
 *   setupTestEnv();   // ← must come BEFORE imports that read process.env
 */

export function setupTestEnv(overrides = {}) {
  const defaults = {
    APP_URL: "http://localhost:9999",
    SESSION_SECRET: "a".repeat(64),
    ALLOWLIST_SALT: "b".repeat(64),
    ADMIN_EMAILS: "admin@example.test",
    EMAIL_FROM: "Test <noreply@example.test>",
    PORT: "9999",
    DATABASE_PATH: ":memory:",
    NODE_ENV: "test",
  };
  Object.assign(process.env, defaults, overrides);
}
