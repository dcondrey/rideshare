// Interop check: lib/didcomm-crypto.js against didcomm-rust (the engine behind
// @writerslogic/didcomm-ts), authcrypt and anoncrypt, both directions. Not part
// of `npm test`: it needs the didcomm WASM package, which this repo does not
// depend on. From the repo root, without touching package.json or a lockfile:
//   npm i --no-save --no-package-lock didcomm@0.4.1 && node tests/interop/didcomm-rust.mjs
// didcomm-rust defaults anoncrypt to XC20P (optional in DIDComm, not supported
// here), so the script asks it for the required A256CBC-HS512.
import * as didcomm from "didcomm";
import { generateKeyPairSync } from "node:crypto";
import { packEncrypted, unpackEncrypted, x25519PublicKey } from "../../lib/didcomm-crypto.js";
const { Message } = didcomm;
const mk = (did) => { const kp = generateKeyPairSync("x25519"); const jwk = kp.privateKey.export({ format: "jwk" }); return { did, kid: `${did}#key-x25519-1`, kp, jwk }; };
const alice = mk("did:example:alice"); // the didcomm-rust side
const bob = mk("did:example:bob");     // our side
const doc = (p) => ({ id: p.did, keyAgreement: [p.kid], authentication: [], service: [],
  verificationMethod: [{ id: p.kid, type: "JsonWebKey2020", controller: p.did, publicKeyJwk: { kty: "OKP", crv: "X25519", x: p.jwk.x } }] });
const resolver = { resolve: async (did) => (did === alice.did ? doc(alice) : did === bob.did ? doc(bob) : null) };
const secretsFor = (people) => ({
  get_secret: async (id) => { const p = people.find((x) => x.kid === id); return p ? { id, type: "JsonWebKey2020", privateKeyJwk: p.jwk } : null; },
  find_secrets: async (ids) => ids.filter((id) => people.some((x) => x.kid === id)),
});
const plain = (from) => ({ id: "m-1", typ: "application/didcomm-plain+json", type: "https://didcomm.org/trust-ping/2.0/ping", from, to: [bob.did], body: { response_requested: true } });
for (const auth of [true, false]) {
  // rust → ours
  const msg = new Message(auth ? plain(alice.did) : { ...plain(alice.did), from: undefined });
  const [packed] = await msg.pack_encrypted(bob.did, auth ? alice.did : null, null, resolver, secretsFor([alice]), { forward: false, enc_alg_anon: "A256cbcHs512EcdhEsA256kw" });
  const r = await unpackEncrypted(JSON.parse(packed), new Map([[bob.kid, bob.kp.privateKey]]), async (skid) => { if (skid !== alice.kid) throw new Error("skid " + skid); return x25519PublicKey(alice.jwk); });
  console.log(auth ? "authcrypt" : "anoncrypt", "rust→ours:", r.authcrypt === auth && r.message.type.endsWith("/ping") ? "OK" : "FAIL", r.senderKid);
  // ours → rust (alice now receives)
  const toAlice = { id: "m-2", typ: "application/didcomm-plain+json", type: "https://didcomm.org/trust-ping/2.0/ping-response", thid: "m-1", ...(auth ? { from: bob.did } : {}), to: [alice.did], body: {} };
  const jwe = packEncrypted(toAlice, [{ kid: alice.kid, publicKey: alice.kp.publicKey }], auth ? { kid: bob.kid, privateKey: bob.kp.privateKey } : undefined);
  const [m2, meta] = await Message.unpack(JSON.stringify(jwe), resolver, secretsFor([alice]), {});
  const v = m2.as_value();
  console.log(auth ? "authcrypt" : "anoncrypt", "ours→rust:", v.thid === "m-1" && meta.authenticated === auth && meta.encrypted ? "OK" : `FAIL ${JSON.stringify(meta)}`);
}
