// @ts-check
/**
 * GET /health — liveness/readiness probe for load balancers, uptime checks,
 * and the CI smoke test. Unauthenticated by design (it's a platform contract,
 * not an attendee- or admin-facing page) and carries no event-specific data.
 */

import { db } from "../lib/db.js";
import { get } from "../lib/router.js";
import { getDeploymentKey } from "../lib/trust.js";

get("/health", async (ctx) => {
  const checks = { db: false, signingKey: false };

  try {
    db.prepare("SELECT 1").get();
    checks.db = true;
  } catch {
    // checks.db stays false
  }

  try {
    // Cached after the first call (server.js calls it once at boot), so this
    // is a cheap read, not a fresh keypair generation on every health check.
    checks.signingKey = !!getDeploymentKey().did;
  } catch {
    // checks.signingKey stays false
  }

  const ok = checks.db && checks.signingKey;
  ctx.json({ status: ok ? "ok" : "error", checks }, ok ? 200 : 503);
});
