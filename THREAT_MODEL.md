# Threat Model

> Full STRIDE-style threat enumeration for the **rideshare** event ride-sharing webapp. Audience: security engineers, penetration testers, and operators evaluating whether to deploy this codebase at a high-stakes event.

This document is the long-form companion to [`SECURITY.md`](SECURITY.md). The security policy contains the disclosure process and a one-page summary; this document enumerates assets, trust boundaries, actors, threats, and mitigations.

The model uses the STRIDE taxonomy:

- **S**poofing — pretending to be someone you are not.
- **T**ampering — modifying data without authorization.
- **R**epudiation — performing an action and denying it later.
- **I**nformation disclosure — reading data without authorization.
- **D**enial of service — preventing legitimate users from getting service.
- **E**levation of privilege — gaining capabilities you should not have.

A threat that is acknowledged but unmitigated is listed as a **residual risk** at the end of this document, not silently swept under "out of scope."

---

## Table of contents

1. [Assets](#assets)
2. [Trust boundaries](#trust-boundaries)
3. [Actors](#actors)
4. [Per-asset threat enumeration](#per-asset-threat-enumeration)
   1. [Attendee email list](#asset-attendee-email-list)
   2. [Attendee contact info (Signal/phone)](#asset-attendee-contact-info)
   3. [Ride metadata](#asset-ride-metadata)
   4. [Deployment signing key](#asset-deployment-signing-key)
   5. [User signing keys](#asset-user-signing-keys)
   6. [Audit log](#asset-audit-log)
5. [Cross-cutting threats](#cross-cutting-threats)
6. [In-scope vs out-of-scope](#in-scope-vs-out-of-scope)
7. [Residual risks](#residual-risks)
8. [Assumptions](#assumptions)
9. [Change log](#change-log)

---

## Assets

The system stores or handles the following assets. Each is rated by sensitivity and whether disclosure is recoverable.

| # | Asset | Sensitivity | Where it lives | Recoverable on disclosure? |
| --- | --- | --- | --- | --- |
| A1 | Attendee email list (the allowlist) | High | `events.db` table `allowlist`, hashed | No — emails are durable identifiers |
| A2 | Attendee out-of-band contact (Signal handle, phone, Matrix ID) | High | `events.db` table `attendees`, plaintext | No |
| A3 | Ride metadata (origin, destination, time, pairings, notes) | Medium-High | `events.db` table `rides` | No — locations reveal home/hotel |
| A4 | Deployment Ed25519 signing key | Critical | `secrets/deployment.key` (file mode 0600) on the host | No — rotation invalidates issued credentials |
| A5 | User Ed25519 signing keys (`did:key`) | Critical to the user | Browser `IndexedDB`, never sent to the server | n/a — server never sees them |
| A6 | Audit log | High | `events.db` table `audit` | No — integrity loss is permanent |
| A7 | Magic-link tokens (in flight) | High during their 10-min window | `events.db` table `magic_links`, then deleted on use | n/a — short-lived |
| A8 | Session IDs | High during session lifetime | `events.db` table `sessions`, opaque random | Yes — revocable by deleting row |
| A9 | Issued Verifiable Credentials (JWS) | Public-by-design but cryptographically bound | Wherever the holder stores them | n/a — public artifacts |

**Note on A1:** the allowlist is stored as `HMAC(server_secret, lower(email))`, not as plaintext. This means a host-read disclosure (insider with DB access) does not directly reveal who is invited — though a dictionary of likely emails can still be checked. See [Asset A1, Information disclosure](#a1-id).

---

## Trust boundaries

A trust boundary is a place where data crosses between zones with different privilege or trust assumptions. We enumerate them so each boundary has an explicit policy.

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

| # | Boundary | Direction | Policy summary |
| --- | --- | --- | --- |
| B1 | Browser ↔ server | bidirectional | TLS terminated at the edge; HSTS preloaded; CSP enforced; strict input validation server-side |
| B2 | Server ↔ SQLite | bidirectional | Same-process IPC via `node:sqlite`; trusted; queries are parameterised everywhere |
| B3 | Server ↔ email provider | server → provider | Outbound only; provider holds delivery secrets; we send tokenised links, never store provider responses with PII beyond a delivery ID |
| B4 | Server ↔ tile provider | server → provider | Optional; only invoked if the deployment chooses a remote tile style; no per-user attribution sent |
| B5 | Server ↔ peer deployment (cross-event verification) | bidirectional via `did:web` resolution | Hardened HTTP fetch; allowlisted IP ranges; size-capped body; redirects refused; see [`docs/security/ssrf.md`](docs/security/ssrf.md) |
| B6 | Operator ↔ host | shell access | Out of scope of this codebase — the operator is trusted with full root |
| B7 | Admin ↔ admin endpoints | inside B1 | Admin role is gated by env-listed admin emails; no privilege escalation route from attendee → admin |

---

## Actors

| Code | Actor | Capabilities | Modeled? |
| --- | --- | --- | --- |
| U-anon | Unauthenticated visitor | View public pages (event landing, sign-in form, `/trust` if public) | yes |
| U-attendee | Signed-in attendee | Post a ride, claim a seat, view their own profile, cancel their own ride | yes |
| U-admin | Event admin (env-listed) | Manage allowlist, view aggregate insights, view audit log, wipe event | yes |
| A-ext | External attacker, unauthenticated | Network access to the server | yes |
| A-acct | Compromised attendee account | Stolen magic link or session cookie | yes |
| A-admin | Compromised admin account | Same as A-acct but with admin role | yes |
| A-host | Compromised host | Root on the box | acknowledged, NOT modeled |
| I-db | Insider with read-only DB access | Can `sqlite3` the file, no app-level privileges | yes |
| A-peer | Malicious or compromised peer deployment | Operates a `did:web` endpoint we trust to issue cross-event credentials | yes |
| A-tile | Malicious tile provider | Returns crafted PNG/MVT bytes | yes (low likelihood, low impact — see B4) |
| A-email | Malicious email provider / passive observer of email | Reads outbound mail (e.g., on a misconfigured corporate gateway) | yes |

---

## Per-asset threat enumeration

### Asset A1 — attendee email list (allowlist)

The allowlist is the set of email addresses approved to sign in for this event. It is the **first** trust decision the system makes.

#### A1, Spoofing

- **T-A1-S1**: An attacker submits a sign-in request with a victim's email, hoping to receive the magic link via a side channel.
  *Mitigation:* the magic link is sent only to the email on file, never echoed in the response. Response shape is identical for "in allowlist", "not in allowlist", and "rate limited".
- **T-A1-S2**: An attacker spoofs the `From:` of a confirmation email to phish the victim into clicking a fake link.
  *Mitigation:* SPF/DKIM/DMARC are required on the sending domain (operator's responsibility — documented in [`RUNBOOK.md`](RUNBOOK.md#first-time-setup-checklist)).

#### A1, Tampering

- **T-A1-T1**: Attacker adds themselves to the allowlist by manipulating the admin endpoint.
  *Mitigation:* admin endpoints require admin session; admin role is set from the `ADMIN_EMAILS` env var, not from any DB row that an attendee can write. Allowlist mutations are recorded in the audit log.
- **T-A1-T2**: Attacker swaps the HMAC of a victim's email for their own to receive the victim's magic links.
  *Mitigation:* HMAC is computed at insert time using a server-only secret; the input email itself is what we hash on each sign-in attempt; an attacker cannot construct an HMAC of their own email that matches a row keyed to the victim's email without the server secret.

#### A1, Repudiation

- **T-A1-R1**: An admin removes an attendee, then denies it.
  *Mitigation:* every allowlist mutation writes an `audit` row with actor session ID and a content hash. Audit chaining is planned (see [`docs/security/audit-tampering.md`](docs/security/audit-tampering.md)).

#### <a id="a1-id"></a>A1, Information disclosure (enumeration)

This is the highest-likelihood threat against A1 and we treat it carefully.

- **T-A1-I1**: An attacker iterates likely emails and observes whether each is in the allowlist (HTTP response shape, response time, or magic-link delivery).
  *Mitigation:*
  - Response body is identical for any email submitted at the sign-in form ("If you are on the list, a link is on the way.").
  - Status code is identical (`200`).
  - Server inserts an artificial random delay sampled from a distribution that dominates the real allowlist-check time (see [`docs/security/timing-attacks.md`](docs/security/timing-attacks.md)).
  - HMAC comparison is constant-time (`crypto.timingSafeEqual`).
  - Per-IP rate limit kicks in at 5 sign-in attempts / 5 minutes; per-email rate limit at 3 / hour.
- **T-A1-I2**: An insider with DB read access scans the allowlist for known targets.
  *Mitigation:* allowlist rows store `HMAC(server_secret, email)`, not plaintext. The insider must already know which emails to check (offline dictionary attack); they cannot bulk-export the guest list.
- **T-A1-I3**: Attacker reads the allowlist via a backup leak.
  *Mitigation:* same as T-A1-I2 — backups inherit the HMAC protection. Backups MUST be encrypted at rest (operator responsibility, in [`RUNBOOK.md`](RUNBOOK.md#backup-procedure)).

#### A1, Denial of service

- **T-A1-D1**: Attacker fills the allowlist with garbage HMACs.
  *Mitigation:* admin-only mutation; rate-limited; allowlist is bounded by event size (typical ≤2,000 rows).

#### A1, Elevation of privilege

- **T-A1-E1**: A regular attendee elevates to admin by adding themselves to `ADMIN_EMAILS`.
  *Mitigation:* `ADMIN_EMAILS` is read from process env at startup; no code path writes it from a request.

---

### Asset A2 — attendee out-of-band contact

Stored after sign-in. Free-text fields that an attendee can edit on their own profile.

#### A2, Spoofing

- **T-A2-S1**: Attacker pretends to be a different attendee in a chat, bypassing the trust model.
  *Mitigation:* contact info is shown alongside the attendee's `did:key` and (if presented) any verifiable credentials. Attendees are educated in the UI to prefer the cryptographic identifier over the human-readable name. Out of band collisions are inherent to free-text and we do not solve them.

#### A2, Tampering

- **T-A2-T1**: Attacker modifies another attendee's contact info via a write endpoint.
  *Mitigation:* profile-mutation endpoints check `session.attendee_id == row.attendee_id`. Tested by `tests/auth.test.js` (file paths described under "Where to read more" below — exact line numbers are filled in by the route handlers).

#### A2, Repudiation

- **T-A2-R1**: Attendee deletes their contact info, then claims someone else did.
  *Mitigation:* profile mutations are audited.

#### A2, Information disclosure

- **T-A2-I1**: Public listing of all attendees with contact info.
  *Mitigation:* contact info is only shown to other signed-in attendees who are part of the same ride or meetup, never on a public page.
- **T-A2-I2**: SQL injection extracts contact info.
  *Mitigation:* all queries are parameterised via `db.prepare(...).run(...)`. Code review checklist forbids string-concatenated SQL.
- **T-A2-I3**: Attacker scrapes via the search endpoint.
  *Mitigation:* search endpoint is rate-limited and returns at most 20 results, never matching by partial email.

#### A2, DoS

- **T-A2-D1**: Attacker stuffs the contact field with megabytes of data.
  *Mitigation:* request body cap is 64KB (`server.js` body parser). Per-field validators reject anything over 256 bytes.

#### A2, EoP

- **T-A2-E1**: Attacker uses contact-update endpoint as an XSS vector to escalate via an admin viewing the row.
  *Mitigation:* all rendering uses the auto-escaping `html\`\`` template (see [`docs/security/xss.md`](docs/security/xss.md)). Admin pages have the same CSP as attendee pages.

---

### Asset A3 — ride metadata

Origin, destination, time of departure, available seats, claimed seats, pairings, and the optional free-text "notes" field.

#### A3, Spoofing

- **T-A3-S1**: Attacker creates a ride pretending to be someone else (different display name).
  *Mitigation:* `attendee_id` on the ride is taken from session, not from the request body. Display name changes are audited.

#### A3, Tampering

- **T-A3-T1**: Attacker modifies a ride that is not theirs (changes destination to a trap).
  *Mitigation:* update endpoints check ownership. The audit log records who changed what.
- **T-A3-T2**: Attacker manipulates the seat counter via concurrent requests (race) to overbook or underbook.
  *Mitigation:* claim is wrapped in a SQLite `BEGIN IMMEDIATE` transaction; the seat counter is decremented inside the transaction; a `CHECK (claimed_seats <= total_seats)` constraint prevents overbooking even if the application logic is wrong. See [`docs/security/`] race-condition section TBD.
  > **TODO** — open `docs/security/race-conditions.md` if/when we want a dedicated treatment.

#### A3, Repudiation

- **T-A3-R1**: Driver cancels the ride after the rider has committed travel.
  *Mitigation:* cancellations are audited; out-of-band we cannot prevent this. The trust dashboard surfaces a "cancelled-after-claim" counter on the driver's profile.

#### A3, Information disclosure

- **T-A3-I1**: Public scraping of all rides exposes attendees' home addresses or hotel locations.
  *Mitigation:* ride locations are coarsened to a configurable radius (default 250m) before being shown to anyone other than the matched rider. The driver enters the precise location; the public view shows the snapped center of a rounded grid cell.
- **T-A3-I2**: Map tile provider learns the location of every ride via tile requests.
  *Mitigation:* tile fetches are server-side proxied for default tile styles; per-request anonymisation via batched fetches; remote attribution is removed before forwarding. Operators can self-host tiles to fully cut this channel.

#### A3, DoS

- **T-A3-D1**: Attendee posts thousands of rides, hiding real ones.
  *Mitigation:* per-attendee active-ride cap (default 5). Configurable in `event.config.yaml`.

#### A3, EoP

- **T-A3-E1**: Attendee escalates a ride note into stored XSS to compromise admins viewing the ride list.
  *Mitigation:* notes are rendered via `html\`\`` (auto-escape) and a strict CSP without `unsafe-inline`. SVG uploads are not allowed in this field. See [`docs/security/xss.md`](docs/security/xss.md).

---

### Asset A4 — deployment Ed25519 signing key

This is the private key used by the deployment to issue Verifiable Credentials over the `did:web` identity.

#### A4, Spoofing

- **T-A4-S1**: Attacker presents a forged credential signed by a key they control, claiming it is from this deployment.
  *Mitigation:* verifier resolves `did:web:event.example.com` and only accepts credentials whose `kid` matches a key listed in the resolved DID document. The deployment's `did.json` is served from `/.well-known/did.json` over TLS.

#### A4, Tampering

- **T-A4-T1**: Attacker tampers with `secrets/deployment.key` on disk.
  *Mitigation:* file mode 0600 owned by the service user; integrity check on startup compares the public key derived from the private key to the published `did.json`. Mismatch refuses to start.

#### A4, Repudiation

- **T-A4-R1**: Deployment issues a bad credential and denies it.
  *Mitigation:* every credential issuance is audited with the credential ID, subject DID, and issued-at timestamp. The credential itself is independently verifiable by anyone holding it.

#### A4, Information disclosure

- **T-A4-I1**: Key file leaked via backup.
  *Mitigation:* `secrets/` is excluded from the SQLite-only backup procedure; if the operator chooses to back up the key, the backup MUST be encrypted (KMS or age). Documented in [`RUNBOOK.md`](RUNBOOK.md#backup-procedure).
- **T-A4-I2**: Key disclosed via log file.
  *Mitigation:* logging library has an allowlist of fields; the key material is never accepted into a log line. Code review forbids logging anything from `lib/keys.js`.

#### A4, DoS

- **T-A4-D1**: Attacker triggers a key-rotation storm.
  *Mitigation:* key rotation is a manual operator action; no request path can rotate the key.

#### A4, EoP

- **T-A4-E1**: Attacker convinces the verifier playground to use an attacker-controlled key as the deployment key.
  *Mitigation:* the deployment key path is hardcoded; the verifier playground takes its issuer DID from the credential being verified and resolves it fresh — there is no "trust the input issuer" code path.

---

### Asset A5 — user signing keys (`did:key`)

Held in the browser's IndexedDB. The server never sees the private key; we only ever receive the public part embedded in the user's `did:key` DID and signatures over challenges.

#### A5, Spoofing

- **T-A5-S1**: Attacker presents a `did:key` and signs a challenge, claiming to be a known attendee.
  *Mitigation:* binding between an email-on-the-allowlist and a `did:key` happens on first sign-in; the binding is stored in the `attendees` table and audited. Subsequent sign-ins require a signature over a server-issued challenge with the bound key.

#### A5, Tampering

- **T-A5-T1**: Attacker modifies the binding to point an email at their own `did:key`.
  *Mitigation:* binding is set once per attendee; rebind requires a fresh magic-link flow and is audited. Optional: an attendee can publish their `did:key` as a cross-event credential for portability.

#### A5, Repudiation

- **T-A5-R1**: User signs a credential, then denies it.
  *Mitigation:* signatures are non-repudiable by design; verifier playground produces a deterministic verification trace.

#### A5, Information disclosure

- **T-A5-I1**: Browser-side key extraction via XSS.
  *Mitigation:* CSP forbids inline scripts and `eval`; key material is held in a non-extractable `CryptoKey` where the browser supports it. Even if extractable, the key never appears in the DOM.

#### A5, DoS / EoP

- N/A specific — see cross-cutting threats.

---

### Asset A6 — audit log

An append-only record of privileged actions, intended to enable post-event forensics.

#### A6, Spoofing

- **T-A6-S1**: Attacker writes audit entries attributing actions to others.
  *Mitigation:* only the server writes audit rows; the actor field is derived from the session, not from the request body.

#### A6, Tampering

- **T-A6-T1**: Attacker (or insider with DB write) edits or deletes audit rows.
  *Mitigation (current):* file-system permissions on `events.db`; audit table has a `BEFORE UPDATE` and `BEFORE DELETE` trigger that raises.
  *Mitigation (planned):* hash-chain each row to the previous (`prev_hash`, `row_hash`); break detection on every read. Tracked in [`docs/security/audit-tampering.md`](docs/security/audit-tampering.md).

#### A6, Repudiation

- **T-A6-R1**: Operator denies an action recorded in the audit.
  *Mitigation:* once the hash chain ships and the head is published periodically (e.g., signed and posted to a public bulletin), the operator cannot quietly re-write history without detection.

#### A6, Information disclosure

- **T-A6-I1**: Attendee reads the full audit log.
  *Mitigation:* admin-only endpoint.

#### A6, DoS

- **T-A6-D1**: Attacker fills the audit log with junk.
  *Mitigation:* every audit-writing path is itself rate-limited or admin-gated.

#### A6, EoP

- N/A.

---

## Cross-cutting threats

These do not map cleanly to a single asset.

### CC-1: Spoofed `did:key`

**Threat:** An attacker generates a key pair and presents the corresponding `did:key`, claiming to be a particular attendee.
**Mitigation:** the binding between email (allowlist proof) and `did:key` is established on first sign-in via the magic-link flow. After binding, sign-in requires a signed challenge over the bound key. There is no "trust this DID because it claims to be X" code path.

### CC-2: Tampered audit log

**Threat:** As described under A6 — current state is mutable for an insider with DB write.
**Mitigation status:** acknowledged; hash chain in [`docs/security/audit-tampering.md`](docs/security/audit-tampering.md).

### CC-3: Replayed magic links

**Threat:** Attacker captures a magic link in flight (e.g., MITM on email transit) and uses it before the legitimate user.
**Mitigation:**

- Magic links are single-use: the row is deleted in the same transaction that creates the session.
- Validity window is 10 minutes from issuance.
- The link's path-component token has 256 bits of entropy.
- Token comparison is constant-time.
- Use of an already-consumed token returns identical response shape to a bad token.

### CC-4: Allowlist enumeration

See [T-A1-I1](#a1-id). The mitigation is identical response shape, identical timing, plus rate limits.

### CC-5: SSRF via `did:web`

**Threat:** Attacker creates a credential with `iss: did:web:internal-service.local` so the verifier reaches into our internal network.
**Mitigation:** the resolver enforces:

- DNS resolution to public IP space only (RFC1918, loopback, link-local, IPv6 ULA all refused).
- TLS required.
- Redirects refused (`redirect: 'error'`).
- Body cap at 16KB.
- Timeout at 5s.
- Per-host concurrency cap.
See [`docs/security/ssrf.md`](docs/security/ssrf.md) for details.

### CC-6: XSS via SVG logo

**Threat:** Operator (or attacker who reaches the logo-upload endpoint) uploads an SVG containing `<script>` or `onload="..."` attributes.
**Mitigation:**

- Logo upload is admin-only.
- Server-side SVG sanitiser strips `<script>`, `<foreignObject>`, all event-handler attributes, and external references (`xlink:href`, `href` to non-`#` targets).
- Logo is served with `Content-Type: image/svg+xml; charset=utf-8` plus `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`.
- Logo is rendered via `<img>`, never `<object>` or `<iframe>`, so even surviving script tags would not execute.

### CC-7: CSP bypass

**Threat:** An attacker finds a way to execute arbitrary script despite the CSP.
**Mitigation:**

- CSP is `default-src 'self'; script-src 'self' 'nonce-<per-request>'; style-src 'self' 'nonce-<per-request>'; img-src 'self' data: <tile-host>; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'`.
- No `unsafe-inline`, no `unsafe-eval`, no wildcards.
- Nonce is a per-request 128-bit random.
- The `html\`\`` template auto-escapes interpolations, so script execution requires CSP failure AND escaping failure simultaneously.
- See [`docs/security/xss.md`](docs/security/xss.md).

### CC-8: Race conditions on confirmation

**Threat:** Two riders click "claim seat" simultaneously and both succeed when only one seat exists.
**Mitigation:** SQLite `BEGIN IMMEDIATE` transaction with `CHECK` constraint on `claimed_seats <= total_seats`. The losing transaction sees a constraint violation and the UI shows "seat just taken — refresh."

### CC-9: Timing attacks on email auth

**Threat:** Attacker uses the time between request and response to determine whether an email is in the allowlist.
**Mitigation:** see [`docs/security/timing-attacks.md`](docs/security/timing-attacks.md). Constant-time HMAC comparison plus an artificial random delay drawn from a distribution chosen so the in/out-of-allowlist distributions are statistically indistinguishable at the relevant per-IP rate limit.

### CC-10: Open redirect on the magic link return URL

**Threat:** Attacker passes `?next=https://evil.example.com` and lures the victim into clicking a magic link that, after auth, redirects them to a phishing page.
**Mitigation:** the `next` parameter is parsed and only the path component is preserved; scheme and host are dropped; relative paths only.

---

## In-scope vs out-of-scope

### In scope (we model and mitigate)

- Authentication and authorization bypass.
- Credential forgery and replay.
- XSS, CSP bypass.
- CSRF (defense via SameSite cookies and origin checks).
- SSRF via `did:web`.
- Audit log tampering (with the caveat that the current mitigation is acknowledged-incomplete).
- Allowlist enumeration.
- Race conditions on safety-relevant state.
- Timing side channels on auth and allowlist endpoints.
- Open redirects.
- Information disclosure via error messages.
- SQL injection (defended structurally by parameterised queries).

### Out of scope (we acknowledge but do not defend against)

- Volumetric DoS — handled at the network edge.
- Compromised host (root on the box).
- Compromised Node.js runtime, `node:sqlite` build, or operating system.
- Compromised CA issuing TLS for the deployment hostname.
- Social engineering of attendees, admins, or maintainers.
- Physical attacks on the host.
- Attacks requiring control of the email provider's transit infrastructure (we treat email as a one-time bearer-token channel and accept that channel's well-known weaknesses).
- Side channels in the underlying browser (Spectre, Rowhammer, GPU pixel leaks, etc.).
- Attacks against weaknesses in fundamental crypto primitives (Ed25519, SHA-256, ChaCha20-Poly1305, HKDF).

---

## Residual risks

Risks we acknowledge and have chosen not to mitigate, with reasoning.

1. **Compromised host = full compromise.** The signing key, the DB, and all in-flight magic links are accessible. We rely on the operator running on hardened infrastructure with disk encryption, short-lived snapshots, and a minimum-privilege deploy user. We do not implement HSM-backed signing in v1; that is a known gap.
2. **Email is a one-time bearer-token channel.** Anyone who reads the magic-link email before the legitimate recipient can sign in. Mitigations are short TTL (10 min), single use, and same-IP-class binding (planned, not yet implemented).
3. **Audit log is mutable for an insider with DB write.** Hash chain is planned and documented; v1 ships with file-system permissions plus triggers as the only barrier.
4. **Cross-event trust is unilateral.** A peer deployment whose signing key we accept can issue credentials in our verifier without our consent. Counter-signature mitigation is planned. See [`docs/security/credential-forgery.md`](docs/security/credential-forgery.md).
5. **Geo-coarsening is not a privacy primitive.** A motivated attacker who knows roughly where you live can still match a coarsened pin. Coarsening reduces casual snooping; it does not defend against a targeted adversary.
6. **Tile provider can correlate ride locations** unless the operator self-hosts tiles. We document the risk.
7. **No defense against a malicious browser extension** running in the attendee's browser. Such an extension can read keys from IndexedDB regardless of CSP.
8. **No defense against TLS MITM with a CA-issued cert** for the deployment hostname (rogue CA, government-compelled cert).

---

## Assumptions

The threat model relies on these assumptions. If any is violated, the analysis above is invalid for the corresponding portion.

1. **TLS termination is correct.** The edge proxy (Caddy, nginx, Cloudflare, etc.) terminates TLS with a strong cipher suite and forwards `X-Forwarded-For` honestly.
2. **`node:sqlite` is honest.** The bundled SQLite implementation respects parameter binding and constraint checks. We do not validate this against a hostile build.
3. **Node `crypto` is correct.** `crypto.randomBytes`, `crypto.timingSafeEqual`, `crypto.createHmac`, and the WebCrypto Ed25519 path return what they claim.
4. **The email provider does not actively forge messages from us.** A passive observer of provider infrastructure is in scope (CC-3); an active forger is treated as a compromised host of the provider — out of scope.
5. **DNS for `did:web` resolution is honest** at the resolver level. We do not implement DNSSEC verification in the resolver.
6. **Operators do not commit secrets to the repo.** `.env`, `secrets/`, and `events.db` are gitignored and CI scans for accidental adds.
7. **Deployment hostname is unique per event.** We do not support a single hostname serving multiple events; the threat model assumes one-host-one-event.
8. **Browser implements CSP correctly.** Attacks against the browser's CSP enforcement are out of scope (CC-7's mitigations rely on the browser doing its job).
9. **The deployment is not behind a corporate proxy that strips security headers.** If it is, the CSP mitigation is degraded and the operator should add the headers at the upstream proxy too.
10. **The audit log writer is the only writer to the `audit` table.** No application code path writes the audit table by any route other than the central `audit()` helper.

---

## Where to read more

- [`SECURITY.md`](SECURITY.md) — disclosure policy and one-page summary.
- [`TRUST.md`](TRUST.md) — DID and Verifiable Credential architecture, with full ceremony diagrams.
- [`RUNBOOK.md`](RUNBOOK.md) — operator procedures.
- [`docs/security/`](docs/security/) — per-control deep dives:
  - [`csrf.md`](docs/security/csrf.md)
  - [`xss.md`](docs/security/xss.md)
  - [`ssrf.md`](docs/security/ssrf.md)
  - [`credential-forgery.md`](docs/security/credential-forgery.md)
  - [`timing-attacks.md`](docs/security/timing-attacks.md)
  - [`audit-tampering.md`](docs/security/audit-tampering.md)
- [`docs/code-reading-guide.md`](docs/code-reading-guide.md) — five-minute tour of the security-critical files.
- [`docs/intentional-non-features.md`](docs/intentional-non-features.md) — what we deliberately don't build.

---

## Change log

| Version | Date | Notes |
| --- | --- | --- |
| 0.3.0 | 2026-04-30 | Initial public threat model, covering portable trust (DID + VC) plus everything from 0.1 / 0.2. |

> Future revisions are tracked alongside [`CHANGELOG.md`](CHANGELOG.md). Material changes to mitigations are called out in the `Security` subsection of the relevant release.
