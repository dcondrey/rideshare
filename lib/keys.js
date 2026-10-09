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

import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
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
  siblingCache.clear();
}

// ── Sibling keys: ES256 issuer key, X25519 DIDComm key ──────────────────────
// SD-JWT VC and OpenID4VC wallets require ES256, and DIDComm needs an X25519
// key-agreement key; the Ed25519 key above can do neither. Each lives in its
// own file beside the first (or inline in an env var) so adding one never
// rewrites the Ed25519 key file, which is deliberately write-once. Each public
// half is recorded in deployment_identity (rows 2 and 3) and checked on load.

/**
 * @typedef {{ privateKey: import("node:crypto").KeyObject,
 *   publicKey: import("node:crypto").KeyObject, keyFragment: string }} SiblingKey
 * @typedef {{ algorithm: string, suffix: string, rowId: number, fragment: string,
 *   inline: () => string, generate: () => { privateKey: import("node:crypto").KeyObject },
 *   accepts: (k: import("node:crypto").KeyObject) => boolean }} SiblingSpec
 */

/** @type {Map<string, SiblingKey>} */
const siblingCache = new Map();

/** @param {SiblingSpec} spec @param {string} raw */
function parseSiblingFile(spec, raw) {
  /** @type {{ algorithm?: string, private_key_jwk?: string, key_fragment?: string }} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${spec.algorithm} deployment key is not valid JSON`);
  }
  if (parsed.algorithm !== spec.algorithm || typeof parsed.private_key_jwk !== "string") {
    throw new Error(
      `${spec.algorithm} deployment key file must have algorithm ${spec.algorithm} and a private_key_jwk`,
    );
  }
  const privateKey = createPrivateKey({ key: JSON.parse(parsed.private_key_jwk), format: "jwk" });
  if (!spec.accepts(privateKey))
    throw new Error(`${spec.algorithm} deployment key has the wrong key type`);
  return {
    privateKey,
    publicKey: createPublicKey(privateKey),
    keyFragment: parsed.key_fragment || spec.fragment,
  };
}

/** @param {SiblingKey} key */
function siblingPublicJwk(key) {
  const { kty, crv, x, y } = /** @type {Record<string, string>} */ (
    key.publicKey.export({ format: "jwk" })
  );
  return JSON.stringify(y ? { kty, crv, x, y } : { kty, crv, x });
}

/** @param {SiblingSpec} spec @param {SiblingKey} key */
function checkAndRecordSibling(spec, key) {
  const row = /** @type {{ public_key_jwk: string } | undefined} */ (
    db.prepare("SELECT public_key_jwk FROM deployment_identity WHERE id = ?").get(spec.rowId)
  );
  if (row && row.public_key_jwk !== siblingPublicJwk(key)) {
    throw new Error(
      `${spec.algorithm} deployment key does not match the public key this deployment has already published; ` +
        `restore the original ${spec.suffix} key file or delete deployment_identity row ${spec.rowId} to adopt a new one`,
    );
  }
  db.prepare(
    `INSERT INTO deployment_identity (id, algorithm, public_key_jwk, did, key_fragment, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    spec.rowId,
    spec.algorithm,
    siblingPublicJwk(key),
    didWebFor(config.appUrl),
    key.keyFragment,
    Date.now(),
  );
}

/** @param {SiblingSpec} spec @returns {SiblingKey} */
function loadSibling(spec) {
  const hit = siblingCache.get(spec.algorithm);
  if (hit) return hit;
  const inline = spec.inline();
  let key;
  if (inline) {
    key = parseSiblingFile(spec, inline);
    checkAndRecordSibling(spec, key);
  } else {
    const path = `${config.deploymentKeyPath}${spec.suffix}`;
    let raw = null;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err;
    }
    if (raw !== null) {
      key = parseSiblingFile(spec, raw);
      checkAndRecordSibling(spec, key);
    } else {
      const { privateKey } = spec.generate();
      key = { privateKey, publicKey: createPublicKey(privateKey), keyFragment: spec.fragment };
      checkAndRecordSibling(spec, key);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(
        path,
        `${JSON.stringify(
          {
            version: KEY_FILE_VERSION,
            algorithm: spec.algorithm,
            key_fragment: key.keyFragment,
            created_at: Date.now(),
            private_key_jwk: JSON.stringify(privateKey.export({ format: "jwk" })),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600, flag: "wx" },
      );
      chmodSync(path, 0o600);
      info(`[keys] generated deployment ${spec.algorithm} keypair`);
    }
  }
  siblingCache.set(spec.algorithm, key);
  return key;
}

/** @type {SiblingSpec} */
const ES256_SPEC = {
  algorithm: "ES256",
  suffix: ".es256",
  rowId: 2,
  fragment: "key-2",
  inline: () => config.deploymentEs256Key,
  generate: () => generateKeyPairSync("ec", { namedCurve: "P-256" }),
  accepts: (k) =>
    k.asymmetricKeyType === "ec" && k.asymmetricKeyDetails?.namedCurve === "prime256v1",
};

/** @type {SiblingSpec} */
const X25519_SPEC = {
  algorithm: "X25519",
  suffix: ".x25519",
  rowId: 3,
  fragment: "key-x25519-1",
  inline: () => config.deploymentX25519Key,
  generate: () => generateKeyPairSync("x25519"),
  accepts: (k) => k.asymmetricKeyType === "x25519",
};

/**
 * The deployment's ES256 signing key (SD-JWT VC, OpenID4VC), generated on
 * first use at `${DEPLOYMENT_KEY_PATH}.es256` or read from DEPLOYMENT_ES256_KEY.
 * @returns {SiblingKey}
 */
export function loadEs256Key() {
  return loadSibling(ES256_SPEC);
}

/**
 * The deployment's X25519 key-agreement key (DIDComm), generated on first use
 * at `${DEPLOYMENT_KEY_PATH}.x25519` or read from DEPLOYMENT_X25519_KEY.
 * @returns {SiblingKey}
 */
export function loadX25519Key() {
  return loadSibling(X25519_SPEC);
}
