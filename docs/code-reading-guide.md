# Code reading guide

A short tour for someone reviewing rideshare for security or fit.

With 5 minutes, read these in order:

1. [`server.js`](#1-serverjs): request → router.
2. [`lib/router.js`](#2-librouterjs): routing and security headers.
3. [`lib/auth.js`](#3-libauthjs): magic links and sessions.
4. [`lib/trust.js`](#4-libtrustjs): DID and VC orchestration.
5. [`routes/trust.js`](#5-routestrustjs): `/trust` endpoints.

Everything else hangs off these.

## 1. `server.js`

Entry point. Creates the `node:http` server and hands every request to the router. Reads `EVENT_CONFIG_PATH`, `secrets/server.secret` and `secrets/deployment.key` at startup and refuses to start if any is missing or malformed. Kept under 100 lines; top-level `await` is allowed here but not in `lib/`.

Security-relevant:

- `process.on('unhandledRejection', ...)` exits non-zero so the supervisor restarts instead of serving from unknown state.
- `shutdown()` drains HTTP, then closes SQLite, which checkpoints the WAL into the database.
- No TLS here. Plain HTTP behind a reverse proxy; `TRUST_PROXY` controls whether `X-Forwarded-*` is believed.

The deployment key integrity check is in `lib/keys.js`: a key file that doesn't match the public key in `deployment_identity` won't load, so a swapped key can't issue credentials peers would reject.

## 2. `lib/router.js`

No Express. `route(req, res, handlers)` dispatches on `req.method + req.url` against a flat handler map, runs a small chain (security headers → body parser → session resolver → CSRF check → handler) and returns a typed `Response`.

It also emits CSP, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy` and the per-request CSP nonce, so it shows most of the security posture in one place.

Security-relevant:

- `Content-Security-Policy` construction with the per-request nonce (search `nonce-`).
- `SameSite=Lax; Secure; HttpOnly` on the session cookie.
- Body-size cap (64KB default), enforced before any handler runs.

## 3. `lib/auth.js`

Magic-link auth and sessions.

- Sign-in: email → allowlist check (constant-time) → 256-bit token → store row → send link → same response shape whether or not the email is allowed.
- Link click: parameterised lookup → constant-time compare → delete magic-link row → create session row → set cookie.
- Sessions: opaque random `sid` in a server-side `sessions` table; revoke by deleting the row.

Security-relevant:

- `crypto.timingSafeEqual` on the token compare.
- `DELETE FROM magic_links WHERE id=?` in the same transaction as session creation, so links are single-use.
- Random delay (`await sleep(randomDelayMs())`) before answering a sign-in, to mask the allowlist timing signal. See [`docs/security/timing-attacks.md`](security/timing-attacks.md).

## 4. `lib/trust.js`

DID resolution and VC verification policy:

1. Resolve a DID (`did:key` for users, `did:web` for deployments) to a public key.
2. Verify a VC's JWS signature against it.
3. Apply policy: accepted issuers, recognised credential types, required claims.

Primitives live in `lib/did.js`, `lib/vc.js` and `lib/keys.js`; this file is policy.

Security-relevant:

- The `did:web` resolver goes through `lib/safe-fetch.js` (public IPs only, no redirects, body cap). See [`docs/security/ssrf.md`](security/ssrf.md).
- The issuer check in `importCredential`: only `did:web` issuers, never this deployment's own DID. A `did:key` resolves from its own string, so accepting one would let users self-issue trust. There is no `TRUST_PEERS` allowlist.
- Signature verification is `ed25519Verify` via `node:crypto`, algorithm pinned to Ed25519, so no algorithm confusion.

## 5. `routes/trust.js`

| Endpoint | Purpose |
|---|---|
| `GET /trust` | Dashboard: current `did:key`, issued credentials, imported credentials |
| `POST /trust/bind` | Bind the browser's `did:key` to the account (after `/trust/bind/challenge`) |
| `GET /trust/credentials.json` | Download your credentials |
| `GET /trust/verify` | Verifier playground: paste a JWS, see the trace (resolved DID, each claim) |
| `POST /trust/import` | Import a cross-event credential and verify it (issuer rules in `lib/trust.js` above) |

All require a session. The playground takes attacker-controlled input; its hardening is here and in `lib/vc.js`.

Security-relevant:

- 8KB cap on `POST /trust/verify` bodies. Real JWS strings are far smaller.
- Every verifier failure returns the same error shape, so a probe can't tell bad signature from unknown issuer from expired. Only the human-readable trace differs, and it's fully escaped.
- Every issuance and verification is audit-logged, so floods of failed verifies show up.

## Where lives X: the cross-reference

| Concern | Lives in |
| --- | --- |
| HTTP entry point | `server.js` |
| Routing & security headers | `lib/router.js` |
| Body parsing & size cap | `lib/router.js` |
| Sessions | `lib/auth.js` |
| Magic links | `lib/auth.js` |
| Allowlist (HMAC) | `lib/allowlist.js` |
| Rate limiting | `lib/rate-limit.js` |
| Audit log | `lib/db.js` (`audit()`) |
| SQLite schema + queries | `lib/db.js` |
| HTML templating + escaping | `lib/html.js` |
| Input validation | `lib/validate.js` |
| Logging | `lib/log.js` |
| Hardened HTTP fetch (SSRF defense) | `lib/safe-fetch.js` |
| Ed25519 keygen / sign / verify | `lib/did.js` |
| Deployment key custody | `lib/keys.js` |
| `did:key` & `did:web` resolution | `lib/did.js` |
| W3C VC issue / parse / verify | `lib/vc.js` |
| Trust policy orchestration | `lib/trust.js` |
| Slippy-map renderer | `public/map.js` |
| Tile URLs (fetched by the browser) | `lib/map-styles.js` |
| YAML config loader | `lib/config.js` (parser in `lib/yaml.js`) |
| Static asset serving | `routes/static.js` |
| `/.well-known/did.json` | `routes/well-known.js` |
| `/.well-known/security.txt` | same handler (file at `public/.well-known/security.txt`) |
| `/health` | `routes/health.js` |
| Sign-in UI & flow | `routes/auth.js` |
| Profile & contact info | `routes/auth.js` |
| Rides (post / claim / cancel) | `routes/rides.js` |
| Meetups | `lib/meetups.js`, admin UI in `routes/admin.js` |
| `/trust` dashboard, verifier | `routes/trust.js` |
| Admin (allowlist, banner, wipe) | `routes/admin.js` |
| Admin insights | `lib/insights.js`, UI in `routes/admin.js` |
| Admin audit viewer | `routes/admin.js` (`/admin/audit`) |

## If you have 30 minutes

Then read:

6. `lib/html.js`: how `html\`\`` auto-escapes and how `raw()` works. Anything bypassing it is an XSS risk.
7. `lib/db.js`: the table definitions; the rest is parameterised wrappers.
8. `audit()` in `lib/db.js`: what's recorded, and the append-only triggers next to it.
9. `lib/safe-fetch.js`: SSRF defense at the network boundary.
10. `routes/auth.js`: the request side of the magic-link flow.

That covers every security-critical control. Use `grep` for the rest.

## See also

- [`SECURITY.md`](../SECURITY.md), [`THREAT_MODEL.md`](../THREAT_MODEL.md), [`TRUST.md`](../TRUST.md): architecture.
- [`docs/security/`](security/): per-control deep dives.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md): where to add new code.
