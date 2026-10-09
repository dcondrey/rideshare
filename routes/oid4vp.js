// @ts-check
/**
 * OpenID4VP 1.0 verifier endpoints (lib/oid4vp.js), the "verify an attendee"
 * page, and the in-app holder's request inspection.
 */

import { html, layout, raw } from "../lib/html.js";
import { error as logError } from "../lib/log.js";
import {
  clientId,
  createPresentationRequest,
  dcqlQuery,
  handleResponse,
  inspectRequest,
  requestObject,
  requestStatus,
} from "../lib/oid4vp.js";
import { qrSvg } from "../lib/qr.js";
import { rateLimit } from "../lib/rate-limit.js";
import { get, post } from "../lib/router.js";

get("/verify", async (ctx) => {
  ctx.html(
    layout({
      title: "Verify an attendee",
      user: ctx.user,
      path: ctx.pathname,
      children: html`
        <section class="page-head">
          <div>
            <h1>Verify an attendee</h1>
            <p class="muted">Ask someone's wallet to prove they shared a ride at this event, over OpenID4VP.</p>
          </div>
        </section>
        <section class="card">
          <p>
            This creates an OpenID4VP 1.0 request signed by this event's DID,
            <code class="break">${clientId()}</code>. It asks for one SD-JWT VC
            ride credential and only two of its claims:
          </p>
          <pre class="code-block">${JSON.stringify(dcqlQuery(), null, 2)}</pre>
          <form method="post" action="/verify/request">
            <button type="submit" class="button button-primary">Create a presentation request</button>
          </form>
        </section>
      `,
    }),
  );
});

post("/verify/request", async (ctx) => {
  if (!rateLimit(`oid4vp-request:${ctx.ip()}`, 30, 10 * 60 * 1000).ok) {
    ctx.error("Too many requests; try again in a few minutes.", 429);
    return;
  }
  const r = createPresentationRequest();
  ctx.html(
    layout({
      title: "Waiting for a wallet",
      user: ctx.user,
      children: html`
        <section class="page-head">
          <a class="link" href="/verify">← Verify</a>
          <h1>Waiting for a wallet</h1>
        </section>
        <section class="card oid4vci-offer">
          <p class="muted">Scan with an OpenID4VP wallet holding a ride credential from this event.</p>
          <div class="qr">${raw(qrSvg(r.walletUrl, { label: "Presentation request QR code" }))}</div>
          <p><a class="button" href="${r.walletUrl}">Open in a wallet on this device</a></p>
          <p><a class="button" href="/trust?request=${encodeURIComponent(r.walletUrl)}#answer-request">Answer with this browser's credential</a></p>
          <div class="oid4vp-status" data-oid4vp-status="${r.id}" aria-live="polite">
            <p class="muted">Waiting… the request expires at ${new Date(r.expiresAt).toISOString().slice(11, 16)} UTC.</p>
          </div>
        </section>
      `,
    }),
  );
});

get("/oid4vp/request/:id", async (ctx) => {
  const jwt = requestObject(ctx.params.id);
  ctx.res.setHeader("Access-Control-Allow-Origin", "*");
  ctx.res.setHeader("Cache-Control", "no-store");
  if (!jwt) {
    ctx.json(
      { error: "invalid_request_uri", error_description: "request not found, answered or expired" },
      404,
    );
    return;
  }
  ctx.res.statusCode = 200;
  ctx.res.setHeader("Content-Type", "application/oauth-authz-req+jwt");
  ctx.res.end(jwt);
});

post("/oid4vp/response", async (ctx) => {
  ctx.res.setHeader("Access-Control-Allow-Origin", "*");
  ctx.res.setHeader("Cache-Control", "no-store");
  try {
    const r = await handleResponse(await ctx.formBody());
    ctx.json(r.ok ? {} : { error: r.error }, r.ok ? 200 : 400);
  } catch (err) {
    logError("oid4vp response failed", { component: "oid4vp", err });
    ctx.json({ error: "server_error" }, 500);
  }
});

get("/oid4vp/status/:id", async (ctx) => {
  const s = requestStatus(ctx.params.id);
  ctx.res.setHeader("Cache-Control", "no-store");
  if (!s) {
    ctx.json({ status: "unknown" }, 404);
    return;
  }
  ctx.json(s);
});

// The in-app holder (public/trust.js) asks its own server to fetch and verify
// a request before showing it, so the request signature is checked with the
// same did:web resolution and egress policy as everything else.
post("/trust/oid4vp/inspect", async (ctx) => {
  if (!ctx.user) {
    ctx.json({ error: "sign in first" }, 401);
    return;
  }
  if (!rateLimit(`oid4vp-inspect:${ctx.user.id}`, 30, 10 * 60 * 1000).ok) {
    ctx.json({ error: "too many requests" }, 429);
    return;
  }
  const body = /** @type {Record<string, unknown> | null} */ (await ctx.jsonBody());
  try {
    ctx.json(await inspectRequest(String(body?.url || "")));
  } catch (err) {
    ctx.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
