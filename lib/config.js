// @ts-check
/**
 * Loads environment + event config and exposes a frozen `config` object.
 *
 * Reads `.env` from the project root if present (manual parser — no dotenv dep).
 * Reads `event.config.json` for event-specific defaults; an admin can override
 * fields at runtime via the config_overrides DB table (see lib/event-config.js).
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parseYaml, YamlError } from "./yaml.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── .env loader ──────────────────────────────────────────────────────────────
// Minimal parser. Supports KEY=value, KEY="quoted value", # comments, blank lines.
// Does not support multi-line values or variable expansion (kept intentionally simple).
function loadDotEnv() {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

// ── Required env helpers ─────────────────────────────────────────────────────
function required(name) {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    console.error(
      `\n[config] Missing required env var: ${name}\n` +
        `         Copy .env.example to .env and fill it in.\n`,
    );
    process.exit(1);
  }
  return v;
}
function optional(name, fallback) {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}
function bool(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}
function intEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ── event.config.{yaml,json} loader ──────────────────────────────────────────
// Prefers YAML for editor friendliness; falls back to JSON for back-compat or
// for users who want guaranteed full JSON compliance.
function loadEventConfig() {
  const yamlPath = resolve(ROOT, "event.config.yaml");
  const ymlPath = resolve(ROOT, "event.config.yml");
  const jsonPath = resolve(ROOT, "event.config.json");

  if (existsSync(yamlPath) || existsSync(ymlPath)) {
    const path = existsSync(yamlPath) ? yamlPath : ymlPath;
    try {
      return parseYaml(readFileSync(path, "utf8"));
    } catch (err) {
      const where = err instanceof YamlError && err.line ? ` (line ${err.line})` : "";
      console.error(`[config] Failed to parse ${path}${where}: ${err.message}`);
      process.exit(1);
    }
  }
  if (existsSync(jsonPath)) {
    try {
      return JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch (err) {
      console.error(`[config] Failed to parse ${jsonPath}: ${err.message}`);
      process.exit(1);
    }
  }
  console.error(
    `[config] No event.config.yaml (or .yml or .json) found in ${ROOT}`,
  );
  process.exit(1);
}

// ── Resolved config ──────────────────────────────────────────────────────────
const eventConfig = loadEventConfig();

const adminEmails = (optional("ADMIN_EMAILS", "") || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (adminEmails.length === 0) {
  console.warn(
    "[config] WARNING: ADMIN_EMAILS is empty — nobody will be able to access /admin.",
  );
}

export const config = Object.freeze({
  rootDir: ROOT,

  // Server
  appUrl: required("APP_URL").replace(/\/$/, ""),
  port: intEnv("PORT", 3000),
  trustProxy: bool("TRUST_PROXY", false),

  // Secrets
  sessionSecret: required("SESSION_SECRET"),
  allowlistSalt: required("ALLOWLIST_SALT"),

  // Admin
  adminEmails,

  // DB
  databasePath: optional("DATABASE_PATH", resolve(ROOT, "data", "app.db")),

  // Email
  resendApiKey: optional("RESEND_API_KEY", ""),
  emailFrom: optional("EMAIL_FROM", "Rideshare <noreply@example.com>"),
  smtp: {
    host: optional("SMTP_HOST", ""),
    port: intEnv("SMTP_PORT", 587),
    user: optional("SMTP_USER", ""),
    pass: optional("SMTP_PASS", ""),
    secure: bool("SMTP_SECURE", false),
  },

  // Limits
  magicLinkRateLimit: intEnv("MAGIC_LINK_RATE_LIMIT", 5),
  sessionLifetimeDays: intEnv("SESSION_LIFETIME_DAYS", 14),

  // Event (file defaults; runtime overrides applied via lib/event-config.js)
  event: eventConfig,
});

// Validate secret strength
if (config.sessionSecret.length < 32) {
  console.warn(
    "[config] WARNING: SESSION_SECRET is short. Use 32+ random hex bytes.",
  );
}
if (config.allowlistSalt.length < 32) {
  console.warn(
    "[config] WARNING: ALLOWLIST_SALT is short. Use 32+ random hex bytes.",
  );
}
if (!config.resendApiKey && !config.smtp.host) {
  console.warn(
    "[config] WARNING: No email transport configured. " +
      "Set RESEND_API_KEY or SMTP_* vars. Magic links will fail to send.",
  );
}
