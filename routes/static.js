// @ts-check
/**
 * Static asset routes.
 *
 *   /styles.css, /app.js, /favicon.svg, /robots.txt, /map.js
 *     → served from public/ at top level.
 *
 *   /static/<file> and /static/lib/<file>
 *     → served from public/ and public/lib/ (generic, safe).
 *
 *   /brand.css
 *     → the single event brand colour as a custom property, served as a file so
 *       the page needs no inline <style> and the CSP can forbid inline styles.
 *
 *   /logo
 *     → served from the assets table in the DB (uploaded via /admin/config).
 *       Falls back to 404 (the layout omits the <img> tag if no logo exists).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { getAsset } from "../lib/assets.js";
import { config } from "../lib/config.js";
import { getEventConfig } from "../lib/event-config.js";
import { get } from "../lib/router.js";

const PUBLIC_DIR = resolve(config.rootDir, "public");

const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Resolve a relative path safely under PUBLIC_DIR. Returns null if unsafe. */
function safeResolve(relPath) {
  // Strip leading slashes; reject path traversal attempts.
  const cleaned = relPath.replace(/^\/+/, "");
  if (cleaned.includes("..") || cleaned.includes("\0")) return null;
  // Each segment must look like a normal filename.
  for (const seg of cleaned.split("/")) {
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) return null;
  }
  const abs = resolve(PUBLIC_DIR, cleaned);
  if (!abs.startsWith(`${PUBLIC_DIR}/`) && abs !== PUBLIC_DIR) return null;
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return abs;
}

function serveFile(ctx, abs) {
  const ext = extname(abs).toLowerCase();
  const type = TYPES[ext] || "application/octet-stream";
  ctx.res.statusCode = 200;
  ctx.res.setHeader("Content-Type", type);
  ctx.res.setHeader("Cache-Control", "public, max-age=300");
  ctx.res.end(readFileSync(abs));
}

/** Top-level convenience routes. */
for (const name of ["styles.css", "app.js", "map.js", "favicon.svg", "robots.txt"]) {
  get(`/${name}`, async (ctx) => {
    const abs = safeResolve(name);
    if (!abs) {
      ctx.res.statusCode = 404;
      ctx.res.end();
      return;
    }
    serveFile(ctx, abs);
  });
}

get("/brand.css", async (ctx) => {
  const event = getEventConfig();
  const brandColor = event.brand?.primaryColor || "#4f46e5";
  // The value is validated as a colour by the event-config loader; escape the
  // two characters that could close the declaration regardless.
  const safe = String(brandColor).replace(/[<>{}"';]/g, "");
  ctx.res.statusCode = 200;
  ctx.res.setHeader("Content-Type", "text/css; charset=utf-8");
  ctx.res.setHeader("Cache-Control", "no-cache");
  ctx.res.end(`:root { --brand: ${safe}; }\n`);
});

/** Generic /static/* — covers public/lib/leaflet.{js,css}, custom logos, etc. */
get("/static/:name", async (ctx) => {
  const abs = safeResolve(ctx.params.name);
  if (!abs) {
    ctx.res.statusCode = 404;
    ctx.res.end();
    return;
  }
  serveFile(ctx, abs);
});

get("/static/lib/:name", async (ctx) => {
  const abs = safeResolve(`lib/${ctx.params.name}`);
  if (!abs) {
    ctx.res.statusCode = 404;
    ctx.res.end();
    return;
  }
  // Vendored libraries are immutable per release — long cache.
  ctx.res.statusCode = 200;
  ctx.res.setHeader(
    "Content-Type",
    TYPES[extname(abs).toLowerCase()] || "application/octet-stream",
  );
  ctx.res.setHeader("X-Content-Type-Options", "nosniff");
  ctx.res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  ctx.res.end(readFileSync(abs));
});

/** Leaflet's CSS references images/* relative to itself. */
get("/static/lib/images/:name", async (ctx) => {
  const abs = safeResolve(`lib/images/${ctx.params.name}`);
  if (!abs) {
    ctx.res.statusCode = 404;
    ctx.res.end();
    return;
  }
  ctx.res.statusCode = 200;
  ctx.res.setHeader(
    "Content-Type",
    TYPES[extname(abs).toLowerCase()] || "application/octet-stream",
  );
  ctx.res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  ctx.res.end(readFileSync(abs));
});

/** Serve the logo from the DB (or fall through to 404). */
get("/logo", async (ctx) => {
  const a = getAsset("logo");
  if (!a) {
    ctx.res.statusCode = 404;
    ctx.res.end();
    return;
  }
  ctx.res.statusCode = 200;
  ctx.res.setHeader("Content-Type", a.mime);
  // This handler writes the response itself, so it gets none of the headers
  // lib/router.js applies in ctx.html/json/redirect. The asset is operator-
  // uploaded and served unauthenticated, so it carries its own lockdown: nothing
  // may load, and the declared type may not be second-guessed by the browser.
  ctx.res.setHeader("Content-Security-Policy", "default-src 'none'");
  ctx.res.setHeader("X-Content-Type-Options", "nosniff");
  ctx.res.setHeader("Cache-Control", "public, max-age=300");
  ctx.res.setHeader("ETag", `"logo-${a.updatedAt}"`);
  ctx.res.end(a.bytes);
});
