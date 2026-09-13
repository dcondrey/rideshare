// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setupTestEnv } from "../helpers/env.js";

const dir = mkdtempSync(join(tmpdir(), "rs-key-custody-"));
const keyPath = join(dir, "deployment.key");
// APP_URL has to name the same host as the DID under test: loadDeploymentKey
// refuses a key whose DID was pinned to a different host.
setupTestEnv({
  DATABASE_PATH: join(dir, "app.db"),
  DEPLOYMENT_KEY_PATH: keyPath,
  APP_URL: "https://legacy.example",
});

const { db } = await import("../../lib/db.js");
const { generateEd25519Keypair, keyToJwkString } = await import("../../lib/did.js");
const { loadDeploymentKey, resetDeploymentKeyCache } = await import("../../lib/keys.js");

const legacy = generateEd25519Keypair();
const legacyPrivateJwk = keyToJwkString(legacy.privateKey);

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("a pre-existing in-database key is migrated out to the key file", () => {
  db.prepare(
    `INSERT INTO signing_keys (id, algorithm, public_key_jwk, private_key_jwk, did, key_fragment, created_at)
     VALUES (1, 'Ed25519', ?, ?, 'did:web:legacy.example', 'key-1', ?)`,
  ).run(keyToJwkString(legacy.publicKey), legacyPrivateJwk, 1700000000000);

  const key = loadDeploymentKey();

  assert.equal(keyToJwkString(key.privateKey), legacyPrivateJwk, "same key, new home");
  assert.equal(key.did, "did:web:legacy.example", "the published DID survives the move");
  assert.equal(statSync(keyPath).mode & 0o777, 0o600, "key file is owner-only");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM signing_keys").get()?.n,
    0,
    "the private key no longer sits in the file scripts/backup.mjs copies",
  );
  assert.equal(
    db.prepare("SELECT public_key_jwk FROM deployment_identity WHERE id = 1").get()?.public_key_jwk,
    keyToJwkString(legacy.publicKey),
    "the public half stays behind so a swap is detectable",
  );
});

test("a later boot loads the same key from the file", () => {
  resetDeploymentKeyCache();
  assert.equal(keyToJwkString(loadDeploymentKey().privateKey), legacyPrivateJwk);
});

test("a key file that does not match the published identity is refused", () => {
  const impostor = generateEd25519Keypair();
  rmSync(keyPath);
  writeFileSync(
    keyPath,
    JSON.stringify({
      version: 1,
      algorithm: "Ed25519",
      did: "did:web:legacy.example",
      key_fragment: "key-1",
      created_at: Date.now(),
      private_key_jwk: keyToJwkString(impostor.privateKey),
    }),
    { mode: 0o600 },
  );
  resetDeploymentKeyCache();
  assert.throws(() => loadDeploymentKey(), /does not match/);
});

test("a key file pinned to a different host than APP_URL is refused", () => {
  const other = generateEd25519Keypair();
  rmSync(keyPath, { force: true });
  writeFileSync(
    keyPath,
    JSON.stringify({
      version: 1,
      algorithm: "Ed25519",
      did: "did:web:staging.example",
      key_fragment: "key-1",
      created_at: Date.now(),
      private_key_jwk: keyToJwkString(other.privateKey),
    }),
    { mode: 0o600 },
  );
  resetDeploymentKeyCache();
  assert.throws(() => loadDeploymentKey(), /does not match APP_URL/);
});
