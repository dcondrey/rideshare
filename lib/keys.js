// @ts-check
/**
 * Custody of the deployment's Ed25519 signing key.
 *
 * The private key lives in a file outside the database — `secrets/deployment.key`
 * by default, `DEPLOYMENT_KEY_PATH` to move it, `DEPLOYMENT_KEY` to supply it
 * inline on a host with no persistent disk. `scripts/backup.mjs` copies only
 * the SQLite file, so a backup carries no issuer key material.
 *
 * Deployments created before this module stored the private key in the
 * `signing_keys` table. `loadDeploymentKey()` migrates one automatically: it
 * writes the key file, reads it back, and only then removes the private key
 * from the database. The public key and the DID stay in `deployment_identity`
 * so a swapped key file is detected rather than silently trusted — every
 * credential already issued verifies against the old public key.
 *
 * Nothing here is logged: no key material, no file contents, and the key file
 * path only on the migration line an operator needs to see.
 */

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { didWebFor, generateEd25519Keypair, keyFromJwkString, keyToJwkString } from "./did.js";
import { info, warn } from "./log.js";

/**
 * @typedef {{
 *   privateKey: import("node:crypto").KeyObject,
 *   publicKey: import("node:crypto").KeyObject,
 *   did: string,
 *   keyFragment: string,
 * }} DeploymentKey
 * @typedef {{ version: number, algorithm: string, did: string,
 *   key_fragment: string, created_at: number, private_key_jwk: string }} KeyFile
 */

const KEY_FILE_VERSION = 1;

/** @type {DeploymentKey | null} */
let cached = null;

db.exec(`
  CREATE TABLE IF NOT EXISTS deployment_identity (
    id             INTEGER PRIMARY KEY,
    algorithm      TEXT    NOT NULL DEFAULT 'Ed25519',
    public_key_jwk TEXT    NOT NULL,
    did            TEXT    NOT NULL,
    key_fragment   TEXT    NOT NULL DEFAULT 'key-1',
    created_at     INTEGER NOT NULL
  );
`);

/**
 * @param {string} raw
 * @returns {DeploymentKey}
 */
function parseKeyFile(raw) {
  /** @type {KeyFile} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("deployment key is not valid JSON");
  }
  if (!parsed || typeof parsed.private_key_jwk !== "string" || !parsed.private_key_jwk) {
    throw new Error("deployment key file has no private_key_jwk");
  }
  if (parsed.algorithm && parsed.algorithm !== "Ed25519") {
    throw new Error(`unsupported deployment key algorithm: ${parsed.algorithm}`);
  }
  const privateKey = keyFromJwkString(parsed.private_key_jwk, "private");
  const publicKey = publicFromPrivate(privateKey);
  return {
    privateKey,
    publicKey,
    did: parsed.did || didWebFor(config.appUrl),
    keyFragment: parsed.key_fragment || "key-1",
  };
}

/**
 * Derive the public key from the private one rather than trusting a stored
 * copy: a key file whose two halves disagree must not be usable.
 * @param {import("node:crypto").KeyObject} privateKey
 */
function publicFromPrivate(privateKey) {
  const jwk = /** @type {Record<string, unknown>} */ (privateKey.export({ format: "jwk" }));
  const { d: _discard, ...pub } = jwk;
  return keyFromJwkString(JSON.stringify(pub), "public");
}

/** @param {DeploymentKey} key @param {number} createdAt */
function serialiseKeyFile(key, createdAt) {
  return `${JSON.stringify(
    {
      version: KEY_FILE_VERSION,
      algorithm: "Ed25519",
      did: key.did,
      key_fragment: key.keyFragment,
      created_at: createdAt,
      private_key_jwk: keyToJwkString(key.privateKey),
    },
    null,
    2,
  )}\n`;
}

/**
 * Write the key file with owner-only permissions, creating its directory the
 * same way. Refuses to overwrite: a second key would invalidate every
 * credential this deployment has issued.
 *
 * @param {string} path
 * @param {DeploymentKey} key
 * @param {number} createdAt
 */
function writeKeyFile(path, key, createdAt) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, serialiseKeyFile(key, createdAt), { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

/** @param {string} path */
function readKeyFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null;
    throw err;
  }
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    warn("deployment key file is readable beyond its owner; run chmod 600", {
      component: "keys",
      mode: mode.toString(8),
    });
  }
  return parseKeyFile(raw);
}

/**
 * @returns {{ public_key_jwk: string, did: string, key_fragment: string } | undefined}
 */
function identityRow() {
  return /** @type {{ public_key_jwk: string, did: string, key_fragment: string } | undefined} */ (
    db
      .prepare("SELECT public_key_jwk, did, key_fragment FROM deployment_identity WHERE id = 1")
      .get()
  );
}

