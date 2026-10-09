// Agent-level interop: a didcomm-rust agent ("alice", the engine behind
// @writerslogic/didcomm-ts) with its own did:web on a loopback port sends an
// authcrypt Trust Ping to a running rideshare server over HTTP, and must get
// an authcrypt ping-response back at its DIDCommMessaging endpoint.
//
// Not part of `npm test` (needs the didcomm WASM package and a running server):
//   ALLOW_INSECURE_DID_WEB=true APP_URL=http://localhost:3123 ... npm start
//   npm i --no-save --no-package-lock didcomm@0.4.1
//   RIDESHARE=http://localhost:3123 node tests/interop/didcomm-rust-agent.mjs
import * as didcomm from "didcomm";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";

const BASE = process.env.RIDESHARE || "http://localhost:3123";
const rideshareDid = `did:web:${encodeURIComponent(new URL(BASE).host)}`;
const kp = generateKeyPairSync("x25519");
const jwk = kp.privateKey.export({ format: "jwk" });

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const did = `did:web:localhost%3A${port}`;
const kid = `${did}#key-x25519-1`;
const aliceDoc = {
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
  id: did,
  verificationMethod: [{ id: kid, type: "JsonWebKey2020", controller: did, publicKeyJwk: { kty: "OKP", crv: "X25519", x: jwk.x } }],
  keyAgreement: [kid],
  authentication: [],
  service: [{ id: `${did}#didcomm-1`, type: "DIDCommMessaging", serviceEndpoint: { uri: `http://localhost:${port}/didcomm`, accept: ["didcomm/v2"], routingKeys: [] } }],
};
const resolver = {
  resolve: async (d) => {
    if (d === did) return aliceDoc;
    if (d === rideshareDid) return (await fetch(`${BASE}/.well-known/did.json`)).json();
    return null;
  },
};
const secrets = {
  get_secret: async (id) => (id === kid ? { id, type: "JsonWebKey2020", privateKeyJwk: jwk } : null),
  find_secrets: async (ids) => ids.filter((id) => id === kid),
};

const got = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no ping-response within 10s")), 10_000);
  server.on("request", (req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/did.json") {
      res.setHeader("content-type", "application/did+json");
      res.end(JSON.stringify(aliceDoc));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      res.statusCode = 202;
      res.end();
      try {
        const [msg, meta] = await didcomm.Message.unpack(body, resolver, secrets, {});
        clearTimeout(timer);
        resolve({ msg: msg.as_value(), meta });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  });
});

const ping = new didcomm.Message({
  id: `ping-${Date.now()}`,
  typ: "application/didcomm-plain+json",
  type: "https://didcomm.org/trust-ping/2.0/ping",
  from: did,
  to: [rideshareDid],
  body: { response_requested: true },
});
const [packed] = await ping.pack_encrypted(rideshareDid, did, null, resolver, secrets, { forward: false });
const post = await fetch(`${BASE}/didcomm`, { method: "POST", headers: { "content-type": "application/didcomm-encrypted+json" }, body: packed });
console.log("rideshare accepted the ping:", post.status);
const { msg, meta } = await got;
console.log("reply type:", msg.type, "| thid matches:", msg.thid === ping.as_value().id, "| from:", msg.from, "| authenticated:", meta.authenticated);
server.close();
process.exit(msg.type.endsWith("/ping-response") && msg.thid === ping.as_value().id && meta.authenticated ? 0 : 1);
