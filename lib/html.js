// @ts-check
/**
 * HTML template helpers.
 *
 * `html` is a tagged template literal that auto-escapes interpolations.
 * Use `raw(s)` to opt out for already-safe HTML chunks.
 *
 *   const greeting = html`<p>Hello ${userInput}!</p>`;   // userInput escaped
 *   const block    = html`<div>${raw(otherTemplate)}</div>`;  // otherTemplate trusted
 */

import { hasLogo } from "./assets.js";
import { getBanner } from "./banner.js";
import { getEventConfig } from "./event-config.js";

const RAW = Symbol("raw-html");

/**
 * @typedef {{ [RAW]: string }} RawHtml
 */

/**
 * Mark a value as already-safe HTML (will not be escaped when interpolated).
 * Strings pass through verbatim — that's the whole point of raw().
 * @param {string | RawHtml | (string|RawHtml)[]} value
 * @returns {RawHtml}
 */
export function raw(value) {
  if (Array.isArray(value)) return { [RAW]: value.map(toRawString).join("") };
  return { [RAW]: toRawString(value) };
}

/** Used by raw(): no escaping — trust the input. */
function toRawString(v) {
  if (v == null || v === false) return "";
  if (typeof v === "object" && v !== null && RAW in v) {
    return /** @type {RawHtml} */ (v)[RAW];
  }
  return String(v);
}

/**
 * Used by html``: escapes plain strings, passes RawHtml through, joins arrays.
 * This is the *interpolator* — different from raw(): it defaults to escape.
 * @param {unknown} v
 */
function rawString(v) {
  if (v == null || v === false) return "";
  if (Array.isArray(v)) return v.map(rawString).join("");
  if (typeof v === "object" && v !== null && RAW in v) {
    return /** @type {RawHtml} */ (v)[RAW];
  }
  return escapeHtml(String(v));
}

/**
 * Escape a string for safe insertion into HTML text or attributes
 * (use double-quoted attributes).
 * @param {string} s
 */
export function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Tagged template: returns RawHtml. Interpolated values are escaped unless
 * they are themselves RawHtml or arrays thereof.
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 */
export function html(strings, ...values) {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += rawString(values[i]);
  }
  return /** @type {RawHtml} */ ({ [RAW]: out });
}

// Regex literals can't contain raw U+2028 / U+2029 (they terminate JS source
// lines), so we build the patterns from explicit escape sequences.
const LS = /\u2028/g;
const PS = /\u2029/g;

/**
 * JSON-encode for safe insertion into a `<script>` data block — JSON-LD,
 * speculation rules, or the map's `application/json` payload. The content of a
 * script element is raw text, so `</script` and friends must not survive
 * verbatim; U+2028/U+2029 are escaped because they are line terminators in a
 * JavaScript source context.
 * @param {unknown} obj
 */
export function jsonScriptSafe(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LS, "\\u2028")
    .replace(PS, "\\u2029");
}

/**
 * Render a RawHtml (or string) as a final HTML string.
 * @param {RawHtml | string} value
 */
export function render(value) {
  if (typeof value === "string") return value;
  return value[RAW];
}

/**
 * Speculation rules for signed-in navigation. `prefetch` only: it fetches the
 * document and nothing more, so it is safe on pages behind auth. `prerender`
 * would run the target page's scripts and is reserved for `/` → `/about`,
 * where both pages are public and side-effect-free.
 *
 * Two exclusions, each for a link that actually exists in the markup:
 *   - `/admin/*` runs the aggregate queries behind /admin/insights, and a
 *     hover should not pay for them. This also covers /admin/insights.csv.
 *   - `.json` covers /trust/credentials.json and /.well-known/did.json, which
 *     are download links; prefetching the first builds a credential payload
 *     nobody asked for.
 */
const APP_SPECULATION = {
  prefetch: [
    {
      source: "document",
      where: {
        and: [
          { href_matches: "/*" },
          { not: { href_matches: "/admin/*" } },
          { not: { href_matches: "/*.json" } },
        ],
      },
      eagerness: "moderate",
    },
  ],
};