/** @param {DeploymentKey} key @param {number} createdAt */
function recordIdentity(key, createdAt) {
  db.prepare(
    `INSERT INTO deployment_identity (id, algorithm, public_key_jwk, did, key_fragment, created_at)
     VALUES (1, 'Ed25519', ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(keyToJwkString(key.publicKey), key.did, key.keyFragment, createdAt);
}

/**
 * IMPORTANT: a key file that does not match the recorded public key signs
 * credentials nobody can verify against the DID document peers already hold.
 * Refuse to run rather than issue them.
 *
 * @param {DeploymentKey} key
 */
/**
 * The DID is written into the key file when the key is generated, so it pins
 * the host APP_URL had at first boot. Moving the deployment to a new host
 * without re-keying keeps issuing credentials whose `iss` document lives
 * somewhere else, and every other deployment rejects them at import with no
 * error visible here.
 * @param {DeploymentKey} key
 */
function assertDidMatchesAppUrl(key) {
  const expected = didWebFor(config.appUrl);
  if (key.did === expected) return;
  throw new Error(
    `deployment DID ${key.did} does not match APP_URL (${config.appUrl} → ${expected}). ` +
      "Credentials issued under the stored DID are unverifiable at this host. Restore the " +
      "original APP_URL, or generate a new identity by moving the key file aside and clearing " +
      "deployment_identity.",
  );
}

function assertMatchesRecordedIdentity(key) {
  const row = identityRow();
  if (!row) return;
  if (row.public_key_jwk !== keyToJwkString(key.publicKey)) {
    throw new Error(
      "deployment key does not match the public key this deployment has already published; " +
        "restore the original key file or clear deployment_identity to adopt a new identity",
    );
  }
}

/**
 * Move a pre-existing in-database key out to the key file. The database row is
 * cleared only after the file has been read back successfully, so a failed
 * migration leaves the deployment exactly as it was.
 *
 * @param {string} path
 * @returns {DeploymentKey | null}
 */
function migrateFromDatabase(path) {
  const row = /** @type {{ private_key_jwk: string, public_key_jwk: string, did: string,
   *   key_fragment: string, created_at: number } | undefined} */ (
    db
      .prepare(
        "SELECT private_key_jwk, public_key_jwk, did, key_fragment, created_at FROM signing_keys WHERE id = 1",
      )
      .get()
  );
  if (!row || !row.private_key_jwk) return null;

  const privateKey = keyFromJwkString(row.private_key_jwk, "private");
  /** @type {DeploymentKey} */
  const key = {
    privateKey,
    publicKey: publicFromPrivate(privateKey),
    did: row.did,
    keyFragment: row.key_fragment || "key-1",
  };
  assertDidMatchesAppUrl(key);
  writeKeyFile(path, key, row.created_at);
  const readBack = readKeyFile(path);
  if (!readBack || keyToJwkString(readBack.privateKey) !== row.private_key_jwk) {
    throw new Error("deployment key file did not read back as written; database left untouched");
  }
  recordIdentity(key, row.created_at);
  db.prepare("DELETE FROM signing_keys WHERE id = 1").run();
  info(`[keys] moved the deployment signing key out of the database into ${path}`);
  return key;
}

/**
 * The deployment's signing key. Generates one on first boot.
 * @returns {DeploymentKey}
 */
export function loadDeploymentKey() {
  if (cached) return cached;

  const inline = config.deploymentKey;
  if (inline) {
    const key = parseKeyFile(inline);
    assertDidMatchesAppUrl(key);
    assertMatchesRecordedIdentity(key);
    recordIdentity(key, Date.now());
    cached = key;
    return cached;
  }

  const path = config.deploymentKeyPath;
  const fromFile = readKeyFile(path);
  if (fromFile) {
    assertDidMatchesAppUrl(fromFile);
    assertMatchesRecordedIdentity(fromFile);
    recordIdentity(fromFile, Date.now());
    cached = fromFile;
    return cached;
  }

  const migrated = migrateFromDatabase(path);
  if (migrated) {
    cached = migrated;
    return cached;
  }

  const { publicKey, privateKey } = generateEd25519Keypair();
  /** @type {DeploymentKey} */
  const key = { privateKey, publicKey, did: didWebFor(config.appUrl), keyFragment: "key-1" };
  const createdAt = Date.now();
  writeKeyFile(path, key, createdAt);
  assertMatchesRecordedIdentity(key);
  recordIdentity(key, createdAt);
  info(`[keys] generated deployment Ed25519 keypair; DID = ${key.did}`);
  cached = key;
  return cached;
}

/** Test seam: drop the in-process cache. */
export function resetDeploymentKeyCache() {
  cached = null;
}
