// @ts-check
/**
 * DIDComm v2.1 envelopes: the spec's own authcrypt vector, round trips for
 * authcrypt and anoncrypt, and the tampering a receiver must catch. The
 * cross-implementation check against didcomm-rust is tests/interop/didcomm-rust.mjs.
 */

import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  hchacha20,
  packEncrypted,
  unpackEncrypted,
  x25519PublicKey,
} from "../../lib/didcomm-crypto.js";

const vector = JSON.parse(
  readFileSync(new URL("../vectors/didcomm-authcrypt-x25519.json", import.meta.url), "utf8"),
);
const party = (did) => ({ did, kid: `${did}#key-x25519-1`, ...generateKeyPairSync("x25519") });
const alice = party("did:web:alice.example");
const bob = party("did:web:bob.example");
const mine = new Map([[bob.kid, bob.privateKey]]);
const aliceKey = async (skid) => {
  if (skid !== alice.kid) throw new Error(`unknown sender ${skid}`);
  return alice.publicKey;
};
const msg = {
  id: "1",
  type: "https://didcomm.org/trust-ping/2.0/ping",
  from: alice.did,
  to: [bob.did],
  body: {},
};

describe("DIDComm encryption", () => {
  for (const kid of Object.keys(vector.recipients)) {
    it(`decrypts the spec's authcrypt vector as ${kid.split("#")[1]}`, async () => {
      const r = await unpackEncrypted(
        vector.jwe,
        new Map([[kid, createPrivateKey({ key: vector.recipients[kid], format: "jwk" })]]),
        async () => x25519PublicKey(vector.sender.jwk),
      );
      assert.equal(r.authcrypt, true);
      assert.equal(r.senderKid, vector.sender.kid);
      for (const f of ["id", "from", "to", "body"])
        assert.deepEqual(r.message[f], vector.plaintext[f]);
    });
  }

  it("round-trips authcrypt and names the sender", async () => {
    const jwe = packEncrypted(msg, [{ kid: bob.kid, publicKey: bob.publicKey }], {
      kid: alice.kid,
      privateKey: alice.privateKey,
    });
    const r = await unpackEncrypted(jwe, mine, aliceKey);
    assert.deepEqual([r.authcrypt, r.senderKid, r.message.id], [true, alice.kid, "1"]);
  });

  it("round-trips anoncrypt without revealing a sender", async () => {
    const { from: _f, ...anon } = msg;
    const jwe = packEncrypted(anon, [{ kid: bob.kid, publicKey: bob.publicKey }]);
    assert.equal(JSON.parse(Buffer.from(jwe.protected, "base64url").toString()).skid, undefined);
    const r = await unpackEncrypted(jwe, mine, aliceKey);
    assert.deepEqual([r.authcrypt, r.senderKid], [false, null]);
  });

  it("rejects a flipped ciphertext bit, a forged sender, and a mismatched from", async () => {
    const jwe = packEncrypted(msg, [{ kid: bob.kid, publicKey: bob.publicKey }], {
      kid: alice.kid,
      privateKey: alice.privateKey,
    });
    const ct = Buffer.from(jwe.ciphertext, "base64url");
    ct[0] ^= 1;
    await assert.rejects(
      unpackEncrypted({ ...jwe, ciphertext: ct.toString("base64url") }, mine, aliceKey),
      /tag mismatch/,
    );
    const mallory = generateKeyPairSync("x25519");
    await assert.rejects(unpackEncrypted(jwe, mine, async () => mallory.publicKey));
    const lying = packEncrypted(
      { ...msg, from: "did:web:mallory.example" },
      [{ kid: bob.kid, publicKey: bob.publicKey }],
      {
        kid: alice.kid,
        privateKey: alice.privateKey,
      },
    );
    await assert.rejects(unpackEncrypted(lying, mine, aliceKey), /from does not match/);
  });

  it("derives the HChaCha20 subkey from the draft's test vector", () => {
    const key = Buffer.from([...Array(32).keys()]);
    const nonce = Buffer.from("000000090000004a0000000031415927", "hex");
    assert.equal(
      hchacha20(key, nonce).toString("hex"),
      "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc",
    );
  });

  for (const enc of /** @type {const} */ (["A256GCM", "XC20P"])) {
    it(`round-trips anoncrypt with ${enc}, and rejects a flipped bit`, async () => {
      const { from: _f, ...anon } = msg;
      const jwe = packEncrypted(anon, [{ kid: bob.kid, publicKey: bob.publicKey }], undefined, {
        enc,
      });
      assert.equal(JSON.parse(Buffer.from(jwe.protected, "base64url").toString()).enc, enc);
      assert.equal((await unpackEncrypted(jwe, mine, aliceKey)).message.id, "1");
      const ct = Buffer.from(jwe.ciphertext, "base64url");
      ct[0] ^= 1;
      await assert.rejects(
        unpackEncrypted({ ...jwe, ciphertext: ct.toString("base64url") }, mine, aliceKey),
      );
    });
  }

  it("refuses messages for someone else, unknown enc, and authcrypt without A256CBC-HS512", async () => {
    const jwe = packEncrypted(msg, [{ kid: alice.kid, publicKey: alice.publicKey }]);
    await assert.rejects(unpackEncrypted(jwe, mine, aliceKey), /not addressed/);
    const auth = packEncrypted(msg, [{ kid: bob.kid, publicKey: bob.publicKey }], {
      kid: alice.kid,
      privateKey: alice.privateKey,
    });
    const h = JSON.parse(Buffer.from(auth.protected, "base64url").toString());
    const swap = (enc) => ({
      ...auth,
      protected: Buffer.from(JSON.stringify({ ...h, enc })).toString("base64url"),
    });
    await assert.rejects(unpackEncrypted(swap("XC20P"), mine, aliceKey), /committing AEAD/);
    await assert.rejects(unpackEncrypted(swap("A128CBC-HS256"), mine, aliceKey), /unsupported enc/);
  });
});
