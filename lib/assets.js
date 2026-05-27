// @ts-check
/**
 * Binary assets stored in the DB (currently: the event logo).
 *
 * Logos are uploaded via the admin UI as data URLs (base64-encoded by the
 * browser via FileReader), validated server-side, then stored as a BLOB row
 * in the `assets` table and served from /logo.
 *
 * Limits enforced server-side regardless of client behaviour:
 *   - max 200KB
 *   - mime must be one of: image/svg+xml, image/png, image/webp, image/jpeg
 */

import { db, audit } from "./db.js";

export const MAX_LOGO_BYTES = 200 * 1024;
export const ALLOWED_LOGO_MIMES = new Set([
  "image/svg+xml",
  "image/png",
  "image/webp",
  "image/jpeg",
]);

/**
 * @param {string} name
 * @returns {{ mime: string, bytes: Buffer, updatedAt: number } | null}
 */
export function getAsset(name) {
  const row = /** @type {any} */ (
    db
      .prepare("SELECT mime_type, bytes, updated_at FROM assets WHERE name = ?")
      .get(name)
  );
  if (!row) return null;
  return { mime: row.mime_type, bytes: Buffer.from(row.bytes), updatedAt: row.updated_at };
}

/**
 * @param {string} name
 * @param {string} mime
 * @param {Buffer} bytes
 */
export function putAsset(name, mime, bytes) {
  if (!ALLOWED_LOGO_MIMES.has(mime)) {
    throw new Error(`Unsupported asset type: ${mime}`);
  }
  if (bytes.length > MAX_LOGO_BYTES) {
    throw new Error(`Asset exceeds ${MAX_LOGO_BYTES} bytes`);
  }
  db.prepare(
    `INSERT INTO assets (name, mime_type, bytes, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       mime_type = excluded.mime_type,
       bytes     = excluded.bytes,
       updated_at = excluded.updated_at`,
  ).run(name, mime, bytes, Date.now());
}

export function deleteAsset(name) {
  db.prepare("DELETE FROM assets WHERE name = ?").run(name);
}

export function hasLogo() {
  const r = /** @type {any} */ (
    db.prepare("SELECT 1 FROM assets WHERE name = 'logo'").get()
  );
  return !!r;
}

/**
 * Decode a `data:` URL, validating mime + size.
 * @param {string} dataUrl
 * @returns {{ mime: string, bytes: Buffer }}
 */
export function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(dataUrl);
  if (!m) throw new Error("Not a data: URL");
  const mime = m[1].toLowerCase();
  const isB64 = !!m[2];
  if (!ALLOWED_LOGO_MIMES.has(mime)) {
    throw new Error(`Unsupported image type: ${mime}`);
  }
  const bytes = isB64
    ? Buffer.from(m[3], "base64")
    : Buffer.from(decodeURIComponent(m[3]), "utf8");
  if (bytes.length > MAX_LOGO_BYTES) {
    throw new Error(
      `Image is ${(bytes.length / 1024).toFixed(0)}KB; limit is ${(MAX_LOGO_BYTES / 1024).toFixed(0)}KB.`,
    );
  }
  return { mime, bytes };
}

/**
 * Upload (or replace) the event logo.
 * @param {string} dataUrl
 * @param {{ actorId: number, actorEmail: string }} actor
 */
export function uploadLogo(dataUrl, actor) {
  const { mime, bytes } = decodeDataUrl(dataUrl);
  putAsset("logo", mime, bytes);
  audit({
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    action: "logo.upload",
    detail: `${mime}, ${bytes.length} bytes`,
  });
}

/**
 * Remove the event logo (revert to text brand).
 * @param {{ actorId: number, actorEmail: string }} actor
 */
export function removeLogo(actor) {
  deleteAsset("logo");
  audit({
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    action: "logo.remove",
  });
}
