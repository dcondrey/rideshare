// @ts-check
/**
 * Side-effect test environment setup. Sets process.env defaults if missing,
 * then re-exports `setupTestEnv` for tests that need to override during runtime.
 *
 * Usage:
 *   import "../helpers/setup.js";   // ← FIRST import in any test that needs config
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test process gets its own deployment key file: lib/keys.js refuses to
// overwrite one, and a shared path would leak identity between test runs.
const KEY_DIR = mkdtempSync(join(tmpdir(), "rs-keys-"));
process.on("exit", () => {
  rmSync(KEY_DIR, { recursive: true, force: true });
});

const TEST_DEFAULTS = {
  APP_URL: "http://localhost:9999",
  SESSION_SECRET: "a".repeat(64),
  ALLOWLIST_SALT: "b".repeat(64),
  ADMIN_EMAILS: "admin@example.test",
  EMAIL_FROM: "Test <noreply@example.test>",
  PORT: "9999",
  DATABASE_PATH: ":memory:",
  NODE_ENV: "test",
  DEPLOYMENT_KEY_PATH: join(KEY_DIR, "deployment.key"),
};

// Always cleared, never inherited: a developer's shell or .env carrying a real
// key would otherwise send live mail from the suite. An empty string also stops
// lib/config.js's .env loader from filling these in. Tests that need a
// transport opt in through setupTestEnv/startTestServer overrides.
const EMAIL_TRANSPORT_CLEARED = {
  RESEND_API_KEY: "",
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASS: "",
};

for (const [k, v] of Object.entries(TEST_DEFAULTS)) {
  if (!process.env[k]) process.env[k] = v;
}
Object.assign(process.env, EMAIL_TRANSPORT_CLEARED);

export function setupTestEnv(overrides = {}) {
  Object.assign(process.env, TEST_DEFAULTS, EMAIL_TRANSPORT_CLEARED, overrides);
}
