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

import { getEventConfig } from "./event-config.js";
import { hasLogo } from "./assets.js";

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

/**
 * Render a RawHtml (or string) as a final HTML string.
 * @param {RawHtml | string} value
 */
export function render(value) {
  if (typeof value === "string") return value;
  return value[RAW];
}

/**
 * Page layout — full HTML document with header/nav/footer.
 *
 * @param {{
 *   title: string,
 *   user?: { email: string, isAdmin: boolean } | null,
 *   description?: string,
 *   children: RawHtml | string,
 *   flash?: { type: 'success'|'error'|'info', message: string } | null,
 * }} args
 */
export function layout({ title, user = null, description, children, flash = null }) {
  const event = getEventConfig();
  const brandColor = event.brand?.primaryColor || "#4f46e5";
  // Prefer an admin-uploaded logo (served from /logo, stored in DB) over the
  // event.config.yaml#brand.logoPath setting.
  const logoSrc = hasLogo() ? "/logo" : event.brand?.logoPath || null;
  return render(html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>${title} · ${event.name}</title>
  ${description ? html`<meta name="description" content="${description}">` : ""}
  <meta name="referrer" content="same-origin">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css">
  <style>:root { --brand: ${brandColor}; }</style>
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
                <a href="/rides">Browse</a>
                <a href="/map">Map</a>
                <a href="/rides/new">Post a ride</a>
                <a href="/rides/mine">My rides</a>
                <a href="/trust">Trust</a>
                ${user.isAdmin ? html`<a href="/admin">Admin</a>` : ""}
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
