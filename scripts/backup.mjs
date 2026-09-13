#!/usr/bin/env node
// @ts-check
// SPDX-License-Identifier: MIT
//
// backup.mjs
// ----------
// Take a consistent snapshot of the SQLite database while the server is running,
// verify it, and prune snapshots past the retention window. Implements the
// procedure in RUNBOOK.md#backup-procedure without shelling out to the `sqlite3`
// binary, which is not guaranteed to be installed on a deploy host.
//
// `VACUUM INTO` is SQLite's own online-snapshot path: it reads a single
// consistent view of the source database (WAL and all) and writes a compacted
// copy. The server may keep serving throughout.
//
// Run via: `node scripts/backup.mjs`
//
// Environment:
//   DATABASE_PATH   source database        (default: <repo>/data/app.db)
//   BACKUP_DIR      destination directory  (default: <repo>/backups)
//   RETENTION_DAYS  prune older snapshots  (default: 30, 0 disables pruning)
//
// Exit codes:
//   0 — snapshot written and verified
//   1 — backup failed (source missing, write failed, integrity check failed)
//   2 — bad configuration (unparseable RETENTION_DAYS)

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE = process.env.DATABASE_PATH || resolve(ROOT, "data", "app.db");
const BACKUP_DIR = process.env.BACKUP_DIR || resolve(ROOT, "backups");
const SNAPSHOT_RE = /^app-(\d{8}T\d{6}Z)\.db$/;
const MS_PER_DAY = 86_400_000;

function retentionDays() {
  const raw = process.env.RETENTION_DAYS;
  if (raw == null || raw === "") return 30;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`RETENTION_DAYS must be a non-negative integer, got: ${raw}`);
    process.exit(2);
  }
  return n;
}

/** UTC stamp with no punctuation SQLite or a shell would care about. */
function stamp(date = new Date()) {
  return `${date.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

/**
 * Snapshot SOURCE into `dest`. Returns the destination size in bytes.
 * @param {string} dest
 */
function snapshot(dest) {
  // Read-only: a backup must never be able to mutate live data, and it stops
  // this script from creating an empty database when DATABASE_PATH is wrong.
  const db = new DatabaseSync(SOURCE, { readOnly: true });
  try {
    // VACUUM INTO takes a string literal, not a bound parameter.
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return statSync(dest).size;
}

/**
 * PRAGMA integrity_check on the snapshot. Throws if it is not "ok".
 * @param {string} dest
 */
function verify(dest) {
  const db = new DatabaseSync(dest, { readOnly: true });
  try {
    const rows = /** @type {{ integrity_check: string }[]} */ (
      db.prepare("PRAGMA integrity_check").all()
    );
    const result = rows.map((r) => r.integrity_check).join("; ");
    if (result !== "ok") throw new Error(`integrity_check reported: ${result}`);
  } finally {
    db.close();
  }
}

/**
 * A snapshot must not carry issuer key material. lib/keys.js moves the private
 * key to secrets/deployment.key on first boot, but a database backed up before
 * the server has restarted still holds it, and RUNBOOK.md tells operators a
 * snapshot is safe to ship off-host.
 *
 * @param {string} dest
 * @returns {boolean} true when the snapshot is clean
 */
function assertNoKeyMaterial(dest) {
  const db = new DatabaseSync(dest, { readOnly: true });
  try {
    const present = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'signing_keys'")
      .get();
    if (!present) return true;
    const row = /** @type {{ n: number } | undefined} */ (
      db.prepare("SELECT COUNT(*) AS n FROM signing_keys WHERE private_key_jwk <> ''").get()
    );
    return !row || row.n === 0;
  } finally {
    db.close();
  }
}

/**
 * Delete snapshots older than `days`. Only files this script named are touched,
 * so pointing BACKUP_DIR at a populated directory cannot delete anything else.
 * @param {number} days
 * @returns {string[]} names removed
 */
function prune(days) {
  if (days === 0) return [];
  const cutoff = Date.now() - days * MS_PER_DAY;
  const removed = [];
  for (const name of readdirSync(BACKUP_DIR)) {
    if (!SNAPSHOT_RE.test(name)) continue;
    const full = join(BACKUP_DIR, name);
    if (statSync(full).mtimeMs >= cutoff) continue;
    rmSync(full);
    removed.push(name);
  }
  return removed;
}

function main() {
  const days = retentionDays();
  try {
    statSync(SOURCE);
  } catch {
    console.error(`No database at ${SOURCE}. Set DATABASE_PATH.`);
    process.exit(1);
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = join(BACKUP_DIR, `app-${stamp()}.db`);

  // The stamp has one-second resolution, so a double-run or a supervisor retry
  // can collide. VACUUM INTO refuses an existing destination anyway; bailing
  // here keeps the failure path from deleting the snapshot the other run wrote.
  if (existsSync(dest)) {
    console.error(`${dest} already exists — a backup for this second has run.`);
    process.exit(1);
  }

  let bytes;
  try {
    bytes = snapshot(dest);
    verify(dest);
  } catch (err) {
    // A half-written or corrupt snapshot is worse than none: it would be
    // restored in an incident and fail there instead of here.
    rmSync(dest, { force: true });
    console.error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`${dest} (${Math.round(bytes / 1024)}KB, verified)`);

  if (!assertNoKeyMaterial(dest)) {
    console.error(
      `WARNING: ${dest} still contains the deployment signing key. Restart the ` +
        `server once so it migrates the key to DEPLOYMENT_KEY_PATH, then re-run ` +
        `this backup and destroy this snapshot. Do not ship it off-host.`,
    );
  }

  const removed = prune(days);
  if (removed.length > 0) {
    console.log(`Pruned ${removed.length} snapshot(s) older than ${days} days.`);
  }
}

main();
