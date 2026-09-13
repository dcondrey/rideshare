// @ts-check
/**
 * Meetup CRUD + first-boot seed from event.config.yaml#meetups.
 *
 * Meetups are event-defined pickup spots that show as pins on the map and
 * become selectable when posting a ride. The YAML list seeds the DB on
 * first boot; subsequent edits in the admin UI live only in the DB.
 */

import { config } from "./config.js";
import { audit, db } from "./db.js";
import { warn as logWarn } from "./log.js";

/**
 * @typedef {{ id: number, name: string, address: string | null, lat: number,
 *   lng: number, sort_order: number, created_at: number }} MeetupRow
 */

/**
 * Seed meetups from the YAML config if the table is empty.
 * Idempotent: only runs when the meetups table has 0 rows.
 */
export function seedMeetupsIfEmpty() {
  const { c } = /** @type {{c:number}} */ (db.prepare("SELECT COUNT(*) AS c FROM meetups").get());
  const configured = Array.isArray(config.event.meetups) ? config.event.meetups : [];
  if (c > 0) {
    // Seeding is first-boot only, on purpose: re-running it would clobber
    // whatever an admin has since done in /admin/meetups. Without this line an
    // operator editing event.config.yaml#meetups on a live deployment gets no
    // feedback at all and reasonably concludes the file is being ignored.
    if (configured.length > 0) {
      logWarn("meetups already seeded; event.config.yaml#meetups is not re-read", {
        in_config: configured.length,
        in_database: c,
        edit_at: "/admin/meetups",
      });
    }
    return;
  }
  const list = configured;
  const ins = db.prepare(
    `INSERT INTO meetups (name, address, lat, lng, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  for (let i = 0; i < list.length; i++) {
    const m = list[i] || {};
    if (m.name && Number.isFinite(m.lat) && Number.isFinite(m.lng)) {
      ins.run(m.name, m.address ?? null, m.lat, m.lng, i, now);
    }
  }
}

export function listMeetups() {
  return /** @type {MeetupRow[]} */ (
    db.prepare("SELECT * FROM meetups ORDER BY sort_order, name").all()
  );
}

/** @param {number} id */
export function getMeetup(id) {
  return /** @type {MeetupRow | undefined} */ (
    db.prepare("SELECT * FROM meetups WHERE id = ?").get(id)
  );
}

/**
 * @param {{ name: string, address: string|null, lat: number, lng: number }} m
 * @param {{ actorId: number, actorEmail: string }} actor
 */
export function createMeetup(m, actor) {
  const r = db
    .prepare(
      `INSERT INTO meetups (name, address, lat, lng, sort_order, created_at)
       VALUES (?, ?, ?, ?, COALESCE((SELECT MAX(sort_order)+1 FROM meetups), 0), ?)`,
    )
    .run(m.name, m.address, m.lat, m.lng, Date.now());
  audit({
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    action: "meetup.create",
    detail: m.name,
  });
  return Number(r.lastInsertRowid);
}

/**
 * @param {number} id
 * @param {{ actorId: number, actorEmail: string }} actor
 */
export function deleteMeetup(id, actor) {
  const m = getMeetup(id);
  if (!m) return false;
  db.prepare("DELETE FROM meetups WHERE id = ?").run(id);
  audit({
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    action: "meetup.delete",
    detail: m.name,
  });
  return true;
}
