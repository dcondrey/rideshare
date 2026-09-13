// @ts-check
/**
 * Tiny HTTP router.
 *
 * Routes are registered with method + path pattern. Patterns support
 * `:param` segments (matched as `[^/]+`). The matched params are exposed
 * on the request context as `ctx.params`.
 *
 * Handlers are async functions of (ctx) → void. They use ctx helpers to
 * write responses (render HTML, redirect, json, etc.).
 *
 * The router also handles cookies, query/body parsing, and auth resolution.
 */

import { Buffer } from "node:buffer";
import { getCurrentUser, parseCookie } from "./auth.js";
import { config } from "./config.js";
import { hmac, randomToken, safeEqual } from "./crypto.js";
import { html, layout } from "./html.js";
import { error as logError, warn as logWarn } from "./log.js";
import { ValidationError } from "./validate.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB cap (allowlist CSV needs more — see /admin/allowlist)
const MAX_BODY_BYTES_ALLOWLIST = 10 * 1024 * 1024; // 10MB for CSV uploads
const HANDLER_TIMEOUT_MS = 25_000;

const CSRF_COOKIE = "rs_csrf";
const CSRF_FIELD = "_csrf";
const SESSION_COOKIE = "rs_session";
const CSRF_NONCE_BYTES = 32;

/**
 * @typedef {Object} RouteCtx
 * @property {import("node:http").IncomingMessage} req
 * @property {import("node:http").ServerResponse} res
 * @property {string} method
 * @property {string} pathname
 * @property {Record<string, string>} params
 * @property {Record<string, string>} query
 * @property {() => Promise<Record<string, string>>} formBody
 * @property {() => Promise<Buffer>} rawBody
 * @property {() => Promise<unknown>} jsonBody
 * @property {() => string} ip
 * @property {ReturnType<typeof getCurrentUser>} user
 * @property {(html: string, status?: number, headers?: Record<string,string>) => void} html
 * @property {(url: string, status?: number, extra?: Record<string,string>) => void} redirect
 * @property {(value: unknown, status?: number) => void} json
 * @property {(message: string, status?: number) => void} error
 * @property {(name: string, value: string) => void} setHeader
 * @property {() => string} csrf
 * @property {() => import("./html.js").RawHtml} csrfField
 */

/**
 * @typedef {(ctx: RouteCtx) => Promise<void> | void} Handler
 */

const routes = [];

/**
 * @param {string} method
 * @param {string} pattern
 * @param {Handler} handler
 */
function register(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    "^" +
      pattern.replace(/\/$/g, "").replace(/:([A-Za-z0-9_]+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "/?$",
  );
  routes.push({ method: method.toUpperCase(), regex, keys, handler, pattern });
}

/** @param {string} p @param {Handler} h */
export const get = (p, h) => register("GET", p, h);
/** @param {string} p @param {Handler} h */
export const post = (p, h) => register("POST", p, h);

/**
 * Dispatch a request to its route, or 404.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ trustProxy: boolean }} opts
 */
export async function dispatch(req, res, opts) {
  const target = req.url || "/";
  // IMPORTANT: only origin-form targets. `new URL("//evil.com/x", base)` reads
  // the leading `//` as an authority and hands back pathname `/x`, so a target
  // the legacy parser left unmatched would start resolving to a real route.
  if (!target.startsWith("/") || target.startsWith("//")) {
    res.statusCode = 400;
    res.end();
    return;
  }
  /** @type {URL} */
  let url;
  try {
    url = new URL(target, "http://localhost");
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }
  const pathname = url.pathname.replace(/\/+$/g, "") || "/";
  const method = (req.method || "GET").toUpperCase();

  const ctx = makeCtx(req, res, method, pathname, url, opts);

  // Applied before the handler runs so that handlers writing bytes straight to
  // ctx.res (routes/static.js) are covered too. A handler needing a stricter
  // policy overrides the individual header after this point.
  for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);

  // Match
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.regex.exec(pathname);
    if (!m) continue;
    for (let i = 0; i < route.keys.length; i++) {
      ctx.params[route.keys[i]] = decodeURIComponent(m[i + 1]);
    }
    const startedAt = Date.now();
    /** @type {NodeJS.Timeout | undefined} */
    let timeoutId;
    try {
      await Promise.race([
        route.handler(ctx),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("Request timeout")), HANDLER_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      handleError(ctx, err);
    } finally {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startedAt;
      if (durationMs > 1000) {
        logWarn("slow request", {
          method: ctx.method,
          path: ctx.pathname,
          duration_ms: durationMs,
        });
      }
    }
    return;
  }

  notFound(ctx);
}

