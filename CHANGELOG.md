# Changelog

All notable changes to **rideshare** are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Subsections per release: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

---

## [Unreleased]

### Added

- *(nothing yet)*

### Changed

- *(nothing yet)*

### Deprecated

- *(nothing yet)*

### Removed

- *(nothing yet)*

### Fixed

- *(nothing yet)*

### Security

- *(nothing yet)*

---

## [0.3.0] — 2026-04-30

Portable trust release. Adds DID + Verifiable Credential support so attendees and deployments can carry trust across events.

### Added

- `lib/keys.js` — Ed25519 key generation and signing helpers built on `node:crypto` and WebCrypto.
- `lib/did.js` — `did:key` (multibase / multicodec) and `did:web` resolution.
- `lib/vc.js` — W3C Verifiable Credentials in JWT (JWS) form: issue, parse, verify.
- `lib/trust.js` — orchestrates DID resolution, credential verification, and the deployment's signing/verification policy.
- `routes/trust.js` — `/trust` dashboard for an attendee, `/trust/credentials` issuance and listing, `/trust/verify` playground for ad-hoc credential inspection.
- `routes/well-known.js` — serves `/.well-known/did.json` for the deployment's `did:web` identifier.
- `public/.well-known/did.json` — generated at deploy time by `bin/did-publish.js`.
- Cross-event trust: `TRUST_PEERS` env var allowlists peer deployment `did:web` identifiers whose credentials we accept.
- `tests/trust.test.js`, `tests/vc.test.js`, `tests/did.test.js` — test vectors from the W3C VC and DID specs.
- [`TRUST.md`](TRUST.md) — full trust-system documentation.

### Changed

- Sign-in flow now binds an attendee's `did:key` on first sign-in; subsequent sign-ins can use either the magic-link path or a signed challenge over the bound key.
- Audit log records DID issuance and verification events alongside existing event types.

### Security

- New SSRF defenses for `did:web` resolution: public-IP-only allowlist, `redirect: 'error'`, response-body cap of 16KB, 5s timeout, per-host concurrency cap. See [`docs/security/ssrf.md`](docs/security/ssrf.md).
- New CSP `connect-src` policy enforces same-origin for fetches; cross-origin DID resolution happens server-side only.
- Documented credential-forgery threat model in [`docs/security/credential-forgery.md`](docs/security/credential-forgery.md). Current v1 model uses unilateral deployment signing; counter-signature mitigation is planned for 0.4.

---

## [0.2.0] — 2026-04-30

Operational and presentational release. Configurable per-event branding, on-host map renderer, and meetups.

### Added

- `event.config.yaml` — per-event configuration (event name, dates, venues, default ride radius, default map style, sender identity, custom CSS variables).
- Logo upload (admin-only). SVGs are sanitised server-side: scripts, foreign-objects, event handlers, and external references are stripped.
- Custom slippy-map renderer in `public/js/map.js`. No Leaflet, no Mapbox SDK. Pure DOM + canvas, supports tile zoom levels 0-18.
- Multiple tile styles selectable per-deployment: OSM standard, Stadia toner-lite, self-hosted MBTiles via local proxy.
- Meetups feature: a meetup is a many-to-many ride with a shared destination and a soft-cap on attendees, distinct from a single-driver ride.
- `routes/admin/insights.js` — aggregate event metrics: signups, rides created, claim rate, magic-link delivery latency, audit volume.

### Changed

- Routing extracted from `server.js` into `lib/router.js` for testability.
- HTML template extracted into `lib/html.js` with `html\`\`` tagged template + `raw()` opt-out for trusted content.

### Security

- Strict CSP shipped with per-request nonce on inline scripts and styles. No `unsafe-inline`, no `unsafe-eval`, no wildcards. See [`docs/security/xss.md`](docs/security/xss.md).
- Tile fetches optionally proxied via the deployment to prevent the tile provider from observing per-attendee location queries.

---

## [0.1.0] — 2026-04-30

Initial release. Minimum viable event ride-sharing app, zero-dependency.

### Added

- Zero runtime npm dependencies, Node ≥ 22.5.
- `server.js` — `node:http` server, top-level routing.
- `lib/db.js` — `node:sqlite` schema bootstrap, parameterised query helpers.
- `lib/auth.js` — magic-link authentication. 256-bit single-use tokens, 10-minute TTL, constant-time comparison, opaque session cookies (`HttpOnly; Secure; SameSite=Lax`).
- `lib/allowlist.js` — HMAC-protected allowlist; emails stored as `HMAC(server_secret, lower(email))`, never plaintext.
- `lib/rate.js` — token-bucket rate limiter, per-IP and per-account.
- `lib/audit.js` — append-only audit log of privileged actions.
- `routes/rides.js` — create, list, claim, cancel.
- `routes/admin.js` — allowlist management, insights, audit viewer.
- `bin/allowlist-import.js` — bulk import attendee list.
- `tests/` — `node --test` suite covering auth, allowlist, rate limiting, ride lifecycle.

### Security

- Allowlist enumeration defenses: identical response shape and status, constant-time HMAC comparison, artificial random delay, per-IP rate limit. See [`docs/security/timing-attacks.md`](docs/security/timing-attacks.md).
- Magic links single-use, short TTL, comparison via `crypto.timingSafeEqual`.
- All SQL queries parameterised; no string concatenation.
- Sessions opaque random, server-side state, revocable.
- HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy: ()`.

---

[Unreleased]: https://example.com/rideshare/compare/v0.3.0...HEAD
[0.3.0]: https://example.com/rideshare/compare/v0.2.0...v0.3.0
[0.2.0]: https://example.com/rideshare/compare/v0.1.0...v0.2.0
[0.1.0]: https://example.com/rideshare/releases/tag/v0.1.0
