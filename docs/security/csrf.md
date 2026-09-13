# CSRF defense

> What CSRF protection **rideshare** uses, and why. Audience: reviewers asking "where is the CSRF token?"

Short answer: three layers — `SameSite=Lax` cookies, a `form-action 'self'` CSP
directive, and a signed double-submit token on the admin write routes. The token
is opt-in per route, so the layer that covers *every* write is `SameSite`; the
token is what covers the residual cookie-injection vector on the routes that
matter most.

---

## The threat

A cross-site request forgery attack lures an authenticated victim to a page on `evil.example.com` that submits a form (or fires `fetch`) to `rides.event.example.com`. If the browser auto-attaches the session cookie, the request runs with the victim's privileges.

Targets in our app: post a ride, claim a ride, cancel a ride, update profile, import a credential, request a credential. Anything that mutates state — and, with the widest blast radius, the `/admin` routes that wipe the allowlist or edit the banner.

---

## Defense layer 1 — `SameSite=Lax` cookies

Set in `lib/auth.js` when the session cookie is issued, and in `lib/router.js`
for the CSRF cookie:

```
Set-Cookie: rs_session=<opaque>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=...
Set-Cookie: rs_csrf=<nonce>; Path=/; HttpOnly; Secure; SameSite=Lax
```

`Secure` is attached only when `APP_URL` is `https://`, so local HTTP development still works.

`SameSite=Lax` means the browser only attaches the cookie to:

- Same-site requests (origin matches), and
- Top-level GETs from a cross-site context (clicking a link).

It does **not** attach the cookie to:

