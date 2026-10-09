// @ts-check
/**
 * Everything the map draws, as one JSON-safe object: tile style, venue,
 * meetups and ride pins. Shared by the /map page, the map-first shell at /
 * and /map/data.json (which the shell polls to refresh pins).
 */

import { getEventConfig } from "./event-config.js";
import { resolveStyle } from "./map-styles.js";
import { listMeetups } from "./meetups.js";
import { browseRides } from "./rides.js";

/**
 * @param {string | undefined} requestedStyle  a style key, or undefined for the event default
 */
export function buildMapData(requestedStyle) {
  const event = getEventConfig();
  const requested = (requestedStyle ?? event.map?.style) || "osm";
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
      ? {
          lat: event.venue.lat,
          lng: event.venue.lng,
          name: event.venue.name || "Venue",
        }
      : null;

  const ridePins = browseRides({})
    .map((r) => {
      let coord = null;
      let source = "";
      if (Number.isFinite(r.pickup_lat) && Number.isFinite(r.pickup_lng)) {
        coord = { lat: r.pickup_lat, lng: r.pickup_lng };
        source = "Custom pin";
      } else if (r.meetup_id && meetupCoords.get(r.meetup_id)) {
        const m = /** @type {{ lat: number, lng: number, name: string }} */ (
          meetupCoords.get(r.meetup_id)
        );
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

  const venuePin = venueCoord ? { ...venueCoord, address: event.venue?.address || "" } : null;
  const meetupPins = meetups.map((m) => ({
    id: m.id,
    name: m.name,
    address: m.address || "",
    lat: m.lat,
    lng: m.lng,
  }));

  const center = venueCoord ?? { lat: 37.7749, lng: -122.4194 };
  const zoom = Number.isFinite(event.map?.defaultZoom) ? event.map.defaultZoom : 11;

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

  return { mapData, requested, style, meetupPins, venuePin, ridePins };
}
