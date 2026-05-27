// @ts-check
/**
 * Map page: Leaflet-based interactive map with venue + meetups + ride pins.
 *
 * No data fetched client-side — pins are rendered server-side into a JSON
 * <script> tag and read by /map.js. Style switcher is a query param + form.
 */

import { get } from "../lib/router.js";
import { layout, html, raw } from "../lib/html.js";
import { getEventConfig } from "../lib/event-config.js";
import { listMeetups } from "../lib/meetups.js";
import { listStyles, resolveStyle } from "../lib/map-styles.js";
import { browseRides } from "../lib/rides.js";

get("/map", async (ctx) => {
  if (!ctx.user) {
    ctx.redirect("/");
    return;
  }
  const event = getEventConfig();
  const styles = listStyles();
  const requested = (ctx.query.style ?? event.map?.style) || "voyager";
  const style = resolveStyle(requested, {
    customTileUrl: event.map?.customTileUrl,
    customAttribution: event.map?.customAttribution,
  });

  const meetups = listMeetups();

  // Build ride pins. Each ride is plotted at, in priority order:
  //   1. its custom pickup_lat/lng,
  //   2. its referenced meetup's coordinates,
  //   3. the airport's coordinates,
  //   4. the venue (for "from venue" rides without other location).
  const airportCoords = new Map(
    (event.airports || [])
      .filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lng))
      .map((a) => [a.code, { lat: a.lat, lng: a.lng, name: a.name }]),
  );
  const meetupCoords = new Map(
    meetups.map((m) => [m.id, { lat: m.lat, lng: m.lng, name: m.name }]),
  );
  const venueCoord =
    Number.isFinite(event.venue?.lat) && Number.isFinite(event.venue?.lng)
      ? { lat: event.venue.lat, lng: event.venue.lng, name: event.venue.name || "Venue" }
      : null;

  const ridePins = browseRides({})
    .map((r) => {
      let coord = null;
      let source = "";
      if (Number.isFinite(r.pickup_lat) && Number.isFinite(r.pickup_lng)) {
        coord = { lat: r.pickup_lat, lng: r.pickup_lng };
        source = "Custom pin";
      } else if (r.meetup_id && meetupCoords.has(r.meetup_id)) {
        const m = meetupCoords.get(r.meetup_id);
        coord = { lat: m.lat, lng: m.lng };
        source = m.name;
      } else if (airportCoords.has(r.airport)) {
        const a = airportCoords.get(r.airport);
        coord = { lat: a.lat, lng: a.lng };
        source = `${r.airport} — ${a.name}`;
      } else if (r.direction === "from_venue" && venueCoord) {
        coord = { lat: venueCoord.lat, lng: venueCoord.lng };
        source = venueCoord.name;
      }
      if (!coord) return null;
      return {
        id: r.id,
        kind: r.kind,
        direction: r.direction,
        date: r.depart_date,
        time: r.depart_time,
        seats: r.seats,
        notes: r.notes || "",
        url: `/rides/${r.id}`,
        source,
        ...coord,
      };
    })
    .filter(Boolean);

  const venuePin = venueCoord
    ? { ...venueCoord, address: event.venue?.address || "" }
    : null;
  const meetupPins = meetups.map((m) => ({
    id: m.id,
    name: m.name,
    address: m.address || "",
    lat: m.lat,
    lng: m.lng,
  }));

  const center = venueCoord ?? { lat: 37.7749, lng: -122.4194 };
  const zoom = Number.isFinite(event.map?.defaultZoom)
    ? event.map.defaultZoom
    : 11;

  const mapData = {
    center,
    zoom,
    tile: {
      url: style.url,
      subdomains: style.subdomains || [],
      attribution: style.attribution,
      maxZoom: style.maxZoom || 19,
    },
    venue: venuePin,
    meetups: meetupPins,
    rides: ridePins,
    brandColor: event.brand?.primaryColor || "#4f46e5",
  };

  ctx.html(
    layout({
      title: "Map",
      user: ctx.user,
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
              <select name="style" onchange="this.form.submit()">
                ${styles.map(
                  (s) => html`<option value="${s.key}" ${requested === s.key ? "selected" : ""}>${s.label}</option>`,
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

        <div id="map" class="map-canvas" aria-label="Map of rides and meetups"></div>

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

// Regex literals can't contain raw U+2028 / U+2029 (they terminate JS source
// lines), so we build the patterns from explicit escape sequences.
const LS = new RegExp("\\u2028", "g");
const PS = new RegExp("\\u2029", "g");

/**
 * JSON-encode for safe insertion into a <script type="application/json"> tag.
 * Replaces `<`, `>`, `&` to prevent script-tag-breaking attacks, plus the JSON
 * Line/Paragraph Separator chars (which break in JS string literals).
 */
function jsonScriptSafe(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LS, "\\u2028")
    .replace(PS, "\\u2029");
}
