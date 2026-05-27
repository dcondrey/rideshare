# CSRF defense

> What CSRF protection **rideshare** uses, and why. Audience: reviewers asking "where is the CSRF token?"

Short answer: we use `SameSite=Lax` cookies plus an `Origin`/`Referer` check on state-changing requests. There is no hidden form token. This is a deliberate design choice; below is the reasoning.

---

## The threat

A cross-site request forgery attack lures an authenticated victim to a page on `evil.example.com` that submits a form (or fires `fetch`) to `rides.event.example.com`. If the browser auto-attaches the session cookie, the request runs with the victim's privileges.

Targets in our app: post a ride, claim a ride, cancel a ride, update profile, import a credential, request a credential. Anything that mutates state.

---

## Defense layer 1 — `SameSite=Lax` session cookies

Set in `lib/router.js` when the session cookie is issued:

```
Set-Cookie: sid=<opaque>; HttpOnly; Secure; SameSite=Lax; Path=/
```

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

## Defense layer 2 — `Origin` / `Referer` check on writes

In `lib/router.js`, every non-`GET`, non-`HEAD`, non-`OPTIONS` request is checked:

```
if request.method in (POST, PUT, PATCH, DELETE):
    if request.header.Origin or Referer not in {EVENT_HOST}:
        return 403
```

Logic:

- `Origin` is set by the browser on every `POST`/`fetch` (and is unsettable from JS, so an attacker page can't forge it).
- If `Origin` is missing (older user agent, certain redirects), fall back to `Referer`.
- If both are missing on a write, reject.

This handles the residual case of an older browser that ignores `SameSite` directives, plus a defense-in-depth layer if `SameSite` is misimplemented in some browser.

---

## Defense layer 3 — no cross-origin `fetch` from our pages

The CSP `connect-src 'self'` directive forbids our pages from initiating cross-origin requests. This isn't a CSRF defense per se but it constrains the blast radius if XSS ever happens — an injected script can't exfiltrate state to an attacker domain. See [`xss.md`](xss.md).

---

## Why no token?

Synchroniser-token CSRF defense (the classic "hidden `<input name="csrf">`") is the historical baseline. It works. We don't use it because:

1. It would require maintaining per-session token state and threading it through every form. More code, more places to forget.
2. `SameSite=Lax` + `Origin` check covers the same threat in modern browsers, with no per-form bookkeeping.
3. Tokens are vulnerable to a class of XSS-derived attacks that `Origin` is not (a script on our page can read the token; it cannot forge the `Origin` header from the browser).

If a deployment targets browsers that predate `SameSite` enforcement, switching this defense to a synchroniser token is a 50-line change to `lib/router.js` plus per-form template updates. Tracked but not planned for v0.x.

---

## What about JSON APIs?

We accept JSON on a small number of endpoints (`/trust/verify`, `/trust/import`). For these:

- `Content-Type: application/json` is required.
- A cross-site form submission cannot set that content type without a CORS preflight.
- We send no `Access-Control-Allow-Origin` header for those endpoints; the preflight will fail.
- The `Origin` check still applies as a backstop.

---

## What's still possible

- **A logged-in attendee opening a tab to evil.example.com** that displays a screenshot of a phishing page asking them to copy-paste a magic link. CSRF defense doesn't help; user education does.
- **Browser extensions with full-page access** can bypass `SameSite` and `Origin` from inside the privileged extension context. Out of scope (CC entry in [`THREAT_MODEL.md`](../../THREAT_MODEL.md)).
- **Click-jacking on a same-origin page**. Mitigated by `frame-ancestors 'none'` in CSP and `X-Frame-Options: DENY`.

---

## See also

- [`THREAT_MODEL.md`](../../THREAT_MODEL.md) — full enumeration.
- [`xss.md`](xss.md) — companion defense; XSS would defeat token-based CSRF.
- [`docs/code-reading-guide.md`](../code-reading-guide.md) — `lib/router.js` is where this is implemented.
