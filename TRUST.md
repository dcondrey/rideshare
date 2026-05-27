# Portable trust — protocol & implementation

This document describes how Event Rideshare implements **portable, cross-event
trust**: a user's reputation built up across one event travels with them, in
their own browser, to any other deployment of this software (or any
W3C-compliant Verifiable Credentials verifier).

The implementation is designed to be **inspectable, standards-compliant, and
self-hostable**. No central registry, no proprietary format, no lock-in.

## TL;DR for the impatient

- Each deployment has a **`did:web`** identifier anchored at
  `https://<your-host>/.well-known/did.json`.
- Each user generates their own **`did:key`** in the browser
  (Ed25519, Web Crypto API). Private key lives in IndexedDB.
- After both parties confirm a ride happened, the deployment issues each side
  a **W3C Verifiable Credential** (compact JWT, EdDSA-signed) attesting the ride.
- A user joining a new deployment **imports** their credentials. The new
  deployment fetches each issuer's `did:web` document, verifies signatures, and
  shows the cumulative trust profile.
- Anyone can paste a credential into the **verifier playground** (`/trust/verify`)
  to inspect it, even from a third-party deployment.

## Standards used

| Concern | Spec | Notes |
|---|---|---|
| User identity | [`did:key` (W3C-CCG)](https://w3c-ccg.github.io/did-method-key/) | Ed25519, multibase `z`, multicodec `0xed01` |
| Deployment identity | [`did:web` (W3C-CCG)](https://w3c-ccg.github.io/did-method-web/) | DID document at `/.well-known/did.json` |
| DID document | [DID Core (W3C)](https://www.w3.org/TR/did-core/) | `Multikey` verification method |
| Credentials | [VC Data Model 2.0 (W3C)](https://www.w3.org/TR/vc-data-model-2.0/) | JSON-LD context, `RideAttendanceCredential` type |
| Credential format | [VC-JWT (W3C)](https://www.w3.org/TR/vc-jwt/) | Compact JWT, `typ: vc+jwt` |
| Signing | EdDSA (RFC 8032) | Ed25519, 64-byte signatures |

We deliberately use **VC-JWT** (compact JWT form) over VC-LD with Data Integrity
proofs because:

- It's smaller (no JSON-LD canonicalisation needed at verification time).
- It's trivially copy-pasteable as a single string.
- Every existing JWT verifier can at minimum inspect the structure.

## The deployment's identity (`did:web`)

On first boot, the server generates a fresh Ed25519 keypair and stores it in
the `signing_keys` table (one row, `id = 1`). The DID is derived from the
public URL of the deployment:

```
https://rideshare.example.com   →   did:web:rideshare.example.com
```

The DID document is served at `/.well-known/did.json`:

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1"
  ],
  "id": "did:web:rideshare.example.com",
  "verificationMethod": [
    {
      "id": "did:web:rideshare.example.com#key-1",
      "type": "Multikey",
      "controller": "did:web:rideshare.example.com",
      "publicKeyMultibase": "z6Mki…"
    }
  ],
  "assertionMethod": ["did:web:rideshare.example.com#key-1"],
  "authentication":  ["did:web:rideshare.example.com#key-1"],
  "service": [
    { "id": "did:web:rideshare.example.com#rideshare",
      "type": "EventRideshareTrust",
      "serviceEndpoint": "https://rideshare.example.com" }
  ]
}
```

Anyone — another deployment, the W3C VC playground, a custom verifier — can
fetch this document and verify any credential signed by us, with no
out-of-band trust needed.

## The user's identity (`did:key`)

The user opts in by clicking **Generate did:key** on `/trust`. The browser:

1. Calls `crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign","verify"])`.
2. Exports the public key as raw 32 bytes.
3. Encodes as `did:key:z` + base58btc(`0xed 0x01` + raw_pubkey).
4. Stores the `CryptoKeyPair` in IndexedDB (`db: rideshare-trust`, `store: keys`).

To bind the DID to their account on this deployment, the browser executes a
**challenge-response** so the server can verify the user actually controls the
private key (not just claims a DID):

```
client → POST /trust/bind/challenge          (auth cookie)
server → { challenge: "rideshare-bind:<uuid>", expiresAt: ... }
client → sign(challenge) with private key
client → POST /trust/bind { did, challenge, signature }
server → verify Ed25519 signature, persist (user_id → did)
```

Without this step, an attacker could sign in to your account and claim
*your* DID. The signature proves they hold the key.

## Issuance: one credential per ride participant

Issuance is gated on **dual confirmation**: both parties must tap "I made
this ride" on the ride detail page after the trip happens. This protects
against unilateral fabrication of credentials by either side.

When dual confirmation fires for an `(accepted_claim, ride)` pair:

1. The server resolves both users' bound `did:key` identifiers.
2. For each side, it constructs a credential with `credentialSubject.id` =
   that side's DID, `counterpart` = the other side's DID, and ride metadata.
3. It signs both credentials with the deployment's Ed25519 private key.
4. Both credentials are persisted in `credentials_issued` and become
   downloadable from `/trust`.

Example credential payload (decoded):

```json
{
  "iss": "did:web:rideshare.example.com",
  "sub": "did:key:z6Mkpr...",
  "nbf": 1745520000,
  "iat": 1745520000,
  "jti": "urn:uuid:c1b9...",
  "vc": {
    "@context": [
      "https://www.w3.org/ns/credentials/v2",
      "https://eventrideshare.org/contexts/v1"
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

The signed JWT is just `base64url(header) . base64url(payload) . base64url(sig)`.
Pasteable as a single line.

## Cross-event verification

When the user lands on a new deployment of this software:

1. They sign in with magic link (per-event allowlist as usual).
2. They generate (or restore) their `did:key`. **The DID is the same** — it's
   their key, not the deployment's.
3. They paste / upload credentials from previous events (or paste the JSON
   bundle exported from `/trust/credentials.json`).
4. The new deployment, for each credential:
   - Refuses if `credentialSubject.id !== <bound DID for this user>` (you can't
     import someone else's credentials).
   - Resolves the issuer DID:
     - `did:key`: trivial (the DID is the key).
     - `did:web`: HTTPS fetch of `/.well-known/did.json`.
   - Verifies the EdDSA signature with the resolved public key.
   - Validates `nbf`/`exp` time bounds.
   - Persists in `imported_credentials` with `verification_status = 'valid'`.
5. The trust profile (`/trust`) now shows aggregate counts: total credentials,
   distinct events (issuer DIDs), distinct counterparts.
6. Ride cards show a **trust badge** (`✓ N`) for posters with credentials —
   visible to anyone browsing.

## Verifier playground

`/trust/verify` accepts any VC-JWT and produces a structured verification
report with reason codes:

```
✓ alg=EdDSA
✓ issuer=did:web:other-event.example
✓ subject=did:key:z6Mkpr...
✓ resolved_issuer_did
✓ signature_valid
```

This works for credentials from **any** deployment of this software, not just
ours. Useful for debugging cross-event integrations and for technical users
who want to inspect what they're receiving.

## Privacy considerations

- The DID is **pseudonymous** by default — it's just an Ed25519 public key.
  Nothing in the DID itself reveals the user's email, name, or attendance
  history.
- Credentials reveal the **counterpart DID** (since both parties consented
  by confirming the ride). They do NOT reveal the counterpart's email or
  legal name.
- The user controls **what** to import to the next event. Selective disclosure
  v1 = "include credentials A and B but not C." A future v2 could add
  zero-knowledge proofs (BBS+ signatures or similar) so the user could prove
  "I have ≥10 credentials from ≥3 events" without revealing which ones.
- The deployment **cannot forge** a credential without its private key, but
  it CAN forge a credential between any two DIDs (since it signs unilaterally).
  A future enhancement is **counter-signed credentials** where the counterpart
  also signs with their `did:key`, raising the trust assumption from "trust the
  event" to "trust the event AND the counterpart's claimed signature."
- Cross-event verification fetches issuer DID documents over HTTPS. To prevent
  SSRF, only HTTPS URLs are allowed in production (with `localhost` allowed in
  development for testing).

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| User claims someone else's DID | Challenge-response signing proves key ownership before bind |
| User imports another user's credentials | Subject DID must match the user's bound DID |
| Replayed signatures | Challenges are one-time-use, expire in 5 minutes |
| Issuer key compromise | Generate fresh keypair, re-issue. Old credentials become unverifiable. |
| SSRF via did:web | Only HTTPS URLs in production; no redirects followed |
| Malformed JWTs crash the verifier | Verification is wrapped in try/catch with structured error reporting |
| Tampered credentials | Signature verification per JWT spec; tamper invalidates EdDSA sig |

## Roadmap

Things explicitly NOT in v1 but designed to be addable:

1. **Counter-signatures** — counterpart also signs the credential with their
   `did:key`, eliminating the unilateral-issuance assumption.
2. **Selective disclosure with BBS+** — prove credential properties without
   revealing the credential itself.
3. **Wallet integrations** — present credentials from existing DID wallets
   (Spruce, Veres, etc.) instead of only this app's IndexedDB store.
4. **DIDComm presentation** — invitation/connection over standard DIDComm so
   users can present credentials without manual paste.
5. **Status lists** — VC StatusList 2021 entries so credentials can be revoked.
6. **Trust frameworks** — let event organizers configure which other
   deployments' credentials count, with weights or thresholds.

## Implementation files

| File | Purpose |
|---|---|
| `lib/did.js` | DID:key + DID:web encoding, base58btc, multicodec, Ed25519 sign/verify |
| `lib/vc.js` | VC-JWT signing and verification |
| `lib/trust.js` | Deployment key, bind flow, ride confirmation, issuance, import, profile |
| `routes/well-known.js` | `/.well-known/did.json` |
| `routes/trust.js` | `/trust`, bind/import endpoints, verifier playground |
| `public/trust.js` | Browser DID:key gen, IndexedDB, signing, import UI |

All files together are about 1,000 lines of JavaScript. No external libraries.
