# Timing attacks

> How **rideshare** defends against timing side channels on auth and allowlist endpoints. Audience: reviewers checking the constant-time properties of comparison operations.

The two endpoints that matter:

1. **Sign-in submission** (`POST /auth/sign-in`) — leaks "is this email on the allowlist?" if not careful.
2. **Magic-link consumption** (`GET /auth/link/:token`) — leaks "is this token valid?" if not careful.

We defend with a combination of:

- Constant-time comparisons.
- Identical response shapes regardless of outcome.
- Artificial random delays sized to dominate the real timing distribution.
- Rate limits that cap how many samples an attacker can collect.

---

## Constant-time comparison

We use `crypto.timingSafeEqual(Buffer, Buffer)` everywhere we compare:

- A user-submitted magic-link token to a stored token.
- An HMAC of the user's email to a stored allowlist HMAC.
- A session ID to a stored session row's ID.
- A signed-challenge response (Ed25519 signature) to the expected verification result.

The function returns in time independent of the position of the first differing byte. Inputs must be the same length; we enforce length equality structurally (the magic-link token is fixed-width, the HMAC output is fixed-width).

Where we *don't* use it: comparisons of trusted-vs-trusted values (e.g., comparing two configuration constants), and comparisons whose result is not security-sensitive. Code review checklist requires `timingSafeEqual` on any comparison whose left side comes from a request.

### What `timingSafeEqual` does NOT solve

- The time it takes to **fetch** the row from the DB. If "user not found" returns from a missing-row check faster than "user found, then comparison fails," the timing channel is open. We mitigate by always doing the full lookup-and-compare, with a sentinel HMAC value used when no row exists. See "Identical response shapes" below.
- The time it takes to **compute** the HMAC of the submitted email. HMAC-SHA-256 over a short string is itself essentially constant-time on modern CPUs, but we still do it unconditionally before the lookup, to keep the per-request work uniform.

---

## Identical response shapes

For `POST /auth/sign-in`:

- Status code: `200` always.
- Body: `If you are on the list, a link is on the way. Check your inbox in a minute.` always.
- Headers: identical, including content-length.

For `GET /auth/link/:token`:

- A valid token redirects to `/dashboard` with a fresh session cookie.
- An invalid token redirects to `/auth/sign-in?failed=1`.
- An already-consumed token redirects to `/auth/sign-in?failed=1`.
- A token whose stored row has expired redirects to `/auth/sign-in?failed=1`.

The three failure modes are indistinguishable from outside.

---

## Artificial random delay

In `lib/auth.js`, the sign-in handler does:

```js
await sleep(randomDelayMs())
```

Before responding, regardless of allowlist outcome.

The delay is sampled from a uniform distribution over [200ms, 600ms]. The endpoint's real work (HMAC + DB lookup + magic-link generation + email enqueue) takes O(10ms) at the tail. The added delay dominates.

**This is a probabilistic defense**, not a guarantee. A determined attacker who collects N requests can reduce the noise. Our backstop is the per-IP rate limit (5 requests / 5 minutes) and per-email rate limit (3 requests / hour). At those rates, recovering an enumeration signal would require months of probing per email — long enough that the event is over, the deployment is wiped, and the allowlist no longer exists.

For the magic-link consumption endpoint, the delay is smaller (50-150ms) because the work is more uniform and the threat is replay (which is defended by the single-use property and 10-minute TTL) rather than enumeration.

---

## Rate limits

`lib/rate.js` implements a token-bucket per key. Keys used:

- `signin:ip:<addr>` — 5 / 5 minutes.
- `signin:email:<hmac>` — 3 / hour.
- `link:ip:<addr>` — 20 / minute (so a legitimate burst from a public Wi-Fi exit IP isn't rate-limited).
- `verify:ip:<addr>` — 30 / minute on `/trust/verify`.

Exceeding the limit returns a `429` after the same artificial delay as a normal response. The response shape doesn't reveal which limit triggered.

---

## What's still possible

- **Network-level timing.** An attacker on the same network as the server can observe TCP/TLS round-trip timing more precisely than from the public internet. Local-network adversaries are rare for our deployments (cloud VMs) but the operator should not host on a shared LAN with untrusted parties.
- **Email delivery latency.** A clever attacker who controls the recipient's email inbox can observe whether a magic-link email arrived, regardless of HTTP-level masking. Mitigation: the deployment's `MAIL_FROM` should be a domain the operator controls and the attacker doesn't.
- **Side channels via cache eviction.** Theoretical at the scale we operate. Not modeled.
- **Time spent in the email provider's API.** A misbehaving email provider that takes 2s for one address and 200ms for another would leak. We send the email asynchronously after responding, so provider latency does not appear in our response timing.

---

## Where to look

- `lib/auth.js` — the sign-in handler, the link consumption handler, the artificial delay.
- `lib/allowlist.js` — the HMAC-then-`timingSafeEqual` flow.
- `lib/rate.js` — the limiter.
- `tests/auth.test.js` — includes a statistical test that the in-vs-out-of-allowlist response time distributions overlap within a tolerance.

---

## See also

- [`THREAT_MODEL.md`](../../THREAT_MODEL.md) — `T-A1-I1` and `CC-9: timing attacks on email auth`.
- [`csrf.md`](csrf.md) — companion auth-flow defense.
