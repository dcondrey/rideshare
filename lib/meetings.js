// @ts-check
/**
 * Meetings between attendees: a title, a time, a place pinned on the map, and
 * invitees who accept or decline. Pins are served per user (never through the
 * shared map data), only to people invited. Each person's notes on a meeting
 * are readable by that person alone.
 */

import { canMessage } from "./chat.js";
import { audit, db, tx } from "./db.js";
import { broadcastWhere } from "./live.js";
import { hiddenFrom } from "./visibility.js";

export const MAX_INVITEES = 8;

/**
 * @typedef {{ id: number, organizer_id: number, organizer: string | null, title: string,
 *   meet_date: string, meet_time: string, place_name: string, lat: number, lng: number,
 *   cancelled_at: number | null, my_status: string }} MeetingRow
 */

/** @param {number} meetingId */
function memberIds(meetingId) {
  return new Set(
    /** @type {{ user_id: number }[]} */ (
      db.prepare("SELECT user_id FROM meeting_invites WHERE meeting_id = ?").all(meetingId)
    ).map((r) => r.user_id),
  );
}

/**
 * Tell everyone on a meeting to refresh their pins. The person who acted gets
 * a plain refresh rather than a notification about their own action.
 * @param {number} meetingId @param {{ kind: string, from: number, title?: string }} data
 */
function ping(meetingId, data) {
  const members = memberIds(meetingId);
  broadcastWhere("meeting", { meetingId, ...data }, (viewer) => members.has(viewer) && viewer !== data.from);
  broadcastWhere("meeting", { meetingId, kind: "refresh" }, (viewer) => viewer === data.from);
}

/**
 * @param {{ organizerId: number, title: string, date: string, time: string,
 *   placeName: string, lat: number, lng: number, invitees: number[] }} m
 * @returns {number}
 */
export function createMeeting(m) {
  const invitees = [...new Set(m.invitees)].filter((id) => id !== m.organizerId);
  if (invitees.length === 0) throw new Error("Invite at least one person.");
  if (invitees.length > MAX_INVITEES) throw new Error(`Invite at most ${MAX_INVITEES} people.`);
  for (const id of invitees) {
    if (!canMessage(m.organizerId, id)) throw new Error("You can't invite one of those people.");
  }
  const id = tx(() => {
    const meetingId = Number(
      db
        .prepare(
          `INSERT INTO meetings (organizer_id, title, meet_date, meet_time, place_name, lat, lng, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.organizerId, m.title, m.date, m.time, m.placeName, m.lat, m.lng, Date.now())
        .lastInsertRowid,
    );
    const ins = db.prepare(
      "INSERT INTO meeting_invites (meeting_id, user_id, status, responded_at) VALUES (?, ?, ?, ?)",
    );
    ins.run(meetingId, m.organizerId, "accepted", Date.now());
    for (const u of invitees) ins.run(meetingId, u, "invited", null);
    return meetingId;
  });
  audit({ actorId: m.organizerId, action: "meeting.create", detail: `meeting ${id}` });
  ping(id, { kind: "invite", title: m.title, from: m.organizerId });
  return id;
}

/**
 * One meeting, if the viewer is on it.
 * @param {number} meetingId @param {number} viewerId
 * @returns {MeetingRow | null}
 */
export function getMeeting(meetingId, viewerId) {
  return /** @type {MeetingRow | null} */ (
    db
      .prepare(
        `SELECT m.id, m.organizer_id, u.display_name AS organizer, m.title, m.meet_date, m.meet_time,
                m.place_name, m.lat, m.lng, m.cancelled_at, i.status AS my_status
           FROM meetings m
           JOIN meeting_invites i ON i.meeting_id = m.id AND i.user_id = ?
           JOIN users u ON u.id = m.organizer_id
          WHERE m.id = ?`,
      )
      .get(viewerId, meetingId) ?? null
  );
}

/** People on a meeting and their answers, minus anyone hidden from the viewer. */
export function meetingPeople(meetingId, viewerId) {
  return /** @type {{ user_id: number, name: string | null, status: string }[]} */ (
    db
      .prepare(
        `SELECT i.user_id, u.display_name AS name, i.status FROM meeting_invites i
           JOIN users u ON u.id = i.user_id WHERE i.meeting_id = ? ORDER BY i.rowid`,
      )
      .all(meetingId)
  ).filter((p) => !hiddenFrom(viewerId, p.user_id));
}

/** The viewer's meetings that aren't cancelled or declined, soonest first. @param {number} viewerId */
export function myMeetings(viewerId) {
  return /** @type {MeetingRow[]} */ (
    db
      .prepare(
        `SELECT m.id, m.organizer_id, u.display_name AS organizer, m.title, m.meet_date, m.meet_time,
                m.place_name, m.lat, m.lng, m.cancelled_at, i.status AS my_status
           FROM meeting_invites i
           JOIN meetings m ON m.id = i.meeting_id
           JOIN users u ON u.id = m.organizer_id
          WHERE i.user_id = ? AND m.cancelled_at IS NULL AND i.status != 'declined'
          ORDER BY m.meet_date, m.meet_time`,
      )
      .all(viewerId)
  );
}

/** @param {number} meetingId @param {number} userId @param {'accepted' | 'declined'} answer */
export function respond(meetingId, userId, answer) {
  const r = db
    .prepare(
      "UPDATE meeting_invites SET status = ?, responded_at = ? WHERE meeting_id = ? AND user_id = ?",
    )
    .run(answer, Date.now(), meetingId, userId);
  if (r.changes === 0) throw new Error("You're not invited to that meeting.");
  ping(meetingId, { kind: answer, from: userId });
}

/** @param {number} meetingId @param {number} organizerId */
export function cancelMeeting(meetingId, organizerId) {
  const r = db
    .prepare(
      "UPDATE meetings SET cancelled_at = ? WHERE id = ? AND organizer_id = ? AND cancelled_at IS NULL",
    )
    .run(Date.now(), meetingId, organizerId);
  if (r.changes > 0) {
    audit({ actorId: organizerId, action: "meeting.cancel", detail: `meeting ${meetingId}` });
    ping(meetingId, { kind: "cancelled", from: organizerId });
  }
  return r.changes > 0;
}

/** The viewer's own note on a meeting, or "". */
export function myNote(meetingId, userId) {
  return (
    /** @type {{ body: string } | undefined} */ (
      db
        .prepare("SELECT body FROM meeting_notes WHERE meeting_id = ? AND user_id = ?")
        .get(meetingId, userId)
    )?.body ?? ""
  );
}

/** Save the viewer's private note; only people on the meeting may keep one. */
export function saveNote(meetingId, userId, body) {
  if (!memberIds(meetingId).has(userId)) throw new Error("You're not on that meeting.");
  const text = String(body ?? "").slice(0, 4000);
  if (!text.trim()) {
    db.prepare("DELETE FROM meeting_notes WHERE meeting_id = ? AND user_id = ?").run(
      meetingId,
      userId,
    );
    return;
  }
  db.prepare(
    `INSERT INTO meeting_notes (meeting_id, user_id, body, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (meeting_id, user_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
  ).run(meetingId, userId, text, Date.now());
}

/** Map pins for the viewer's own meetings. @param {number} viewerId */
export function meetingPins(viewerId) {
  return myMeetings(viewerId).map((m) => ({
    id: m.id,
    title: m.title,
    when: `${m.meet_date} ${m.meet_time}`,
    place: m.place_name,
    lat: m.lat,
    lng: m.lng,
    status: m.my_status,
    url: `/meetings/${m.id}`,
  }));
}