/**
 * Page layout — full HTML document with header/nav/footer.
 *
 * `indexable` defaults to false: all but two routes are session-gated, so the
 * safe default is `noindex`. `/` and `/about` opt in. `jsonLd` and `og` are
 * only ever passed by those two for the same reason — structured data must
 * describe what the visitor can actually see on the page. lib/seo.js builds it
 * and carries the reasoning.
 *
 * @param {{
 *   title: string,
 *   user?: { email: string, isAdmin: boolean } | null,
 *   description?: string,
 *   children: RawHtml | string,
 *   flash?: { type: 'success'|'error'|'info', message: string } | null,
 *   path?: string,
 *   indexable?: boolean,
 *   jsonLd?: unknown,
 *   og?: Record<string, string> | null,
 *   speculation?: unknown,
 * }} args
 */
export function layout({
  title,
  user = null,
  description,
  children,
  flash = null,
  path = "",
  indexable = false,
  jsonLd = null,
  og = null,
  speculation = null,
}) {
  // Signed-in pages get link prefetching by default; `speculation: false`
  // opts a page out, and an explicit object overrides the default.
  const rules = speculation === null && user ? APP_SPECULATION : speculation;
  const event = getEventConfig();
  const banner = getBanner();
  // Prefer an admin-uploaded logo (served from /logo, stored in DB) over the
  // event.config.yaml#brand.logoPath setting.
  const logoSrc = hasLogo() ? "/logo" : event.brand?.logoPath || null;
  /** @param {string} href @param {string} label */
  const navLink = (href, label) =>
    path === href
      ? html`<a href="${href}" aria-current="page">${label}</a>`
      : html`<a href="${href}">${label}</a>`;
  return render(html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>${title} · ${event.name}</title>
  ${description ? html`<meta name="description" content="${description}">` : ""}
  <meta name="referrer" content="same-origin">
  ${indexable ? "" : html`<meta name="robots" content="noindex, nofollow">`}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/brand.css">
  ${og ? metaTags(og) : ""}
  ${jsonLd ? html`<script type="application/ld+json">${raw(jsonScriptSafe(jsonLd))}</script>` : ""}
  ${rules ? html`<script type="speculationrules">${raw(jsonScriptSafe(rules))}</script>` : ""}
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="container header-inner">
      <a href="/" class="brand">
        ${logoSrc ? html`<img src="${logoSrc}" alt="" class="brand-logo">` : ""}
        <span class="brand-name">${event.name}</span>
        <span class="brand-sub">Rideshare</span>
      </a>
      <nav class="primary-nav" aria-label="Primary">
        ${
          user
            ? html`
                ${navLink("/rides", "Browse")}
                ${navLink("/map", "Map")}
                ${navLink("/rides/new", "Post a ride")}
                ${navLink("/rides/mine", "My rides")}
                ${navLink("/trust", "Trust")}
                ${user.isAdmin ? navLink("/admin", "Admin") : ""}
                <form method="post" action="/auth/signout" class="signout-form">
                  <button type="submit" class="link-button">Sign out</button>
                </form>
              `
            : html`<a href="/">Sign in</a>`
        }
      </nav>
    </div>
  </header>

  ${
    banner
      ? html`<div class="flash flash-${banner.severity}" role="status"><div class="container">${banner.message}</div></div>`
      : ""
  }
  ${
    flash
      ? html`<div class="flash flash-${flash.type}" role="status"><div class="container">${flash.message}</div></div>`
      : ""
  }

  <main id="main" class="container main-content">
    ${children}
  </main>

  <footer class="site-footer">
    <div class="container">
      <p>${event.name} Rideshare · ${event.dates.start} – ${event.dates.end}</p>
      ${event.supportEmail ? html`<p>Questions? <a href="mailto:${event.supportEmail}">${event.supportEmail}</a></p>` : ""}
      <p class="footer-meta">Self-hosted, zero-dependency. <a href="/about">About</a></p>
    </div>
  </footer>
</body>
</html>`);
}

/**
 * Open Graph + X card tags. `og:*` and `article:*` use the `property`
 * attribute, everything else uses `name` — X reads either, but OG parsers
 * require `property`.
 * @param {Record<string, string>} tags
 */
function metaTags(tags) {
  const parts = Object.entries(tags)
    .filter(([, v]) => typeof v === "string" && v !== "")
    .map(([k, v]) =>
      k.startsWith("og:") || k.startsWith("article:")
        ? html`<meta property="${k}" content="${v}">`
        : html`<meta name="${k}" content="${v}">`,
    );
  return html`${parts}`;
}
