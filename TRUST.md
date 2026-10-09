# Portable trust: protocol and implementation

Ride history from one event travels in the user's browser to any other deployment, or any W3C Verifiable Credentials verifier. No central registry.

## TL;DR

- Each deployment has a `did:web` anchored at `https://<your-host>/.well-known/did.json`.
- Each user generates a `did:key` in the browser (Ed25519, Web Crypto). The private key stays in IndexedDB.
- When both parties confirm a ride, each gets a W3C Verifiable Credential (compact JWT, EdDSA).
- Another deployment imports them by resolving the issuer's `did:web` and checking signatures.
- `/trust/verify` inspects any credential, from any deployment.

## Standards used

| Concern | Spec | Notes |
|---|---|---|
| User identity | [`did:key` (W3C-CCG)](https://w3c-ccg.github.io/did-method-key/) | Ed25519, multibase `z`, multicodec `0xed01` |
| Deployment identity | [`did:web` (W3C-CCG)](https://w3c-ccg.github.io/did-method-web/) | DID document at `/.well-known/did.json` |
| DID document | [DID Core (W3C)](https://www.w3.org/TR/did-core/) | `JsonWebKey2020` verification methods (see below) |
| Credentials | [VC Data Model 2.0 (W3C)](https://www.w3.org/TR/vc-data-model-2.0/) | JSON-LD context, `RideAttendanceCredential` type |
| Credential format | [VC-JWT (W3C)](https://www.w3.org/TR/vc-jwt/) | Compact JWT, `typ: vc+jwt` |
| Signing | EdDSA (RFC 8032) | Ed25519, 64-byte signatures |

Encoding is the VC-JWT 1.1 shape: the credential sits in a `vc` claim next to `iss`, `sub`, `nbf`, `iat`, `jti`, and the body uses VC 2.0 vocabulary (`@context` `https://www.w3.org/ns/credentials/v2`, `validFrom`). App terms (`RideAttendanceCredential`, `RideParticipant`, `ride`, `event`) fall under the VC 2.0 `@vocab`, so no extra context URL. A strict VC-JOSE-COSE 2.0 verifier expects the credential as the JWT payload with no `vc` wrapper, so it has to read the `vc` claim to accept these.

VC-JWT over VC-LD/Data Integrity: no JSON-LD canonicalisation, one pasteable string, any JWT tool can read it.

## The deployment's identity (`did:web`)

First boot generates an Ed25519 keypair. The private key lives outside the database (`DEPLOYMENT_KEY_PATH`, default `secrets/deployment.key`, or inline `DEPLOYMENT_KEY`; see `lib/keys.js`), so DB backups hold no issuer key. The DID comes from the public URL:

```
https://rideshare.example.com   →   did:web:rideshare.example.com
```

Served at `/.well-known/did.json`:

```json
{
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
  "id": "did:web:rideshare.example.com",
  "verificationMethod": [
    { "id": "did:web:rideshare.example.com#key-1", "type": "JsonWebKey2020",
      "controller": "did:web:rideshare.example.com",
      "publicKeyJwk": { "kty": "OKP", "crv": "Ed25519", "x": "…" } },
    { "id": "did:web:rideshare.example.com#key-2", "type": "JsonWebKey2020",
      "controller": "did:web:rideshare.example.com",
      "publicKeyJwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" } },
    { "id": "did:web:rideshare.example.com#key-x25519-1", "type": "JsonWebKey2020",
      "controller": "did:web:rideshare.example.com",
      "publicKeyJwk": { "kty": "OKP", "crv": "X25519", "x": "…" } }
  ],
  "keyAgreement":    ["did:web:rideshare.example.com#key-x25519-1"],
  "assertionMethod": ["did:web:rideshare.example.com#key-1", "did:web:rideshare.example.com#key-2"],
  "authentication":  ["did:web:rideshare.example.com#key-1"],
  "service": [
    { "id": "did:web:rideshare.example.com#didcomm-1", "type": "DIDCommMessaging",
      "serviceEndpoint": { "uri": "https://rideshare.example.com/didcomm",
                           "accept": ["didcomm/v2"], "routingKeys": [] } }
  ]
}
```

All keys are `JsonWebKey2020`, not the newer Multikey: didcomm-rust (the engine of most DIDComm agents) refuses a DID document with a Multikey method or any service type other than `DIDCommMessaging`.

## The user's identity (`did:key`)

The user clicks **Generate did:key** on `/trust`. The browser:

1. Calls `crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign","verify"])`.
2. Exports the raw 32-byte public key.
3. Encodes `did:key:z` + base58btc(`0xed 0x01` + raw_pubkey).
4. Stores the `CryptoKeyPair` in IndexedDB (`db: rideshare-trust`, `store: keys`).

Binding to the account is challenge-response, proving key possession:

```
client → POST /trust/bind/challenge          (auth cookie)
server → { challenge: "rideshare-bind:<uuid>", expiresAt: ... }
client → sign(challenge) with private key
client → POST /trust/bind { did, challenge, signature }
server → verify Ed25519 signature, persist (user_id → did)
```

## Issuance: one credential per ride participant

Both parties must tap "I made this ride" after the trip, so neither can fabricate one alone. Then, for the `(accepted_claim, ride)` pair, the server:

1. Resolves both users' bound `did:key`.
2. Builds one credential per side: `credentialSubject.id` = that side's DID, `counterpart` = the other DID, plus ride metadata.
3. Signs both with the deployment's Ed25519 key.
4. Stores them in `credentials_issued`; they're downloadable from `/trust`.

Decoded payload:

```json
{
  "iss": "did:web:rideshare.example.com",
  "sub": "did:key:z6Mkpr...",
  "nbf": 1745520000,
  "iat": 1745520000,
  "jti": "urn:uuid:c1b9...",
  "vc": {
    "@context": [
      "https://www.w3.org/ns/credentials/v2"
    ],
    "id": "urn:uuid:c1b9...",
    "type": ["VerifiableCredential", "RideAttendanceCredential"],
    "issuer": "did:web:rideshare.example.com",
    "validFrom": "2026-04-25T03:00:00.000Z",
    "credentialSubject": {
      "id": "did:key:z6Mkpr...",
      "type": "RideParticipant",
      "role": "rider",
      "counterpart": "did:key:z6Mksx...",
      "ride": {
        "date": "2026-04-23",
        "time": "17:30",
        "airport": "SFO",
        "direction": "from_venue"
      },
      "event": {
        "name": "IIW XL",
        "startDate": "2026-04-21",
        "endDate": "2026-04-23"
      }
    }
  }
}
```

The signed JWT is `base64url(header) . base64url(payload) . base64url(sig)`, one line.

## Cross-event verification

On a new deployment:

1. Sign in with a magic link (per-event allowlist as usual).
2. Generate or restore the `did:key`. It's the same DID, because it's the user's key.
3. Paste or upload credentials, or the JSON bundle from `/trust/credentials.json`.
4. For each credential the deployment:
   - Refuses it if `credentialSubject.id !== <bound DID for this user>`.
   - Resolves the issuer: `did:key` from the DID itself, `did:web` by HTTPS fetch of `/.well-known/did.json`.
   - Verifies the EdDSA signature.
   - Checks `nbf`/`exp`.
   - Stores it in `imported_credentials` with `verification_status = 'valid'`.
5. `/trust` shows totals: credentials, distinct events (issuer DIDs), distinct counterparts.
6. Ride cards show a trust badge (`✓ N`) for posters with credentials, visible to everyone.

## Verifier playground

`/trust/verify` takes any VC-JWT and returns a report with reason codes:

```
✓ alg=EdDSA
✓ issuer=did:web:other-event.example
✓ subject=did:key:z6Mkpr...
✓ resolved_issuer_did
✓ signature_valid
```

## Privacy considerations

- The DID is pseudonymous: an Ed25519 public key, with no email, name or history in it.
- Credentials reveal the counterpart's DID (both confirmed the ride), not their email or legal name.
- The user picks which credentials to import ("A and B, not C"). Zero-knowledge proofs (BBS+ or similar) could later prove "≥10 credentials from ≥3 events" without naming them.
- Nobody can forge a credential without the deployment key, but the deployment itself can issue one between any two DIDs. Counter-signatures (roadmap) fix that.
- Issuer DID documents are fetched over HTTPS only in production (`localhost` allowed in development) to limit SSRF.

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| User claims someone else's DID | Challenge-response signature before bind |
| User imports another user's credentials | Subject DID must match the user's bound DID |
| Replayed signatures | Challenges are single-use and expire in 5 minutes |
| Issuer key compromise | New keypair, re-issue. Old credentials become unverifiable. |
| SSRF via did:web | HTTPS only in production; no redirects followed |
| Malformed JWTs crash the verifier | Verification wrapped in try/catch with structured errors |
| Tampered credentials | Tampering invalidates the EdDSA signature |

## Roadmap

1. Counter-signatures: the counterpart also signs with their `did:key`, removing unilateral issuance.
2. Selective disclosure with BBS+: prove properties without revealing the credential.
3. Wallet integrations: present from existing DID wallets (Spruce, Veres, etc.), not only this app's IndexedDB store.
4. DIDComm presentation: present credentials over DIDComm instead of pasting.
5. Status lists: VC StatusList 2021 entries for revocation.
6. Trust frameworks: organizers choose which other deployments' credentials count, with weights or thresholds.

## Implementation files

| File | Purpose |
|---|---|
| `lib/did.js` | DID:key + DID:web encoding, base58btc, multicodec, Ed25519 sign/verify |
| `lib/vc.js` | VC-JWT signing and verification |
| `lib/trust.js` | Deployment key, bind flow, ride confirmation, issuance, import, profile |
| `routes/well-known.js` | `/.well-known/did.json` |
| `routes/trust.js` | `/trust`, bind/import endpoints, verifier playground |
| `public/trust.js` | Browser DID:key gen, IndexedDB, signing, import UI |

No external libraries: Node `crypto` and browser WebCrypto only.

## Selective disclosure (SD-JWT VC)

Each ride credential is issued twice: the VC-JWT above and an SD-JWT VC (`typ: dc+sd-jwt`) signed with the deployment's ES256 key (`#key-2` in the DID document, also published at `/.well-known/jwt-vc-issuer`). The SD-JWT VC uses the HTTPS origin as `iss`, as SD-JWT VC requires for metadata-based key resolution, and binds to the holder's `did:key` via `cnf.jwk`.

| Claim | Disclosure |
|---|---|
| `iss`, `vct`, `iat`, `cnf`, `jti` | Always visible (SD-JWT VC forbids disclosing `iss`, `vct`, `cnf`) |
| `sub` (holder DID), `role`, `counterpart` | Selectively disclosable |
| `ride.date`, `ride.time`, `ride.airport`, `ride.direction` | Each selectively disclosable |
| `event.name`, `event.startDate`, `event.endDate` | Each selectively disclosable |

Two decoy digests sit at the top level. The holder presents from `/trust`: the browser keeps the chosen disclosures and signs a `kb+jwt` (`alg: Ed25519`) over `iat`, `aud`, a verifier `nonce` and `sd_hash`. The playground verifier issues the nonce (`POST /trust/verify/nonce`), consumes it once, and resolves a foreign issuer's key from its `/.well-known/jwt-vc-issuer` metadata.

Code: `lib/jose.js` (JWS, JWK), `lib/sd-jwt.js` (RFC 9901), `lib/verifier.js` (nonces, issuer keys), `issueRideSdJwt()` in `lib/trust.js`.

## Issuance to wallets (OpenID4VCI)

`lib/oid4vci.js` and `routes/oid4vci.js` implement the OpenID4VCI 1.0 pre-authorized code flow. The issuer is its own authorization server and takes token requests without a client id.

| Step | Endpoint | Rule |
|---|---|---|
| Offer | `POST /trust/oid4vci/offer` (attendee, cookie) | 10-minute offer for one of the attendee's credentials, shown as a QR of `openid-credential-offer://?credential_offer_uri=…` plus a 6-digit PIN rendered once; only hashes of code and PIN are stored |
| Offer object | `GET /oid4vci/offer/:id` | `credential_issuer`, `credential_configuration_ids`, and the pre-authorized grant with `tx_code` (numeric, length 6) until redeemed |
| Token | `POST /oid4vci/token` | Code + PIN → 10-minute Bearer token; code is single-use, five wrong PINs burn it, rate-limited per IP |
| Nonce | `POST /oid4vci/nonce` | `c_nonce`, single-use, five minutes |
| Credential | `POST /oid4vci/credential` | `credential_configuration_id` + `proofs.jwt[1]`; proof `typ` must be `openid4vci-proof+jwt`, exactly one of `jwk`/`kid` (`did:key` only), `aud` = issuer URL, `iat` within five minutes, live nonce. Returns `{credentials:[{credential}]}` with an SD-JWT VC bound to the proof key; token is single-use |

## Presentation to a verifier (OpenID4VP)

`lib/oid4vp.js` and `routes/oid4vp.js` make each deployment an OpenID4VP 1.0 verifier.

| Step | Endpoint | Rule |
|---|---|---|
| Request | `POST /verify/request` | 10-minute request with fresh `state` and `nonce`; QR of `openid4vp://?client_id=decentralized_identifier:<did>&request_uri=…` |
| Request object | `GET /oid4vp/request/:id` | `application/oauth-authz-req+jwt`, header `typ: oauth-authz-req+jwt`, `alg: ES256`, `kid: <did>#key-2`; payload `client_id`, `response_type: vp_token`, `response_mode: direct_post`, `response_uri`, `nonce`, `state`, `dcql_query`, `client_metadata.vp_formats_supported`; gone once answered or expired |
| Response | `POST /oid4vp/response` | `vp_token` must map the DCQL credential id to one SD-JWT VC presentation; KB-JWT `aud` = full prefixed client id, `nonce` = the request's; `vct` must be this deployment's; settles once, on success only, so junk posted with a leaked `state` can't void the request |
| Status | `GET /oid4vp/status/:token` | Separate random token rendered only on the verifier page (the request id in the QR doesn't unlock it); returns verified claims, or the latest failed attempt while pending |
| In-app holder | `POST /trust/oid4vp/inspect` | Fetches a request (locally or via `safe-fetch`), checks `typ`, that `kid` belongs to the client id's DID, and the signature against that DID's `assertionMethod` key; the browser then signs and posts only the requested claims |

## DIDComm between deployments

`lib/didcomm-crypto.js` implements DIDComm v2.1 envelopes on node:crypto alone; `lib/didcomm.js` and `routes/didcomm.js` make each deployment's did:web an agent.

| Piece | Detail |
|---|---|
| Keys | X25519 `#key-x25519-1` in `keyAgreement` (`lib/keys.js` `loadX25519Key()`, `${DEPLOYMENT_KEY_PATH}.x25519`) |
| Endpoint | `DIDCommMessaging` service → `POST /didcomm`, `application/didcomm-encrypted+json`, 202 on acceptance, 64 KB cap, rate-limited per IP |
| Envelopes | Authcrypt `ECDH-1PU+A256KW` + `A256CBC-HS512` (always outbound); anoncrypt `ECDH-ES+A256KW` + `A256CBC-HS512` accepted. `A256GCM` and `XC20P` refused: optional in the spec, and Node has no XChaCha20 |
| Protocols | Trust Ping 2.0 (answers `ping` with `ping-response` on the same thread); Discover Features 2.0 (discloses both protocols) |
| Replies | Only to authcrypt senders, at the endpoint their own DID document declares, through `lib/safe-fetch.js`, rate-limited per sender |
| UI | `/trust/didcomm`: ping or query any `did:web` agent and see the message log |

Tested against the spec's `ENCRYPTED_MSG_AUTH_X25519` vector (`tests/vectors/didcomm-authcrypt-x25519.json`) and against didcomm-rust, the engine of @writerslogic/didcomm-ts:

- envelope packing in both directions and both modes (`tests/interop/didcomm-rust.mjs`);
- a full round trip where a didcomm-rust agent with its own did:web pings a running deployment over HTTP and authenticates the reply (`tests/interop/didcomm-rust-agent.mjs`).

## Spec versions and interoperability decisions

Checked against primary sources on 2026-10-08.

| Spec | Version | Consequence here |
|---|---|---|
| SD-JWT | RFC 9901 (Nov 2025) | Disclosures, `_sd`, KB-JWT (`typ: kb+jwt`, `sd_hash` over the presentation including its trailing `~`) |
| SD-JWT VC | draft-ietf-oauth-sd-jwt-vc-19 | `typ: dc+sd-jwt`; `vct` required; `iss`, `nbf`, `exp`, `cnf`, `vct`, `status` never disclosable. Issuer keys resolve through `/.well-known/jwt-vc-issuer` or `x5c`; the draft has no DID mechanism, so SD-JWT VCs use the HTTPS origin as `iss` and the same keys are also in the DID document |
| OpenID4VCI | 1.0 Final (Sep 2025) | Issuer identifier is the HTTPS origin; pre-authorized code flow; nonce endpoint (no `c_nonce` in the token response); `proofs.jwt[]` with `typ: openid4vci-proof+jwt`; format `dc+sd-jwt` |
| OpenID4VP | 1.0 Final (Jul 2025) | DCQL only (Presentation Exchange was removed); `vp_token` keyed by credential query id; KB-JWT `aud` is the full prefixed `client_id` |
| HAIP | 1.0 Final (Dec 2025) | Requires X.509 issuer chains, wallet-attestation client auth, DPoP and the authorization-code flow, and never mentions DIDs. **This app does not claim HAIP conformance**; it targets plain OpenID4VCI/OpenID4VP with ES256 |
| DIDComm Messaging | v2.1 (WG approved 2023-04) | Server-to-server: authcrypt `ECDH-1PU+A256KW` with `A256CBC-HS512` over X25519, anoncrypt `ECDH-ES+A256KW`, Trust Ping 2.0, Discover Features 2.0 |
| JOSE algorithm names | IANA registry, RFC 9864 | `EdDSA` is deprecated in favour of `Ed25519`; new tokens say `Ed25519`, both accepted |

ES256 (P-256) signs SD-JWT VCs and OpenID4VC because every OpenID4VC wallet profile requires it. The Ed25519 key still signs VC-JWTs. The ES256 key is `lib/keys.js` `loadEs256Key()`.
