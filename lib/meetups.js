// @ts-check
/**
 * Meetup CRUD + first-boot seed from event.config.yaml#meetups.
 *
 * Meetups are event-defined pickup spots that show as pins on the map and
 * become selectable when posting a ride. The YAML list seeds the DB on
 * first boot; subsequent edits in the admin UI live only in the DB.
 */

import { db, audit } from "./db.js";
import { config } from "./config.js";

/**
 * Seed meetups from the YAML config if the table is empty.
 * Idempotent: only runs when the meetups table has 0 rows.
 */
export function seedMeetupsIfEmpty() {
  const { c } = /** @type {{c:number}} */ (
    db.prepare("SELECT COUNT(*) AS c FROM meetups").get()
  );
  if (c > 0) return;
  const list = Array.isArray(config.event.meetups) ? config.event.meetups : [];
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
  return /** @type {any[]} */ (
    db
      .prepare("SELECT * FROM meetups ORDER BY sort_order, name")
      .all()
  );
}

/** @param {number} id */
export function getMeetup(id) {
  return /** @type {any|undefined} */ (
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
