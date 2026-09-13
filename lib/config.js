// @ts-check
/**
 * Loads environment + event config and exposes a frozen `config` object.
 *
 * Reads `.env` from the project root if present (manual parser — no dotenv dep).
 * Reads `event.config.json` for event-specific defaults; an admin can override
 * fields at runtime via the config_overrides DB table (see lib/event-config.js).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "./errors.js";
import { formatConfigProblems, validateEventConfig } from "./event-schema.js";
import { warn as logWarn } from "./log.js";
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
  const examplePath = resolve(ROOT, "event.config.example.yaml");

  if (existsSync(yamlPath) || existsSync(ymlPath)) {
    const path = existsSync(yamlPath) ? yamlPath : ymlPath;
    try {
      return validateOrExit(parseYaml(readFileSync(path, "utf8")), path);
    } catch (err) {
      const where = err instanceof YamlError && err.line ? ` (line ${err.line})` : "";
      console.error(`[config] Failed to parse ${path}${where}: ${errorMessage(err)}`);
      process.exit(1);
    }
  }
  if (existsSync(jsonPath)) {
    try {
      return validateOrExit(JSON.parse(readFileSync(jsonPath, "utf8")), jsonPath);
    } catch (err) {
      console.error(`[config] Failed to parse ${jsonPath}: ${errorMessage(err)}`);
      process.exit(1);
    }
  }
  // Fall back to the tracked example so a fresh checkout boots and CI has
  // something to run against. Loud, because every value in it is a placeholder:
  // a deployment running on this is showing "Your Event" to attendees.
  if (existsSync(examplePath)) {
    logWarn("no event.config.yaml; falling back to event.config.example.yaml", {
      fix: "cp event.config.example.yaml event.config.yaml",
      component: "config",
    });
    try {
      return validateOrExit(parseYaml(readFileSync(examplePath, "utf8")), examplePath);
    } catch (err) {
      const where = err instanceof YamlError && err.line ? ` (line ${err.line})` : "";
      console.error(`[config] Failed to parse ${examplePath}${where}: ${errorMessage(err)}`);
      process.exit(1);
    }
  }

  console.error(
    `[config] No event.config.yaml (or .yml or .json) found in ${ROOT}\n` +
      `         Copy the example to get started:  cp event.config.example.yaml event.config.yaml`,
  );
  process.exit(1);
}

/**
 * Reject a config the app cannot run on, naming every problem at once.
 *
 * REQUIRED: this runs before any route reads the config. Six files dereference
 * nested fields without a guard, which is only safe because a config missing
 * them never reaches them.
 * @template T
 * @param {T} cfg
 * @param {string} file
 * @returns {T}
 */
function validateOrExit(cfg, file) {
  const problems = validateEventConfig(cfg);
  if (problems.length === 0) return cfg;
  console.error(formatConfigProblems(problems, file));
  process.exit(1);
}

// ── Resolved config ──────────────────────────────────────────────────────────
const eventConfig = loadEventConfig();

const adminEmails = (optional("ADMIN_EMAILS", "") || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (adminEmails.length === 0) {
  logWarn("ADMIN_EMAILS is empty — nobody will be able to access /admin", { component: "config" });
}

export const config = Object.freeze({
  rootDir: ROOT,

  // Environment
  // IMPORTANT: defaults to production. Three of the documented deploy targets
  // never set NODE_ENV, so a permissive default fails open on a live server;
  // `npm run dev` sets it explicitly, so a wrong guess only costs a local demo.
  nodeEnv: optional("NODE_ENV", "production"),
  hostname: optional("HOSTNAME", "localhost"),

  // Server
  appUrl: required("APP_URL").replace(/\/$/, ""),
  port: intEnv("PORT", 3000),
  trustProxy: bool("TRUST_PROXY", false),

  // Opt-in, never inferred: allows did:web resolution to fall back to plaintext
  // HTTP for localhost / 127.0.0.1 so the demo and tests run without TLS.
  allowInsecureDidWeb: bool("ALLOW_INSECURE_DID_WEB", false),

  // Secrets
  sessionSecret: required("SESSION_SECRET"),
  // Deployment signing key custody. The key lives outside the database so the
  // SQLite-only backup carries no issuer key material; DEPLOYMENT_KEY is the
  // inline form for hosts with no persistent disk.
  deploymentKeyPath: optional("DEPLOYMENT_KEY_PATH", resolve(ROOT, "secrets", "deployment.key")),
  deploymentKey: optional("DEPLOYMENT_KEY", ""),
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
    // Escape hatch for a local development relay (MailHog, Mailpit) that speaks
    // no TLS at all. Off by default: without it, a relay that fails to offer
    // STARTTLS is refused rather than silently downgraded to plaintext.
    allowPlaintext: bool("SMTP_ALLOW_PLAINTEXT", false),
  },

  // Limits
  magicLinkRateLimit: intEnv("MAGIC_LINK_RATE_LIMIT", 5),
  sessionLifetimeDays: intEnv("SESSION_LIFETIME_DAYS", 14),

  // Event (file defaults; runtime overrides applied via lib/event-config.js)
  event: eventConfig,
});

// Validate secret strength
if (config.sessionSecret.length < 32) {
  logWarn("SESSION_SECRET is short; use 32+ random hex bytes", { component: "config" });
}
if (config.allowlistSalt.length < 32) {
  logWarn("ALLOWLIST_SALT is short; use 32+ random hex bytes", { component: "config" });
}
if (!config.resendApiKey && !config.smtp.host) {
  logWarn("no email transport configured; set RESEND_API_KEY or SMTP_* vars", {
    component: "config",
  });
}
if (config.smtp.host && (!config.smtp.user || !config.smtp.pass)) {
  logWarn("SMTP_HOST is set but SMTP_USER/SMTP_PASS are missing", { component: "config" });
}
if (config.allowInsecureDidWeb && config.appUrl.startsWith("https://")) {
  logWarn(
    "ALLOW_INSECURE_DID_WEB is on with an https APP_URL — unauthenticated callers can make this server fetch loopback ports",
    { component: "config" },
  );
}
if (config.nodeEnv !== "production" && config.appUrl.startsWith("https://")) {
  logWarn(`NODE_ENV is "${config.nodeEnv}" with an https APP_URL`, { component: "config" });
}
