// @ts-check
/**
 * Site-wide operator banner — a single optional message shown on every page
 * for live-incident comms (mail outage, DB-restore cutoff, etc.). Stored as
 * one row (id = 1) in `site_banner`; no row means no banner is shown.
 */

import { audit, db } from "./db.js";

/**
 * @typedef {{ message: string, severity: 'info'|'warning', createdAt: number }} BannerInfo
 */

/** @returns {BannerInfo | null} */
export function getBanner() {
  const row =
    /** @type {{ message: string, severity: 'info'|'warning', created_at: number } | undefined} */ (
      db.prepare("SELECT message, severity, created_at FROM site_banner WHERE id = 1").get()
    );
  if (!row) return null;
  return { message: row.message, severity: row.severity, createdAt: row.created_at };
}

/**
 * @param {{ message: string, severity: 'info'|'warning' }} banner
 * @param {{ actorId: number, actorEmail: string, ip?: string|null }} actor
 */
export function setBanner(banner, actor) {
  db.prepare(
    `INSERT INTO site_banner (id, message, severity, created_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET message = excluded.message, severity = excluded.severity,
       created_at = excluded.created_at`,
  ).run(banner.message, banner.severity, Date.now());
  audit({
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    action: "banner.set",
    detail: banner.message,
    ip: actor.ip ?? null,
  });
}

/** @param {{ actorId: number, actorEmail: string, ip?: string|null }} actor */
export function clearBanner(actor) {
  db.prepare("DELETE FROM site_banner WHERE id = 1").run();
  audit({
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    action: "banner.clear",
    ip: actor.ip ?? null,
  });
}
