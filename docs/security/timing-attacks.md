# Timing attacks

Timing side channels on **rideshare** sign-in.

Two endpoints matter:

| Endpoint | Could leak |
|---|---|
| `POST /auth/send` (request a link) | whether an email is on the allowlist |
| `GET /auth/callback?token=` (use a link) | whether a token is valid |

Defenses: the sign-in response doesn't wait on any allowlist work, secrets are compared via HMAC or `safeEqual`, and rate limits cap sampling.

---

## Sign-in: response decoupled from the work

`POST /auth/send` in `routes/auth.js`:

1. Parses the email. Invalid input redirects to `/auth/check`.
2. Starts `startMagicLink()` fire-and-forget.
3. Redirects to `/auth/check`.

Rate limits, allowlist check and send run after the redirect, so every outcome gets the same immediate response. Rate-limited requests return silently; no `429`.

The off-list path in `startMagicLink` (`lib/auth.js`) also awaits `artificialDelay()` (50-150ms jitter). The real protection is the rate limit.

---

## Magic-link consumption

`consumeMagicLink()` HMACs the submitted token with `SESSION_SECRET` and looks up `magic_links.token_hash`. No artificial delay.

- Valid: 303 redirect to `/` with a fresh session cookie.
- Missing, invalid, already used or expired: a `400` "That link didn't work" page with the reason.

Reasons are distinguishable; fine, since tokens are 256 random bits, single-use, 15-minute TTL.

---

## Comparisons

- **Allowlist and magic-link tokens:** the submitted value is HMACed (`ALLOWLIST_SALT` / `SESSION_SECRET`) and matched by indexed SQLite equality on the hash. The attacker never sees the key, so timing on the stored hash bytes isn't useful.
- **Signed payloads and CSRF tokens:** `safeEqual` in `lib/crypto.js` wraps `crypto.timingSafeEqual`. It compares UTF-8 byte lengths first, so mismatched input returns `false` instead of throwing. Used by `verifyPayload()` and `csrfProtected` in `lib/router.js`.

Code review requires `safeEqual` on any secret comparison whose left side comes from a request.

---

## Rate limits

`lib/rate-limit.js`: fixed-window counter per key, in memory, reset on restart.

| Key | Limit | Where |
|---|---|---|
| `magic:email:<address>` | `MAGIC_LINK_RATE_LIMIT` (default 5) / hour | `lib/auth.js` |
| `magic:ip:<addr>` | 30 / hour | `lib/auth.js` |
| `admincheck:<user id>` | 30 / hour, admin allowlist lookup | `routes/admin.js` |

`POST /trust/verify` is **not** rate-limited today.

---

## What's still possible

- **Network-level timing.** An attacker on the server's LAN sees round trips more precisely. Rare on cloud VMs; don't host on a LAN shared with untrusted parties.
- **Inbox observation.** Someone who controls the recipient's inbox sees whether a link arrived, regardless of HTTP masking. Keep `EMAIL_FROM` on a domain you control.
- **Cache-eviction side channels.** Theoretical at our scale. Not modeled.
- **Email provider latency.** Not visible: the send happens after the redirect.

---

## Where to look

- `routes/auth.js`: `/auth/send` and `/auth/callback`.
- `lib/auth.js`: `startMagicLink`, `consumeMagicLink`, `artificialDelay`.
- `lib/allowlist.js`: `isAllowed`, the HMAC lookup.
- `lib/crypto.js`: `safeEqual`.
- `lib/rate-limit.js`: the limiter.
- `tests/unit/rate-limit.test.js`: window and boundary behavior. There's no statistical timing test; the comparisons and delay are verified by reading, not measurement.

---

## See also

- [`THREAT_MODEL.md`](../../THREAT_MODEL.md): `T-A1-I1` and `CC-9: timing attacks on email auth`.
- [`csrf.md`](csrf.md): companion auth-flow defense.
