// @ts-check
// SPDX-License-Identifier: MIT
/**
 * Structured data (JSON-LD) and social-card metadata for the two routes a
 * signed-out visitor can reach: `/` and `/about`.
 *
 * IMPORTANT: every property emitted here must correspond to something the
 * visitor can actually read on that page. Marking up data the page does not
 * display is cloaking, and Google, Bing and the AI crawlers all treat it as a
 * spam signal. Two consequences show up below and are deliberate:
 *   - the Event carries `location` as a bare name, because `/` renders
 *     `venue.name` but never the postal address or the coordinates (those live
 *     on `/map`, which is session-gated);
 *   - the SoftwareApplication omits its licence, because `/about` says
 *     "open-source" without naming MIT.
 *
 * Wikidata ids give an AI agent an unambiguous referent for the entities on the
 * page. Event- and venue-specific ids cannot be known here, so they come from
 * `event.config.yaml#seo.wikidata` and are simply absent when unset — never
 * guessed. The ids that ARE hard-coded describe this software and the concepts
 * its own prose names; each was resolved against the Wikidata API rather than
 * from recall.
 */

import { config } from "./config.js";

/**
 * The subset of the resolved event config this module reads. `getEventConfig()`
 * returns a JSON clone with no type of its own, so the shape is stated here
 * rather than threaded through as an untyped object.
 *
 * @typedef {{
 *   name: string,
 *   longName?: string,
 *   tagline?: string,
 *   dates: { start: string, end: string },
 *   venue: { name: string },
 *   registrationUrl?: string,
 *   seo?: {
 *     ogImage?: string,
 *     wikidata?: { event?: string, venue?: string, topics?: string[] },
 *   },
 * }} EventConfig
 */

const WIKIDATA = "https://www.wikidata.org/wiki/";

/**
 * Wikidata entities for concepts this app's own visible copy names. Each was
 * resolved by reading the item back from the Wikidata API, not from recall.
 *
 * Two of these have near-identical neighbours, so check before editing:
 *   - Q749649 is the practice "carpooling". Q1924207 is a 1996 film.
 *   - Q23582374 is peer-to-peer ridesharing, the practice. Q27973 is
 *     "ridesharing company", a P279 subclass of it describing the operator —
 *     wrong here, since this app is not a transportation network company.
 */
const QID = {
  carpool: "Q749649",
  ridesharing: "Q23582374",
  nodejs: "Q756100",
  sqlite: "Q319417",
  webApplication: "Q189210",
};

/** @param {string} qid */
function entity(qid) {
  return { "@id": `${WIKIDATA}${qid}` };
}

/**
 * Absolute URL for `path` against APP_URL. Open Graph and JSON-LD `url` both
 * require absolute URLs; a relative one is silently dropped by most consumers.
 * @param {string} path
 */
export function absoluteUrl(path) {
  return new URL(path, config.appUrl).toString();
}

/**
 * Configured Wikidata ids, normalised. Anything that is not a `Q`-number is
 * dropped rather than passed through — a malformed id would produce a link to
 * a Wikidata page that does not exist.
 * @param {unknown} raw
 * @returns {string[]}
 */
function configuredQids(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => /^Q[1-9][0-9]*$/.test(v));
}

/** @param {EventConfig} event */
function seoConfig(event) {
  const seo = event.seo && typeof event.seo === "object" ? event.seo : {};
  const wikidata = seo.wikidata && typeof seo.wikidata === "object" ? seo.wikidata : {};
  return {
    ogImage: typeof seo.ogImage === "string" && seo.ogImage !== "" ? seo.ogImage : null,
    eventQids: configuredQids(wikidata.event),
    venueQids: configuredQids(wikidata.venue),
    topicQids: configuredQids(wikidata.topics),
  };
}

/**
 * JSON-LD for `/`. An Event nested inside the WebSite that describes it, so a
 * consumer reading either node reaches the other rather than seeing two
 * unrelated top-level things.
 *
 * `about` is the event itself when the operator has supplied its Wikidata id;
 * `mentions` covers the concepts the page's copy actually talks about.
 * @param {EventConfig} event
 */
