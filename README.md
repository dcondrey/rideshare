### Event Rideshare

<img align="left" width="96" alt="Event Rideshare logo" src="public/favicon.svg">
Zero-dependency, self-hosted ride-sharing platform for conference attendees.

<br clear="left">

[![CI](https://img.shields.io/github/actions/workflow/status/dcondrey/rideshare/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/dcondrey/rideshare/actions/workflows/ci.yml) [![CodeQL](https://img.shields.io/github/actions/workflow/status/dcondrey/rideshare/codeql.yml?branch=main&style=flat-square&label=CodeQL)](https://github.com/dcondrey/rideshare/actions/workflows/codeql.yml) [![License](https://img.shields.io/github/license/dcondrey/rideshare?style=flat-square)](https://github.com/dcondrey/rideshare/blob/main/LICENSE)

<p align="center">
  <img src="docs/screenshots/map-shell.png" alt="The map-first home screen: a full-screen map of the venue, ride offers, requests and meetup points, with floating filters, navigation and a Post a ride button" width="860">
</p>

Event Rideshare is a self-hosted ride board for conference attendees, and a
working reference for **decentralized identifiers (DIDs) and W3C Verifiable
Credentials** in an everyday product. Every deployment is its own `did:web`
issuer. Every attendee holds a `did:key` they generated in their own browser.
When two people confirm they shared a ride, both receive a signed
`RideAttendanceCredential` that they keep, export, carry to the next event,
and verify anywhere. There's no central registry, no wallet vendor and no
dependencies: the whole trust layer is plain JavaScript on Node's built-in
crypto and the browser's WebCrypto.

### The map is the app

Signed in, the home screen is a full-screen map of the venue, ride offers,
ride requests and meetup points, with floating filters to show or hide each.
Everything else opens in a panel over the map: a side drawer on desktop, a
bottom sheet you can pull up on a phone. Panels have real URLs
(`/?panel=/rides/12`), so links, reloads and the back button work, and every
page still renders on its own without JavaScript. The map refreshes its pins
every 30 seconds and after anything you post, and stops zooming out at country
level.

<p align="center"><img src="docs/screenshots/map-shell-phone.png" alt="The map with a bottom-sheet panel on a phone" width="320"></p>

## Try the live demo

**[rideshare-demo.onrender.com](https://rideshare-demo.onrender.com)**, issuer
`did:web:rideshare-demo.onrender.com`. It runs on Render's free plan, so the
first request after a quiet spell takes up to a minute while it wakes, and
every wake-up starts a fresh demo.

The demo runs as the **Internet Demo Workshop (IDW)**, a fictional demo
unconference modeled on the Internet Identity Workshop ("Show me, don't tell
me": no slide decks, bugs are celebrated). Sign-in is one click, and the
landing page lists the accounts:

| Account | Email | What you can do |
|---|---|---|
| Attendee | `attendee@demo.test` | Your own private sandbox: post rides, claim seats, create a DID, earn and verify a credential |
| Organizer | `organizer@demo.test` | The admin dashboard, insights, allowlist, config and audit log, read-only |

Everyone else on the board is a synthetic attendee. They post rides, ask for
seats on yours, accept your claims within seconds to a minute, and confirm
shared rides, so you can walk the whole flow alone:

1. **Create your DID.** Your browser generates an Ed25519 `did:key` with
   WebCrypto, stores the private key in IndexedDB, and proves control by
   signing a one-time server challenge.
2. **Confirm a ride.** You start with an accepted seat in a synthetic driver's
   car. The driver has already confirmed it, so your confirmation completes
   the pair.
3. **Hold a credential.** Both sides are issued a VC-JWT signed by the
   event's `did:web` key.
4. **Verify it.** Paste it into the verifier at `/trust/verify`, or into any
   VC-JWT tool that resolves `did:web`.

Then the tour's "Go further" steps: reveal only some claims from the SD-JWT VC
copy, send the credential to a wallet over OpenID4VCI, verify someone over
OpenID4VP from `/verify`, and ping another event's DIDComm agent from
`/trust/didcomm`.

**Run the demo locally** (uses its own database file, so it can't touch real data):

```bash
APP_URL=http://localhost:3000 \
SESSION_SECRET=$(openssl rand -hex 32) ALLOWLIST_SALT=$(openssl rand -hex 32) \
DEMO_MODE=true EVENT_CONFIG=event.config.demo.yaml \
DATABASE_PATH=./data/demo.db DEPLOYMENT_KEY_PATH=./data/demo.key \
npm start
```

**Host it on Render's free plan:** in Render, choose **New → Blueprint**,
select this repository, and set the Blueprint path to `render.demo.yaml`.
There is nothing else to fill in: the URL comes from Render's
`RENDER_EXTERNAL_URL`, secrets are generated, and the issuer becomes
`did:web:<service>.onrender.com`, resolvable by anyone. The free plan has no
disk and sleeps when idle, so each wake-up is a fresh demo.

`DEMO_MODE` opens sign-in to anyone. It refuses to start against a database
that holds real attendees, and it makes the organizer account read-only.
Never set it on a real event.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/landing.png" alt="Landing page with the two demo accounts and the IDW manifesto"></td>
    <td width="50%"><img src="docs/screenshots/tour.png" alt="Guided demo tour with live progress checkmarks"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/ride-confirmed.png" alt="Ride page after confirming: dual-confirmed, two credentials issued"></td>
    <td><img src="docs/screenshots/verify.png" alt="Verifier report: EdDSA, issuer, subject, issuer DID resolved, signature valid"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/map.png" alt="Map of ride pickup pins, meetup spots and the venue on OpenStreetMap tiles"></td>
    <td><img src="docs/screenshots/admin.png" alt="Organizer dashboard with signup, match and demand metrics"></td>
  </tr>
</table>

---

## For the decentralized identity crowd

### Identifiers

| Party | DID method | Key | Where it lives |
|---|---|---|---|
| Deployment (issuer, verifier, DIDComm agent) | [`did:web`](https://w3c-ccg.github.io/did-method-web/) | Ed25519 (`#key-1`, VC-JWT), P-256 (`#key-2`, SD-JWT VC and OpenID4VP requests), X25519 (`#key-x25519-1`, DIDComm key agreement), all as `JsonWebKey2020` | Private key in a file outside the database (`DEPLOYMENT_KEY_PATH`, or inline `DEPLOYMENT_KEY`), so backups carry no issuer key. DID document at `/.well-known/did.json` |
| Attendee (holder/subject) | [`did:key`](https://w3c-ccg.github.io/did-method-key/) | Ed25519, multicodec `0xed01`, base58btc multibase `z6Mk…` | Generated in the browser with WebCrypto. The private key stays in IndexedDB; the user can download it as a JWK backup file and restore it on another device |

The DID document a demo deployment serves. This is real output from a local
run configured as `https://rideshare-demo.onrender.com`; your deployment's
hostname and key will differ, and the demo's key changes on every restart:

```json
{
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
  "id": "did:web:rideshare-demo.onrender.com",
  "verificationMethod": [
    { "id": "did:web:rideshare-demo.onrender.com#key-1", "type": "JsonWebKey2020", "controller": "did:web:rideshare-demo.onrender.com",
      "publicKeyJwk": {"kty": "OKP", "crv": "Ed25519", "x": "D2d8YkeVVmu9UbGM7B0nxEo2hFA-RRH3ndMSLWuROKM"} },
    { "id": "did:web:rideshare-demo.onrender.com#key-2", "type": "JsonWebKey2020", "controller": "did:web:rideshare-demo.onrender.com",
      "publicKeyJwk": {"kty": "EC", "crv": "P-256", "x": "G7sWqzrLpdZMO1yHQPyvudRTUcEaNQTB5SquLjJ8yoY", "y": "PjSHYqXiGqcEvLAC2RsECeQsCYrQm3mhvnd4IbksVik"} },
    { "id": "did:web:rideshare-demo.onrender.com#key-x25519-1", "type": "JsonWebKey2020", "controller": "did:web:rideshare-demo.onrender.com",
      "publicKeyJwk": {"kty": "OKP", "crv": "X25519", "x": "kbIT5_1gjk51UA8uu0ACDOb2--rvNQZagkIbMP0icWQ"} }
  ],
  "keyAgreement": ["did:web:rideshare-demo.onrender.com#key-x25519-1"],
  "assertionMethod": ["did:web:rideshare-demo.onrender.com#key-1", "did:web:rideshare-demo.onrender.com#key-2"],
  "authentication": ["did:web:rideshare-demo.onrender.com#key-1"],
  "service": [{
    "id": "did:web:rideshare-demo.onrender.com#didcomm-1",
    "type": "DIDCommMessaging",
    "serviceEndpoint": {"uri": "https://rideshare-demo.onrender.com/didcomm", "accept": ["didcomm/v2"], "routingKeys": []}
  }]
}
```

**Binding a DID to an account** is a challenge-response, so nobody can claim a
key they don't hold: the server issues a single-use, five-minute
`rideshare-bind:<uuid>` challenge, the browser signs it with the `did:key`, and
the server verifies the Ed25519 signature before recording the binding.

### Credentials

Issuance is gated on **dual confirmation**: after the trip, both the driver and
the rider tap "I made this ride". Then the deployment signs one credential per
side, each naming the holder as subject and the other side as `counterpart`.
If a participant binds their DID only after confirming, the credential is
issued at bind time.

A credential issued by that same local run, decoded (JOSE header, then
payload). Its issuer key no longer exists, so it is for reading, not verifying:

```json
{ "alg": "EdDSA", "typ": "vc+jwt", "kid": "did:web:rideshare-demo.onrender.com#key-1" }
```

```json
{
  "iss": "did:web:rideshare-demo.onrender.com",
  "sub": "did:key:z6MkghGtr7XD79JpirJUSVenpeAAqL8YajmYCNPwVz1A5saB",
  "nbf": 1791513927,
  "iat": 1791513927,
  "jti": "urn:uuid:27abf7d7-ea5f-4d3d-8d13-c7a12b498228",
  "vc": {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    "id": "urn:uuid:27abf7d7-ea5f-4d3d-8d13-c7a12b498228",
    "type": ["VerifiableCredential", "RideAttendanceCredential"],
    "issuer": "did:web:rideshare-demo.onrender.com",
    "validFrom": "2026-10-09T02:45:27.395Z",
    "credentialSubject": {
      "id": "did:key:z6MkghGtr7XD79JpirJUSVenpeAAqL8YajmYCNPwVz1A5saB",
      "type": "RideParticipant",
      "role": "driver",
      "counterpart": "did:key:z6MkvEZ4r91r7cTr8bGxBj9ZsFjzQ4wynFp3BCFFnE4XEuAN",
      "ride": { "date": "2026-10-23", "time": "06:00", "airport": "OAK", "direction": "to_venue" },
      "event": { "name": "IDW", "startDate": "2026-10-23", "endDate": "2026-10-25" }
    }
  }
}
```

### Portability and verification

- **Export** every credential from `/trust` as single JWTs or one JSON bundle.
- **Import** them on any other deployment. It checks that the subject is the
  importer's bound DID, resolves each issuer's `did:web` document over HTTPS
  through an SSRF-hardened fetch (no private addresses, no redirects, size and
  time caps), verifies the EdDSA signature, checks `nbf`/`exp`, and re-verifies
  imported credentials in the background so a rotated or retired issuer key
  stops counting.
- **Trust badges** on ride cards show how many confirmed rides a poster holds,
  across how many issuers, without revealing who they rode with.
- **The verifier** at `/trust/verify` needs no account and works on
  credentials from any deployment. It reports every check it ran, by name.
- **Privacy:** a DID is a bare public key with no email, name or attendance
  history in it. Credentials name the counterpart's DID, never their email or
  name, and the holder chooses which credentials to present elsewhere.

### Standards, and exactly how closely they're followed

| Concern | Spec | Status |
|---|---|---|
| DID syntax and documents | [DID Core](https://www.w3.org/TR/did-core/) | Followed. `JsonWebKey2020` methods rather than Multikey, because didcomm-rust rejects documents containing Multikey |
| Issuer identifier | `did:web` | Followed for minting, including `%3A` port encoding. **Deviation:** resolution refuses any port other than 443 (an SSRF guard), so a `did:web:host%3A8443` issuer can't be verified by another deployment. A deployment verifies its own credentials against its local key, with no network round trip |
| Holder identifier | `did:key` (Ed25519) | Followed. Encoding covered by `tests/unit/crypto-did-key.test.js` |
| Data model | [VC Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/) | Followed: v2 context, `validFrom`. App terms resolve through the v2 context's `@vocab` |
| Securing | VC-JWT, EdDSA ([RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)) | **Deviation:** VC-JWT 1.1 shape, with the credential in a `vc` claim next to `iss`/`sub`/`nbf`/`jti`, while the header says `typ: vc+jwt`, the [VC-JOSE-COSE](https://www.w3.org/TR/vc-jose-cose/) media type, whose payload is the bare credential. A strict VC-JOSE-COSE verifier will see that mismatch; it has to read the `vc` claim to accept these |
| Signatures | Ed25519, ES256 | Node's built-in `crypto`, verified against RFC 8032 test vectors. ES256 (P-256) signs SD-JWT VCs |
| Issuance to wallets | [OpenID4VCI 1.0](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html) | Pre-authorized code flow with a PIN, nonce endpoint, `jwt` proofs (ES256 or Ed25519), format `dc+sd-jwt`. Not implemented: authorization code flow, DPoP, key attestations, deferred issuance, so not HAIP |
| Messaging | [DIDComm v2.1](https://identity.foundation/didcomm-messaging/spec/v2.1/) | Authcrypt (`ECDH-1PU+A256KW`) and anoncrypt (`ECDH-ES+A256KW`) with `A256CBC-HS512` over X25519; Trust Ping 2.0 and Discover Features 2.0 between deployments. Checked against the spec vector and against didcomm-rust (packing both ways, and a live agent round trip). Anoncrypt also accepts `A256GCM` and `XC20P` (XChaCha20 via a hand-written HChaCha20, checked against the draft's vector), so didcomm-rust's default works. Not implemented: signed (JWS) messages, mediators and forward routing |
| Presentation | [OpenID4VP 1.0](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html) | `decentralized_identifier` client id with an ES256-signed request object by reference, DCQL, `direct_post`, `dc+sd-jwt` with key binding. Not implemented: `x509_hash`, `direct_post.jwt`, the Digital Credentials API |
| Selective disclosure | [SD-JWT, RFC 9901](https://www.rfc-editor.org/rfc/rfc9901) + [SD-JWT VC draft-19](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/) | Followed. Every ride credential is also issued as a `dc+sd-jwt` bound to the holder's `did:key` via `cnf.jwk`; the holder picks claims on `/trust` and signs a KB-JWT with a verifier nonce. Tested against the RFC's own digest vectors. Issuer keys at `/.well-known/jwt-vc-issuer`; `x5c` chains are not supported |

### Issue to a wallet (OpenID4VCI)

Next to each credential on `/trust`, **Add to a wallet** shows a QR code and a
6-digit PIN: an [OpenID4VCI 1.0](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html)
credential offer using the pre-authorized code flow. A wallet scans it, trades
the code and PIN for an access token, fetches a `c_nonce`, proves possession of
its own key with an `openid4vci-proof+jwt`, and receives the ride credential as
an SD-JWT VC bound to that key. Metadata lives at
`/.well-known/openid-credential-issuer` and
`/.well-known/oauth-authorization-server`. Codes, PINs, tokens and nonces are
single-use and expire in minutes, and five wrong PINs burn the offer. The flow
is tested end to end with a scripted wallet; it does not implement HAIP's
X.509 chains, wallet attestation, DPoP or authorization-code flow, so strict
HAIP wallets may refuse it.

### Verify a wallet (OpenID4VP)

`/verify` creates an [OpenID4VP 1.0](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html)
presentation request and shows it as a QR code. The client identifier is
`decentralized_identifier:<this event's did:web>`, and the request object
(`typ: oauth-authz-req+jwt`) is signed with the DID's ES256 key, so a wallet
authenticates the verifier by resolving the DID document. A DCQL query asks for
one ride credential and only `event.name` and `role`. The wallet answers by
`direct_post`; the page polls and shows the verified claims. The checks are
the issuer signature, the key binding (`aud` must be the full client
identifier), the request's nonce, the accepted `vct`, and single use.

The browser holder on `/trust` can answer too: paste the `openid4vp://` link,
and this server fetches the request and checks its signature against the
verifier's DID document before the browser sends exactly the requested claims.
HAIP's `x509_hash` client identifiers and encrypted `direct_post.jwt`
responses are not implemented.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/selective-disclosure.png" alt="Choosing which SD-JWT VC claims to disclose"></td>
    <td width="50%"><img src="docs/screenshots/sd-jwt-verified.png" alt="Verifier report for a selectively disclosed, key-bound SD-JWT VC"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/oid4vci-offer.png" alt="OpenID4VCI credential offer QR code with a 6-digit PIN"></td>
    <td><img src="docs/screenshots/oid4vp-verified.png" alt="OpenID4VP verifier page after a wallet presented event.name and role"></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/screenshots/didcomm.png" alt="DIDComm agent page with a trust ping and ping-response round trip"></td>
  </tr>
</table>

### Talk to other events (DIDComm)

Each deployment's `did:web` is also a [DIDComm v2.1](https://identity.foundation/didcomm-messaging/spec/v2.1/)
agent: an X25519 `keyAgreement` key and a `DIDCommMessaging` service at
`/didcomm` in its DID document. On `/trust/didcomm` you can send a Trust Ping or
a Discover Features query to any deployment's DID and watch the authenticated
reply arrive; pinging the deployment's own DID shows the whole round trip on
one server. Messages are authcrypt (`ECDH-1PU+A256KW`, `A256CBC-HS512`); inbound
anoncrypt may use any of the three content algorithms the spec lists. All of
it is built on `node:crypto` alone and interoperates with didcomm-rust, the
engine of [@writerslogic/didcomm-ts](https://github.com/writerslogic/didcomm-ts):
envelopes in every mode and algorithm, both directions, plus a live agent
round trip over HTTP. To rerun those checks:

```bash
npm i --no-save --no-package-lock didcomm@0.4.1
node tests/interop/didcomm-rust.mjs
# with a server running under ALLOW_INSECURE_DID_WEB=true:
RIDESHARE=http://localhost:3000 node tests/interop/didcomm-rust-agent.mjs
```

### Selective disclosure

Each ride credential has an SD-JWT VC twin with every ride and counterpart
detail selectively disclosable. On `/trust` the holder ticks the claims to
reveal, say only `event.name` and `role`, and the browser drops the other
disclosures and signs a key-binding JWT over what's left with the `did:key`
private key, using a single-use nonce from the verifier. The verifier at
`/trust/verify` checks the ES256 issuer signature, every disclosure digest,
the key binding, `sd_hash` and nonce freshness, and shows what was revealed
next to how many digests stayed hidden (withheld claims and decoys look the
same). Replaying a presentation fails on the spent nonce.

**Not implemented (yet):** status lists or any revocation, BBS proofs, Data
Integrity proofs, DIDComm credential exchange (issue-credential 3.0 and
present-proof 3.0 define no SD-JWT format), DIDComm signed messages and
mediators, and HAIP conformance. **No real wallet app has been tested yet**:
the OpenID4VCI and OpenID4VP flows are verified with scripted wallets against
the live demo, and the OpenID Foundation conformance suite is the next check.
Wallets that don't support the `decentralized_identifier` client id prefix
can't answer `/verify` requests. Credentials carry no `exp`, and a deployment
publishes a single Ed25519 key, so rotating it makes every earlier VC-JWT
unverifiable. On the free-plan live demo all keys regenerate whenever it
wakes, so credentials and DIDComm peers from earlier sessions stop verifying.
The
[TRUST.md](./TRUST.md) roadmap covers counter-signed credentials (the
counterpart co-signs with their `did:key`, so the event alone can't fabricate
a ride), BBS+ proofs and status lists. If you are testing interop at an event
like IDW, these are the gaps you'll hit first; issues and patches are welcome.

Protocol details, the threat table and implementation file map are in
[TRUST.md](./TRUST.md); the forgery analysis is in
[docs/security/credential-forgery.md](./docs/security/credential-forgery.md).

---

## Why does this exist?

Every conference has the same problem: hundreds of attendees flying into the same airports, heading to the same venue, on the same dates, and nobody coordinates. People pay for solo rideshares, miss connections, and waste money.

Event Rideshare gives organizers a private, self-hosted coordination tool they can spin up in minutes, brand for their event, and tear down when it's over. No accounts to create, no app to install, no vendor lock-in, no data left behind.

## How it works

```
  Attendee signs in           Posts or browses rides         Claims a ride
  with magic link     →     (offering or requesting)    →    and gets matched
       |                           |                              |
  Email on allowlist?        Airport, date, time,         Poster accepts/declines.
  Rate-limited, no           seats, meetup pin,           Both sides see contact
  enumeration possible.      notes, flexibility.          info only after match.
```

1. **Sign in** with a registered email (passwordless magic link).
2. **Post** a ride you're offering or requesting: airport, date, time, seats, notes, and optional pickup location.
3. **Browse and claim** rides from other attendees. When a poster accepts, both sides exchange contact details.
4. **View the map** with the venue, meetup spots, and all active rides pinned at their pickup locations.
5. **Organizers** get a privacy-safe insights dashboard: engagement, match rates, unmet demand by airport/date, and CSV export.

## Features

| Category | Details |
|---|---|
| **Zero dependencies** | No `npm install`. Just Node >=22.5 and a single process. No build step. |
| **Self-contained** | One Node process + one SQLite file. Nothing else to provision. |
| **Privacy-first** | The invite allowlist is stored as one-way HMAC hashes. No trackers. No third-party JS. Aggregate-only analytics with k-anonymity. |
| **Map-first interface** | The home screen is a full-screen map (custom renderer, no library) with layer filters; every other page opens in a slide-out panel with its own URL. OpenStreetMap tiles by default, keyed providers optional. |
| **Portable trust** | Confirmed rides mint W3C Verifiable Credentials (VC 2.0 data model, VC-JWT, EdDSA) that holders carry across events. Each deployment is a `did:web` issuer; each user is a browser-generated `did:key` holder. See [above](#for-the-decentralized-identity-crowd) and [TRUST.md](./TRUST.md). |
| **Live demo mode** | `DEMO_MODE=true` adds one-click demo accounts, synthetic attendees who react to you, and a guided tour. See [Try the live demo](#try-the-live-demo). |
| **One-click deploy** | Docker, Railway, Render, Fly.io, or any VPS. |
| **Event-agnostic** | Name, dates, venue, airports, brand color, logo, meetup pins, all configurable in one YAML file or live via the admin UI. |
| **Admin dashboard** | Allowlist management, event config editor, insights with CSV export, audit log, meetup/logo management. |
| **Dark mode and theming** | Automatic dark mode, a brand color, and an optional per-event stylesheet (`brand.stylesheet`). |

---

## Quick start

```bash
git clone https://github.com/dcondrey/rideshare.git
cd rideshare
cp .env.example .env
```

Generate secrets and edit `.env`:

```bash
# Paste each output into .env:
openssl rand -hex 32    # → SESSION_SECRET
openssl rand -hex 32    # → ALLOWLIST_SALT

# Then set:
#   ADMIN_EMAILS=you@example.com
#   RESEND_API_KEY=re_xxx  (or SMTP_* vars)
#   EMAIL_FROM="Rideshare <noreply@yourdomain.com>"
```

Start the server:

```bash
npm start
# → http://localhost:3000
```

For development with auto-reload:

```bash
npm run dev
```

### First-run checklist

1. Open `http://localhost:3000` and sign in with your admin email.
2. Go to `/admin/allowlist` and upload your attendee CSV — or, without a browser,
   `npm run allowlist:import -- attendees.csv`.
3. Customize your event at `/admin/config` (or edit `event.config.yaml`).
4. Share the URL with attendees.

Want to try the whole flow first? `node scripts/seed-demo.js --yes` populates
the app with fake attendees, rides, and claims for a dry run — it refuses to
touch a database that already has real signups.

### Requirements

- **Node.js 22.5+** (for the built-in `node:sqlite` module; stable in Node 24+)
- An email provider: [Resend](https://resend.com) (free tier, recommended) or any SMTP server

---

<details>
<summary><strong>Deploy</strong> -- Docker, Railway, Render, Fly.io</summary>

### Docker

```bash
cp .env.example .env    # edit with your values
docker compose up -d
```

SQLite lives in a named volume (`rideshare-data`). Back it up with:

```bash
docker run --rm -v rideshare-data:/data -v $PWD:/out alpine \
  tar czf /out/backup.tgz /data
```

### Railway

1. Add a **Volume** mounted at `/data`.
2. Set environment variables in the Railway UI:

| Variable | Value |
|---|---|
| `APP_URL` | `https://your-app.up.railway.app` |
| `SESSION_SECRET` | 32-byte hex (use Railway's "generate") |
| `ALLOWLIST_SALT` | 32-byte hex |
| `ADMIN_EMAILS` | `you@example.com` |
| `RESEND_API_KEY` | `re_xxx` |
| `EMAIL_FROM` | `"Rideshare <noreply@yourdomain.com>"` |
| `TRUST_PROXY` | `true` |

### Render

Push to GitHub, then in Render: **New > Blueprint** and point at this repo. The included `render.yaml` provisions the service, a 1GB disk for SQLite, and prompts for secrets. For a public demo instead of a real event, use `render.demo.yaml` (see [Try the live demo](#try-the-live-demo)).

### Fly.io

```bash
fly launch --copy-config --name your-app
fly volumes create data --size 1 --region iad
fly secrets set \
  SESSION_SECRET=$(openssl rand -hex 32) \
  ALLOWLIST_SALT=$(openssl rand -hex 32) \
  ADMIN_EMAILS=you@example.com \
  RESEND_API_KEY=re_xxx \
  EMAIL_FROM='"Rideshare <noreply@yourdomain.com>"' \
  APP_URL=https://your-app.fly.dev \
  TRUST_PROXY=true
fly deploy
```

</details>

<details>
<summary><strong>Configuration</strong> -- event name, dates, airports, brand, map style</summary>

All event configuration lives in **`event.config.yaml`** at the project root. Copy it from the tracked template first:

```bash
cp event.config.example.yaml event.config.yaml
```

Your copy is gitignored, so a pull never conflicts with your event's settings. Without it the app boots from the example and says so on every start. Edit it once before deploy, or change most fields live via `/admin/config` without restarting. JSON is also accepted (`event.config.json`).

The file is checked at boot: an unknown key, a missing required field, a reversed date range or an out-of-range coordinate stops the process and prints every problem with its path, instead of surfacing as a broken page later.

<details>
<summary><strong>Full example configuration</strong></summary>

```yaml
name: IIW XL
longName: Internet Identity Workshop
tagline: Find a ride. Offer a seat. Get there together.

dates:
  start: 2026-04-21
  end: 2026-04-23

venue:
  name: Computer History Museum
  address: 1401 N Shoreline Blvd, Mountain View, CA
  lat: 37.4143
  lng: -122.0773

airports:
  - code: SFO
    name: San Francisco Intl
    lat: 37.6213
    lng: -122.3790
  - code: SJC
    name: San Jose Mineta Intl
    lat: 37.3639
    lng: -121.9289

meetups:
  - name: Hotel Avante
    address: 860 E El Camino Real, Mountain View
    lat: 37.3989
    lng: -122.0822

map:
  style: osm
  defaultZoom: 11
  customTileUrl: ""
  customAttribution: ""

brand:
  primaryColor: "#2563eb"
  logoPath: null

registrationUrl: https://internetidentityworkshop.com
supportEmail: support@example.com
```

</details>

### Logo

Upload via the admin UI at `/admin/config` (stored in the DB, max 200KB; PNG/WebP/JPEG, served from `/logo`), or drop a file in `public/` and set `brand.logoPath: /static/<file>` in config. Upload takes priority. The logo also appears above the event name on the landing page.

### Theme

`brand.primaryColor` sets the accent color. For a fuller theme, drop a stylesheet in `public/` and set `brand.stylesheet: /static/<file>.css`; it loads after the built-in CSS on every page and can override any of its custom properties. `public/idw-theme.css`, the demo's black, white and phosphor-green theme, is a worked example.

### Map styles

| Style | Look | API key |
|---|---|---|
| **`osm`** (default) | Classic OpenStreetMap | No |
| `voyager` | Flat retro warm palette (CARTO) | CARTO key |
| `positron` | Bright minimal grayscale (CARTO) | CARTO key |
| `dark-matter` | Dark retro (CARTO) | CARTO key |
| `toner-lite` | Black and white (Stadia) | Stadia key off localhost |
| `custom` | Your own tile URL | Depends on provider |

CARTO's basemaps now return an "API key required" placeholder tile to keyless
requests, which is why `osm` is the default. Tile images are requested with the
page origin as `Referer`, as the OpenStreetMap tile usage policy asks; a busy
event should use its own tile provider through `custom`.

For Mapbox, MapTiler, or other paid providers, choose `custom` and set `map.customTileUrl` and `map.customAttribution`.

Riders can pin their pickup location by selecting a meetup spot, entering coordinates, or letting it default to the airport.

</details>

<details>
<summary><strong>Importing attendees</strong></summary>

1. Sign in as admin and visit `/admin/allowlist`.
2. Upload or paste a CSV. Accepts a single column of emails, or any multi-column file with an `email` header.
3. Choose **Replace** (swap entire list) or **Append** (add to existing).

The CSV is never written to disk. Each email is normalized (lowercase, trimmed, Gmail dot/plus-tag stripped) and stored as `HMAC-SHA256(email, ALLOWLIST_SALT)`. Raw emails are never persisted.

</details>

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Required | Default | Description |
|---|---|---|---|
| `APP_URL` | Yes | | Public URL the app is served from. On Render, defaults to `RENDER_EXTERNAL_URL` |
| `SESSION_SECRET` | Yes | | 32-byte hex; signs sessions and magic links |
| `ALLOWLIST_SALT` | Yes | | 32-byte hex; HMAC key for attendee emails |
| `ADMIN_EMAILS` | Yes | | Comma-separated admin email addresses |
| `EMAIL_FROM` | Yes | | RFC 5322 sender, e.g. `"Rideshare <noreply@x.com>"` |
| `RESEND_API_KEY` | One of | | [Resend](https://resend.com) API key (recommended) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | One of | | Bring-your-own SMTP |
| `SMTP_ALLOW_PLAINTEXT` | No | `false` | Waives the STARTTLS requirement. Local no-TLS relays only |
| `PORT` | | `3000` | HTTP port |
| `DATABASE_PATH` | | `./data/app.db` | SQLite file path |
| `TRUST_PROXY` | | `false` | Set `true` behind a reverse proxy |
| `MAGIC_LINK_RATE_LIMIT` | | `5` | Max sign-in emails per address per hour |
| `SESSION_LIFETIME_DAYS` | | `14` | Session cookie lifetime |
| `DEPLOYMENT_KEY_PATH` | | `./secrets/deployment.key` | Issuer signing key file, created on first boot. Back it up separately from the database |
| `DEPLOYMENT_KEY` | | | The key file's contents inline, for hosts with no persistent disk. Takes precedence over the path |
| `EVENT_CONFIG` | | | Event config file to load instead of `event.config.yaml`, e.g. `event.config.demo.yaml` |
| `DEMO_MODE` | | `false` | Live-demo mode: one-click demo accounts and synthetic attendees. Never on a real event |
| `ALLOW_INSECURE_DID_WEB` | | `false` | Lets `did:web` resolve over plain HTTP for `localhost` only, for local cross-deployment testing |

</details>

<details>
<summary><strong>Operations</strong> -- backups, wiping after the event, updating</summary>

### Backups

```bash
npm run backup
```

Takes a consistent snapshot with SQLite's `VACUUM INTO` while the server keeps
serving, verifies it with `PRAGMA integrity_check`, and prunes snapshots past
`RETENTION_DAYS` (default 30). No `sqlite3` binary needed, and no separate WAL
copy -- the snapshot already folds the WAL in. See
[RUNBOOK.md](RUNBOOK.md#backup-procedure) for restore and cadence.

### Wiping after the event

Use **Allowlist > Wipe attendee data** in the admin UI. To remove everything (rides, claims, audit log), delete the SQLite file or the entire deployment.

### Updating

Pull the latest source, restart the process. Schema migrations are forward-compatible (`CREATE TABLE IF NOT EXISTS`, additive `ALTER`), so no manual migration step is needed.

</details>

<details>
<summary><strong>Project layout</strong></summary>

```
.
├── server.js                 # HTTP server, graceful shutdown
├── event.config.example.yaml # Event config template (copy to event.config.yaml)
├── event.config.demo.yaml    # The live demo's fictional event (IDW)
├── lib/
│   ├── config.js             # Env + YAML/JSON config loader
│   ├── event-schema.js       # Event config validation at boot
│   ├── event-config.js       # File defaults + DB overrides
│   ├── db.js                 # SQLite schema, migrations, audit log
│   ├── auth.js               # Magic-link auth + sessions
│   ├── rides.js              # Ride + claim business logic
│   ├── allowlist.js          # CSV parsing, hashed allowlist
│   ├── trust.js              # DID binding, ride confirmation, VC issuance + import
│   ├── vc.js                 # VC-JWT signing and verification
│   ├── did.js                # did:key / did:web encoding, resolution, Ed25519
│   ├── keys.js               # Ed25519, ES256 and X25519 key custody outside the database
│   ├── jose.js               # Compact JWS (ES256, Ed25519) and JWK import
│   ├── sd-jwt.js             # SD-JWT / SD-JWT VC issue, present, verify (RFC 9901)
│   ├── verifier.js           # Verifier nonces and SD-JWT VC issuer-key resolution
│   ├── oid4vci.js            # OpenID4VCI 1.0 issuer, pre-authorized code flow
│   ├── oid4vp.js             # OpenID4VP 1.0 verifier and in-app holder
│   ├── didcomm-crypto.js     # DIDComm v2.1 authcrypt/anoncrypt envelopes
│   ├── didcomm.js            # DIDComm agent: trust ping, discover features
│   ├── qr.js                 # QR encoder for wallet offers and requests
│   ├── safe-fetch.js         # SSRF-hardened outbound fetch for did:web
│   ├── crypto.js             # HMAC, constant-time compare, tokens, email normalization
│   ├── demo.js               # Synthetic attendees and live-demo behavior
│   ├── email.js              # Resend HTTP + SMTP client
│   ├── router.js             # HTTP router, CSRF, security headers
│   ├── html.js               # Auto-escaping HTML templates + layout
│   ├── validate.js           # Input validation
│   ├── rate-limit.js         # In-memory token bucket
│   ├── insights.js           # Privacy-safe aggregate metrics
│   ├── log.js                # Structured logging with a field allowlist
│   ├── seo.js                # JSON-LD and social cards
│   ├── banner.js             # Site-wide operator banner
│   ├── yaml.js               # Minimal YAML parser
│   ├── assets.js             # Logo upload
│   ├── meetups.js            # Meetup CRUD
│   ├── map-styles.js         # Tile-style catalogue
│   └── errors.js
├── routes/
│   ├── auth.js               # Sign-in, magic link, sign-out
│   ├── demo.js               # Demo sign-in, tour, activity feed
│   ├── rides.js              # Browse, create, claim, manage
│   ├── admin.js              # Dashboard, allowlist, config, audit
│   ├── map.js                # Interactive map
│   ├── trust.js              # DID binding, credentials, verifier, selective disclosure
│   ├── oid4vci.js            # Issuer metadata, offer, token, nonce, credential
│   ├── oid4vp.js             # /verify, request object, direct_post response
│   ├── didcomm.js            # /didcomm endpoint and /trust/didcomm page
│   ├── well-known.js         # /.well-known/did.json
│   ├── health.js             # /health
│   └── static.js             # CSS, JS, images
├── public/
│   ├── styles.css            # Responsive UI + dark mode
│   ├── app.js                # Progressive enhancement
│   ├── map.js                # Custom slippy-map renderer
│   ├── trust.js              # In-browser did:key generation, signing, import
│   ├── idw-theme.css         # Demo theme (example of brand.stylesheet)
│   ├── idw-logo.png          # Demo logo
│   ├── favicon.svg
│   └── robots.txt
├── scripts/                  # Backup, allowlist import, demo seeding, CI gates
├── tests/                    # Unit, e2e, spec vectors; interop/ checks against didcomm-rust
├── docs/
│   ├── screenshots/
│   ├── code-reading-guide.md
│   ├── intentional-non-features.md
│   └── security/             # XSS, CSRF, SSRF, timing, forgery, audit deep-dives
├── Dockerfile                # Single-stage, non-root
├── docker-compose.yml
├── railway.json
├── render.yaml               # Real event on Render (starter plan + disk)
├── render.demo.yaml          # Public demo on Render (free plan)
├── fly.toml
├── biome.jsonc               # Lint + format rules
├── .github/workflows/        # CI, CodeQL, changelog
├── SECURITY.md               # Security policy + mitigations
├── THREAT_MODEL.md           # STRIDE analysis
├── TRUST.md                  # Portable trust protocol spec
├── RUNBOOK.md                # Operations + troubleshooting
├── CONTRIBUTING.md           # How to contribute
└── CHANGELOG.md
```

</details>

---

## Why zero dependencies?

This is a deliberate architectural choice, not a stunt.

- **No supply chain risk.** No `node_modules`, no transitive dependencies, no advisory fatigue. The attack surface is this code and Node.js itself.
- **No build step.** Clone and run. No webpack, no transpiler, no bundler.
- **No version rot.** Nothing to update, audit, or pin. The app runs the same today as it will in five years on any Node >=22.5.
- **Instant deploy.** Docker image builds in seconds. CI runs in seconds. Cold starts are instant.
- **Auditability.** Every line of code is in this repo. Reviewers can read it all in an afternoon.

The tradeoffs are real (hand-rolled SMTP client, YAML parser, map renderer, QR encoder, SD-JWT, OpenID4VC and DIDComm) but intentional. Each is tested against an independent reference where one exists: RFC 8032 and RFC 9901 vectors, the DIDComm spec vector and didcomm-rust, python-qrcode matrices, and the XChaCha draft vector.

---

## Security

Security is a core design constraint, not an afterthought. See [SECURITY.md](./SECURITY.md) and [THREAT_MODEL.md](./THREAT_MODEL.md) for the complete STRIDE analysis.

**Key protections:**

- **Hashed invite allowlist.** The list of who is invited is stored only as HMAC-SHA256 hashes (`ALLOWLIST_SALT`), so a stolen database does not hand over the guest list. The addresses of attendees who have actually signed in are a different matter: `users.email` and `magic_links.email` hold them in plaintext, because the app has to send mail to them. Treat the database file and every backup of it as carrying attendee addresses — see [RUNBOOK.md](./RUNBOOK.md#backup-procedure).
- **No enumeration.** Magic-link endpoints return identical responses for on-list and off-list emails. Rate-limited per-email and per-IP.
- **No third-party code.** Zero client-side JS libraries. No external fonts, trackers, or analytics. CSP enforced to `default-src 'self'`.
- **Constant-time comparisons** for all secret-derived values.
- **Parameterized queries** everywhere. Zero SQL injection surface.
- **Opaque sessions.** Random tokens stored server-side, revocable instantly.
- **Audit log.** Every admin action and sensitive operation is logged with timestamp, actor, and IP.
- **HSTS + SameSite cookies + CSP.** Defense in depth against XSS, CSRF, and downgrade attacks.

Found a vulnerability? See the disclosure process in [SECURITY.md](./SECURITY.md).

---

## Limitations

- **Single instance.** SQLite + in-memory rate limiter prevent multi-replica deployments. For event scale (a few thousand users), one small instance is more than sufficient.
- **No real-time updates.** Server-rendered pages. No websockets.
- **SMTP subset.** The hand-rolled SMTP client supports PLAIN/LOGIN Auth and STARTTLS (works with Postmark, SES, Mailgun, Gmail). For XOAUTH2-only providers, use Resend.
- **`node:sqlite` warning.** Technically experimental in Node 22 (warning suppressed). Fully stable in Node 24+.

For a full list of intentional non-features (no payments, no OAuth, no real-time chat, no native app) and the reasoning behind each, see [docs/intentional-non-features.md](./docs/intentional-non-features.md).

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for code style, RFC process, and how to submit patches.

## License

MIT. See [LICENSE](./LICENSE).
