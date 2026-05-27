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

Set in `lib/router.js` on every HTML response:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-<128-bit-random>';
  style-src 'self' 'nonce-<128-bit-random>';
  img-src 'self' data: <tile-host>;
  connect-src 'self';
  font-src 'self';
  frame-ancestors 'none';
  base-uri 'none';
  object-src 'none';
  form-action 'self';
  upgrade-insecure-requests;
```

Notes:

- **No `unsafe-inline`.** Inline scripts and styles must carry the per-request nonce. The nonce is fresh per request, so an attacker who captures a page's HTML cannot precompute a script that would be allowed on the next request.
- **No `unsafe-eval`.** No `eval`, no `new Function(...)`, no `setTimeout('string', ...)` in our codebase or any allowed inline script.
- **No wildcards.** Every source is explicit.
- **`frame-ancestors 'none'`** stops click-jacking by refusing to be embedded in any iframe.
- **`base-uri 'none'`** stops `<base href="evil.example.com/">` injection.
- **`object-src 'none'`** stops Flash/Java/`<embed>` content.
- **`form-action 'self'`** stops a hijacked page from `<form action="evil...">`.
- **`img-src` includes the tile host** because the slippy-map renderer fetches tiles from there (or from `'self'` if the operator enables the tile proxy — recommended). `data:` is allowed for inline raster icons in the UI.

The nonce is produced by `crypto.randomBytes(16).toString('base64')` per request, and applied to the literal string `nonce-` in the header plus to the `nonce` attribute on every `<script>` and `<style>` element the template emits. Search `lib/router.js` for `cspNonce`.

### What CSP does NOT defend against

- Stored data that isn't rendered as HTML (e.g., a CSV export of contact info). CSP applies to HTML pages; CSV exports are TSV-quoted at write.
- Attacks against the browser itself (Spectre, GPU pixel leaks). Out of scope (see [`THREAT_MODEL.md`](../../THREAT_MODEL.md) residual risks).
- A vulnerability in our HTML template that produces `<script nonce="<correct-nonce>">attacker stuff</script>`. That would require the template author to explicitly opt out via `raw()` AND include the nonce, which is essentially "we wrote an XSS by hand." Layer 1 + the `raw()` audit (Layer 3) catch this.

### Reporting

In production we set `Content-Security-Policy-Report-Only: ...; report-to default` *in addition* to the enforcing header, with `report-to` pointing at `/csp-report`. Violations are written to the audit log. Spike in reports → investigate. (No third-party CSP reporting service; the report endpoint is on our origin.)

---

## Layer 3 — `raw()` opt-out

`raw(string)` produces a value that the `html\`\`` template will splice in unescaped.

Use cases (the only ones currently in the codebase):

- The deployment logo SVG, after server-side sanitisation.
- The user's avatar SVG, after the same sanitiser.
- Computed HTML produced by another `html\`\`` call (which is already safe — but `raw()` makes the trust explicit at the call site).

**Every `raw()` call in `lib/`, `routes/`, and templates is reviewed.** A new `raw()` call requires a security-impact note on the PR (see [`CONTRIBUTING.md`](../../CONTRIBUTING.md)). Reviewers grep for `raw\(` on every PR touching templates.

### The SVG sanitiser

`lib/svgSanitise.js` (or whatever the current name is — see `lib/` listing in [`docs/code-reading-guide.md`](../code-reading-guide.md)). Strips:

- `<script>` elements.
- `<foreignObject>` elements (can carry HTML).
- All event-handler attributes (`onload`, `onclick`, `on*`).
- All `xlink:href` and `href` attributes whose value is not a same-document fragment (`#foo`).
- All CSS containing `expression(...)`, `url(http*)`, or `behavior:`.
- All `<style>` elements (we route style through nonced `<style>` in the template, not embedded in SVG).

The sanitiser is allowlist-based: only a fixed set of SVG element and attribute names pass through. Everything else is dropped.

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
- `lib/svgSanitise.js` — the SVG sanitiser.
- `tests/html.test.js` — escape vectors including the OWASP XSS cheat sheet payloads.

---

## See also

- [`csrf.md`](csrf.md) — CSRF would matter less if XSS were possible; both must be defended.
- [`audit-tampering.md`](audit-tampering.md) — every CSP violation report goes to the audit log.
- [`THREAT_MODEL.md`](../../THREAT_MODEL.md) — `CC-6: XSS via SVG logo`, `CC-7: CSP bypass`.