export function landingJsonLd(event) {
  const seo = seoConfig(event);
  const home = absoluteUrl("/");

  /** @type {Record<string, unknown> & { location: Record<string, unknown> }} */
  const eventNode = {
    "@type": "Event",
    "@id": `${home}#event`,
    name: event.longName || event.name,
    startDate: event.dates.start,
    endDate: event.dates.end,
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    // The page shows the venue's name and nothing more, so neither does this.
    location: { "@type": "Place", name: event.venue.name },
    url: home,
    subjectOf: { "@id": `${home}#website` },
  };
  if (event.tagline) eventNode.description = event.tagline;
  if (seo.eventQids.length > 0) eventNode.sameAs = seo.eventQids.map((q) => `${WIKIDATA}${q}`);
  if (seo.venueQids.length > 0) {
    eventNode.location.sameAs = seo.venueQids.map((q) => `${WIKIDATA}${q}`);
  }
  if (event.registrationUrl) {
    eventNode.offers = {
      "@type": "Offer",
      url: event.registrationUrl,
      availability: "https://schema.org/InStock",
    };
  }

  const mentions = [entity(QID.carpool), entity(QID.ridesharing), ...seo.topicQids.map(entity)];

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${home}#website`,
        name: `${event.name} Rideshare`,
        url: home,
        inLanguage: "en",
        // `about` is the event when the operator has given it a Wikidata id,
        // and the local Event node otherwise — either way the site resolves to
        // a single subject rather than floating unattached.
        about: seo.eventQids.length > 0 ? entity(seo.eventQids[0]) : { "@id": `${home}#event` },
        mentions,
      },
      eventNode,
    ],
  };
}

/**
 * JSON-LD for `/about`. A SoftwareApplication describing this deployment.
 *
 * `mentions` lists only what the page's prose names out loud — Node.js and
 * SQLite. DID and Verifiable Credentials are deliberately absent: they are
 * central to `/trust`, which is session-gated and therefore not marked up.
 * @param {EventConfig} event
 */
export function aboutJsonLd(event) {
  const about = absoluteUrl("/about");
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${about}#app`,
    name: `${event.name} Rideshare`,
    applicationCategory: "TravelApplication",
    applicationSubCategory: "Ridesharing",
    operatingSystem: "Any (server-rendered web application)",
    url: about,
    isAccessibleForFree: true,
    about: entity(QID.carpool),
    mentions: [entity(QID.nodejs), entity(QID.sqlite), entity(QID.webApplication)],
    // "self-hosted, open-source ... single Node.js process with zero
    // third-party dependencies ... local SQLite database" — the page's own copy.
    description:
      `${event.name} Rideshare is a self-hosted, open-source ride coordination tool for ` +
      `event attendees. A single Node.js process with zero third-party dependencies, ` +
      `storing data in a local SQLite database.`,
    isPartOf: { "@id": `${absoluteUrl("/")}#website` },
  };
}

/**
 * Open Graph + X card tags. `summary_large_image` is only claimed when an image
 * is configured; claiming it without one renders an empty card.
 * @param {{ event: EventConfig, title: string, description: string, path: string }} args
 */
export function socialCard({ event, title, description, path }) {
  const seo = seoConfig(event);
  /** @type {Record<string, string>} */
  const tags = {
    "og:type": "website",
    "og:site_name": `${event.name} Rideshare`,
    "og:title": title,
    "og:description": description,
    "og:url": absoluteUrl(path),
    "og:locale": "en_US",
    "twitter:card": seo.ogImage ? "summary_large_image" : "summary",
    "twitter:title": title,
    "twitter:description": description,
  };
  if (seo.ogImage) {
    tags["og:image"] = absoluteUrl(seo.ogImage);
    tags["og:image:alt"] = `${event.longName || event.name} rideshare board`;
    tags["twitter:image"] = absoluteUrl(seo.ogImage);
  }
  return tags;
}