/**
 * Build the per-request context object with helpers.
 */
function makeCtx(req, res, method, pathname, url, opts) {
  const ctx = /** @type {RouteCtx} */ ({});
  ctx.req = req;
  ctx.res = res;
  ctx.method = method;
  ctx.pathname = pathname;
  ctx.params = {};
  /** @type {Record<string,string>} */
  const query = {};
  // First value wins: the legacy node:url parser returned an array for a
  // repeated key, and every consumer here is typed for a single string.
  for (const [k, v] of url.searchParams) {
    if (!(k in query)) query[k] = v;
  }
  ctx.query = query;

  /** @type {Promise<Buffer> | null} */
  let bodyPromise = null;
  ctx.rawBody = () => {
    if (bodyPromise) return bodyPromise;
    const isAllowlist = pathname === "/admin/allowlist";
    const limit = isAllowlist ? MAX_BODY_BYTES_ALLOWLIST : MAX_BODY_BYTES;
    bodyPromise = readBody(req, limit);
    return bodyPromise;
  };
  ctx.formBody = async () => {
    const buf = await ctx.rawBody();
    return parseUrlEncoded(buf.toString("utf8"));
  };
  ctx.jsonBody = async () => {
    const buf = await ctx.rawBody();
    if (buf.length === 0) return null;
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch {
      throw new ValidationError("body", "must be valid JSON");
    }
  };
  ctx.ip = () => clientIp(req, opts.trustProxy);

  ctx.user = getCurrentUser(req);

  // REQUIRED: csrf() must be called before the response is written — it emits a
  // Set-Cookie header. Rendering a form through csrfField() satisfies that,
  // because template arguments are evaluated before ctx.html() runs.
  // IMPORTANT: the token binds to the session id on the *request*, so a handler
  // that signs a user in and renders a protected form in the same response would
  // embed a token for the old session. Sign-in redirects instead (routes/auth.js),
  // so the form is always rendered by a later request carrying the new cookie.
  let csrfValue = null;
  ctx.csrf = () => {
    if (csrfValue) return csrfValue;
    const existing = parseCookie(req.headers.cookie || "")[CSRF_COOKIE];
    let nonce = isMintedNonce(existing) ? existing : null;
    if (!nonce) {
      nonce = randomToken(CSRF_NONCE_BYTES);
      appendHeader(res, "Set-Cookie", csrfCookieHeader(nonce));
    }
    csrfValue = csrfToken(nonce, sessionIdOf(req));
    return csrfValue;
  };
  ctx.csrfField = () => html`<input type="hidden" name="${CSRF_FIELD}" value="${ctx.csrf()}">`;

  ctx.setHeader = (name, value) => res.setHeader(name, value);
  ctx.html = (body, status = 200, headers = {}) => {
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers)) appendHeader(res, k, v);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(body);
  };
  ctx.redirect = (url, status = 303, extra = {}) => {
    res.statusCode = status;
    for (const [k, v] of Object.entries(extra)) appendHeader(res, k, v);
    res.setHeader("Location", url);
    res.end();
  };
  ctx.json = (value, status = 200) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(value));
  };
  ctx.error = (message, status = 400) => {
    ctx.html(
      layout({
        title: "Something went wrong",
        user: ctx.user,
        children: html`
          <section class="empty">
            <h1>Hmm.</h1>
            <p>${message}</p>
            <p><a class="button" href="/">Go home</a></p>
          </section>
        `,
      }),
      status,
    );
  };
  return ctx;
}

