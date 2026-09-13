// @ts-check
/**
 * Re-verification of imported credentials must be able to say "no" without
 * being able to say it by accident.
 *
 * `verification_status = 'invalid'` is terminal: revalidateImportedCredentials
 * only ever reads rows that are still 'valid'. So a failure that would not
 * recur on retry — a signature that does not verify, a credential past its
 * `exp` — has to write it, and a failure that says nothing about the credential
 * — DNS down, connection refused, TLS mismatch at the issuer's host — must not.
 * verifyCredential reports the second kind as `ok: false` with
 * `issuer_resolution_failed`, not by throwing, which is what makes this easy to
 * get wrong.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { setupTestEnv } from "../helpers/env.js";

setupTestEnv();

import { db } from "../../lib/db.js";
import { revalidateImportedCredentials } from "../../lib/trust.js";

let seq = 0;

function makeUser() {
  seq++;
  const now = Date.now();
  return Number(
    db
      .prepare(
        "INSERT INTO users (email, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
      )
      .run(`holder${seq}@example.com`, `Holder ${seq}`, now, now).lastInsertRowid,
  );
}

/**
 * Insert an imported credential recorded as valid and already stale.
 * @param {number} userId
 * @param {string} jwt
 */
function importedRow(userId, jwt) {
  seq++;
  const id = `urn:uuid:test-${seq}`;
  db.prepare(
    `INSERT INTO imported_credentials
       (id, user_id, issuer_did, subject_did, counterpart_did, issued_at_iso, jwt,
        imported_at, last_verified_at, verification_status)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'valid')`,
  ).run(id, userId, "did:web:issuer.invalid", "did:key:zSubject", jwt, 1, 1);
  return id;
}

/** @param {string} id */
function statusOf(id) {
  return /** @type {{ verification_status: string, last_verified_at: number | null }} */ (
    db
      .prepare(
        "SELECT verification_status, last_verified_at FROM imported_credentials WHERE id = ?",
      )
      .get(id)
  );
}

describe("imported-credential re-verification", () => {
  beforeEach(() => {
    db.exec("DELETE FROM imported_credentials; DELETE FROM users;");
  });

  it("leaves a row alone when the issuer's DID document cannot be resolved", async () => {
    // did:web:issuer.invalid resolves through the real resolver and fails on
    // DNS — the transient case, not a bad credential.
    const user = makeUser();
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "vc+jwt" })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({
        iss: "did:web:issuer.invalid",
        sub: "did:key:zSubject",
        jti: "urn:uuid:x",
        vc: {
          id: "urn:uuid:x",
          type: ["VerifiableCredential"],
          issuer: "did:web:issuer.invalid",
          credentialSubject: { id: "did:key:zSubject" },
        },
      }),
    ).toString("base64url");
    const id = importedRow(user, `${header}.${payload}.AAAA`);

    const res = await revalidateImportedCredentials({ userId: user });

    assert.equal(res.invalidated, 0, "a resolver failure must not invalidate");
    assert.equal(
      statusOf(id).verification_status,
      "valid",
      "'invalid' is terminal — one outage would destroy the credential permanently",
    );
    assert.equal(
      statusOf(id).last_verified_at,
      1,
      "the timestamp stays stale so the next sweep retries",
    );
  });

  it("invalidates a credential whose failure is intrinsic to it", async () => {
    // Malformed: no resolution is even attempted, and it will fail the same way
    // on every retry.
    const user = makeUser();
    const id = importedRow(user, "not-a-jwt");

    const res = await revalidateImportedCredentials({ userId: user });

    assert.equal(res.checked, 1);
    assert.equal(res.invalidated, 1);
    assert.equal(statusOf(id).verification_status, "invalid");
    assert.ok(
      Number(statusOf(id).last_verified_at) > 1,
      "an invalidated row records when it was checked",
    );
  });

  it("skips rows verified inside the freshness window", async () => {
    const user = makeUser();
    const id = importedRow(user, "not-a-jwt");
    db.prepare("UPDATE imported_credentials SET last_verified_at = ? WHERE id = ?").run(
      Date.now(),
      id,
    );

    const res = await revalidateImportedCredentials({ userId: user });

    assert.equal(res.checked, 0);
    assert.equal(statusOf(id).verification_status, "valid");
  });
});
