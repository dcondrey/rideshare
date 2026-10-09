// @ts-check
/**
 * OpenID4VCI 1.0 endpoints (lib/oid4vci.js) and the attendee's offer page.
 *
 * The wallet-facing endpoints carry no cookies, so they need no CSRF token;
 * they are authorized by the pre-authorized code + PIN, the access token, and
 * the proof JWT instead. Errors use the OAuth JSON shape.
 */

import { html, layout, raw } from "../lib/html.js";
import { error as logError } from "../lib/log.js";
import {
  authorizationServerMetadata,
  createOffer,
  exchangeToken,
  getOffer,
  issueCNonce,
  issueCredential,
  issuerMetadata,
  OAuthError,
} from "../lib/oid4vci.js";
import { qrSvg } from "../lib/qr.js";
import { rateLimit } from "../lib/rate-limit.js";
import { get, post } from "../lib/router.js";

/**
 * @param {import("../lib/router.js").RouteCtx} ctx
 * @param {unknown} body
 * @param {number} [status]
 */
function noStoreJson(ctx, body, status = 200) {
  ctx.res.setHeader("Cache-Control", "no-store");
  ctx.res.setHeader("Access-Control-Allow-Origin", "*");
  ctx.json(body, status);
}

/** @param {import("../lib/router.js").RouteCtx} ctx @param {unknown} err */
function oauthError(ctx, err) {
  if (err instanceof OAuthError) {
    if (err.status === 401) ctx.res.setHeader("WWW-Authenticate", `Bearer error="${err.code}"`);
    noStoreJson(ctx, { error: err.code, error_description: err.message }, err.status);
    return;
  }
  logError("oid4vci request failed", { component: "oid4vci", err });
  noStoreJson(ctx, { error: "server_error" }, 500);
}

get("/.well-known/openid-credential-issuer", async (ctx) => {
  ctx.res.setHeader("Access-Control-Allow-Origin", "*");
  ctx.res.setHeader("Cache-Control", "public, max-age=300");
  ctx.json(issuerMetadata());
});

get("/.well-known/oauth-authorization-server", async (ctx) => {
  ctx.res.setHeader("Access-Control-Allow-Origin", "*");
  ctx.res.setHeader("Cache-Control", "public, max-age=300");
  ctx.json(authorizationServerMetadata());
});

get("/oid4vci/offer/:id", async (ctx) => {
  const offer = getOffer(ctx.params.id);
  if (!offer) {
    noStoreJson(
      ctx,
      { error: "invalid_request", error_description: "offer not found, used or expired" },
      404,
    );
    return;
  }
  noStoreJson(ctx, offer);
});

post("/oid4vci/token", async (ctx) => {
  if (!rateLimit(`oid4vci-token:${ctx.ip()}`, 30, 10 * 60 * 1000).ok) {
    noStoreJson(ctx, { error: "slow_down" }, 429);
    return;
  }
  try {
    noStoreJson(ctx, exchangeToken(await ctx.formBody()));
  } catch (err) {
    oauthError(ctx, err);
  }
});

post("/oid4vci/nonce", async (ctx) => {
  if (!rateLimit(`oid4vci-nonce:${ctx.ip()}`, 60, 10 * 60 * 1000).ok) {
    noStoreJson(ctx, { error: "slow_down" }, 429);
    return;
  }
  noStoreJson(ctx, issueCNonce());
});

post("/oid4vci/credential", async (ctx) => {
  try {
    const body = await ctx.jsonBody();
    noStoreJson(ctx, issueCredential(String(ctx.req.headers.authorization || ""), body));
  } catch (err) {
    oauthError(ctx, err);
  }
});

// ── Attendee side: show an offer as a QR code plus PIN ─────────────────────
post("/trust/oid4vci/offer", async (ctx) => {
  const user = ctx.user;
  if (!user) {
    ctx.redirect("/");
    return;
  }
  const form = await ctx.formBody();
  let offer;
  try {
    offer = createOffer(user.id, String(form.credential_id || ""));
  } catch {
    ctx.error("That credential isn't yours, or no longer exists.", 404);
    return;
  }
  // Rendered in the POST response rather than after a redirect, so the PIN is
  // never stored in clear anywhere: only its hash is kept.
  ctx.res.setHeader("Cache-Control", "no-store");
  ctx.html(
    layout({
      title: "Add to a wallet",
      user,
      children: html`
        <section class="page-head">
          <a class="link" href="/trust">← Trust</a>
          <h1>Add this credential to a wallet</h1>
        </section>
        <section class="card oid4vci-offer">
          <p class="muted">
            Scan with an OpenID4VCI wallet that supports the pre-authorized code
            flow and SD-JWT VCs (<code>dc+sd-jwt</code>). The wallet receives its
            own copy of your ride credential, bound to the wallet's key.
          </p>
          <div class="qr">${raw(qrSvg(offer.walletUrl, { label: "Credential offer QR code" }))}</div>
          <p class="offer-pin">PIN <strong>${offer.txCode}</strong></p>
          <p class="muted small">
            The wallet asks for this PIN. The offer works once and expires at
            ${new Date(offer.expiresAt).toISOString().slice(11, 16)} UTC.
          </p>
          <p><a class="button" href="${offer.walletUrl}">Open in a wallet on this device</a></p>
          <details>
            <summary>Offer details</summary>
            <p class="small"><code class="break">${offer.walletUrl}</code></p>
            <p class="small">Credential issuer metadata:
              <a href="/.well-known/openid-credential-issuer">/.well-known/openid-credential-issuer</a></p>
          </details>
        </section>
      `,
    }),
  );
});
