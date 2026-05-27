// @ts-check
/**
 * Map tile style catalogue.
 *
 * Each entry resolves to a Leaflet tile URL template and the attribution
 * string the provider requires. All defaults are free, no-API-key tile
 * sources. To use a paid provider with branded styling, choose `custom`
 * and set `map.customTileUrl` + `map.customAttribution` in the config.
 *
 * Default style: `voyager` — CartoDB Voyager. Flat retro warm palette.
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
    label: "Voyager (default)",
    description: "Flat retro with warm palette — CartoDB",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    subdomains: ["a", "b", "c", "d"],
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  {
    key: "positron",
    label: "Positron",
    description: "Bright minimal grayscale — CartoDB",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    subdomains: ["a", "b", "c", "d"],
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  {
    key: "dark-matter",
    label: "Dark Matter",
    description: "Inverted retro for dark mode — CartoDB",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    subdomains: ["a", "b", "c", "d"],
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  {
    key: "toner-lite",
    label: "Toner Lite",
    description: "B&W retro — Stamen via Stadia (may need API key)",
    url: "https://tiles.stadiamaps.com/tiles/stamen_toner_lite/{z}/{x}/{y}{r}.png",
    maxZoom: 18,
    attribution:
      '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://stamen.com/">Stamen Design</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  {
    key: "osm",
    label: "OpenStreetMap",
    description: "Classic colourful default",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
];

const DEFAULT_KEY = "voyager";

export function listStyles() {
  return STYLES.map(({ key, label, description }) => ({ key, label, description }));
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
  // Fallback to default
  return STYLES.find((s) => s.key === DEFAULT_KEY);
}
