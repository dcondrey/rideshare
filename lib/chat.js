// @ts-check
/**
 * Attendee chat: one shared room, direct messages, blocking, reports and
 * organizer moderation. Messages are stored server-side in the clear, behind
 * access checks, so organizers can review reports; they are not end-to-end
 * encrypted. In the live demo a visitor's messages reach nobody but synthetic
 * attendees (lib/visibility.js).
 */

import { audit, db } from "./db.js";
import { broadcastWhere } from "./live.js";
import { hiddenFrom } from "./visibility.js";

export const MAX_MESSAGE = 500;

/** @param {number} a @param {number} b True when either has blocked the other. */
export function blockedEitherWay(a, b) {
  return !!db
    .prepare(
      `SELECT 1 FROM blocks WHERE (blocker_id = ?1 AND blocked_id = ?2)
                              OR (blocker_id = ?2 AND blocked_id = ?1) LIMIT 1`,
    )
    .get(a, b);
}

/** @param {number} userId */
function assertNotMuted(userId) {
  const row = /** @type {{ muted_until: number | null } | undefined} */ (
    db.prepare("SELECT muted_until FROM users WHERE id = ?").get(userId)
  );
  if (row?.muted_until && row.muted_until > Date.now()) {
    throw new Error("An organizer has paused your messages for now.");
  }
}

/** @param {string} body */
function cleanBody(body) {
  const s = String(body ?? "").trim();
  if (!s) throw new Error("Write something first.");
  if (s.length > MAX_MESSAGE) throw new Error(`Keep it under ${MAX_MESSAGE} characters.`);
  return s;
}

/** Whether `viewerId` may see something `authorId` wrote. */
function canSee(viewerId, authorId) {
  return (
    viewerId === authorId ||
    (!hiddenFrom(viewerId, authorId) && !blockedEitherWay(viewerId, authorId))
  );
}

/** The other person's display name, if the viewer may see them. */
export function displayNameFor(viewerId, otherId) {
  return hiddenFrom(viewerId, otherId) ? null : nameOf(otherId);
}

const nameOf = (userId) =>
  /** @type {{ display_name: string | null } | undefined} */ (
    db.prepare("SELECT display_name FROM users WHERE id = ?").get(userId)
  )?.display_name || "Attendee";

// ── Room ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ id: number, user_id: number, name: string | null, body: string, created_at: number }} ChatRow
 */

/** @param {number} userId @param {string} body @returns {number} */
export function postChat(userId, body) {
  assertNotMuted(userId);
  const text = cleanBody(body);
  const now = Date.now();
  const id = Number(
    db
      .prepare("INSERT INTO chat_messages (user_id, body, created_at) VALUES (?, ?, ?)")
      .run(userId, text, now).lastInsertRowid,
  );
  broadcastWhere(
    "chat",
    { id, userId, name: nameOf(userId), body: text, at: now },
    (viewer) => viewer !== userId && canSee(viewer, userId),
  );
  return id;
}

/** Newest `limit` room messages the viewer may see, oldest first. @param {number} viewerId */
export function recentChat(viewerId, limit = 60) {
  const rows = /** @type {ChatRow[]} */ (
    db
      .prepare(
        `SELECT m.id, m.user_id, u.display_name AS name, m.body, m.created_at
           FROM chat_messages m JOIN users u ON u.id = m.user_id
          WHERE m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 400`,
      )
      .all()
  );
  return rows
    .filter((r) => canSee(viewerId, r.user_id))
    .slice(0, limit)
    .reverse();
}

// ── Direct messages ──────────────────────────────────────────────────────────

/**
 * Who may start a conversation with whom: the recipient is listed in the
 * directory, shares a ride with the sender, or has written to them before.
 * Never across a block or between two demo visitors.
 * @param {number} from @param {number} to
 */
