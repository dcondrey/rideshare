# Security model

This document describes the threats this app defends against, the mitigations
in place, and the limits of those mitigations. Read it before deploying for
a real event.

## What we protect

The most sensitive asset is the **attendee list** — the set of email
addresses of registered event attendees. Conference attendee lists are
valuable to spammers, phishers, recruiters, and competitors, and leaks
embarrass the event.

The next most sensitive asset is **per-user contact information** that
people opt into sharing only after a ride match (Signal, phone, social
handle, etc.).

After that, **ride metadata** (who's traveling when, from where) — useful
to a stalker, less so to a generic attacker.

## Threats and mitigations

### T1. Stolen DB file leaks the attendee list

The `data/app.db` file might be stolen via host compromise, accidental
public S3 bucket, leaked backup, etc.

**Mitigation:**
- Attendee emails are stored as `HMAC-SHA256(normalize(email), ALLOWLIST_SALT)`,
  never in plaintext.
- The salt is a per-deployment secret kept in env vars, *not* in the DB.
- Without the salt, the hashes are useless for anything except offline
  brute-forcing against a candidate email list — which is far less useful
  than a plaintext dump.
- Rotating the salt invalidates all hashes; admin must re-import the CSV.

**Limit:** an attacker who steals **both** the DB and the env file (i.e.
who has full host access) can re-derive hashes for any candidate email.
Defence is at the host level: encrypted volumes, restricted host access.

### T2. Allowlist enumeration via the sign-in form

An attacker probes `/auth/send` with thousands of emails to learn who is
registered.

**Mitigation:**
- Identical HTTP response and rendered page regardless of whether the email
  is on the list or not.
- `startMagicLink` does an artificial delay on the off-list path to mask
  the difference in CPU work.
- Per-email rate limit: max `MAGIC_LINK_RATE_LIMIT` (default 5) sends per
  email per hour.
- Per-IP rate limit: 30 sends per IP per hour.
- No endpoint anywhere returns the contents of the allowlist.

**Limit:** a sophisticated attacker with many IPs can still probe slowly.
At 30 emails/hour/IP and (say) 100 IPs, they could learn ~72k addresses/day.
For a typical event allowlist of <2k addresses, this is non-trivial but not
impossible. Defence in depth: deploy behind Cloudflare or a similar WAF and
enforce stronger limits there.

### T3. Allowlist enumeration via the admin "check" tool

A compromised admin account checks every email in a wordlist via
`/admin/allowlist/check`.

**Mitigation:**
- Per-admin rate limit (30 checks per admin per hour).
- Every check is written to the audit log with timestamp, admin email, and
  IP. Other admins can spot abuse.

### T4. Stolen session cookie

If a user's session cookie is exfiltrated (XSS, MITM, malware), the attacker
can act as them.

**Mitigation:**
- Sessions are opaque random tokens (32 bytes from `crypto.randomBytes`),
  stored server-side. Compromised cookies are revoked instantly by deleting
  the row.
- Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` when `APP_URL`
  is `https://`.
- Strict CSP (no inline scripts except style; no third-party origins).
- Auto-escaping HTML templates (XSS-safe by default).
- 14-day default session lifetime; configurable.

### T5. Magic-link interception

Tokens travel in URL query strings, which appear in browser history, server
logs, and Referer headers.

**Mitigation:**
- Tokens are random (256 bits), one-time-use, and expire after 15 minutes.
- The DB stores the HMAC of the token, not the token itself, so log access
  alone doesn't yield a valid token.
- `Referrer-Policy: same-origin` reduces leaks via cross-origin Referer.

**Limit:** an attacker with access to the user's browser history within the
15-minute window before first use can sign in. The user closing the email
tab promptly mitigates this.

### T6. CSRF

Cross-site request forgery against the state-changing POST endpoints
(`/rides/new`, `/claims/:id/accept`, etc.).

**Mitigation:**
- `SameSite=Lax` session cookie blocks cross-origin POSTs initiated by
  third-party sites in modern browsers.
- `Content-Security-Policy: frame-ancestors 'none'` blocks framing.
- `Permissions-Policy` denies geolocation/camera/microphone.

**Limit:** SameSite=Lax is the primary defence. Browsers ≥10 years old
that don't enforce SameSite are vulnerable to classic CSRF. Acceptable
trade-off for an event in 2026.

### T7. Server-side request injection / SSRF

The app does not make outbound requests based on user input, except to
the Resend API endpoint which is hard-coded.

### T8. Mass account takeover via rate-limit bypass

The in-memory rate limiter resets on process restart.

**Mitigation:** rate-limit windows are 1 hour; a single restart cycle
won't help an attacker enumerate at scale.

**Limit:** if you're running on a platform that auto-restarts on every
deploy and you're being actively attacked, consider a DB-backed limiter
(swap in `lib/rate-limit.js`).

### T9. Insecure transport

If `APP_URL` is `http://` (e.g. local dev), session cookies are sent
without `Secure`.

**Mitigation:** in production, always set `APP_URL` to `https://`. Set
`TRUST_PROXY=true` so the app correctly identifies HTTPS when behind a
TLS-terminating proxy.

### T10. Privacy regression via insights

Aggregate metrics could leak individual identities if a bucket is small
enough (e.g. "1 person flew SFO→venue at 3:14am Tuesday").

**Mitigation:**
- The insights aggregator coalesces buckets with fewer than 5 entries into
  "Other" (k-anonymity heuristic).
- No per-user views exist anywhere in the admin UI. The audit log has
  per-actor records but only for state-changing actions, not browsing.

## Deployment hygiene

- **Strong secrets.** Generate `SESSION_SECRET` and `ALLOWLIST_SALT` with
  `openssl rand -hex 32`. Don't reuse across events.
- **Encrypted storage.** Run on a host with disk encryption at rest.
  Railway, Render, and Fly volumes are encrypted by default.
- **Backup hygiene.** SQLite backups contain the same hashes as the live
  DB — protect them the same way. Don't push backups to public buckets.
- **Limited admin access.** Keep `ADMIN_EMAILS` to the minimum set of
  organizers who actually need it.
- **Wipe after the event.** Either click "Wipe attendee data" in admin, or
  destroy the deployment + volume. The default
  `SESSION_LIFETIME_DAYS=14` means stale sessions expire on their own.

## What we don't claim

- This is **not** SOC2-audited or pen-tested by a third party. It's a
  small, auditable codebase (~2000 lines) that you can read end-to-end.
- It does **not** defend against a compromised admin account (other than
  the audit log telling you what they did).
- It does **not** defend against a compromised host (root on the server).
- It is **not** designed for multi-tenancy or extreme scale.

## Reporting issues

Email `supportEmail` from your `event.config.json`, or open an issue with
the prefix `security:` in your fork's tracker.
