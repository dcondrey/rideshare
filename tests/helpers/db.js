// @ts-check
/**
 * Per-test isolated database. Each test file (or `beforeEach`) calls
 * `freshDb()` to get an in-memory SQLite instance with the full schema
 * applied. The instance is independent of the global `db` from `lib/db.js`.
 *
 * Why a separate factory: production code expects a singleton. Tests need
 * many isolated instances. We re-apply the schema bootstrap manually here.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Read the schema bootstrap SQL out of lib/db.js. We extract the inline
 * `db.exec(\`...\`)` blocks so tests stay in lockstep with production.
 *
 * Returns one big SQL string. Idempotent (CREATE IF NOT EXISTS everywhere).
 */
let cachedSchemaSql = null;
function loadSchemaSql() {
  if (cachedSchemaSql) return cachedSchemaSql;
  const dbModule = readFileSync(
    resolve(__dirname, "../../lib/db.js"),
    "utf8",
  );
  const blocks = [];
  // Match db.exec(`...`) blocks anywhere in the file
  const re = /db\.exec\(`([\s\S]*?)`\)/g;
  let m;
  while ((m = re.exec(dbModule)) !== null) blocks.push(m[1]);
  if (blocks.length === 0) {
    throw new Error("Could not find db.exec(`...`) blocks in lib/db.js");
  }
  cachedSchemaSql = blocks.join("\n");
  return cachedSchemaSql;
}

/**
 * Create a fresh in-memory SQLite database with the full app schema applied.
 * @returns {DatabaseSync}
 */
export function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = MEMORY;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(loadSchemaSql());
  // Seed schema_version
  const v = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
  if (!v) db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(2);
  return db;
}
