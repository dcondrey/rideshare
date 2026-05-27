// @ts-check
/**
 * Privacy-safe analytics for event organizers.
 *
 * - All metrics are aggregate counts.
 * - No per-user records exposed.
 * - Buckets with fewer than MIN_CELL members are coalesced into "Other"
 *   (k-anonymity heuristic).
 */

import { db } from "./db.js";
import { allowlistCount } from "./allowlist.js";
import { getEventConfig } from "./event-config.js";

const MIN_CELL = 5;

/** Engagement funnel: allowlisted → signed in → posted → matched. */
export function funnel() {
  const allowlisted = allowlistCount();
  const signedIn = /** @type {{c:number}} */ (
    db.prepare("SELECT COUNT(*) AS c FROM users").get()
  ).c;
  const posters = /** @type {{c:number}} */ (
    db
      .prepare("SELECT COUNT(DISTINCT user_id) AS c FROM rides")
      .get()
  ).c;
  const matched = /** @type {{c:number}} */ (
    db
      .prepare(
        `SELECT COUNT(DISTINCT u) AS c FROM (
           SELECT r.user_id AS u FROM claims c JOIN rides r ON r.id = c.ride_id
            WHERE c.status = 'accepted'
           UNION
           SELECT c.claimer_id AS u FROM claims c WHERE c.status = 'accepted'
         )`,
      )
      .get()
  ).c;
  return { allowlisted, signedIn, posters, matched };
}

/** Activity totals. */
export function activity() {
  const offers = countRides("offer");
  const requests = countRides("request");
  const totalClaims = scalar("SELECT COUNT(*) FROM claims");
  const acceptedClaims = scalar(
    "SELECT COUNT(*) FROM claims WHERE status = 'accepted'",
  );
  const requestRows = scalar(
    "SELECT COUNT(*) FROM rides WHERE kind = 'request'",
  );
  const matchedRequests = scalar(
    `SELECT COUNT(DISTINCT r.id) FROM rides r JOIN claims c ON c.ride_id = r.id
      WHERE r.kind = 'request' AND c.status = 'accepted'`,
  );
  const offerRows = scalar("SELECT COUNT(*) FROM rides WHERE kind = 'offer'");
  const matchedOffers = scalar(
    `SELECT COUNT(DISTINCT r.id) FROM rides r JOIN claims c ON c.ride_id = r.id
      WHERE r.kind = 'offer' AND c.status = 'accepted'`,
  );
  return {
    offers,
    requests,
    totalClaims,
    acceptedClaims,
    requestMatchRate: pct(matchedRequests, requestRows),
    offerMatchRate: pct(matchedOffers, offerRows),
  };
}

/** Median time between claim creation and acceptance, in hours. */
export function medianTimeToMatchHours() {
  const rows = /** @type {{dt:number}[]} */ (
    db
      .prepare(
        `SELECT (decided_at - created_at) AS dt FROM claims
          WHERE status = 'accepted' AND decided_at IS NOT NULL`,
      )
      .all()
  );
  if (rows.length === 0) return null;
  const sorted = rows.map((r) => r.dt).sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  return Math.round((mid / 3600000) * 10) / 10;
}

/**
 * Counts grouped by airport — for both offers and requests, with k-anonymity
 * applied to small buckets.
 */
export function byAirport() {
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT airport, kind, COUNT(*) AS c FROM rides
          WHERE status != 'cancelled' GROUP BY airport, kind`,
      )
      .all()
  );
  return coalesceSmall(rows, ["airport"], MIN_CELL);
}

export function byDirection() {
  return /** @type {any[]} */ (
    db
      .prepare(
        `SELECT direction, kind, COUNT(*) AS c FROM rides
          WHERE status != 'cancelled' GROUP BY direction, kind`,
      )
      .all()
  );
}

export function byDate() {
  return /** @type {any[]} */ (
    db
      .prepare(
        `SELECT depart_date AS date, kind, COUNT(*) AS c FROM rides
          WHERE status != 'cancelled' GROUP BY depart_date, kind
          ORDER BY depart_date`,
      )
      .all()
  );
}

/**
 * Unmet demand: open requests that have no accepted claim, grouped by
 * date + airport + direction. The most actionable insight for organizers.
 */
export function unmetDemand() {
  return /** @type {any[]} */ (
    db
      .prepare(
        `SELECT r.depart_date AS date, r.airport, r.direction, COUNT(*) AS c
           FROM rides r
          WHERE r.kind = 'request' AND r.status = 'open'
            AND NOT EXISTS (
              SELECT 1 FROM claims c
               WHERE c.ride_id = r.id AND c.status = 'accepted'
            )
          GROUP BY r.depart_date, r.airport, r.direction
          ORDER BY r.depart_date, r.airport`,
      )
      .all()
  );
}

/**
 * Build a CSV (string) of all aggregate metrics for export.
 */
export function metricsCsv() {
  const event = getEventConfig();
  const f = funnel();
  const a = activity();
  const ttm = medianTimeToMatchHours();
  const lines = [
    `# ${event.name} Rideshare metrics`,
    `# Generated ${new Date().toISOString()}`,
    `# All values are aggregate. No personal data is included.`,
    ``,
    `metric,value`,
    `allowlisted_attendees,${f.allowlisted}`,
    `signed_in,${f.signedIn}`,
    `posted_a_ride,${f.posters}`,
    `matched_someone,${f.matched}`,
    `offers_total,${a.offers}`,
    `requests_total,${a.requests}`,
    `claims_total,${a.totalClaims}`,
    `claims_accepted,${a.acceptedClaims}`,
    `request_match_rate_pct,${a.requestMatchRate ?? ""}`,
    `offer_match_rate_pct,${a.offerMatchRate ?? ""}`,
    `median_time_to_match_hours,${ttm ?? ""}`,
    ``,
    `# By airport`,
    `airport,kind,count`,
    ...byAirport().map((r) => `${esc(r.airport)},${r.kind},${r.c}`),
    ``,
    `# By direction`,
    `direction,kind,count`,
    ...byDirection().map((r) => `${r.direction},${r.kind},${r.c}`),
    ``,
    `# By date`,
    `date,kind,count`,
    ...byDate().map((r) => `${r.date},${r.kind},${r.c}`),
    ``,
    `# Unmet demand (open requests with no accepted claim)`,
    `date,airport,direction,count`,
    ...unmetDemand().map(
      (r) => `${r.date},${esc(r.airport)},${r.direction},${r.c}`,
    ),
  ];
  return lines.join("\n") + "\n";
}

function countRides(kind) {
  return scalar("SELECT COUNT(*) FROM rides WHERE kind = ?", [kind]);
}
function scalar(sql, args = []) {
  const row = /** @type {any} */ (db.prepare(sql).get(...args));
  return Number(Object.values(row)[0]);
}
function pct(num, den) {
  if (!den) return null;
  return Math.round((num / den) * 1000) / 10;
}
function coalesceSmall(rows, keys, k) {
  // Identify any (groupKey) totals < k and rewrite their key to "Other"
  const totals = new Map();
  for (const r of rows) {
    const key = keys.map((k) => r[k]).join("|");
    totals.set(key, (totals.get(key) || 0) + r.c);
  }
  return rows.map((r) => {
    const key = keys.map((kk) => r[kk]).join("|");
    if ((totals.get(key) || 0) < k) {
      const out = { ...r };
      for (const kk of keys) out[kk] = "Other";
      return out;
    }
    return r;
  });
}
function esc(s) {
  if (s == null) return "";
  const str = String(s);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
