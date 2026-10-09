// @ts-check
/**
 * Map page: Leaflet-based interactive map with venue + meetups + ride pins.
 *
 * No data fetched client-side — pins are rendered server-side into a JSON
 * <script> tag and read by /map.js. Style switcher is a query param + form.
 */

import { config } from "../lib/config.js";
import { getEventConfig } from "../lib/event-config.js";
import { html, jsonScriptSafe, layout, raw } from "../lib/html.js";
import { buildMapData } from "../lib/map-data.js";
import { listStyles } from "../lib/map-styles.js";
import { get } from "../lib/router.js";

get("/map", async (ctx) => {
  if (!ctx.user) {
    ctx.redirect("/");
    return;
  }
  const event = getEventConfig();
  const styles = listStyles();
  const { mapData, requested, style, meetupPins, venuePin, ridePins } = buildMapData(
    ctx.query.style,
  );

  ctx.html(
    layout({
      title: "Map",
      user: ctx.user,
      path: ctx.pathname,
      children: html`
        <section class="page-head">
          <div>
            <h1>Map</h1>
            <p class="muted">
              ${ridePins.length} ride pin${ridePins.length === 1 ? "" : "s"} ·
              ${meetupPins.length} meetup${meetupPins.length === 1 ? "" : "s"}
              ${venuePin ? html` · venue ${venuePin.name}` : ""}
            </p>
          </div>
          <form method="get" action="/map" class="row">
            <label class="row-tight">
              <span class="muted small">Style</span>
              <select name="style" data-autosubmit>
                ${styles.map(
                  (s) =>
                    html`<option value="${s.key}" ${requested === s.key ? "selected" : ""}>${s.label}</option>`,
                )}
                ${
                  event.map?.customTileUrl
                    ? html`<option value="custom" ${requested === "custom" ? "selected" : ""}>Custom (config)</option>`
                    : ""
                }
              </select>
            </label>
            <noscript><button type="submit" class="button">Apply</button></noscript>
          </form>
        </section>

        <div id="map" class="map-canvas" role="region" aria-label="Map of rides and meetups"></div>

        <p class="map-attribution-note muted small">
          Map by ${raw(style.attribution)}.
          ${style.description ? html` · ${style.description}` : ""}
        </p>

        <details class="card">
          <summary><strong>Legend</strong></summary>
          <ul class="legend-list">
            <li><span class="pin pin-venue"></span> Venue</li>
            <li><span class="pin pin-meetup"></span> Pre-defined meetup</li>
            <li><span class="pin pin-offer"></span> Ride being offered</li>
            <li><span class="pin pin-request"></span> Ride being requested</li>
          </ul>
        </details>

        <script id="map-data" type="application/json">${raw(jsonScriptSafe(mapData))}</script>
        <script src="/map.js" defer></script>
      `,
    }),
  );
});

// ── Map-first shell ─────────────────────────────────────────────────────────
// Signed-in users land on a full-screen map; every other page opens in a
// slide-out panel (public/shell.js) and still renders on its own without JS.

get("/map/data.json", async (ctx) => {
  if (!ctx.user) {
    ctx.json({ error: "sign in" }, 401);
    return;
  }
  ctx.res.setHeader("Cache-Control", "no-store");
  ctx.json(buildMapData(undefined).mapData);
});

/** @param {string} href @param {string} label @param {string} icon */
const navItem = (href, label, icon) =>
  html`<a href="${href}" class="shell-nav-item"><span class="shell-nav-icon" aria-hidden="true">${icon}</span><span>${label}</span></a>`;

/**
 * Render the map-first page. `?panel=/path` opens that page in the panel.
 * @param {import("../lib/router.js").RouteCtx} ctx
 */
export function renderShell(ctx) {
  const user = /** @type {NonNullable<typeof ctx.user>} */ (ctx.user);
  const event = getEventConfig();
  const { mapData } = buildMapData(undefined);
  const logo = event.brand?.logoPath || null;
  ctx.html(
    layout({
      title: "Map",
      user,
      path: "/",
      shell: true,
      speculation: false,
      children: html`
        <div id="map" class="shell-map" role="region" aria-label="Map of the venue, rides and meetup points"></div>
        <script type="application/json" id="map-data">${raw(jsonScriptSafe(mapData))}</script>

        <header class="shell-top">
          <a href="/" class="shell-brand">
            ${logo ? html`<img src="${logo}" alt="" class="shell-logo">` : ""}
            <span class="shell-brand-text"><strong>${event.name}</strong><span>Rideshare</span></span>
          </a>
          <div class="shell-filters" role="group" aria-label="Show on the map">
            <button type="button" class="chip" data-layer="offer" aria-pressed="true"><span class="dot dot-offer"></span>Offers</button>
            <button type="button" class="chip" data-layer="request" aria-pressed="true"><span class="dot dot-request"></span>Requests</button>
            <button type="button" class="chip" data-layer="group" aria-pressed="true"><span class="dot dot-group"></span>Groups</button>
            <button type="button" class="chip" data-layer="meetup" aria-pressed="true"><span class="dot dot-meetup"></span>Meetups</button>
            <button type="button" class="chip" data-layer="people" aria-pressed="true"><span class="dot dot-people"></span>People</button>
          </div>
          ${config.demoMode ? html`<a href="/demo" class="shell-live"><span class="live-dot"></span>Live demo · tour</a>` : ""}
        </header>

        <nav class="shell-nav" aria-label="Primary">
          ${navItem("/rides", "Rides", "≡")}
          ${navItem("/rides/mine", "Mine", "◎")}
          ${navItem("/arrivals", "Arrivals", "⇣")}
          ${navItem("/trust", "Trust", "✓")}
          ${navItem("/verify", "Verify", "⌕")}
          ${navItem("/trust/didcomm", "DIDComm", "⇄")}
          ${user.isAdmin ? navItem("/admin", "Admin", "⚙") : ""}
          <form method="post" action="/auth/signout" class="shell-signout">
            <button type="submit" class="shell-nav-item"><span class="shell-nav-icon" aria-hidden="true">⎋</span><span>Sign out</span></button>
          </form>
        </nav>

        <a href="/rides/new" class="shell-fab"><span aria-hidden="true">+</span> Post a ride</a>
        <button type="button" class="shell-share" aria-pressed="false" title="Only your matched ride partners can see it">
          <span class="share-dot" aria-hidden="true"></span><span class="share-label">Share my location</span>
        </button>

        <aside id="panel" class="panel" hidden role="dialog" aria-modal="false" aria-labelledby="panel-title">
          <div class="panel-head">
            <button type="button" class="panel-grip" aria-label="Expand or shrink the panel"></button>
            <h2 id="panel-title" class="panel-title"></h2>
            <button type="button" class="panel-close" aria-label="Close panel">×</button>
          </div>
          <div class="panel-body" tabindex="-1"></div>
        </aside>

        <noscript><p class="shell-noscript">The map needs JavaScript. <a href="/rides">Browse rides as a list</a>.</p></noscript>
        <script src="/map.js" defer></script>
        <script src="/trust.js" defer></script>
        <script src="/shell.js" defer></script>
      `,
    }),
  );
}
