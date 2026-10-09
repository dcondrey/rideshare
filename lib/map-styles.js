// @ts-check
/**
 * Map tile style catalogue.
 *
 * Each entry resolves to a Leaflet tile URL template and the attribution
 * string the provider requires. To use a paid provider with branded styling,
 * choose `custom` and set `map.customTileUrl` + `map.customAttribution`.
 *
 * Default style: `osm`, the OpenStreetMap standard layer, the one keyless
 * source left in this list. CARTO's basemaps now answer every keyless request
 * with an "API KEY REQUIRED" placeholder tile (checked 2026-10-08), and
 * Stadia's do the same off localhost; those styles stay selectable for
 * deployments that hold a key, but they are no longer the default.
 */

/**
 * @typedef {Object} TileStyle
 * @property {string} key
 * @property {string} label
 * @property {string} url
 * @property {string} attribution
 * @property {string[]} [subdomains]
 * @property {number} [maxZoom]
 * @property {number} [minZoom]
 * @property {string} [description]
 */

/** @type {TileStyle[]} */
const STYLES = [
  {
    key: "voyager",
    label: "Voyager (CARTO key)",
    description: "Flat retro with warm palette — CartoDB (needs a CARTO API key)",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    subdomains: ["a", "b", "c", "d"],
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  {
    key: "positron",
    label: "Positron (CARTO key)",
    description: "Bright minimal grayscale — CartoDB (needs a CARTO API key)",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    subdomains: ["a", "b", "c", "d"],
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  {
    key: "dark-matter",
    label: "Dark Matter (CARTO key)",
    description: "Inverted retro for dark mode — CartoDB (needs a CARTO API key)",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    subdomains: ["a", "b", "c", "d"],
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  {
    key: "toner-lite",
    label: "Toner Lite (Stadia key)",
    description: "B&W retro — Stamen via Stadia (needs a Stadia API key off localhost)",
    url: "https://tiles.stadiamaps.com/tiles/stamen_toner_lite/{z}/{x}/{y}{r}.png",
    maxZoom: 18,
    attribution:
      '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://stamen.com/">Stamen Design</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  {
    key: "osm",
    label: "OpenStreetMap (default)",
    description: "Classic colourful default, no key",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
];

const DEFAULT_KEY = "osm";

export function listStyles() {
  return STYLES.map(({ key, label, description }) => ({
    key,
    label,
    description,
  }));
}

/**
 * Resolve a style entry by key, with `custom` and unknown-key fallbacks.
 * @param {string|null|undefined} key
 * @param {{ customTileUrl?: string, customAttribution?: string }} [overrides]
 * @returns {TileStyle}
 */
export function resolveStyle(key, overrides = {}) {
  if (key === "custom" && overrides.customTileUrl) {
    return {
      key: "custom",
      label: "Custom",
      url: overrides.customTileUrl,
      attribution: overrides.customAttribution || "",
    };
  }
  const found = STYLES.find((s) => s.key === key);
  if (found) return found;
  // Fallback to default. DEFAULT_KEY is one of STYLES by construction, so the
  // lookup cannot miss; assert that rather than widening the return type.
  const fallback = STYLES.find((s) => s.key === DEFAULT_KEY);
  if (!fallback) throw new Error(`map-styles: default style ${DEFAULT_KEY} is missing`);
  return fallback;
}