/**
 * Cookie carrying the CSRF token. HttpOnly: the token reaches the page through
 * a server-rendered hidden field, so no script ever needs to read it.
 * @param {string} token
 */
function csrfCookieHeader(token) {
  const secure = config.appUrl.startsWith("https://") ? "; Secure" : "";
  return `${CSRF_COOKIE}=${token}; Path=/; HttpOnly${secure}; SameSite=Lax`;
}

/**
 * True when `value` is a nonce this server could have minted, decided by
 * decoding it rather than by matching a pattern: base64url-decode it and
 * re-encode, and it round-trips only if it is exactly the CSRF_NONCE_BYTES-byte
 * value `randomToken` produces. Node's decoder is lenient, so the re-encode is
 * what rejects stray characters, padding, and multibyte input.
 * @param {string | undefined} value
 * @returns {value is string}
 */
function isMintedNonce(value) {
  if (typeof value !== "string") return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === CSRF_NONCE_BYTES && decoded.toString("base64url") === value;
}

/**
 * Session id from the request cookie, or "" when signed out. Anonymous callers
 * all share the empty binding; the signature still gates them, since the nonce
 * alone is not a valid token.
 * @param {import("node:http").IncomingMessage} req
 */
function sessionIdOf(req) {
  return parseCookie(req.headers.cookie || "")[SESSION_COOKIE] || "";
}

/**
 * Signed double-submit token: the cookie nonce plus an HMAC binding it to the
 * session it was issued for.
 *
 * Plain double-submit trusts the cookie jar, and the cookie jar is shared across
 * a registrable domain — a sibling subdomain can write `rs_csrf` for the parent
 * domain and then submit the matching field. It cannot produce the signature,
 * which is what closes that path; binding to the session id additionally stops
 * one signed-in user replaying their own token into another user's session.
 * @param {string} nonce
 * @param {string} sessionId
 */
function csrfToken(nonce, sessionId) {
  return `${nonce}.${hmac(`${sessionId}.${nonce}`, config.sessionSecret)}`;
}

/**
 * Wrap a POST handler with signed double-submit CSRF validation: the `_csrf`
 * form field must be `csrfToken()` recomputed over the `rs_csrf` cookie nonce
 * and the request's session id. Opt-in per route — the sign-out form and the
 * /rides/:id/confirm fetch() carry no token.
 *
 * NOTE: the body is read before the wrapped handler runs, so an unauthenticated
 * POST to an admin route is read to the cap and answered 403 rather than being
 * redirected by requireAdmin. Standard middleware ordering; the cap still holds.
 * @param {Handler} handler
 * @returns {Handler}
 */
export function csrfProtected(handler) {
  return async (ctx) => {
    const cookieNonce = parseCookie(ctx.req.headers.cookie || "")[CSRF_COOKIE];
    const body = await ctx.formBody();
    const submitted = body[CSRF_FIELD] || "";
    // No shape check on `submitted`: safeEqual compares encoded buffers and is
    // total over any string, so an unparseable field simply fails to match.
    if (
      !isMintedNonce(cookieNonce) ||
      !safeEqual(submitted, csrfToken(cookieNonce, sessionIdOf(ctx.req)))
    ) {
      logWarn("csrf rejected", { method: ctx.method, path: ctx.pathname });
      ctx.error("That form expired or came from the wrong place. Reload and try again.", 403);
      return;
    }
    await handler(ctx);
  };
}

