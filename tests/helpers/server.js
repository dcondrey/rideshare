// @ts-check
/**
 * Spawn the real HTTP server in-process on a random port for E2E tests.
 *
 * Usage:
 *   const srv = await startTestServer();
 *   const r = await srv.fetch("/some/path");
 *   ...
 *   await srv.close();
 *
 * Each call to startTestServer() returns a fresh server bound to a fresh
 * temporary database file.
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupTestEnv } from "./env.js";

/**
 * @returns {Promise<{
 *   port: number,
 *   url: string,
 *   fetch: (path: string, init?: RequestInit) => Promise<Response>,
 *   close: () => Promise<void>,
 *   tmpDir: string,
 * }>}
 */
export async function startTestServer(envOverrides = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "rs-test-"));
  const dbPath = join(tmpDir, "test.db");
  setupTestEnv({
    DATABASE_PATH: dbPath,
    APP_URL: "http://127.0.0.1:0",
    PORT: "0",
    NODE_ENV: "test",
    ...envOverrides,
  });

  // Bust the module cache so each server gets a fresh module graph
  // (necessary because lib/db.js singleton would otherwise be shared).
  // We do this by importing with a query string.
  const tag = `?test=${Math.random().toString(36).slice(2)}&t=${Date.now()}`;
  const router = await import(`../../lib/router.js${tag}`);
  // Trigger registration of routes
  await import(`../../routes/auth.js${tag}`);
  await import(`../../routes/rides.js${tag}`);
  await import(`../../routes/admin.js${tag}`);
  await import(`../../routes/map.js${tag}`);
  await import(`../../routes/trust.js${tag}`);
  await import(`../../routes/well-known.js${tag}`);
  await import(`../../routes/static.js${tag}`);
  const cfg = await import(`../../lib/config.js${tag}`);
  // Initialize signing key
  await (await import(`../../lib/trust.js${tag}`)).getDeploymentKey();

  const server = createServer((req, res) => {
    router.dispatch(req, res, { trustProxy: false }).catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = /** @type {{ port: number }} */ (server.address());
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    port: addr.port,
    url,
    tmpDir,
    fetch: (path, init = {}) => fetch(url + path, { redirect: "manual", ...init }),
    close: async () => {
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve(undefined))),
      );
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
