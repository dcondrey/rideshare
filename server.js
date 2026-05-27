// @ts-check
/**
 * Entry point. Boots the HTTP server, registers routes, handles signals.
 *
 * Usage:
 *   node --no-warnings=ExperimentalWarning server.js
 *
 * Or:  npm start  (which sets the warning flag for you)
 */

import { createServer } from "node:http";

import { config } from "./lib/config.js";
import { dispatch } from "./lib/router.js";

// Importing each routes/* file registers its handlers via the router.
// Order matters only insofar as `static.js` defines /styles.css etc.,
// which must not collide with route patterns above.
import "./routes/auth.js";
import "./routes/rides.js";
import "./routes/admin.js";
import "./routes/map.js";
import "./routes/trust.js";
import "./routes/well-known.js";
import "./routes/static.js";

// Seed event-defined meetups from event.config.yaml (only if table is empty).
import { seedMeetupsIfEmpty } from "./lib/meetups.js";
seedMeetupsIfEmpty();

// Initialize the deployment's signing key (one-time, then cached).
import { getDeploymentKey } from "./lib/trust.js";
getDeploymentKey();

const server = createServer((req, res) => {
  dispatch(req, res, { trustProxy: config.trustProxy }).catch((err) => {
    console.error("[server] unhandled:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.end("Internal server error");
    } else {
      try { res.end(); } catch {}
    }
  });
});

server.listen(config.port, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  console.log(
    `\n  ✓ ${config.event.name} Rideshare ready\n` +
      `    Local:    http://localhost:${port}\n` +
      `    Public:   ${config.appUrl}\n` +
      `    Database: ${config.databasePath}\n` +
      `    Email:    ${config.resendApiKey ? "Resend" : config.smtp.host ? `SMTP (${config.smtp.host})` : "NONE — set RESEND_API_KEY or SMTP_HOST"}\n` +
      `    Admins:   ${config.adminEmails.length ? config.adminEmails.join(", ") : "NONE — set ADMIN_EMAILS"}\n`,
  );
});

// Graceful shutdown so the HTTP server drains and SQLite gets a clean close.
function shutdown(signal) {
  console.log(`\n[server] received ${signal}, shutting down…`);
  server.close(() => {
    console.log("[server] closed");
    process.exit(0);
  });
  // Force-exit after 10s in case a hung connection blocks close.
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