export function canMessage(from, to) {
  if (from === to || hiddenFrom(from, to) || blockedEitherWay(from, to)) return false;
  const target = /** @type {{ listed: number } | undefined} */ (
    db.prepare("SELECT listed FROM users WHERE id = ?").get(to)
  );
  if (!target) return false;
  if (target.listed === 1) return true;
  const sharedRide = db
    .prepare(
      `SELECT 1 FROM rides r
        WHERE r.status != 'cancelled' AND (
          (r.user_id = ?1 AND EXISTS (SELECT 1 FROM claims c WHERE c.ride_id = r.id AND c.claimer_id = ?2 AND c.status = 'accepted')) OR
          (r.user_id = ?2 AND EXISTS (SELECT 1 FROM claims c WHERE c.ride_id = r.id AND c.claimer_id = ?1 AND c.status = 'accepted')) OR
          (EXISTS (SELECT 1 FROM claims c WHERE c.ride_id = r.id AND c.claimer_id = ?1 AND c.status = 'accepted') AND
           EXISTS (SELECT 1 FROM claims c WHERE c.ride_id = r.id AND c.claimer_id = ?2 AND c.status = 'accepted')))
        LIMIT 1`,
    )
    .get(from, to);
  if (sharedRide) return true;
  return !!db
    .prepare("SELECT 1 FROM direct_messages WHERE sender_id = ? AND recipient_id = ? LIMIT 1")
    .get(to, from);
}

/** @param {number} from @param {number} to @param {string} body @returns {number} */
export function sendDirect(from, to, body) {
  assertNotMuted(from);
  if (!canMessage(from, to)) throw new Error("You can't message this person.");
  const text = cleanBody(body);
  const now = Date.now();
  const id = Number(
    db
      .prepare(
        "INSERT INTO direct_messages (sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(from, to, text, now).lastInsertRowid,
  );
  broadcastWhere(
    "dm",
    { id, from, name: nameOf(from), body: text, at: now },
    (viewer) => viewer === to,
  );
  return id;
}

/** True when `from` has never written to `to` (a new conversation). */
export const isNewConversation = (from, to) =>
  !db
    .prepare(
      `SELECT 1 FROM direct_messages WHERE (sender_id = ?1 AND recipient_id = ?2)
                                       OR (sender_id = ?2 AND recipient_id = ?1) LIMIT 1`,
    )
    .get(from, to);

/**
 * The viewer's conversations, newest first, with the other person's name, the
 * last message and how many are unread.
 * @param {number} viewerId
 */
export function conversations(viewerId) {
  const rows =
    /** @type {{ other: number, name: string | null, body: string, created_at: number, unread: number }[]} */ (
      db
        .prepare(
          `WITH mine AS (
           SELECT CASE WHEN sender_id = ?1 THEN recipient_id ELSE sender_id END AS other, id, body, created_at,
                  (recipient_id = ?1 AND read_at IS NULL) AS unread
             FROM direct_messages
            WHERE (sender_id = ?1 OR recipient_id = ?1) AND deleted_at IS NULL
         )
         SELECT m.other, u.display_name AS name, m.body, m.created_at,
                (SELECT SUM(unread) FROM mine x WHERE x.other = m.other) AS unread
           FROM mine m JOIN users u ON u.id = m.other
          WHERE m.id = (SELECT MAX(id) FROM mine y WHERE y.other = m.other)
          ORDER BY m.created_at DESC`,
        )
        .all(viewerId)
    );
  return rows.filter((r) => !hiddenFrom(viewerId, r.other));
}

/**
 * Messages between the viewer and `otherId`, oldest first. Marks the viewer's
 * incoming messages read.
 * @param {number} viewerId @param {number} otherId
 */
export function thread(viewerId, otherId) {
  if (hiddenFrom(viewerId, otherId)) return [];
  db.prepare(
    "UPDATE direct_messages SET read_at = ? WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL",
  ).run(Date.now(), viewerId, otherId);
  return /** @type {{ id: number, sender_id: number, body: string, created_at: number }[]} */ (
    db
      .prepare(
        `SELECT id, sender_id, body, created_at FROM direct_messages
          WHERE ((sender_id = ?1 AND recipient_id = ?2) OR (sender_id = ?2 AND recipient_id = ?1))
            AND deleted_at IS NULL
          ORDER BY id DESC LIMIT 200`,
      )
      .all(viewerId, otherId)
  ).reverse();
}

/** @param {number} viewerId */
export const unreadCount = (viewerId) =>
  /** @type {{ n: number }} */ (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM direct_messages WHERE recipient_id = ? AND read_at IS NULL AND deleted_at IS NULL",
      )
      .get(viewerId)
  ).n;

// ── Blocking, reports, moderation ────────────────────────────────────────────

/** @param {number} blocker @param {number} blocked */
export function block(blocker, blocked) {
  if (blocker === blocked) return;
  db.prepare(
    "INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)",
  ).run(blocker, blocked, Date.now());
}
/** @param {number} blocker @param {number} blocked */
export function unblock(blocker, blocked) {
  db.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?").run(blocker, blocked);
}
/** @param {number} blocker @param {number} blocked */
export const hasBlocked = (blocker, blocked) =>
  !!db
    .prepare("SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?")
    .get(blocker, blocked);

