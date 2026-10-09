# CSRF defense

CSRF protection in **rideshare**, for reviewers asking "where is the CSRF token?"

Three layers:

1. `SameSite=Lax` cookies: cover every write.
2. CSP `form-action 'self'`.
3. Signed double-submit token: opt-in per route, on admin writes, covering cookie injection.

---

## The threat

A page on `evil.example.com` posts to `rides.event.example.com` with the victim's cookie. Targets: ride, profile and credential writes; worst case, `/admin` routes that wipe the allowlist or edit the banner.

---

## Defense layer 1: `SameSite=Lax` cookies

Set in `lib/auth.js` (session) and `lib/router.js` (CSRF cookie):

```
Set-Cookie: rs_session=<opaque>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=...
Set-Cookie: rs_csrf=<nonce>; Path=/; HttpOnly; Secure; SameSite=Lax
```

`Secure` only when `APP_URL` is `https://`, so local HTTP works.

| Cookie attached | Cookie not attached |
|---|---|
| Same-site requests | Cross-site `POST`, `PUT`, `PATCH`, `DELETE`, `fetch`, `XMLHttpRequest` |
| Top-level cross-site GET (clicking a link) | Cross-site form submissions to our origin |
| | `<img src>` / `<script src>` (we do nothing privileged on GET) |

Stops hidden-form CSRF in Chromium 80+, Firefox 96+, Safari 13+.

Not `Strict`: the magic link is a top-level cross-site GET and would lose the new session cookie.

### Why not `SameSite=None`?

No protection; only for embedded widgets or OAuth pop-ups, which we don't have.

---

## Defense layer 2: `form-action 'self'`

`securityHeaders()` in `lib/router.js` sets `form-action 'self'` (no posting from our origin to an attacker's, the exfiltration half of XSS-plus-CSRF) and `frame-ancestors 'none'` (click-jacking).

There is **no** `Origin`/`Referer` check on writes (an earlier revision claimed one). `SameSite=Lax` covers the same browsers, and a check would need test exemptions. If added, it goes in `dispatch()` in `lib/router.js` for every non-idempotent method.

---

## Defense layer 3: signed double-submit token on `/admin` writes

`lib/router.js` exports `csrfProtected(handler)`. Every POST handler in `routes/admin.js` uses it, and every admin form renders `ctx.csrfField()`.

The field is signed, not a copy of the cookie:

```
Cookie:  rs_csrf=<nonce>                     32 random bytes, base64url
Field:   _csrf=<nonce>.<sig>                 sig = HMAC-SHA256(sessionSecret, `${sessionId}.${nonce}`)
```

A sibling subdomain (`blog.example.com`) can set `rs_csrf` for `.example.com` but can't produce `sig` without `SESSION_SECRET`. Session binding stops replay into another session.

Validation in `csrfProtected`:

1. The cookie nonce must be one this server could have minted: base64url-decode and check it re-encodes identically (rejects stray characters, padding and multibyte input structurally, no regex).
2. The field must equal `<nonce>.<sig>` recomputed from the cookie and the *current* session id, compared with `safeEqual`.

`safeEqual` compares UTF-8 byte lengths, so a 43-character multibyte string returns `false` instead of making `timingSafeEqual` throw (500 instead of 403). Tested in `tests/e2e/admin-csrf.test.js` and `tests/unit/crypto-helpers.test.js`.

### Why opt-in rather than global

Two POSTs carry no token on purpose:

- `/auth/signout`: its form is in every layout, including pages for signed-out visitors.
- `/rides/:id/confirm`: a `fetch()` from `public/app.js`.

A global wrapper would break both. `tests/e2e/admin-csrf.test.js` crawls the admin subnav, so new admin pages are covered automatically.

### Token lifetime

Minted only when absent or unrecognizable, so tabs don't clash. Not rotated per request.

---

## What about JSON APIs?

`routes/trust.js` takes JSON on `/trust/bind/challenge`, `/trust/bind`, `/trust/import`, `/trust/import-bundle`, and `/trust/verify`.

An earlier revision claimed these require `Content-Type: application/json` and a CORS preflight. **Neither is true.**

- `ctx.jsonBody()` in `lib/router.js` parses the body regardless of content type.
- `/trust/verify` also accepts form posts (`routes/trust.js:368`) for third-party verifiers.
- A cross-site form can send `Content-Type: text/plain` with a JSON body as a simple request, no preflight.

Layer 1 protects them: all need a session, which `SameSite=Lax` keeps off cross-site POSTs. No `Access-Control-Allow-Origin` is sent, so cross-origin `fetch` can't read responses. (`/.well-known/*` sends `Access-Control-Allow-Origin: *` but is GET-only public DID documents.)

A content-type requirement on the four bind/import routes would add a layer. Not done; see [`THREAT_MODEL.md`](../../THREAT_MODEL.md).

---

## What's still possible

- **Non-`/admin` writes in browsers that ignore `SameSite`** (pre-2020). No token on `routes/rides.js`, `routes/trust.js`, or `/auth/send`.
- **Phishing** for a pasted magic link. Needs user education.
- **Browser extensions** with full-page access bypass `SameSite`. Out of scope (CC entry in [`THREAT_MODEL.md`](../../THREAT_MODEL.md)).
- **XSS on our origin** reads the rendered token. See [`xss.md`](xss.md).

---

## See also

- [`THREAT_MODEL.md`](../../THREAT_MODEL.md): full enumeration.
- [`xss.md`](xss.md): XSS would defeat token-based CSRF.
- [`docs/code-reading-guide.md`](../code-reading-guide.md): `lib/router.js` is where this lives.
