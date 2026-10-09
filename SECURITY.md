# Security model

Read before deploying for a real event.

## What we protect

1. **Attendee list** (email addresses), valuable to spammers, phishers, recruiters.
2. **Contact info** shared after a ride match (Signal, phone, social handle).
3. **Ride metadata** (who travels when, from where).

## Threats and mitigations

### T1. Stolen DB file leaks the attendee list

Via host compromise, a public bucket, a leaked backup.

- Emails stored as `HMAC-SHA256(normalize(email), ALLOWLIST_SALT)`, never plaintext.
- The salt is an env var, not in the DB; without it, only offline brute force against a candidate list works.
- Rotating the salt invalidates all hashes; admin re-imports the CSV.

**Limit:** DB plus env file (full host access) lets an attacker hash any candidate. Harden the host.

### T2. Allowlist enumeration via the sign-in form

Probing `/auth/send` to learn who's registered.

- Same response whether or not the email is listed.
- `startMagicLink` adds an artificial delay on the off-list path.
- `MAGIC_LINK_RATE_LIMIT` (default 5) per email per hour; 30 per IP per hour.
- No endpoint returns the allowlist.

**Limit:** 100 IPs at 30/hour probe ~72k addresses/day, against lists usually under 2k. Put Cloudflare or a similar WAF in front with stricter limits.

### T3. Allowlist enumeration via the admin "check" tool

A compromised admin runs a wordlist through `/admin/allowlist/check`.

- 30 checks per admin per hour.
- Each check is audit-logged (timestamp, admin email, IP).

### T4. Stolen session cookie

From XSS, MITM or malware.

- Opaque 32-byte tokens (`crypto.randomBytes`) stored server-side; delete the row to revoke.
- `HttpOnly`, `SameSite=Lax`, and `Secure` when `APP_URL` is `https://`.
- Strict CSP (no inline scripts except style; no third-party origins) and auto-escaping templates.
- 14-day default lifetime, configurable.

### T5. Magic-link interception

Query-string tokens land in history, logs and Referer headers.

- 256-bit random, single-use, 15-minute expiry.
- DB stores the token's HMAC, so log access alone yields nothing.
- `Referrer-Policy: same-origin`.

**Limit:** browser-history access within 15 minutes, before first use, allows sign-in.

### T6. CSRF

Forged POSTs (`/rides/new`, `/claims/:id/accept`, etc.).

- `SameSite=Lax` session cookie blocks cross-origin POSTs in modern browsers.
- `Content-Security-Policy: frame-ancestors 'none'` blocks framing.
- `Permissions-Policy` denies camera, microphone and other powerful features. Geolocation and screen wake lock are allowed for this origin only, for opt-in live location.

**Limit:** SameSite=Lax is the main defense; browsers 10+ years old that ignore it are exposed. Acceptable for a 2026 event. See [`docs/security/csrf.md`](docs/security/csrf.md).

### T7. Server-side request injection / SSRF

No outbound requests built from user input, except the hard-coded Resend API endpoint.

### T8. Mass account takeover via rate-limit bypass

The in-memory limiter resets on restart. Windows are 1 hour, so one restart doesn't enable enumeration at scale.

**Limit:** on a platform that restarts every deploy, under active attack, swap in a DB-backed limiter (`lib/rate-limit.js`).

### T9. Insecure transport

An `http://` `APP_URL` (local dev) drops `Secure` from cookies. In production use `https://`, and `TRUST_PROXY=true` behind a TLS-terminating proxy.

### T10. Privacy regression via insights

Small buckets identify people ("1 person flew SFO→venue at 3:14am Tuesday").

- Buckets under 5 entries merge into "Other" (k-anonymity heuristic).
- No per-user admin views. The audit log records actors for state changes only, not browsing.

## Deployment hygiene

- Generate `SESSION_SECRET` and `ALLOWLIST_SALT` with `openssl rand -hex 32`, fresh per event.
- Encrypt disks at rest. Railway, Render and Fly volumes are encrypted by default.
- Protect backups like the live DB.
- Keep `ADMIN_EMAILS` minimal.
- After the event: "Wipe attendee data" in admin, or destroy the deployment and volume. `SESSION_LIFETIME_DAYS=14` expires stale sessions.

## What we don't claim

- No SOC2 audit or third-party pen test. The codebase is small (~2000 lines) and readable end to end.
- No defense against a compromised admin beyond the audit log, or a compromised host (root).
- Not built for multi-tenancy or extreme scale.

## Reporting issues

Email the `supportEmail` in your `event.config.yaml`, or open an issue prefixed `security:` in your fork's tracker.
