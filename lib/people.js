// @ts-check
/**
 * Attendee profiles and the opt-in directory. A profile shows display name,
 * affiliation, bio, an http(s) link and the cross-event trust badge. It never
 * shows email or the contact method; those stay behind a ride match.
 */

import { config } from "./config.js";
import { db } from "./db.js";
import { hiddenFrom, VISITOR_EMAIL_LIKE } from "./visibility.js";

/**
 * @typedef {{ id: number, name: string | null, bio: string | null,
 *   affiliation: string | null, link: string | null, listed: number }} Profile
 */

/** Accept only absolute http(s) URLs. @param {string | null | undefined} raw */
export function safeLink(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Listed attendees, optionally filtered by a search over name, affiliation
 * and bio. In the live demo, other visitors are never listed: everyone a
 * visitor can find is synthetic.
 * @param {{ q?: string, viewerId: number }} opts
 * @returns {Profile[]}
 */
export function listDirectory({ q = "", viewerId }) {
  const where = ["listed = 1"];
  /** @type {(string | number)[]} */
  const args = [];
  const term = q.trim().slice(0, 60);
  if (term) {
    where.push(
      "(display_name LIKE ? ESCAPE '\\' OR affiliation LIKE ? ESCAPE '\\' OR bio LIKE ? ESCAPE '\\')",
    );
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like, like);
  }
  if (config.demoMode) {
    where.push("(email NOT LIKE ? OR id = ?)");
    args.push(VISITOR_EMAIL_LIKE, viewerId);
  }
  return /** @type {Profile[]} */ (
    db
      .prepare(
        `SELECT id, display_name AS name, bio, affiliation, link, listed FROM users
          WHERE ${where.join(" AND ")} ORDER BY display_name COLLATE NOCASE LIMIT 200`,
      )
      .all(...args)
  );
}

/**
 * A profile the viewer may see: their own, or a listed one (never another
 * demo visitor's).
 * @param {number} id @param {number} viewerId
 * @returns {Profile | null}
 */
export function getProfile(id, viewerId) {
  const row = /** @type {Profile | undefined} */ (
    db
      .prepare(
        "SELECT id, display_name AS name, bio, affiliation, link, listed FROM users WHERE id = ?",
      )
      .get(id)
  );
  if (!row) return null;
  if (row.id !== viewerId && (row.listed !== 1 || hiddenFrom(viewerId, row.id))) return null;
  return row;
}

/**
 * @param {number} userId
 * @param {{ bio: string | null, affiliation: string | null, link: string | null, listed: boolean }} p
 */
export function updatePublicProfile(userId, p) {
  db.prepare("UPDATE users SET bio = ?, affiliation = ?, link = ?, listed = ? WHERE id = ?").run(
    p.bio,
    p.affiliation,
    safeLink(p.link),
    p.listed ? 1 : 0,
    userId,
  );
}
