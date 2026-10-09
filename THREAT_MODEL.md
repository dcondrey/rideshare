# Threat Model

> STRIDE threat model for **rideshare**, an event ride-sharing webapp. For security engineers, pentesters, and operators deciding whether to run it at a high-stakes event. Disclosure process and one-page summary: [`SECURITY.md`](SECURITY.md).

Threat IDs encode asset and STRIDE category: T-A1-I1 is A1, **I**nformation disclosure (**S**poofing, **T**ampering, **R**epudiation, **D**enial of service, **E**levation of privilege).

Known unmitigated threats are [Residual risks](#residual-risks), not out of scope.

---

## Table of contents

1. [Assets](#assets)
2. [Trust boundaries](#trust-boundaries)
3. [Actors](#actors)
4. [Per-asset threat enumeration](#per-asset-threat-enumeration)
   1. [Attendee email list](#asset-a1-attendee-email-list-allowlist)
   2. [Attendee contact info (Signal/phone)](#asset-a2-attendee-out-of-band-contact)
   3. [Ride metadata](#asset-a3-ride-metadata)
   4. [Deployment signing key](#asset-a4-deployment-ed25519-signing-key)
   5. [User signing keys](#asset-a5-user-signing-keys-didkey)
   6. [Audit log](#asset-a6-audit-log)
   7. [Live location](#asset-a10-live-location)
5. [Cross-cutting threats](#cross-cutting-threats)
6. [In-scope vs out-of-scope](#in-scope-vs-out-of-scope)
7. [Residual risks](#residual-risks)
8. [Assumptions](#assumptions)
9. [Where to read more](#where-to-read-more)
10. [Change log](#change-log)

---

## Assets

| # | Asset | Sensitivity | Where it lives | Recoverable on disclosure? |
| --- | --- | --- | --- | --- |
| A1 | Attendee email list (the allowlist) | High | `data/app.db` table `allowlist_hashes`, hashed | No: emails are durable identifiers |
| A2 | Out-of-band contact (Signal, phone, Matrix ID) | High | `data/app.db` table `users`, plaintext | No |
| A3 | Ride metadata (route, time, pairings, notes) | Medium-High | `data/app.db` table `rides` | No: locations reveal home/hotel |
| A4 | Deployment Ed25519 signing key | Critical | `secrets/deployment.key` (mode 0600) on the host | No: rotation invalidates issued credentials |
| A5 | User Ed25519 signing keys (`did:key`) | Critical to the user | Browser `IndexedDB`, never sent to the server | n/a: server never sees them |
| A6 | Audit log | High | `data/app.db` table `audit_log` | No: integrity loss is permanent |
| A7 | Magic-link tokens (in flight) | High for 15 min | `data/app.db` table `magic_links`, deleted on use | n/a: short-lived |
| A8 | Session IDs | High while valid | `data/app.db` table `sessions`, opaque random | Yes: delete the row |
| A9 | Issued Verifiable Credentials (JWS) | Public, cryptographically bound | With the holder | n/a: public |
| A10 | Live location (opt-in sharing) | High while shared | Server memory only: latest point per user, 2-minute expiry | Partly: stale fast, but a past position can reveal a hotel |

A1 rows are `HMAC(server_secret, lower(email))`. A DB insider can test guessed emails but not read the list (T-A1-I2; see also [T-A1-I1](#a1-id)).

---

## Trust boundaries

```
+--------------+  TLS  +---------+   IPC   +-----------+
|   Browser    |<----->| Server  |<------->|  SQLite   |
+--------------+       +---------+         +-----------+
                          |   |
                          |   +---- HTTP egress ----> did:web peer
                          |
                          +-------- SMTP/Resend ----> Email provider
                          |
                          +-------- HTTP -----------> Tile provider
                                                        (OSM, Stadia, etc.)
```

| # | Boundary | Direction | Policy |
| --- | --- | --- | --- |
| B1 | Browser ↔ server | bidirectional | TLS at the edge; HSTS preloaded; CSP; strict server-side input validation |
| B2 | Server ↔ SQLite | bidirectional | Same-process via `node:sqlite`; trusted; all queries parameterised |
| B3 | Server ↔ email provider | server → provider | Outbound only; provider holds delivery secrets; we send tokenised links and keep only a delivery ID |
| B4 | Server ↔ tile provider | server → provider | Optional, remote tile styles only; no per-user attribution sent |
| B5 | Server ↔ peer deployment (cross-event verification) | bidirectional via `did:web` resolution | Allowlisted IP ranges, size-capped body, no redirects. See [`docs/security/ssrf.md`](docs/security/ssrf.md) |
| B6 | Operator ↔ host | shell access | Out of scope; operator has trusted root |
| B7 | Admin ↔ admin endpoints | inside B1 | Admin role from env-listed emails; no attendee → admin path |

---

## Actors

All actors are modeled except A-host (acknowledged, not modeled). A-tile: low likelihood and impact (B4).

| Code | Actor | Capabilities |
| --- | --- | --- |
| U-anon | Unauthenticated visitor | Public pages (landing, sign-in, `/trust` if public) |
| U-attendee | Signed-in attendee | Post a ride, claim a seat, view own profile, cancel own ride |
| U-admin | Event admin (env-listed) | Manage allowlist, view insights and audit log, wipe event |
| A-ext | External attacker, unauthenticated | Network access |
| A-acct | Compromised attendee account | Stolen magic link or session cookie |
| A-admin | Compromised admin account | A-acct plus admin role |
| A-host | Compromised host | Root |
| I-db | Insider with read-only DB access | Can `sqlite3` the file; no app privileges |
| A-peer | Malicious or compromised peer deployment | Runs a `did:web` endpoint we trust for cross-event credentials |
| A-tile | Malicious tile provider | Returns crafted PNG/MVT bytes |
| A-email | Malicious email provider / passive observer | Reads outbound mail (e.g., misconfigured corporate gateway) |

---

## Per-asset threat enumeration

### Asset A1: attendee email list (allowlist)

Who may sign in. Enumeration (I1) is the likeliest attack.

- **T-A1-S1**: Sign-in with a victim's email to grab the link via a side channel.
  *Mitigation:* link goes only to the email on file, never echoed; one response for listed, unlisted, and rate limited.
- **T-A1-S2**: Spoofed `From:` on a confirmation email to phish the victim.
  *Mitigation:* SPF/DKIM/DMARC on the sending domain (operator, [`RUNBOOK.md`](RUNBOOK.md#first-time-setup-checklist)).
- **T-A1-T1**: Attacker adds themselves via the admin endpoint.
  *Mitigation:* admin session required; role comes from `ADMIN_EMAILS` env, not a DB row. Mutations audited.
- **T-A1-T2**: Victim's HMAC swapped so the attacker gets their links.
  *Mitigation:* HMAC is keyed with a server-only secret and recomputed from the submitted email; no forged row matches without it.
- **T-A1-R1**: Admin removes an attendee, then denies it.
  *Mitigation:* each mutation writes an `audit` row with actor session ID and content hash. Chaining planned ([`docs/security/audit-tampering.md`](docs/security/audit-tampering.md)).
- <a id="a1-id"></a>**T-A1-I1**: Probe likely emails via response shape, timing, or delivery.
  *Mitigation:* same body ("If you are on the list, a link is on the way.") and status (`200`) for all. `POST /auth/send` redirects before the lookup runs, and the off-list path adds a 50-150 ms delay ([`docs/security/timing-attacks.md`](docs/security/timing-attacks.md)). Rate limits: 30 / hour per IP, `MAGIC_LINK_RATE_LIMIT` (default 5) / hour per email.
- **T-A1-I2**: DB-read insider checks for known targets.
  *Mitigation:* rows are `HMAC(server_secret, email)`: needs candidate emails (offline dictionary), can't bulk-export.
- **T-A1-I3**: Allowlist read from a leaked backup.
  *Mitigation:* same HMAC protection. Backups MUST be encrypted at rest (operator, [`RUNBOOK.md`](RUNBOOK.md#backup-procedure)).
- **T-A1-D1**: Garbage HMACs flood the allowlist.
  *Mitigation:* admin-only, rate-limited, bounded by event size (typical ≤2,000 rows).
- **T-A1-E1**: Attendee adds themselves to `ADMIN_EMAILS`.
  *Mitigation:* read from process env at startup; no request path writes it.

### Asset A2: attendee out-of-band contact

Free-text profile fields the attendee edits.

- **T-A2-S1**: Impersonating an attendee in a chat.
  *Mitigation:* contact is shown with the `did:key` and any presented credentials; UI says trust the identifier, not the name. Free-text collisions are unsolved.
- **T-A2-T1**: Editing another attendee's contact info.
  *Mitigation:* actor from the session, never the body. Ownership checks in `lib/rides.js`, exercised by `tests/unit/ride-capacity.test.js` and `tests/e2e/full-flow.test.js`.
- **T-A2-R1**: Attendee deletes their contact info, blames someone else.
  *Mitigation:* profile mutations audited.
- **T-A2-I1**: Public list of attendee contacts.
  *Mitigation:* shown only to signed-in attendees in the same ride or meetup.
- **T-A2-I2**: SQL injection.
  *Mitigation:* all queries parameterised (`db.prepare(...).run(...)`); review checklist forbids concatenated SQL.
- **T-A2-I3**: Scraping via search.
  *Mitigation:* there is no attendee search. The admin allowlist check is exact-match and rate-limited to 30 / hour per admin.
- **T-A2-D1**: Megabytes in the contact field.
  *Mitigation:* 2 MB request body cap (`lib/router.js`); contact field limited to 200 characters.
- **T-A2-E1**: Stored XSS aimed at an admin viewing the row.
  *Mitigation:* auto-escaping `html\`\`` template ([`docs/security/xss.md`](docs/security/xss.md)); admin pages share the attendee CSP.

### Asset A3: ride metadata

Origin, destination, departure time, seats, pairings, optional notes.

- **T-A3-S1**: Ride posted under someone else's display name.
  *Mitigation:* `attendee_id` from the session, not the body. Display name changes audited.
- **T-A3-T1**: Editing someone else's ride (e.g., destination to a trap).
  *Mitigation:* ownership check on update; changes audited.
- **T-A3-T2**: Racing the seat counter to over/underbook.
  *Mitigation:* claims and decisions run in `BEGIN IMMEDIATE` (`tx()` in `lib/db.js`), locked before the seat count is read; capacity checked there (`lib/rides.js`, `tests/unit/ride-capacity.test.js`). No schema `CHECK` backstop; this code path is the only enforcement.
- **T-A3-R1**: Driver cancels after the rider committed travel.
  *Mitigation:* audited; not preventable. A cancellation counter on profiles is not implemented.
- **T-A3-I1**: Scraping rides for home or hotel locations.
  *Mitigation (current):* rides are visible only to signed-in, allowlisted attendees. A custom pickup pin is shown at the coordinates the poster chose, so posters should pick a public spot or a meetup point. *Planned:* coarsen custom pins for everyone but matched riders.
- **T-A3-I2**: Tile provider learns ride locations from tile requests.
  *Mitigation:* none in the app: the browser fetches tiles directly from the configured provider. Self-hosted tiles (`map.customTileUrl`) close the channel.
- **T-A3-D1**: Ride spam buries real rides.
  *Mitigation:* per-user rate limits: 5 ride posts and 10 claims per 10 minutes (`routes/rides.js`); posting requires an allowlisted account.
- **T-A3-I3**: Trip status ("missed my connection, landing 18:40") reveals travel plans.
  *Mitigation:* readable only by the ride's poster and accepted riders, checked when the ride page renders and again for each live event (`notifyRide` in `lib/live.js`). The arrivals board aggregates counts per airport and hour with no names. Posting is rate-limited (20 per 10 minutes). Covered by `tests/e2e/groups.test.js`.
- **T-A3-S2**: Strangers join a group (shared taxi or transit) without approval and get members' contacts.
  *Mitigation:* accepted as the point of groups; only allowlisted attendees can join, joins are audited (`group.joined`), and drivers' car offers still need approval.
- **T-A3-I4**: A trip-safety link (`/trip/<token>`) leaks to someone other than the trusted contact.
  *Mitigation:* the link is a bearer capability scoped to one person's view of one ride: route, departure time and that person's own updates, no names of others and no contacts. 192-bit random token, stored only as an HMAC; expires 12 hours after departure (between 6 hours and 7 days from creation); revocable from the ride page; at most 5 active per person per ride; creation rate-limited and audited. `Cache-Control: no-store`. Covered by `tests/e2e/safety.test.js`.
- **T-A3-E1**: Stored XSS in a note.
  *Mitigation:* `html\`\`` auto-escape; CSP without `unsafe-inline`; no SVG uploads in the field. See [`docs/security/xss.md`](docs/security/xss.md).

### Asset A4: deployment Ed25519 signing key

Signs Verifiable Credentials for the deployment's `did:web` identity.

- **T-A4-S1**: Credential signed with an attacker key, claimed as ours.
  *Mitigation:* verifier resolves `did:web:event.example.com` and accepts only a `kid` in the resolved DID document (`/.well-known/did.json` over TLS).
- **T-A4-T1**: `secrets/deployment.key` tampered with on disk.
  *Mitigation:* written mode 0600; wider mode warns at boot. `lib/keys.js` refuses to load if the derived public key differs from the one recorded in `deployment_identity` at first adoption.
- **T-A4-R1**: Deployment issues a bad credential and denies it.
  *Mitigation:* each issuance audited (credential ID, subject DID, issued-at); holders can verify independently.
- **T-A4-I1**: Key leaked via backup.
  *Mitigation:* key is outside the DB, so `scripts/backup.mjs` (SQLite only) skips it; it warns if a snapshot holds a pre-migration key row. Operator key backups MUST be encrypted (KMS or age); [`RUNBOOK.md`](RUNBOOK.md#backup-procedure).
- **T-A4-I2**: Key in a log line.
  *Mitigation:* `lib/log.js` writes only allowlisted field names and reports dropped names without values. `lib/keys.js` logs no key material.
- **T-A4-D1**: Key-rotation storm.
  *Mitigation:* rotation is manual; no request path rotates.
- **T-A4-E1**: Playground tricked into treating an attacker key as ours.
  *Mitigation:* deployment key path is hardcoded; the playground resolves the credential's issuer DID fresh. No "trust the input issuer" path.

### Asset A5: user signing keys (`did:key`)

In browser IndexedDB. The server sees only the public key (in the `did:key`) and challenge signatures.

- **T-A5-S1**: Attacker signs a challenge with their own `did:key`, claiming to be an attendee.
  *Mitigation:* email-to-`did:key` binding set on first sign-in, stored in `attendees`, audited. Later sign-ins need a signature from the bound key over a server challenge.
- **T-A5-T1**: Binding repointed to the attacker's key.
  *Mitigation:* set once; rebind needs a fresh magic-link flow and is audited. Optional: publish the `did:key` as a cross-event credential.
- **T-A5-R1**: User signs a credential, then denies it.
  *Mitigation:* signatures are non-repudiable; playground gives a deterministic verification trace.
- **T-A5-I1**: Key extracted via XSS.
  *Mitigation:* CSP forbids inline scripts and `eval`; non-extractable `CryptoKey` where supported; never in the DOM.

DoS / EoP: nothing asset-specific; see cross-cutting threats.

### Asset A6: audit log

Append-only record of privileged actions for forensics.

- **T-A6-S1**: Forged entries blaming others.
  *Mitigation:* only the server writes rows; actor from the session.
- **T-A6-T1**: Attacker or DB-write insider edits or deletes rows.
  *Mitigation (current):* DB file permissions; `BEFORE UPDATE` / `BEFORE DELETE` triggers on `audit_log` that raise (`lib/db.js`).
  *Mitigation (planned):* hash chain (`prev_hash`, `row_hash`) checked on every read ([`docs/security/audit-tampering.md`](docs/security/audit-tampering.md)).
- **T-A6-R1**: Operator denies an audited action.
  *Mitigation:* once the chain ships with a periodically published head (e.g., signed, posted to a public bulletin), rewrites are detectable.
- **T-A6-I1**: Attendee reads the full log.
  *Mitigation:* admin-only endpoint.
- **T-A6-D1**: Log flooded with junk.
  *Mitigation:* every audit-writing path is rate-limited or admin-gated.

EoP: N/A.

### Asset A10: live location

Shared only after "Share my location" is tapped on the map, and only while that page is open. Code: `lib/live.js`, `routes/live.js`.

- **T-A10-I1**: Someone other than a ride partner watches you move.
  *Mitigation:* sent only to the sharer and people on a non-cancelled ride with them via an accepted claim. Checked per event: a cancelled match stops within the 10-second partner cache. `tests/e2e/live.test.js`.
- **T-A10-I2**: History leaks via storage, backups or logs.
  *Mitigation:* nothing on disk. Latest point per user in memory, dropped after 2 minutes idle, on "stop", or on restart.
- **T-A10-D1**: Client floods updates.
  *Mitigation:* 40/min per user; coordinates and accuracy range-checked; browser sends at most one per 4 seconds.
- **T-A10-S1**: Demo attendees mistaken for real people.
  *Mitigation:* synthetic movement only in `DEMO_MODE`, computed from the clock, marked `synthetic`, drawn grey.

Geolocation stops when the tab closes or backgrounds: no background tracking. The page holds a Screen Wake Lock while sharing. `Permissions-Policy` allows `geolocation` and `screen-wake-lock` for this origin only.

---

## Cross-cutting threats

### CC-1: Spoofed `did:key`

**Threat:** attacker claims their `did:key` belongs to an attendee.
**Mitigation:** bound to the allowlisted email at first magic-link sign-in; later sign-ins need a challenge signed by that key. No "trust this DID because it says so" path.

### CC-2: Tampered audit log

**Threat:** see A6; mutable today for a DB-write insider.
**Mitigation status:** acknowledged; hash chain in [`docs/security/audit-tampering.md`](docs/security/audit-tampering.md).

### CC-3: Replayed magic links

**Threat:** link intercepted (e.g., email transit MITM) and used first.
**Mitigation:** single use (row deleted in the transaction that creates the session); valid 15 minutes; 256-bit query-string token, stored only as an HMAC and looked up by that hash; a consumed token gets the same response as a bad one.

### CC-4: Allowlist enumeration

See [T-A1-I1](#a1-id): identical response and timing, plus rate limits.

### CC-5: SSRF via `did:web`

**Threat:** `iss: did:web:internal-service.local` points the verifier at internal hosts.
**Mitigation:** resolver allows public IPs only (RFC1918, loopback, link-local, IPv6 ULA refused); TLS required; redirects refused (`redirect: 'error'`); 16KB body cap; 5s timeout; per-host concurrency cap. See [`docs/security/ssrf.md`](docs/security/ssrf.md).

### CC-6: XSS via SVG logo

**Threat:** logo SVG with `<script>` or `onload="..."`.
**Mitigation:** upload is admin-only. SVG is not accepted (`lib/assets.js` allows PNG, WebP, JPEG), so there is no sanitiser. Served with `Content-Security-Policy: default-src 'none'` and `X-Content-Type-Options: nosniff`; rendered via `<img>`, never `<object>` or `<iframe>`.

### CC-7: CSP bypass

**Threat:** script runs despite CSP.
**Mitigation:** CSP is `default-src 'self'; script-src 'self' 'nonce-<per-request>'; style-src 'self' 'nonce-<per-request>'; img-src 'self' data: <tile-host>; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'`. No `unsafe-inline`, `unsafe-eval`, or wildcards; 128-bit per-request nonce. `html\`\`` auto-escapes, so an exploit needs CSP and escaping to fail together. See [`docs/security/xss.md`](docs/security/xss.md).

### CC-8: Race conditions on confirmation

**Threat:** two riders both get the last seat.
**Mitigation:** `BEGIN IMMEDIATE`; capacity checked under the write lock in `lib/rides.js`. No schema `CHECK` constraint. See T-A3-T2.

### CC-9: Timing attacks on email auth

**Threat:** timing reveals allowlist membership.
**Mitigation:** constant-time HMAC compare plus a random delay making in-list and out-of-list timings statistically indistinguishable at the per-IP rate limit. See [`docs/security/timing-attacks.md`](docs/security/timing-attacks.md).

### CC-10: Open redirect on the magic link return URL

**Threat:** `?next=https://evil.example.com` redirects to phishing after auth.
**Mitigation:** only the path of `next` is kept (relative only; scheme and host dropped).

### CC-11: Admin-controlled HTML in map tile attribution

**Threat:** `event.config.yaml#map.customAttribution` is admin-set HTML by design (tile credits usually need a link); an admin takeover or malicious commit could inject script.
**Mitigation:** `public/map.js` never uses `innerHTML`; it parses with `DOMParser` and rebuilds only text nodes and `<a href="http(s)://...">`, dropping every other element and every attribute but `href`. This guards against a hostile value; whoever sets it already has `U-admin` / `A-admin` ([Actors](#actors)).

### CC-12: Replayed or forged SD-JWT VC presentations

**Threat:** replay; unsigned, reused, or claim-overwriting disclosures; self-signed forgery; nonce-table flood.
**Mitigation:** `lib/sd-jwt.js` follows RFC 9901 §7: rejects `alg: none`, key/alg mismatch, repeated disclosures or digests, unreferenced disclosures, and disclosures that collide with a visible claim or use a reserved name. Key binding: `cnf.jwk`, `aud`, bounded `iat`, `sd_hash` over the exact presentation. Playground nonces (`lib/verifier.js`): single-use, 5-minute expiry, consumed by one atomic `UPDATE`. `/trust/verify/nonce` is rate-limited per IP and purges expired nonces on each issue. Remote issuer keys fetched only via `lib/safe-fetch.js` (CC-5); metadata `issuer` must equal `iss`. Tests: `tests/unit/sd-jwt.test.js`, `tests/e2e/demo-mode.test.js`.

### CC-13: Stolen or guessed OpenID4VCI offers

**Threat:** photographed QR, guessed PIN, replayed code/token/proof, or someone else's credential bound to the attacker's key.
**Mitigation:** offers only re-issue the attendee's own credential. PIN (shown once in the POST response, never stored in clear) required at the token endpoint; five wrong PINs burn the code, and the counter commits even on failed requests. Code, token, nonce: single-use, short-lived; token endpoint rate-limited per IP. Proof JWTs need issuer `aud`, fresh `iat`, a live single-use nonce, and a valid signature by the key they bind. Residual: QR plus PIN within ten minutes gets the credential (pre-authorized flow's trust model). Tests: `tests/e2e/oid4vci.test.js`.

### CC-14: Spoofed verifiers and replayed OpenID4VP responses

**Threat:** fake verifier harvesting claims; `vp_token` replay to any verifier; responses to requests never received; forged request steering the in-app holder to an attacker endpoint.
**Mitigation:** requests signed by the verifier's did:web key (`decentralized_identifier` prefix); the in-app holder verifies it against the DID document's `assertionMethod` and sends only requested claims. Responses accepted only for a live, unanswered `state`; key binding must carry the full client identifier as `aud` and that request's `nonce`. Only a valid presentation settles a request (atomic status update); junk leaves it pending, since `state` is public in the request object and any bystander could otherwise void a verification. Status reads need a separate random token held by the verifier's page; the QR request id isn't enough. Remote requests via `lib/safe-fetch.js`. Residual: holder trusts whoever controls the DID's domain (standard did:web assumption). Tests: `tests/e2e/oid4vp.test.js`.

### CC-15: Forged, replayed or reflected DIDComm messages

**Threat:** forged sender; tampered ciphertext; attacker DID with its endpoint aimed at a victim, reflecting our replies; large-message flood.
**Mitigation:** authcrypt KEK derivation uses the sender's static X25519 key from its DID document's `keyAgreement`, and plaintext `from` must equal the `skid` DID, so forged senders fail to decrypt. A256CBC-HS512 tag checked in constant time before decryption; `apv` must match recipient key ids. Replies go only to authcrypt senders, at their own declared endpoint, via `lib/safe-fetch.js` (public HTTPS, no redirects), rate-limited per sender: at most one small outbound per inbound. Inbound capped at 64 KB, rate-limited per IP; message log keeps the last 500 rows. Discover Features patterns matched by plain string scan, never regex. Residual: each inbound authcrypt POST can trigger one pre-decryption did:web GET via `lib/safe-fetch.js`, as `/trust/verify` does for VC issuers. Tests: `tests/unit/didcomm-crypto.test.js`, `tests/e2e/didcomm.test.js`.

---

## In-scope vs out-of-scope

**In scope (modeled and mitigated):** authentication and authorization bypass; credential forgery and replay; XSS and CSP bypass; CSRF (SameSite cookies, `form-action 'self'`, signed double-submit token on `/admin` writes; no `Origin` check); SSRF via `did:web`; audit log tampering (current mitigation acknowledged incomplete); allowlist enumeration; races on safety-relevant state; timing side channels on auth and allowlist endpoints; open redirects; information disclosure via error messages; SQL injection (parameterised queries).

**Out of scope (acknowledged, not defended):** volumetric DoS (network edge); compromised host, Node.js runtime, `node:sqlite` build, or OS; a compromised CA issuing TLS for our hostname; social engineering of attendees, admins, or maintainers; physical attacks on the host; control of the email provider's transit (email is a one-time bearer-token channel, weaknesses accepted); browser side channels (Spectre, Rowhammer, GPU pixel leaks, etc.); breaks in Ed25519, SHA-256, ChaCha20-Poly1305, HKDF.

---

## Residual risks

1. **Compromised host = full compromise** of signing key, DB, and in-flight magic links. Mitigated only by hardened infra (disk encryption, short-lived snapshots, minimum-privilege deploy user). No HSM signing in v1 (known gap).
2. **Email is a one-time bearer-token channel.** First reader of the link signs in. 15-minute TTL, single use; same-IP-class binding planned, not implemented.
3. **Audit log mutable for a DB-write insider.** Hash chain planned and documented; v1 has file permissions plus triggers only.
4. **Cross-event trust is unilateral.** A peer whose key we accept issues credentials our verifier honors, without our consent. Counter-signature planned. See [`docs/security/credential-forgery.md`](docs/security/credential-forgery.md).
5. **Custom pickup pins are exact.** Any signed-in attendee sees them; coarsening is planned, not implemented.
6. **Tile provider can correlate ride locations** unless tiles are self-hosted.
7. **Malicious browser extensions** can read keys from IndexedDB regardless of CSP. No defense.
8. **TLS MITM with a CA-issued cert** for the deployment hostname (rogue CA, government-compelled cert). No defense.

---

## Assumptions

If one fails, the matching analysis is void.

1. **Edge TLS is correct.** The proxy (Caddy, nginx, Cloudflare, etc.) uses strong ciphers and forwards `X-Forwarded-For` honestly.
2. **`node:sqlite` is honest** about parameter binding and constraints. Not tested against a hostile build.
3. **Node `crypto` is correct:** `crypto.randomBytes`, `crypto.timingSafeEqual`, `crypto.createHmac`, WebCrypto Ed25519.
4. **The email provider doesn't forge our mail.** Passive observers are in scope (CC-3); an active forger is a compromised provider, out of scope.
5. **DNS for `did:web` is honest** at the resolver. No DNSSEC verification.
6. **No secrets in the repo.** `.env`, `secrets/`, `data/` are gitignored.
7. **One hostname per event.**
8. **The browser enforces CSP** (CC-7 depends on it).
9. **No proxy strips security headers.** Otherwise CSP degrades; add them upstream.
10. **Only `audit()` writes the `audit` table.**

---

## Where to read more

- [`SECURITY.md`](SECURITY.md): disclosure policy, one-page summary.
- [`TRUST.md`](TRUST.md): DID and VC architecture, ceremony diagrams.
- [`RUNBOOK.md`](RUNBOOK.md): operator procedures.
- [`docs/security/`](docs/security/): per-control deep dives: [`csrf.md`](docs/security/csrf.md), [`xss.md`](docs/security/xss.md), [`ssrf.md`](docs/security/ssrf.md), [`credential-forgery.md`](docs/security/credential-forgery.md), [`timing-attacks.md`](docs/security/timing-attacks.md), [`audit-tampering.md`](docs/security/audit-tampering.md).
- [`docs/code-reading-guide.md`](docs/code-reading-guide.md): tour of the security-critical files.
- [`docs/intentional-non-features.md`](docs/intentional-non-features.md): what we deliberately don't build.

---

## Change log

| Version | Date | Notes |
| --- | --- | --- |
| 0.3.0 | 2026-04-30 | Initial public threat model, covering portable trust (DID + VC) plus everything from 0.1 / 0.2. |
| 0.4.0 | 2026-10-08 | Added A10 live location; tightened wording. |

Mitigation changes are also noted in the `Security` subsection of [`CHANGELOG.md`](CHANGELOG.md).
