// @ts-check
/**
 * /.well-known/did.json — the deployment's DID document.
 *
 * This is the public anchor that lets ANY other deployment (or W3C-compliant
 * verifier) resolve our did:web identifier and verify credentials we issue.
 */

import { get } from "../lib/router.js";
import { getDeploymentDidDocument } from "../lib/trust.js";

get("/.well-known/did.json", async (ctx) => {
  ctx.res.statusCode = 200;
  ctx.res.setHeader("Content-Type", "application/did+json; charset=utf-8");
  ctx.res.setHeader("Cache-Control", "public, max-age=300");
  ctx.res.setHeader("Access-Control-Allow-Origin", "*");
  ctx.res.end(JSON.stringify(getDeploymentDidDocument(), null, 2));
});
