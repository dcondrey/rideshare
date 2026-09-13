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
import { db } from "./lib/db.js";
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
import "./routes/health.js";
import "./routes/static.js";

// Seed the attendee allowlist from ./allowlist.csv (only if table is empty).
import { seedAllowlistIfEmpty } from "./lib/allowlist.js";
// Seed event-defined meetups from event.config.yaml (only if table is empty).
import { seedMeetupsIfEmpty } from "./lib/meetups.js";

seedMeetupsIfEmpty();
seedAllowlistIfEmpty();

import { info, error as logError } from "./lib/log.js";
// Initialize the deployment's signing key (one-time, then cached).
import { getDeploymentKey, revalidateImportedCredentials } from "./lib/trust.js";

getDeploymentKey();

// Imported credentials are counted forever once verified, so a background
// sweep re-checks the stalest few. Deliberately not on the /trust render path:
// a GET must not fire outbound did:web fetches, which is the same reason
// /trust/credentials.json is excluded from speculative prefetch.
const CREDENTIAL_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
function sweepCredentials() {
  revalidateImportedCredentials({ limit: 20 })
    .then(({ checked, invalidated }) => {
      if (checked > 0) {
        info(`[trust] re-verified ${checked} imported credentials, ${invalidated} now invalid`);
      }
    })
    .catch((err) => {
      logError("imported-credential sweep failed", {
        component: "trust",
        err: err instanceof Error ? err.message : String(err),
      });
    });
}
setInterval(sweepCredentials, CREDENTIAL_SWEEP_INTERVAL_MS).unref();

const server = createServer((req, res) => {
  dispatch(req, res, { trustProxy: config.trustProxy }).catch((err) => {
    console.error("[server] unhandled:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.end("Internal server error");
    } else {
      try {
        res.end();
      } catch {}
    }
  });
});

server.listen(config.port, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  const transport = config.resendApiKey
    ? "Resend"
    : config.smtp.host
      ? `SMTP (${config.smtp.host})`
      : "NONE - set RESEND_API_KEY or SMTP_HOST";
  const admins = config.adminEmails.length
    ? config.adminEmails.join(", ")
    : "NONE - set ADMIN_EMAILS";
  info(
    `\n  ${config.event.name} Rideshare ready\n` +
      `    Local:    http://localhost:${port}\n` +
      `    Public:   ${config.appUrl}\n` +
      `    Database: ${config.databasePath}\n` +
      `    Email:    ${transport}\n` +
      `    Admins:   ${admins}\n`,
  );
});

// Graceful shutdown so the HTTP server drains and SQLite gets a clean close.
function shutdown(signal) {
  info(`\n[server] received ${signal}, shutting down...`);
  server.close(() => {
    closeDatabase();
    info("[server] closed");
    process.exit(0);
  });
  // Force-exit after 10s in case a hung connection blocks close. The database
  // still gets its close: in WAL mode that is what checkpoints the -wal file
  // back into the database, and skipping it leaves a snapshot to recover from.
  setTimeout(() => {
    closeDatabase();
    process.exit(0);
  }, 10000).unref();
}

let dbClosed = false;
function closeDatabase() {
  if (dbClosed) return;
  dbClosed = true;
  try {
    db.close();
  } catch (err) {
    logError("database close failed during shutdown", {
      component: "server",
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// A rejected promise nobody handled has already skipped whatever error path the
// handler meant to take, so the process state is unknown. Exit non-zero and let
// the supervisor restart us rather than serve from it.
process.on("unhandledRejection", (reason) => {
  logError("unhandled rejection; exiting", {
    component: "server",
    err: reason instanceof Error ? reason.message : String(reason),
  });
  process.exit(1);
});
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
