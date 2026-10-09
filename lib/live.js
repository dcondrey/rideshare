// @ts-check
/**
 * Live map channel: Server-Sent Events carrying shared positions and, in the
 * live demo, synthetic attendees on the move.
 *
 * Privacy model (THREAT_MODEL.md A10):
 *   - A position is shared only by an explicit action in the browser, and only
 *     ever sent to the sharer's ride partners: the poster and accepted riders
 *     of a ride they are on together. Authorization is checked for every
 *     event sent, not once at subscribe time, because matches change.
 *   - Positions live in memory only (latest point per user, two-minute TTL).
 *     They never reach SQLite, backups, the audit log or log output.
 *   - Synthetic demo attendees are visible to everyone and labeled as such.
 */

import { config } from "./config.js";
import { db } from "./db.js";
import { getEventConfig } from "./event-config.js";

const POSITION_TTL_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 20_000;
const GHOST_TICK_MS = 2_000;
const PARTNER_CACHE_MS = 10_000;

/** @typedef {{ lat: number, lng: number, accuracy: number | null, at: number, name: string }} Position */
/** @typedef {{ userId: number, res: import("node:http").ServerResponse }} Subscriber */

/** @type {Map<number, Position>} */
const positions = new Map();
/** @type {Set<Subscriber>} */
const subscribers = new Set();
/** @type {Map<number, { at: number, ids: Set<number> }>} */
const partnerCache = new Map();

/**
 * Everyone who shares a non-cancelled ride with `userId` through an accepted
 * claim: the poster and every accepted rider.
 * @param {number} userId
 * @returns {Set<number>}
 */
export function partnersOf(userId) {
  const hit = partnerCache.get(userId);
  if (hit && Date.now() - hit.at < PARTNER_CACHE_MS) return hit.ids;
  const rows = /** @type {{ uid: number }[]} */ (
    db
      .prepare(
        `WITH mine AS (
           SELECT r.id FROM rides r
            WHERE r.status != 'cancelled' AND (
              r.user_id = ?1 OR EXISTS (SELECT 1 FROM claims c WHERE c.ride_id = r.id
                                         AND c.claimer_id = ?1 AND c.status = 'accepted'))
             AND EXISTS (SELECT 1 FROM claims c WHERE c.ride_id = r.id AND c.status = 'accepted'))
         SELECT r.user_id AS uid FROM rides r WHERE r.id IN (SELECT id FROM mine)
         UNION
         SELECT c.claimer_id FROM claims c WHERE c.ride_id IN (SELECT id FROM mine) AND c.status = 'accepted'`,
      )
      .all(userId)
  );
  const ids = new Set(rows.map((r) => r.uid).filter((id) => id !== userId));
  partnerCache.set(userId, { at: Date.now(), ids });
  return ids;
}

/** @param {Subscriber} sub @param {string} event @param {unknown} data */
function send(sub, event, data) {
  try {
    sub.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    subscribers.delete(sub);
  }
}

/** @param {number} userId @param {Position | null} p */
function positionEvent(userId, p) {
  return p
    ? { userId, name: p.name, lat: p.lat, lng: p.lng, accuracy: p.accuracy, at: p.at }
    : { userId, gone: true };
}

/**
 * Deliver one user's position (or its removal) to that user and their partners.
 * @param {number} userId
 */
function broadcastPosition(userId) {
  const p = positions.get(userId) || null;
  const audience = partnersOf(userId);
  for (const sub of subscribers) {
    if (sub.userId === userId || audience.has(sub.userId)) {
      send(sub, "position", { ...positionEvent(userId, p), self: sub.userId === userId });
    }
  }
}

/**
 * Record a position shared by `userId`.
 * @param {number} userId
 * @param {string} name
 * @param {{ lat: number, lng: number, accuracy?: number | null }} pos
 */
