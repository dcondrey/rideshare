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

import { parse as parseUrl } from "node:url";
import { Buffer } from "node:buffer";

import { ValidationError } from "./validate.js";
import { getCurrentUser } from "./auth.js";
import { layout } from "./html.js";
import { html } from "./html.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB cap (allowlist CSV needs more — see /api/admin/allowlist)
const MAX_BODY_BYTES_ALLOWLIST = 10 * 1024 * 1024; // 10MB for CSV uploads

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
      pattern
        .replace(/\/$/g, "")
        .replace(/:([A-Za-z0-9_]+)/g, (_, k) => {
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
  const url = parseUrl(req.url || "/", true);
  const pathname = (url.pathname || "/").replace(/\/+$/g, "") || "/";
  const method = (req.method || "GET").toUpperCase();

  const ctx = makeCtx(req, res, method, pathname, url, opts);

  // Match
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.regex.exec(pathname);
    if (!m) continue;
    for (let i = 0; i < route.keys.length; i++) {
      ctx.params[route.keys[i]] = decodeURIComponent(m[i + 1]);
    }
    try {
      await route.handler(ctx);
    } catch (err) {
      handleError(ctx, err);
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
  ctx.query = /** @type {Record<string,string>} */ (url.query || {});

  let bodyPromise = null;
  ctx.rawBody = () => {
    if (bodyPromise) return bodyPromise;
    const isAllowlist = pathname === "/api/admin/allowlist";
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
    return JSON.parse(buf.toString("utf8"));
  };
  ctx.ip = () => clientIp(req, opts.trustProxy);

  ctx.user = getCurrentUser(req);

  ctx.setHeader = (name, value) => res.setHeader(name, value);
  ctx.html = (body, status = 200, headers = {}) => {
    res.statusCode = status;
    for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);
    for (const [k, v] of Object.entries(headers)) appendHeader(res, k, v);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(body);
  };
  ctx.redirect = (url, status = 303, extra = {}) => {
    res.statusCode = status;
    for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);
    for (const [k, v] of Object.entries(extra)) appendHeader(res, k, v);
    res.setHeader("Location", url);
    res.end();
  };
  ctx.json = (value, status = 200) => {
    res.statusCode = status;
    for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);
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
    "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
    "Content-Security-Policy":
      // img-src allows https: so map tiles (from CartoDB / OSM / Stadia /
      // user-configured custom providers) can be displayed. style-src
      // 'unsafe-inline' is needed for the per-page brand-color <style>.
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'",
  };
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
      return xff.split(",")[0].trim();
    }
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
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new BodyTooLarge(`Body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
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
  console.error(`[${ctx.method} ${ctx.pathname}]`, err);
  ctx.error("Something went wrong on our end.", 500);
}
