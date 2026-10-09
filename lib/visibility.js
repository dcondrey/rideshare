// @ts-check
/**
 * Live-demo isolation. Sign-in to the demo is open to anyone, so one visitor
 * must never see another visitor's rides, name, contact, position, status or
 * messages. Visitors see synthetic attendees and themselves only. Outside
 * DEMO_MODE every rule here is a no-op.
 */

import { config } from "./config.js";
import { db } from "./db.js";

export const VISITOR_EMAIL_LIKE = "%@visitors.demo.test";

/** @param {number} userId */
export function isDemoVisitor(userId) {
  if (!config.demoMode) return false;
  const row = /** @type {{ email: string } | undefined} */ (
    db.prepare("SELECT email FROM users WHERE id = ?").get(userId)
  );
  return !!row && row.email.endsWith("@visitors.demo.test");
}

/**
 * True when `subjectId` must be hidden from `viewerId`: two different demo
 * visitors.
 * @param {number} viewerId @param {number} subjectId
 */
export function hiddenFrom(viewerId, subjectId) {
  return (
    config.demoMode && viewerId !== subjectId && isDemoVisitor(viewerId) && isDemoVisitor(subjectId)
  );
}
