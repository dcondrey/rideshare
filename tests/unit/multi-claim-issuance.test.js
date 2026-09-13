// @ts-check
/**
 * A ride with several accepted claims issues one credential pair per claim.
 *
 * Two separate mechanisms used to stop after the first pair: the idempotency
 * guard counted credentials by ride_id and skipped at >= 2, and
 * ride_confirmations keyed on (ride_id, user_id), so the poster's INSERT OR
 * IGNORE for the second claim was silently dropped. A driver with three
 * accepted riders saw two of them confirm, get `recorded: true`, and never
 * receive the credential the UI promised.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { setupTestEnv } from "../helpers/env.js";

setupTestEnv();

import { sign as edSign } from "node:crypto";
import { db } from "../../lib/db.js";
import { base58btcEncode, generateEd25519Keypair, pubKeyRawBytes } from "../../lib/did.js";
import { createClaim, createRide, decideClaim } from "../../lib/rides.js";
import { bindDid, confirmRide, issueDidChallenge, trustProfileFor } from "../../lib/trust.js";

let seq = 0;

function makeUser() {
  seq++;
  const now = Date.now();
  const r = db
    .prepare(
      "INSERT INTO users (email, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
    )
    .run(`rider${seq}@example.com`, `Rider ${seq}`, now, now);
  return Number(r.lastInsertRowid);
}

/** Bind a fresh did:key to a user, the same way the browser flow does. */
function bindFreshDid(userId) {
  const { publicKey, privateKey } = generateEd25519Keypair();
  const raw = pubKeyRawBytes(publicKey);
  const did = `did:key:z${base58btcEncode(new Uint8Array([0xed, 0x01, ...raw]))}`;
  const { challenge } = issueDidChallenge(userId);
  const signature = edSign(null, Buffer.from(challenge, "utf8"), privateKey).toString("base64url");
  bindDid({ userId, did, challenge, signatureB64u: signature });
  return did;
}

describe("credential issuance across several accepted claims on one ride", () => {
  beforeEach(() => {
    db.exec(
      "DELETE FROM credentials_issued; DELETE FROM ride_confirmations; DELETE FROM claims; " +
        "DELETE FROM rides; DELETE FROM user_dids; DELETE FROM did_challenges; DELETE FROM users;",
    );
    seq = 0;
  });

  it("issues a pair for every dual-confirmed claim, not only the first", () => {
    const poster = makeUser();
    bindFreshDid(poster);
    const rideId = createRide({
      userId: poster,
      kind: "offer",
      direction: "to_venue",
      airport: "SFO",
      otherPlace: null,
      departDate: "2026-08-07",
      departTime: "09:00",
      flexMinutes: 30,
      seats: 3,
      notes: null,
    });

    const riders = [makeUser(), makeUser(), makeUser()];
    for (const r of riders) {
      bindFreshDid(r);
      decideClaim(
        createClaim({ rideId, claimerId: r, seats: 1, message: null }),
        poster,
        "accepted",
      );
    }

    // The poster confirms once; that applies to all three accepted claims.
    confirmRide({ rideId, userId: poster });
    for (const r of riders) confirmRide({ rideId, userId: r });

    const rows = /** @type {{ c: number }} */ (
      db.prepare("SELECT COUNT(*) AS c FROM credentials_issued WHERE ride_id = ?").get(rideId)
    );
    assert.equal(rows.c, 6, "expected one credential per side per claim");

    for (const r of riders) {
      assert.equal(
        trustProfileFor(r).fromThisEvent,
        1,
        "every rider who confirmed should hold a credential",
      );
    }
    assert.equal(trustProfileFor(poster).fromThisEvent, 3, "the poster holds one per claim");
  });

  it("stays idempotent when a confirmation is repeated", () => {
    const poster = makeUser();
    bindFreshDid(poster);
    const rideId = createRide({
      userId: poster,
      kind: "offer",
      direction: "to_venue",
      airport: "SFO",
      otherPlace: null,
      departDate: "2026-08-07",
      departTime: "09:00",
      flexMinutes: 30,
      seats: 2,
      notes: null,
    });
    const rider = makeUser();
    bindFreshDid(rider);
    decideClaim(
      createClaim({ rideId, claimerId: rider, seats: 1, message: null }),
      poster,
      "accepted",
    );

    confirmRide({ rideId, userId: poster });
    confirmRide({ rideId, userId: rider });
    confirmRide({ rideId, userId: rider });
    confirmRide({ rideId, userId: poster });

    const rows = /** @type {{ c: number }} */ (
      db.prepare("SELECT COUNT(*) AS c FROM credentials_issued WHERE ride_id = ?").get(rideId)
    );
    assert.equal(rows.c, 2, "one pair, however many times either side confirms");
  });

  it("does not re-mint for rows written before claim_id existed", () => {
    // The ALTER TABLE that added claim_id backfills NULL. The guard those rows
    // were written under allowed at most one pair per ride, so a NULL row has
    // to keep counting as "already issued" or an upgraded database mints a
    // second pair on the next confirmation.
    const poster = makeUser();
    bindFreshDid(poster);
    const rideId = createRide({
      userId: poster,
      kind: "offer",
      direction: "to_venue",
      airport: "SFO",
      otherPlace: null,
      departDate: "2026-08-07",
      departTime: "09:00",
      flexMinutes: 30,
      seats: 2,
      notes: null,
    });
    const rider = makeUser();
    bindFreshDid(rider);
    decideClaim(
      createClaim({ rideId, claimerId: rider, seats: 1, message: null }),
      poster,
      "accepted",
    );
    confirmRide({ rideId, userId: poster });
    confirmRide({ rideId, userId: rider });

    db.prepare("UPDATE credentials_issued SET claim_id = NULL WHERE ride_id = ?").run(rideId);

    confirmRide({ rideId, userId: poster });
    confirmRide({ rideId, userId: rider });

    const rows = /** @type {{ c: number }} */ (
      db.prepare("SELECT COUNT(*) AS c FROM credentials_issued WHERE ride_id = ?").get(rideId)
    );
    assert.equal(rows.c, 2, "a legacy NULL-claim_id pair must still count as issued");
  });

  it("does not count this deployment as an event for a user it never issued to", () => {
    const stranger = makeUser();
    const profile = trustProfileFor(stranger);
    assert.equal(profile.totalCredentials, 0);
    assert.equal(profile.distinctEvents, 0, "no credentials means no events");
  });
});