- Cross-site `POST`, `PUT`, `PATCH`, `DELETE`, `fetch`, `XMLHttpRequest`.
- Cross-site form submissions targeting our origin.
- `<img src>` or `<script src>` (those have always been cookie-attaching but we don't do anything privileged on GET, and our state-changing endpoints are not GET).

This kills the standard "submit a hidden form from another origin" CSRF in modern browsers (Chromium 80+, Firefox 96+, Safari 13+).

We do **not** use `SameSite=Strict` because it breaks the magic-link flow: clicking the link in an email is a top-level cross-site GET to our origin, and `Strict` would refuse to attach the (newly created) session cookie.

### Why not `SameSite=None`?

`None` removes the protection entirely. Used only for legitimate cross-site contexts (embedded widgets, OAuth pop-ups). We have neither.

---

## Defense layer 2 — `form-action 'self'`

The CSP emitted by `securityHeaders()` in `lib/router.js` includes `form-action 'self'`.
That is the reverse direction of the same threat: it stops a page on *our* origin
from submitting a form to an attacker's origin, which is the exfiltration half of
an XSS-plus-CSRF chain. `frame-ancestors 'none'` in the same header blocks the
click-jacking variant.

There is **no** `Origin`/`Referer` check on writes. An earlier revision of this
document described one; it was never implemented. `SameSite=Lax` covers the same
browsers for the same vector, and a header check would need a matching exemption
list for the non-browser callers in the test suite. If it is ever added it belongs
in `dispatch()` in `lib/router.js`, applied to every non-idempotent method.

---

## Defense layer 3 — signed double-submit token on `/admin` writes

`lib/router.js` exports `csrfProtected(handler)`. Every POST handler in
`routes/admin.js` is wrapped in it, and every admin form renders `ctx.csrfField()`.

The token is **not** a bare copy of the cookie:

```
Cookie:  rs_csrf=<nonce>                     32 random bytes, base64url
Field:   _csrf=<nonce>.<sig>                 sig = HMAC-SHA256(sessionSecret, `${sessionId}.${nonce}`)
```

Plain double-submit trusts the cookie jar, and the cookie jar is shared across a
registrable domain: a sibling subdomain (`blog.example.com`) can write `rs_csrf`
for `.example.com`, then submit the matching field. It cannot produce `sig`,
because that needs `SESSION_SECRET`. Binding `sig` to the session id additionally
stops one signed-in user replaying their own token into someone else's session.

Validation, in `csrfProtected`:

1. The cookie nonce must be a value this server could have minted — decided by
   base64url-decoding it and checking it re-encodes to itself, not by matching a
   pattern. A lenient decoder plus a strict re-encode rejects stray characters,
   padding, and multibyte input structurally.
2. The submitted field must equal `<nonce>.<sig>` recomputed from that cookie and
   the *current* session id, compared with `safeEqual`.

`safeEqual` encodes both sides to UTF-8 before comparing lengths, so a submitted
value of any shape returns `false` rather than raising. Comparing `String.length`
instead would let a 43-character multibyte string reach `timingSafeEqual` with
mismatched buffers and throw — a 500 where a 403 belongs. Pinned by
`tests/e2e/admin-csrf.test.js` and `tests/unit/crypto-helpers.test.js`.

### Why opt-in rather than global

Two POST routes deliberately carry no token: `/auth/signout`, whose form renders
into every layout including pages served to signed-out visitors, and
`/rides/:id/confirm`, which is a `fetch()` from `public/app.js`. Wrapping the
router's whole POST path would break both. `tests/e2e/admin-csrf.test.js` crawls
the admin dashboard's subnav rather than a hardcoded path list, so a new admin
page cannot be added without the test reaching its forms.

### Token lifetime

The cookie is minted only when absent or unrecognisable, so two tabs do not
invalidate each other. It is not rotated per form or per request.

---

## What about JSON APIs?

`routes/trust.js` takes JSON on `/trust/bind/challenge`, `/trust/bind`,
`/trust/import`, `/trust/import-bundle`, and `/trust/verify`.

An earlier revision of this document claimed `Content-Type: application/json` is
required on these, and that the resulting CORS preflight is what stops a
cross-site submission. **Neither is true.** `ctx.jsonBody()` in `lib/router.js`
parses the raw body whatever the content type says, and `/trust/verify`
deliberately accepts a form post as well (`routes/trust.js:368`) so that a
third-party verifier can use either. A cross-site form can send
`Content-Type: text/plain` with a JSON-shaped body as a simple request, with no
preflight to fail.

What actually protects these routes is layer 1: they all require a session, and
`SameSite=Lax` keeps `rs_session` off a cross-site POST, so a forged request
arrives unauthenticated. No `Access-Control-Allow-Origin` is sent for them, so a
scripted cross-origin `fetch` cannot read a response either. (`/.well-known/*`
does send `Access-Control-Allow-Origin: *`, but it is GET-only and serves public
DID documents.)

Requiring a content type on the four bind/import routes would add a second layer
here — `/trust/verify` would have to stay dual-mode. Not done; see
[`THREAT_MODEL.md`](../../THREAT_MODEL.md).

---

## What's still possible

- **Any non-`/admin` write, against a browser that ignores `SameSite`.** Those routes have no token: everything in `routes/rides.js`, `routes/trust.js`, and `/auth/send`. Pre-2020 browsers only.
- **A logged-in attendee opening a tab to evil.example.com** that displays a screenshot of a phishing page asking them to copy-paste a magic link. CSRF defense doesn't help; user education does.
- **Browser extensions with full-page access** can bypass `SameSite` from inside the privileged extension context. Out of scope (CC entry in [`THREAT_MODEL.md`](../../THREAT_MODEL.md)).
- **XSS on our own origin** defeats the token: a script on our page can read the rendered field. See [`xss.md`](xss.md).

---

## See also

- [`THREAT_MODEL.md`](../../THREAT_MODEL.md) — full enumeration.
- [`xss.md`](xss.md) — companion defense; XSS would defeat token-based CSRF.
- [`docs/code-reading-guide.md`](../code-reading-guide.md) — `lib/router.js` is where this is implemented.
