# Code reading guide

> A five-minute tour of **rideshare** for a curious reviewer. Audience: someone evaluating the codebase for security or fit, who has 5–30 minutes.

If you have **5 minutes**, read these five files in order:

1. [`server.js`](#1-serverjs) — request → router.
2. [`lib/router.js`](#2-librouterjs) — middleware-light routing + security headers.
3. [`lib/auth.js`](#3-libauthjs) — magic-link + sessions.
4. [`lib/trust.js`](#4-libtrustjs) — DID + VC orchestration.
5. [`routes/trust.js`](#5-routestrustjs) — `/trust` endpoints.

That's the core. Everything else is leaves.

---

## 1. `server.js`

The entry point. Imports `node:http`, sets up the server, hands every request to the router. Reads `EVENT_CONFIG_PATH`, `secrets/server.secret`, and `secrets/deployment.key` at startup; refuses to start if any are missing or malformed.

The file is short on purpose — under 100 lines. Anything bigger lives in `lib/`. Top-level `await` is permitted here (it's the entry point); it is not permitted in `lib/`.

**The three security-critical lines:**

- The `process.on('unhandledRejection', ...)` handler that exits non-zero so the supervisor restarts rather than serving from unknown state.
- `shutdown()`, which drains the HTTP server and then closes SQLite — the close is what checkpoints the WAL file back into the database.
- TLS termination is **not** here. The server speaks plaintext HTTP and expects a reverse proxy in front; `TRUST_PROXY` decides whether `X-Forwarded-*` is believed.

The deployment key's integrity check lives in `lib/keys.js`, not here: a key file
that does not match the public key recorded in `deployment_identity` refuses to
load, so a swapped key cannot issue credentials that peers will reject.

---

## 2. `lib/router.js`

The router. There is no Express here. The exported `route(req, res, handlers)` function dispatches by `req.method + req.url` against a flat handler map, applies a small middleware chain (security headers → body parser → session resolver → CSRF check → handler), and produces a typed `Response`.

This file is also where CSP, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy`, and the per-request CSP nonce are emitted. Reading it tells you most of what you need to know about the security posture without touching any individual endpoint.

**The three security-critical lines:**

- The `Content-Security-Policy` header construction, with the per-request nonce. Search for `nonce-`.
- The `SameSite=Lax; Secure; HttpOnly` cookie flags applied to the session cookie.
- The body-size cap (64KB by default) that rejects oversize requests before any handler runs, defending against memory-exhaustion DoS.

---

## 3. `lib/auth.js`

Magic-link authentication and session management.

Sign-in flow: receive an email → check allowlist (constant-time) → generate a 256-bit token → store row → email the link → return identical response shape regardless of allowlist hit. On link-click: parameterised lookup → constant-time token compare → delete the magic-link row → create a session row → set the cookie.

Session flow: opaque random `sid` → server-side `sessions` table → revoke by deleting row.

**The three security-critical lines:**

- `crypto.timingSafeEqual` on the magic-link token comparison.
- The `DELETE FROM magic_links WHERE id=?` inside the same transaction as session creation, ensuring single use.
- The artificial random delay (`await sleep(randomDelayMs())`) before responding to a sign-in submission, designed to drown out the in-vs-out-of-allowlist timing signal. See [`docs/security/timing-attacks.md`](security/timing-attacks.md).

---

## 4. `lib/trust.js`

Orchestrates DID resolution and Verifiable Credential verification.

Three responsibilities:

1. Resolve a DID (`did:key` for users, `did:web` for deployments) to a public key.
2. Verify a presented Verifiable Credential's JWS signature against that key.
3. Apply the deployment's trust policy: which issuer DIDs are accepted, which credential types are recognised, what claims must be present.

Calls into `lib/did.js`, `lib/vc.js`, and `lib/keys.js` for the primitives. This file holds the *policy*; the other three hold the *mechanics*.

**The three security-critical lines:**

- The `did:web` resolver call site, which routes through the hardened fetch in `lib/safe-fetch.js` (public-IP-only, no redirects, body cap). See [`docs/security/ssrf.md`](security/ssrf.md).
- The issuer check in `importCredential` (`lib/trust.js`): only a `did:web` issuer is accepted, and never this deployment's own DID. A `did:key` resolves from the DID string itself, so accepting one would let any user self-issue their own trust score. There is no `TRUST_PEERS` allowlist in this codebase.
- The signature verification call, `ed25519Verify` via `node:crypto` with the algorithm pinned to Ed25519. No algorithm-confusion possible.

---

## 5. `routes/trust.js`

The `/trust` endpoints:

- `GET /trust` — the dashboard: shows the attendee's current `did:key`, the credentials they've been issued, and any cross-event credentials they've imported.
- `POST /trust/credentials` — request issuance of a fresh credential from the deployment.
- `GET /trust/verify` — the verifier playground: paste a JWS, see the verification trace, including which DID was resolved and what each claim asserted.
- `POST /trust/import` — accept a cross-event credential and validate it against `TRUST_PEERS`.

All four require an authenticated session. The verifier playground is the most interesting from a security view: it accepts an attacker-controlled string. Hardening lives in this file plus `lib/vc.js`.

**The three security-critical lines:**

- The size cap on `POST /trust/verify` body (8KB) — JWS strings should never approach this; anything larger is suspect.
- The error-message normalisation in the verifier: every failure mode returns the same error shape so a probe can't distinguish "bad signature" from "unknown issuer" from "expired" via response shape (only the human-readable trace, which is rendered with full escaping).
- The audit-log call on every issuance and every verification, so a flood of failed verifies is detectable.

---

## Where lives X — the cross-reference

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
| `/.well-known/security.txt` | served via the same handler (file lives at `public/.well-known/security.txt`) |
| `/health` | `routes/health.js` |
| Sign-in UI & flow | `routes/auth.js` |
| Profile & contact info | `routes/auth.js` |
| Rides (post / claim / cancel) | `routes/rides.js` |
| Meetups | `lib/meetups.js`, admin UI in `routes/admin.js` |
| `/trust` dashboard, verifier | `routes/trust.js` |
| Admin (allowlist, banner, wipe) | `routes/admin.js` |
| Admin insights | `lib/insights.js`, UI in `routes/admin.js` |
| Admin audit viewer | `routes/admin.js` (`/admin/audit`) |

---

## If you have 30 minutes

After the five files above, in this order:

6. `lib/html.js` — see how `html\`\`` auto-escapes and how `raw()` works. Any deviation from this template is a XSS risk.
7. `lib/db.js` — schema definitions. Read the table definitions; everything else is parameterised wrappers.
8. `lib/db.js`'s `audit()` — what we record, and the append-only triggers beside it.
9. `lib/safe-fetch.js` — the SSRF defense at the network boundary.
10. `routes/auth.js` — the request-shape view of the magic-link flow you read in `lib/auth.js`.

After those, you've seen every security-critical control and have enough context to navigate the rest by `find` and `grep`.

---

## See also

- [`SECURITY.md`](../SECURITY.md), [`THREAT_MODEL.md`](../THREAT_MODEL.md), [`TRUST.md`](../TRUST.md) — the architectural docs.
- [`docs/security/`](security/) — per-control deep dives.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — where to add new code.
