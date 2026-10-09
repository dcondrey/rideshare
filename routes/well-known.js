// @ts-check
/**
 * /.well-known/did.json — the deployment's DID document.
 * /.well-known/jwt-vc-issuer — the SD-JWT VC issuer's keys.
 * /vct/ride-attendance — SD-JWT VC Type Metadata for the ride credential.
 *
 * This is the public anchor that lets ANY other deployment (or W3C-compliant
 * verifier) resolve our did:web identifier and verify credentials we issue.
 */

import { get } from "../lib/router.js";
import { getDeploymentDidDocument, jwtVcIssuerMetadata, rideVct } from "../lib/trust.js";

/**
 * Public, cacheable JSON that any wallet or verifier may fetch cross-origin.
 * @param {{ res: import("node:http").ServerResponse }} ctx
 * @param {unknown} body
 * @param {string} [type]
 */
function publicJson(ctx, body, type = "application/json") {
  ctx.res.statusCode = 200;
  ctx.res.setHeader("Content-Type", `${type}; charset=utf-8`);
  ctx.res.setHeader("Cache-Control", "public, max-age=300");
  ctx.res.setHeader("Access-Control-Allow-Origin", "*");
  ctx.res.end(JSON.stringify(body, null, 2));
}

// SD-JWT VC draft-19 §4: the issuer's keys, for verifiers of its SD-JWT VCs.
get("/.well-known/jwt-vc-issuer", async (ctx) => {
  publicJson(ctx, jwtVcIssuerMetadata());
});

// SD-JWT VC draft-19 §5: Type Metadata, served at the vct URL itself.
get("/vct/ride-attendance", async (ctx) => {
  publicJson(ctx, {
    vct: rideVct(),
    name: "Ride attendance",
    description:
      "Attests that the holder shared a ride with another attendee at an event, as confirmed by both of them.",
    display: [
      { locale: "en", name: "Ride attendance", description: "A ride shared with another attendee" },
    ],
  });
});

get("/.well-known/did.json", async (ctx) => {
  ctx.res.statusCode = 200;
  ctx.res.setHeader("Content-Type", "application/did+json; charset=utf-8");
  ctx.res.setHeader("Cache-Control", "public, max-age=300");
  ctx.res.setHeader("Access-Control-Allow-Origin", "*");
  ctx.res.end(JSON.stringify(getDeploymentDidDocument(), null, 2));
});
