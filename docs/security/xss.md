# XSS defense

> How **rideshare** prevents cross-site scripting. Audience: reviewers verifying that user content can never execute as script.

Three layers, in order of how often they fire:

1. **Auto-escaping `html\`\`` template** — the default for every page.
2. **Strict CSP** — server-enforced, blocks anything that slipped past escaping.
3. **`raw()` opt-out for trusted content** — explicit, audited, narrow.

A successful XSS exploit requires bypassing **all three**. Each is independently sufficient against most attacks; together they form a meaningful margin.

---

## Layer 1 — `html\`\`` tagged template

In `lib/html.js`. Used by every route that returns HTML.

```js
import { html, raw } from '../lib/html.js'

return html`
  <h1>Hello, ${user.displayName}</h1>
  <p>Your bio: ${user.bio}</p>
`
```

Every interpolated value (`${...}`) is HTML-escaped. The escape function replaces the five canonical characters: `& < > " '`. There is no "safe by context" magic; we don't try to detect "you're inside an attribute, so escape differently." The template author writes attributes with double quotes, the escaper escapes `"`, and the result is safe regardless of context (attribute, text, comment).

### What does NOT get escaped

- Values wrapped in `raw()`. By design — see Layer 3.
- Values passed through `html\`\`` themselves (nested templates). The template tracks what came from another `html\`\`` call and treats it as pre-escaped. This means you can compose templates safely:

  ```js
  const item = (r) => html`<li>${r.title}</li>`
  return html`<ul>${rides.map(item)}</ul>`
  ```

### What's not allowed

- Computed attribute names from user input (`<div ${attr}="...">`). The template throws if it sees an interpolation in attribute-name position. We avoid the entire category of "user controls the attribute name" attacks structurally.
- Computed event-handler names (`<div on${name}="...">`). Same throw.
- `javascript:` URLs. The template scans `${...}` values placed in attribute position for a leading `javascript:` and throws. (CSP would also block this, but we want the template to fail loudly during development.)

---

## Layer 2 — Strict Content Security Policy

Set in `lib/router.js` on every response that goes through `ctx.html`,
`ctx.json` or `ctx.redirect`:

```
Content-Security-Policy:
  default-src 'self';
  img-src 'self' data: https:;
  style-src 'self';
  script-src 'self' 'inline-speculation-rules';
  connect-src 'self';
  form-action 'self';
  base-uri 'self';
  object-src 'none';
  frame-ancestors 'none'
```

Notes:

- **No `unsafe-inline`, no nonce.** There is no inline script to allow:
  `'inline-speculation-rules'` permits `<script type="speculationrules">` and
  nothing executable. A nonce-based policy would mean threading a per-request
  nonce through every `<script src>` in `routes/` to buy one inline JSON block,
  so it is deliberately not used. There is no `cspNonce` in this codebase.
- **No `unsafe-eval`.** No `eval`, no `new Function(...)`, no `setTimeout('string', ...)`.
- **No wildcards, except `img-src https:`** — map tiles are fetched by the
  browser from whichever provider `event.config.yaml` names, and the provider is
  operator-configurable, so the scheme is allowed rather than a host list.
  `data:` covers inline raster icons.
- **`frame-ancestors 'none'`** stops click-jacking by refusing to be embedded in any iframe.
- **`base-uri 'self'`** stops `<base href="evil.example.com/">` injection.
- **`object-src 'none'`** stops Flash/Java/`<embed>` content.
- **`form-action 'self'`** stops a hijacked page from `<form action="evil...">`.

The header set is applied once in `dispatch()` before the handler runs
(`lib/router.js`), so a handler writing bytes straight to `ctx.res` — every
route in `routes/static.js` — gets it too. It used to be attached per response
helper, which silently exempted every static asset. A handler needing something
tighter overrides that one header afterwards: `/logo` serves operator-uploaded
bytes unauthenticated and replaces the policy with `default-src 'none'`.

### What CSP does NOT defend against

- Stored data that isn't rendered as HTML (e.g., a CSV export of contact info). CSP applies to HTML pages; CSV exports are TSV-quoted at write.
- Attacks against the browser itself (Spectre, GPU pixel leaks). Out of scope (see [`THREAT_MODEL.md`](../../THREAT_MODEL.md) residual risks).
- A vulnerability in our HTML template that produces attacker markup inside a
  `<script>` block. That requires the template author to opt out via `raw()`,
  which is what the Layer 3 audit covers.

### Reporting

Not implemented. There is no `Content-Security-Policy-Report-Only` header and no
`/csp-report` endpoint; violations are visible only in the visitor's own browser
console. Adding one means a route, a body cap, and a rate limit, since the
endpoint would be unauthenticated by definition.

---

## Layer 3 — `raw()` opt-out

`raw(string)` produces a value that the `html\`\`` template will splice in unescaped.

Use cases (the only ones currently in the codebase):

- JSON embedded in a `<script type="application/ld+json">` or
  `type="speculationrules"` block, escaped for that context by `jsonScriptSafe()`
  (`lib/html.js`).
- The tile provider's attribution string from `event.config.yaml`, which is
  operator-authored config, not user input (`routes/map.js`).
- Computed HTML produced by another `html\`\`` call (which is already safe — but `raw()` makes the trust explicit at the call site).

No uploaded image is ever spliced into a page as markup.

**Every `raw()` call in `lib/`, `routes/`, and templates is reviewed.** A new `raw()` call requires a security-impact note on the PR (see [`CONTRIBUTING.md`](../../CONTRIBUTING.md)). Reviewers grep for `raw\(` on every PR touching templates.

### SVG uploads: refused, not sanitised

There is no SVG sanitiser, and deliberately so. `ALLOWED_LOGO_MIMES` in
`lib/assets.js` is `image/png`, `image/webp`, `image/jpeg`; an SVG upload is
rejected at the boundary.

An SVG is an executable document, and `/logo` is unauthenticated: a visitor who
navigates to it directly gets it rendered as a document on this origin, where
`script-src 'self'` applies to inline script that is now same-origin. Writing a
sanitiser means betting that an allowlist covers every present and future vector
a browser will execute. Refusing the format costs an organizer one PNG export.

---

## Belt-and-braces: response headers

In addition to CSP:

- `X-Content-Type-Options: nosniff` — stops the browser from sniffing a JSON response as HTML.
- `X-Frame-Options: DENY` — older equivalent of `frame-ancestors 'none'`.
- `Referrer-Policy: same-origin` — keep our paths off external referers.
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` — disable powerful APIs we don't use.

---

## Where to look

- `lib/html.js` — the template + escape function.
- `lib/router.js` — CSP and other security headers.
- `lib/assets.js` — the upload mime allowlist.
- `tests/unit/html.test.js` — escape vectors.

---

## See also

- [`csrf.md`](csrf.md) — CSRF would matter less if XSS were possible; both must be defended.
- [`audit-tampering.md`](audit-tampering.md) — every CSP violation report goes to the audit log.
- [`THREAT_MODEL.md`](../../THREAT_MODEL.md) — `CC-6: XSS via SVG logo`, `CC-7: CSP bypass`.
