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
 *   /logo
 *     → served from the assets table in the DB (uploaded via /admin/config).
 *       Falls back to 404 (the layout omits the <img> tag if no logo exists).
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, extname, basename } from "node:path";

import { get } from "../lib/router.js";
import { config } from "../lib/config.js";
import { getAsset } from "../lib/assets.js";

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
  if (!abs.startsWith(PUBLIC_DIR + "/") && abs !== PUBLIC_DIR) return null;
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
for (const name of [
  "styles.css",
  "app.js",
  "map.js",
  "favicon.svg",
  "robots.txt",
]) {
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
  ctx.res.setHeader("Content-Type", TYPES[extname(abs).toLowerCase()] || "application/octet-stream");
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
  ctx.res.setHeader("Content-Type", TYPES[extname(abs).toLowerCase()] || "application/octet-stream");
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
  ctx.res.setHeader("Cache-Control", "public, max-age=300");
  ctx.res.setHeader("ETag", `"logo-${a.updatedAt}"`);
  ctx.res.end(a.bytes);
});
