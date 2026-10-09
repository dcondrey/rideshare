// @ts-check
/**
 * Live map channel (lib/live.js):
 *   GET  /live/stream     Server-Sent Events for the signed-in user
 *   POST /live/position   share a point (JSON { lat, lng, accuracy })
 *   POST /live/stop       stop sharing
 */

import { sharePosition, stopSharing, subscribe } from "../lib/live.js";
import { rateLimit } from "../lib/rate-limit.js";
import { get, post } from "../lib/router.js";

get("/live/stream", async (ctx) => {
  if (!ctx.user) {
    ctx.json({ error: "sign in" }, 401);
    return;
  }
  subscribe(ctx.user.id, ctx.res);
});

post("/live/position", async (ctx) => {
  const user = ctx.user;
  if (!user) {
    ctx.json({ error: "sign in" }, 401);
    return;
  }
  // A phone reports every few seconds; anything faster is a bug or abuse.
  if (!rateLimit(`live-pos:${user.id}`, 40, 60 * 1000).ok) {
    ctx.json({ error: "too many updates" }, 429);
    return;
  }
  const b = /** @type {Record<string, unknown> | null} */ (await ctx.jsonBody());
  const lat = Number(b?.lat);
  const lng = Number(b?.lng);
  const acc = b?.accuracy == null ? null : Number(b.accuracy);
  if (
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    !Number.isFinite(lng) ||
    lng < -180 ||
    lng > 180
  ) {
    ctx.json({ error: "lat/lng out of range" }, 400);
    return;
  }
  if (acc !== null && (!Number.isFinite(acc) || acc < 0 || acc > 100_000)) {
    ctx.json({ error: "accuracy out of range" }, 400);
    return;
  }
  sharePosition(user.id, user.displayName || "Your ride partner", { lat, lng, accuracy: acc });
  ctx.json({ ok: true });
});

post("/live/stop", async (ctx) => {
  if (!ctx.user) {
    ctx.json({ error: "sign in" }, 401);
    return;
  }
  stopSharing(ctx.user.id);
  ctx.json({ ok: true });
});