export function sharePosition(userId, name, pos) {
  positions.set(userId, {
    lat: pos.lat,
    lng: pos.lng,
    accuracy: pos.accuracy ?? null,
    at: Date.now(),
    name,
  });
  broadcastPosition(userId);
}

/** Stop sharing: drop the point and tell partners it is gone. @param {number} userId */
export function stopSharing(userId) {
  if (positions.delete(userId)) broadcastPosition(userId);
}

/** @param {number} userId */
export const isSharing = (userId) => positions.has(userId);

/**
 * Attach an SSE stream for `userId`. Sends the partners' current positions,
 * then live updates, synthetic attendees (demo) and heartbeats.
 * @param {number} userId
 * @param {import("node:http").ServerResponse} res
 */
export function subscribe(userId, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 5000\n\n");
  const sub = { userId, res };
  subscribers.add(sub);
  const partners = partnersOf(userId);
  for (const [uid, p] of positions) {
    if (uid === userId || partners.has(uid))
      send(sub, "position", { ...positionEvent(uid, p), self: uid === userId });
  }
  if (config.demoMode) send(sub, "ghosts", ghostPositions(Date.now()));
  res.on("close", () => subscribers.delete(sub));
}

/** How many streams are open (for tests and the health of the demo). */
export const subscriberCount = () => subscribers.size;

// ── Synthetic attendees (DEMO_MODE) ─────────────────────────────────────────
// Each ghost with an accepted ride "travels" between its ride's airport and the
// venue on a loop, as a pure function of time, so every viewer sees the same
// movement and nothing is stored. Clearly labeled synthetic in the UI.

/** @param {number} t */
export function ghostPositions(t) {
  const event = getEventConfig();
  const venue = event.venue;
  const airports = new Map((event.airports || []).map((a) => [a.code, a]));
  const rows = /** @type {{ id: number, name: string, airport: string, direction: string }[]} */ (
    db
      .prepare(
        `SELECT DISTINCT u.id, u.display_name AS name, r.airport, r.direction FROM users u
           JOIN rides r ON r.user_id = u.id
          WHERE u.email LIKE '%@ghost.demo.test' AND r.status != 'cancelled'
          ORDER BY u.id LIMIT 24`,
      )
      .all()
  );
  const out = [];
  for (const g of rows) {
    const a = airports.get(g.airport);
    if (!a) continue;
    const loopMs = (18 + (g.id % 9)) * 60_000; // 18–26 minute trips
    const phase = ((t + g.id * 97_000) % loopMs) / loopMs;
    // Ease in and out so cars slow near both ends, and bow the path a little
    // so it reads as a road trip rather than a ruler line.
    const k = phase < 0.5 ? 2 * phase * phase : 1 - (-2 * phase + 2) ** 2 / 2;
    const [from, to] = g.direction === "to_venue" ? [a, venue] : [venue, a];
    const bow = Math.sin(Math.PI * k) * 0.04 * (g.id % 2 ? 1 : -1);
    out.push({
      id: g.id,
      name: g.name,
      synthetic: true,
      lat: from.lat + (to.lat - from.lat) * k + bow * (to.lng - from.lng),
      lng: from.lng + (to.lng - from.lng) * k - bow * (to.lat - from.lat),
    });
  }
  return out;
}

// Housekeeping: expire stale points, heartbeat, and move the ghosts.
setInterval(() => {
  const now = Date.now();
  for (const [uid, p] of positions) {
    if (now - p.at > POSITION_TTL_MS) {
      positions.delete(uid);
      broadcastPosition(uid);
    }
  }
  for (const sub of subscribers) {
    try {
      sub.res.write(": keep-alive\n\n");
    } catch {
      subscribers.delete(sub);
    }
  }
}, HEARTBEAT_MS).unref();

setInterval(() => {
  if (!config.demoMode || subscribers.size === 0) return;
  const ghosts = ghostPositions(Date.now());
  for (const sub of subscribers) send(sub, "ghosts", ghosts);
}, GHOST_TICK_MS).unref();
