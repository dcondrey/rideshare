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
 * IMPORTANT: one server per test *process*. ESM has no cache-busting that
 * reaches transitive imports, so `lib/db.js` is a singleton for the lifetime of
 * the process and binds to whatever DATABASE_PATH was set when it was first
 * imported. Give each test file its own server, not each test case.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
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
 *   mod: (specifier: string) => Promise<any>,
 * }>}
 */
export async function startTestServer(envOverrides = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "rs-test-"));
  const dbPath = join(tmpDir, "test.db");
  setupTestEnv({
    DATABASE_PATH: dbPath,
    DEPLOYMENT_KEY_PATH: join(tmpDir, "deployment.key"),
    APP_URL: "http://127.0.0.1:0",
    PORT: "0",
    NODE_ENV: "test",
    ...envOverrides,
  });

  // Every import here is untagged and so shares one module graph with the code
  // under test. A `?tag` cache-bust would apply only to these entry modules —
  // routes/*.js import "../lib/router.js" with no tag, so they would register
  // their routes on a different router instance than the one dispatched below,
  // and every request would 404.
  const router = await import("../../lib/router.js");
  // Trigger registration of routes
  await import("../../routes/auth.js");
  await import("../../routes/rides.js");
  await import("../../routes/admin.js");
  await import("../../routes/map.js");
  await import("../../routes/trust.js");
  await import("../../routes/well-known.js");
  await import("../../routes/static.js");
  await import("../../lib/config.js");
  await (await import("../../lib/trust.js")).getDeploymentKey();

  /**
   * Reach into the server's module graph — to seed the database, mint tokens,
   * or assert on state the HTTP surface does not expose.
   * @param {string} specifier repo-relative, e.g. "lib/db.js"
   */
  const mod = (specifier) => import(`../../${specifier}`);

  const server = createServer((req, res) => {
    router.dispatch(req, res, { trustProxy: false }).catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const addr = /** @type {{ port: number }} */ (server.address());
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    port: addr.port,
    url,
    tmpDir,
    mod,
    fetch: (path, init = {}) => fetch(url + path, { redirect: "manual", ...init }),
    close: async () => {
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve(undefined))),
      );
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
