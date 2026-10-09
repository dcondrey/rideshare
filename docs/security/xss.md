# XSS defense

How **rideshare** keeps user content from executing as script. For reviewers.

Three layers:

1. **Auto-escaping `html` tagged template**: default for every page.
2. **Strict CSP**: blocks what slips past escaping.
3. **`raw()` opt-out**: explicit, reviewed, narrow.

---

## Layer 1: `html` tagged template

`lib/html.js`, used by every HTML route.

```js
import { html, raw } from '../lib/html.js'

return html`
  <h1>Hello, ${user.displayName}</h1>
  <p>Your bio: ${user.bio}</p>
`
```

Every `${...}` goes through `escapeHtml` (`& < > " '`). No context detection; double-quoted attributes plus escaped `"` make text and attribute positions safe.

### What does NOT get escaped

- `raw()` values (Layer 3).
- Results of other `html` calls (and arrays of them), already escaped, so templates compose:

  ```js
  const item = (r) => html`<li>${r.title}</li>`
  return html`<ul>${rides.map(item)}</ul>`
  ```

### What the template does not catch

The template only escapes. It does not detect:

- Interpolation in attribute-name position (`<div ${attr}="...">`) or event-handler names (`<div on${name}="...">`).
- `javascript:` URLs in attribute values.

Don't interpolate attribute names. CSP (no `unsafe-inline`) blocks `javascript:` URL execution.

---

## Layer 2: Strict Content Security Policy

From `lib/router.js`:

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

- **No `unsafe-inline`, no nonce** (no `cspNonce` exists). `'inline-speculation-rules'` allows only `<script type="speculationrules">`; a nonce would have to reach every `<script src>` in `routes/` for one JSON block.
- **No `unsafe-eval`.** No `eval`, `new Function(...)`, or `setTimeout('string', ...)`.
- **Only wildcard is `img-src https:`**: map tiles come from whichever provider `event.config.yaml` names. `data:` is for inline raster icons.
- `frame-ancestors 'none'`: no framing (click-jacking).
- `base-uri 'self'`: no `<base href="evil.example.com/">`.
- `object-src 'none'`: no Flash/Java/`<embed>`.
- `form-action 'self'`: no `<form action="evil...">`.

Headers are set once in `dispatch()` (`lib/router.js`) before the handler, so direct `ctx.res` writers (all of `routes/static.js`) get them. Handlers can tighten afterwards: `/logo` serves operator-uploaded bytes unauthenticated and sets `default-src 'none'`.

### What CSP does NOT defend against

- Data not rendered as HTML (e.g. CSV export of contact info). CSV exports are TSV-quoted at write.
- Browser-level attacks (Spectre, GPU pixel leaks). Out of scope ([`THREAT_MODEL.md`](../../THREAT_MODEL.md) residual risks).
- Attacker markup inside a `<script>` block. That needs a `raw()` opt-out, which Layer 3 review covers.

### Reporting

Not implemented: no `Content-Security-Policy-Report-Only`, no `/csp-report`. Violations show only in the visitor's console. An endpoint would need a body cap and rate limit (unauthenticated).

---

## Layer 3: `raw()` opt-out

`raw(string)` is spliced in unescaped. Current uses:

- JSON in `<script type="application/ld+json">` or `type="speculationrules"` blocks, escaped for that context by `jsonScriptSafe()` (`lib/html.js`).
- The tile provider attribution from `event.config.yaml`: operator config, not user input (`routes/map.js`).
- HTML from another `html` call, wrapped to make the trust explicit.

No uploaded image is ever spliced in as markup.

New `raw()` calls need a security-impact note on the PR ([`CONTRIBUTING.md`](../../CONTRIBUTING.md)); reviewers grep for `raw\(` on template changes.

### SVG uploads: refused, not sanitised

No SVG sanitiser, on purpose. `ALLOWED_LOGO_MIMES` in `lib/assets.js` is `image/png`, `image/webp`, `image/jpeg`; SVG is rejected at upload.

SVG is executable, and `/logo` is unauthenticated: opened directly it's a same-origin document whose inline script `script-src 'self'` allows. A sanitiser bets on covering every future vector; refusing costs one PNG export.

---

## Other response headers

- `X-Content-Type-Options: nosniff`: no sniffing JSON as HTML.
- `X-Frame-Options: DENY`: older form of `frame-ancestors 'none'`.
- `Referrer-Policy: same-origin`: keeps our paths out of external referers.
- `Permissions-Policy`: denies powerful features (`camera=()`, `microphone=()`, `payment=()`, and others). `geolocation=(self)` and `screen-wake-lock=(self)` are allowed for opt-in live location.

---

## Where to look

- `lib/html.js`: template and escaping.
- `lib/router.js`: CSP and other headers.
- `lib/assets.js`: upload mime allowlist.
- `tests/unit/html.test.js`: escape vectors.

---

## See also

- [`csrf.md`](csrf.md): XSS defeats token-based CSRF; both need defending.
- [`audit-tampering.md`](audit-tampering.md): audit-log integrity.
- [`THREAT_MODEL.md`](../../THREAT_MODEL.md): `CC-6: XSS via SVG logo`, `CC-7: CSP bypass`.