/**
 * Report a message the reporter can see.
 * @param {number} reporterId @param {'chat' | 'dm'} kind @param {number} messageId @param {string | null} reason
 */
export function report(reporterId, kind, messageId, reason) {
  const visible =
    kind === "chat"
      ? db.prepare("SELECT user_id AS author FROM chat_messages WHERE id = ?").get(messageId)
      : db
          .prepare(
            "SELECT sender_id AS author FROM direct_messages WHERE id = ? AND recipient_id = ?",
          )
          .get(messageId, reporterId);
  if (!visible) throw new Error("Message not found");
  db.prepare(
    "INSERT INTO reports (reporter_id, kind, message_id, reason, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(reporterId, kind, messageId, reason, Date.now());
  audit({ actorId: reporterId, action: "message.report", detail: `${kind} ${messageId}` });
}

/**
 * @typedef {{ id: number, kind: string, message_id: number, reason: string | null, created_at: number,
 *   body: string | null, author_id: number | null, author: string | null, reporter: string | null }} ReportRow
 */

/** Open reports with the reported text, for organizers. */
export function openReports() {
  return /** @type {ReportRow[]} */ (
    db
      .prepare(
        `SELECT r.id, r.kind, r.message_id, r.reason, r.created_at,
                COALESCE(c.body, d.body) AS body,
                COALESCE(c.user_id, d.sender_id) AS author_id,
                a.display_name AS author, rp.display_name AS reporter
           FROM reports r
           LEFT JOIN chat_messages c ON r.kind = 'chat' AND c.id = r.message_id
           LEFT JOIN direct_messages d ON r.kind = 'dm' AND d.id = r.message_id
           LEFT JOIN users a ON a.id = COALESCE(c.user_id, d.sender_id)
           LEFT JOIN users rp ON rp.id = r.reporter_id
          WHERE r.resolved_at IS NULL ORDER BY r.created_at`,
      )
      .all()
  );
}

/**
 * Organizer action on a report: delete the message, mute its author for a
 * day (and delete), or dismiss. Audited.
 * @param {number} adminId @param {number} reportId @param {'delete' | 'mute' | 'dismiss'} action
 */
export function resolveReport(adminId, reportId, action) {
  const r = /** @type {{ kind: string, message_id: number } | undefined} */ (
    db
      .prepare("SELECT kind, message_id FROM reports WHERE id = ? AND resolved_at IS NULL")
      .get(reportId)
  );
  if (!r) return false;
  const now = Date.now();
  if (action === "delete" || action === "mute") {
    if (r.kind === "chat") {
      db.prepare("UPDATE chat_messages SET deleted_at = ?, deleted_by = ? WHERE id = ?").run(
        now,
        adminId,
        r.message_id,
      );
    } else {
      db.prepare("UPDATE direct_messages SET deleted_at = ? WHERE id = ?").run(now, r.message_id);
    }
  }
  if (action === "mute") {
    const author = /** @type {{ a: number } | undefined} */ (
      db
        .prepare(
          r.kind === "chat"
            ? "SELECT user_id AS a FROM chat_messages WHERE id = ?"
            : "SELECT sender_id AS a FROM direct_messages WHERE id = ?",
        )
        .get(r.message_id)
    );
    if (author) {
      db.prepare("UPDATE users SET muted_until = ? WHERE id = ?").run(
        now + 24 * 60 * 60 * 1000,
        author.a,
      );
    }
  }
  // Every report on the same message is settled by one decision.
  db.prepare(
    "UPDATE reports SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE kind = ? AND message_id = ? AND resolved_at IS NULL",
  ).run(now, adminId, action, r.kind, r.message_id);
  audit({ actorId: adminId, action: `report.${action}`, detail: `${r.kind} ${r.message_id}` });
  return true;
}

/** Organizer deletes a room message directly. @param {number} adminId @param {number} messageId */
export function deleteChatMessage(adminId, messageId) {
  const r = db
    .prepare(
      "UPDATE chat_messages SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL",
    )
    .run(Date.now(), adminId, messageId);
  if (r.changes > 0)
    audit({ actorId: adminId, action: "chat.delete", detail: `chat ${messageId}` });
  return r.changes > 0;
}
