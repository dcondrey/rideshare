// @ts-check
/**
 * Database layer — node:sqlite (Node ≥22.5).
 *
 * Schema is bootstrapped on first start. Migrations are append-only:
 * each block uses CREATE TABLE IF NOT EXISTS / ALTER TABLE guarded by
 * checks against the schema_version table. Keep changes additive.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { config } from "./config.js";

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);

// Pragmas: WAL for concurrent reads during writes, foreign keys on.
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA synchronous = NORMAL;");

// ── Schema bootstrap ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT    NOT NULL UNIQUE,
    display_name TEXT,
    contact_method TEXT,        -- "Signal: +1...", "@handle on X", etc.
    created_at  INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT    PRIMARY KEY,         -- random opaque token (cookie value)
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS magic_links (
    token_hash TEXT    PRIMARY KEY,         -- HMAC of the token (never raw)
    email      TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    ip         TEXT
  );
  CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links(email);
  CREATE INDEX IF NOT EXISTS magic_links_expires_idx ON magic_links(expires_at);

  -- Hashed allowlist. Raw emails are NEVER stored here.
  -- email_hash = HMAC-SHA256(normalize(email), ALLOWLIST_SALT)
  CREATE TABLE IF NOT EXISTS allowlist_hashes (
    email_hash TEXT PRIMARY KEY,
    added_at   INTEGER NOT NULL
  );

  -- Runtime overrides for event.config.json fields. Stored as JSON-encoded values.
  CREATE TABLE IF NOT EXISTS config_overrides (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rides (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT    NOT NULL CHECK (kind IN ('offer','request')),
    direction    TEXT    NOT NULL CHECK (direction IN ('to_venue','from_venue')),
    airport      TEXT    NOT NULL,           -- airport code or "OTHER"
    other_place  TEXT,                       -- if airport = "OTHER"
    depart_date  TEXT    NOT NULL,           -- YYYY-MM-DD
    depart_time  TEXT    NOT NULL,           -- HH:MM (24h)
    flex_minutes INTEGER NOT NULL DEFAULT 0, -- ± minutes the poster is flexible
    seats        INTEGER NOT NULL DEFAULT 1, -- offers: seats available; requests: seats needed
    notes        TEXT,
    status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','full','cancelled')),
    pickup_lat   REAL,                       -- optional custom pickup pin (otherwise derived)
    pickup_lng   REAL,
    meetup_id    INTEGER REFERENCES meetups(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rides_user_idx ON rides(user_id);
  CREATE INDEX IF NOT EXISTS rides_browse_idx
    ON rides(status, kind, direction, depart_date);

  CREATE TABLE IF NOT EXISTS claims (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ride_id     INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    claimer_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seats       INTEGER NOT NULL DEFAULT 1,
    message     TEXT,
    status      TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','declined','withdrawn')),
    created_at  INTEGER NOT NULL,
    decided_at  INTEGER,
    UNIQUE (ride_id, claimer_id)             -- one claim per user per ride
  );
  CREATE INDEX IF NOT EXISTS claims_ride_idx ON claims(ride_id);
  CREATE INDEX IF NOT EXISTS claims_claimer_idx ON claims(claimer_id);

  -- Binary assets stored in the DB (logo, etc.). Keyed by name; one row per asset.
  CREATE TABLE IF NOT EXISTS assets (
    name        TEXT    PRIMARY KEY,
    mime_type   TEXT    NOT NULL,
    bytes       BLOB    NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- Event-defined meetup / pickup spots, editable in the admin UI.
  -- Initial rows are seeded from event.config.yaml#meetups on first boot.
  CREATE TABLE IF NOT EXISTS meetups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    address    TEXT,
    lat        REAL    NOT NULL,
    lng        REAL    NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  -- ── Trust / DID layer ────────────────────────────────────────────────────
  -- The deployment's own Ed25519 signing key. One row, generated at first
  -- boot. Never rotate without invalidating credentials downstream.
  CREATE TABLE IF NOT EXISTS signing_keys (
    id              INTEGER PRIMARY KEY,
    algorithm       TEXT    NOT NULL DEFAULT 'Ed25519',
    public_key_jwk  TEXT    NOT NULL,
    private_key_jwk TEXT    NOT NULL,
    did             TEXT    NOT NULL,
    key_fragment    TEXT    NOT NULL DEFAULT 'key-1',
    created_at      INTEGER NOT NULL
  );

  -- A user has at most one bound DID:key (their portable identity).
  CREATE TABLE IF NOT EXISTS user_dids (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    did        TEXT    NOT NULL UNIQUE,
    bound_at   INTEGER NOT NULL
  );

  -- One-time challenges issued by /me/did/challenge, consumed by bind.
  CREATE TABLE IF NOT EXISTS did_challenges (
    challenge   TEXT    PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    consumed_at INTEGER
  );

  -- Per-user, per-ride confirmation that the ride actually took place.
  -- When BOTH parties to an accepted claim confirm, credentials are issued.
  CREATE TABLE IF NOT EXISTS ride_confirmations (
    ride_id      INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    claim_id     INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    confirmed_at INTEGER NOT NULL,
    PRIMARY KEY (ride_id, user_id)
  );

  -- Credentials we have issued. We store the JWT verbatim so users can
  -- re-fetch theirs across sessions / devices.
  CREATE TABLE IF NOT EXISTS credentials_issued (
    id              TEXT    PRIMARY KEY,         -- credential id (urn:uuid)
    ride_id         INTEGER REFERENCES rides(id) ON DELETE SET NULL,
    subject_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    subject_did     TEXT    NOT NULL,
    counterpart_did TEXT,                         -- the other party's DID, if known
    jwt             TEXT    NOT NULL,
    issued_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS credentials_issued_subject_idx
    ON credentials_issued(subject_user_id);

  -- Credentials a user has imported from other deployments. Verified at
  -- import time; re-verifiable on demand.
  CREATE TABLE IF NOT EXISTS imported_credentials (
    id                  TEXT    PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issuer_did          TEXT    NOT NULL,
    subject_did         TEXT    NOT NULL,
    counterpart_did     TEXT,
    issued_at_iso       TEXT,
    jwt                 TEXT    NOT NULL,
    imported_at         INTEGER NOT NULL,
    last_verified_at    INTEGER,
    verification_status TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (verification_status IN ('pending','valid','invalid'))
  );
  CREATE INDEX IF NOT EXISTS imported_credentials_user_idx
    ON imported_credentials(user_id);

  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_email TEXT,                          -- denormalised in case user deleted
    action     TEXT    NOT NULL,
    detail     TEXT,
    ip         TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at);
`);

// Seed schema_version if empty
const versionRow = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
if (!versionRow) {
  db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(2);
}

// ── Forward-only migrations ──────────────────────────────────────────────────
// Each block is wrapped in try/catch so re-runs are no-ops on already-migrated
// DBs. New columns are added with defaults so reads of existing rows still work.
function tryExec(sql) {
  try { db.exec(sql); } catch (err) {
    // Most ALTERs error with "duplicate column" or "already exists" on re-run.
    if (!/duplicate|already exists/i.test(err.message)) throw err;
  }
}
tryExec("ALTER TABLE rides ADD COLUMN pickup_lat REAL");
tryExec("ALTER TABLE rides ADD COLUMN pickup_lng REAL");
tryExec("ALTER TABLE rides ADD COLUMN meetup_id INTEGER REFERENCES meetups(id) ON DELETE SET NULL");

// ── Sweep expired magic links + sessions on boot ─────────────────────────────
const now = Date.now();
db.prepare("DELETE FROM magic_links WHERE expires_at < ?").run(now);
db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);

// ── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Insert into audit_log. Never throws — best-effort.
 * @param {{ actorId?: number|null, actorEmail?: string|null,
 *           action: string, detail?: string|null, ip?: string|null }} entry
 */
export function audit(entry) {
  try {
    db.prepare(
      `INSERT INTO audit_log (actor_id, actor_email, action, detail, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.actorId ?? null,
      entry.actorEmail ?? null,
      entry.action,
      entry.detail ?? null,
      entry.ip ?? null,
      Date.now(),
    );
  } catch (err) {
    console.error("[audit] failed:", err.message);
  }
}

/**
 * Run a function inside a transaction. Aborts and re-throws on error.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function tx(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
