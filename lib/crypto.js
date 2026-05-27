// @ts-check
/**
 * Cryptographic helpers — HMACs, signed tokens, constant-time compare,
 * random tokens. Only uses node:crypto.
 */

import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { config } from "./config.js";

/**
 * HMAC-SHA256(message, key) → hex string.
 * @param {string} message
 * @param {string} key
 */
export function hmac(message, key) {
  return createHmac("sha256", key).update(message).digest("hex");
}

/**
 * Constant-time string equality. Returns false for length mismatches
 * (length is not secret here, since hashes are fixed length).
 * @param {string} a
 * @param {string} b
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Random URL-safe token. 32 bytes = 256 bits of entropy.
 * @param {number} bytes
 */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Normalize an email address for hashing/lookup.
 *  - lowercase
 *  - trim whitespace
 *  - strip Gmail-style "+tags" and dots in the local-part for gmail.com
 *
 * Doing this consistently means people can sign in with the same address
 * shape they used at registration even if punctuation differs slightly.
 *
 * @param {string} email
 */
export function normalizeEmail(email) {
  if (typeof email !== "string") return "";
  let e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at === -1) return e;
  let local = e.slice(0, at);
  const domain = e.slice(at + 1);
  // Strip + tag for everyone (very common convention)
  const plus = local.indexOf("+");
  if (plus !== -1) local = local.slice(0, plus);
  // Strip dots only for gmail/googlemail
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
  }
  return `${local}@${domain}`;
}

/**
 * HMAC an email against ALLOWLIST_SALT. Used to store and compare allowlist
 * entries without retaining raw emails.
 * @param {string} email — already normalized OK; we re-normalize for safety
 */
export function hashEmailForAllowlist(email) {
  return hmac(normalizeEmail(email), config.allowlistSalt);
}

/**
 * Signed token: payload encoded as base64url JSON + HMAC suffix.
 * Used for magic-link tokens. (Sessions use opaque random IDs in DB.)
 *
 *   token = base64url(JSON(payload)) + "." + hex(hmac(payload, secret))
 *
 * @param {object} payload
 * @returns {string}
 */
export function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmac(body, config.sessionSecret);
  return `${body}.${sig}`;
}

/**
 * Verify and decode a token produced by signPayload. Returns payload or null.
 * @param {string} token
 */
export function verifyPayload(token) {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(body, config.sessionSecret);
  if (!safeEqual(sig, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
