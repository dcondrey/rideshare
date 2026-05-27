// @ts-check
/**
 * Authentication: magic-link emails + opaque session cookies.
 *
 * Flow:
 *   1. User enters email on /          (POST /auth/send)
 *   2. We always return the same response — "If your address is registered,
 *      a link has been sent." (No allowlist enumeration via this endpoint.)
 *   3. If the email IS on the allowlist, we generate a token, store its
 *      HMAC in magic_links, and email the user a link containing the raw token.
 *   4. User clicks link → /auth/callback?token=…
 *      We HMAC the token, look it up, mark used, mint a session cookie,
 *      upsert the user record, redirect to /rides.
 *
 * Sessions are opaque random tokens (not signed JWTs) with a server-side
 * row in `sessions`. Lets us revoke instantly.
 */

import { db, audit } from "./db.js";
import {
  hmac,
  randomToken,
  normalizeEmail,
  safeEqual,
} from "./crypto.js";
import { config } from "./config.js";
import { isAllowed } from "./allowlist.js";
import { sendEmail } from "./email.js";
import { rateLimit } from "./rate-limit.js";
import { getEventConfig } from "./event-config.js";

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_COOKIE = "rs_session";
const SECONDS_PER_DAY = 86400;

/**
 * Initiate a magic-link send. ALWAYS resolves successfully so callers can't
 * use the response to determine whether an email is on the allowlist.
 *
 * @param {string} rawEmail
 * @param {string} ip
 * @returns {Promise<{ sent: boolean }>} sent=true ONLY for telemetry/tests; the
 *   public-facing route should ignore this and always return the same message.
 */
export async function startMagicLink(rawEmail, ip) {
  const email = normalizeEmail(rawEmail);

  // Per-email and per-IP rate limit (defence in depth against enumeration).
  const perEmail = rateLimit(`magic:email:${email}`, config.magicLinkRateLimit, 60 * 60 * 1000);
  const perIp = rateLimit(`magic:ip:${ip}`, 30, 60 * 60 * 1000);
  if (!perEmail.ok || !perIp.ok) {
    // Silently succeed from the user's perspective — we don't reveal rate-limit
    // hits per-email either.
    return { sent: false };
  }

  if (!isAllowed(email)) {
    // Pretend to take the same amount of work as a real send. Cheap timing
    // mitigation; real protection is at the rate-limit layer above.
    await artificialDelay();
    return { sent: false };
  }

  const token = randomToken(32);
  const tokenHash = hmac(token, config.sessionSecret);
  const now = Date.now();
  db.prepare(
    `INSERT INTO magic_links (token_hash, email, created_at, expires_at, ip)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tokenHash, email, now, now + MAGIC_LINK_TTL_MS, ip);

  const link = `${config.appUrl}/auth/callback?token=${encodeURIComponent(token)}`;
  const eventName = getEventConfig().name;
  await sendEmail({
    to: email,
    subject: `Sign in to ${eventName} Rideshare`,
    text:
      `Hi,\n\n` +
      `Click this link to sign in to ${eventName} Rideshare:\n\n${link}\n\n` +
      `This link expires in 15 minutes. If you didn't request it, ignore this email.\n`,
    html: magicLinkHtml({ link, eventName }),
  });
  return { sent: true };
}

/**
 * Consume a magic-link token: validate, mint a session, upsert the user.
 * @param {string} rawToken
 * @param {string} ip
 * @param {string} userAgent
 * @returns {{ ok: true, sessionId: string, userId: number, email: string } | { ok: false, reason: string }}
 */
export function consumeMagicLink(rawToken, ip, userAgent) {
  if (!rawToken) return { ok: false, reason: "Missing token" };
  const tokenHash = hmac(rawToken, config.sessionSecret);
  const row = db
    .prepare(
      `SELECT email, expires_at, used_at FROM magic_links WHERE token_hash = ?`,
    )
    .get(tokenHash);
  if (!row) return { ok: false, reason: "Invalid or expired link" };
  if (row.used_at != null) return { ok: false, reason: "Link already used" };
  if (row.expires_at < Date.now()) {
    return { ok: false, reason: "Link expired — request a new one" };
  }

  const now = Date.now();
  db.prepare("UPDATE magic_links SET used_at = ? WHERE token_hash = ?").run(
    now,
    tokenHash,
  );

  // Defence in depth: double-check the email is still on the allowlist
  // (admin may have wiped it between request and use).
  if (!isAllowed(row.email)) {
    return { ok: false, reason: "No longer registered for this event" };
  }

  // Upsert user
  let user = /** @type {any} */ (
    db.prepare("SELECT id, email FROM users WHERE email = ?").get(row.email)
  );
  if (!user) {
    const r = db
      .prepare(
        `INSERT INTO users (email, created_at, last_seen_at) VALUES (?, ?, ?)`,
      )
      .run(row.email, now, now);
    user = { id: Number(r.lastInsertRowid), email: row.email };
  } else {
    db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(
      now,
      user.id,
    );
  }

  const sessionId = randomToken(32);
  const expiresAt = now + config.sessionLifetimeDays * SECONDS_PER_DAY * 1000;
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, user.id, now, expiresAt, (userAgent || "").slice(0, 200));

  audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "auth.signin",
    ip,
  });

  return { ok: true, sessionId, userId: user.id, email: user.email };
}

/**
 * Resolve the authenticated user from a request, if any. Returns null otherwise.
 * @param {import("node:http").IncomingMessage} req
 * @returns {{ id: number, email: string, displayName: string|null, contactMethod: string|null, isAdmin: boolean } | null}
 */
export function getCurrentUser(req) {
  const sessionId = parseCookie(req.headers.cookie || "")[SESSION_COOKIE];
  if (!sessionId) return null;
  const row = /** @type {any} */ (
    db
      .prepare(
        `SELECT s.expires_at, u.id, u.email, u.display_name, u.contact_method
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      )
      .get(sessionId)
  );
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    contactMethod: row.contact_method,
    isAdmin: config.adminEmails.includes(row.email),
  };
}

/**
 * Sign out: delete the session row.
 * @param {import("node:http").IncomingMessage} req
 */
export function signOut(req) {
  const sessionId = parseCookie(req.headers.cookie || "")[SESSION_COOKIE];
  if (!sessionId) return;
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

/** @param {string} sessionId */
export function sessionCookieHeader(sessionId) {
  const maxAge = config.sessionLifetimeDays * SECONDS_PER_DAY;
  const secure = config.appUrl.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookieHeader() {
  const secure = config.appUrl.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0`;
}

/** @param {string} cookieHeader */
function parseCookie(cookieHeader) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of cookieHeader.split(/;\s*/)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function artificialDelay() {
  // 50–150ms jitter — slightly mask the work-difference between hit/miss.
  return new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 100)));
}

/** @param {{link: string, eventName: string}} args */
function magicLinkHtml({ link, eventName }) {
  // Inline-styled, no external assets — works everywhere.
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:480px;margin:32px auto;padding:24px;">
    <h2 style="margin:0 0 16px;">Sign in to ${escapeHtml(eventName)} Rideshare</h2>
    <p>Click the button below to sign in. This link expires in 15 minutes.</p>
    <p style="margin:24px 0;">
      <a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Sign in</a>
    </p>
    <p style="font-size:13px;color:#666;">If the button doesn't work, paste this URL into your browser:<br><span style="word-break:break-all;">${escapeHtml(link)}</span></p>
    <p style="font-size:13px;color:#666;">Didn't request this? You can safely ignore this email.</p>
  </body></html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