function appendHeader(res, key, value) {
  const existing = res.getHeader(key);
  if (existing == null) res.setHeader(key, value);
  else if (Array.isArray(existing)) res.setHeader(key, [...existing, value]);
  else res.setHeader(key, [String(existing), value]);
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    // Deny every powerful feature: this app uses none of them. The map is
    // pan/zoom only and never asks for the visitor's position, so geolocation
    // stays denied too. Listing them explicitly means a future dependency
    // cannot quietly start using one.
    "Permissions-Policy": [
      "accelerometer=()",
      "autoplay=()",
      "browsing-topics=()",
      "camera=()",
      "display-capture=()",
      "encrypted-media=()",
      "fullscreen=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      // Denied because nothing uses it. Becomes `self` if WebAuthn ships —
      // docs/intentional-non-features.md has it planned for v0.5.
      "publickey-credentials-get=()",
      "screen-wake-lock=()",
      "serial=()",
      "usb=()",
      "xr-spatial-tracking=()",
    ].join(", "),
    "Content-Security-Policy":
      // img-src allows https: so map tiles (from CartoDB / OSM / Stadia /
      // user-configured custom providers) can be displayed. The brand colour
      // ships as /brand.css, so no inline style is needed.
      // 'inline-speculation-rules' permits <script type="speculationrules"> and
      // nothing else — it does not allow any executable inline script. It is
      // what lets the CSP stay nonce-free: the alternative, 'strict-dynamic'
      // with a per-request nonce, ignores 'self' and would mean threading a
      // nonce into every <script src> in routes/ to buy one inline JSON block.
      "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self' 'inline-speculation-rules'; connect-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
  };
}

let warnedUntrustedProxy = false;

function clientIp(req, trustProxy) {
  const xff = req.headers["x-forwarded-for"];
  if (trustProxy) {
    if (typeof xff === "string" && xff.length > 0) {
      // IMPORTANT: the *rightmost* hop is the address our own proxy observed.
      // Everything to its left was supplied by the client, so keying a rate
      // limit on the leftmost entry lets an attacker rotate out of the bucket.
      const hops = xff.split(",");
      const last = hops[hops.length - 1].trim();
      if (last.length > 0) return last;
    }
  } else if (typeof xff === "string" && xff.length > 0 && !warnedUntrustedProxy) {
    // Running behind a proxy with TRUST_PROXY unset collapses every visitor
    // into one per-IP rate-limit bucket. Say so once rather than silently
    // rejecting the 31st sign-in of the hour for the whole event.
    warnedUntrustedProxy = true;
    logWarn("X-Forwarded-For seen but TRUST_PROXY is off; per-IP limits key on the proxy address");
  }
  return req.socket.remoteAddress || "0.0.0.0";
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let timeoutId;
    const resetTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        req.destroy();
        reject(new Error("Request body read timeout"));
      }, 10000);
    };
    resetTimeout();
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        clearTimeout(timeoutId);
        req.destroy();
        reject(new BodyTooLarge(`Body exceeds ${maxBytes} bytes`));
        return;
      }
      resetTimeout();
      chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timeoutId);
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

class BodyTooLarge extends Error {}

/** @param {string} s */
function parseUrlEncoded(s) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!s) return out;
  for (const part of s.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = decodeURIComponent((eq === -1 ? part : part.slice(0, eq)).replace(/\+/g, " "));
    const v = eq === -1 ? "" : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
    // Preserve last value for repeated keys (good enough for our forms;
    // we don't have any multi-select inputs).
    out[k] = v;
  }
  return out;
}

function notFound(ctx) {
  ctx.html(
    layout({
      title: "Not found",
      user: ctx.user,
      children: html`
        <section class="empty">
          <h1>404</h1>
          <p>That page doesn't exist.</p>
          <p><a class="button" href="/">Go home</a></p>
        </section>
      `,
    }),
    404,
  );
}

function handleError(ctx, err) {
  if (err instanceof ValidationError) {
    return ctx.error(err.userMessage || err.message, 400);
  }
  if (err instanceof BodyTooLarge) {
    return ctx.error("That upload is too large.", 413);
  }
  logError("unhandled request error", { method: ctx.method, path: ctx.pathname, err });
  ctx.error("Something went wrong on our end.", 500);
}
