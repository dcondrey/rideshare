// @ts-check
/**
 * DIDComm v2.1 endpoint (lib/didcomm.js) and the page for pinging another
 * deployment's agent.
 *
 *   POST /didcomm           inbound encrypted messages (202 on acceptance)
 *   GET  /trust/didcomm     this agent's identity, a send form, the message log
 */

import { endpointUri, receive, recentMessages, sendPing, sendQuery } from "../lib/didcomm.js";
import { errorMessage } from "../lib/errors.js";
import { html, layout } from "../lib/html.js";
import { warn } from "../lib/log.js";
import { rateLimit } from "../lib/rate-limit.js";
import { get, post } from "../lib/router.js";
import { getDeploymentKey } from "../lib/trust.js";

const MAX_MESSAGE_BYTES = 64 * 1024;

post("/didcomm", async (ctx) => {
  const type = String(ctx.req.headers["content-type"] || "");
  if (!/^application\/(didcomm-encrypted\+)?json\b/i.test(type)) {
    ctx.json({ error: "expected application/didcomm-encrypted+json" }, 415);
    return;
  }
  if (!rateLimit(`didcomm-in:${ctx.ip()}`, 60, 60 * 1000).ok) {
    ctx.json({ error: "rate_limited" }, 429);
    return;
  }
  const raw = await ctx.rawBody();
  if (raw.length > MAX_MESSAGE_BYTES) {
    ctx.json({ error: "message too large" }, 413);
    return;
  }
  try {
    await receive(JSON.parse(raw.toString("utf8")));
    ctx.json({}, 202);
  } catch (err) {
    warn("didcomm message rejected", { component: "didcomm", err: errorMessage(err) });
    ctx.json({ error: "message could not be decrypted or verified" }, 400);
  }
});

get("/trust/didcomm", async (ctx) => {
  const user = ctx.user;
  if (!user) {
    ctx.redirect("/");
    return;
  }
  const did = getDeploymentKey().did;
  const log = recentMessages(30);
  const short = (t) => t.replace("https://didcomm.org/", "");
  ctx.html(
    layout({
      title: "DIDComm",
      user,
      path: ctx.pathname,
      children: html`
        <section class="page-head">
          <div>
            <a class="link" href="/trust">← Trust</a>
            <h1>DIDComm agent</h1>
            <p class="muted">Every deployment is a DIDComm v2.1 agent. Ping another event's agent by its DID.</p>
          </div>
        </section>
        <section class="card">
          <p>This agent: <code class="break">${did}</code><br>
            Endpoint: <code class="break">${endpointUri()}</code><br>
            <span class="muted small">Authcrypt (ECDH-1PU+A256KW, A256CBC-HS512) over X25519; key and endpoint are in the
            <a href="/.well-known/did.json">DID document</a>. Protocols: Trust Ping 2.0, Discover Features 2.0.</span></p>
          <form method="post" action="/trust/didcomm/send" class="stacked">
            <label><span>Peer DID</span>
              <input name="did" required value="${did}" autocapitalize="none" spellcheck="false" placeholder="did:web:other-event.example">
            </label>
            <div class="row">
              <button type="submit" name="action" value="ping" class="button button-primary">Send a trust ping</button>
              <button type="submit" name="action" value="query" class="button">Ask what it supports</button>
            </div>
            <p class="muted small">Pinging this deployment's own DID shows the full round trip on one server.</p>
          </form>
        </section>
        <section class="card">
          <h2>Messages</h2>
          <p class="small"><a href="/trust/didcomm">Refresh</a></p>
          ${
            log.length === 0
              ? html`<p class="muted">None yet.</p>`
              : html`<table class="data-table">
                  <thead><tr><th>When</th><th></th><th>Type</th><th>Peer</th><th>Thread</th></tr></thead>
                  <tbody>
                    ${log.map(
                      (m) => html`<tr>
                        <td>${new Date(m.created_at).toISOString().slice(11, 19)}</td>
                        <td>${m.direction === "in" ? "← in" : "→ out"}</td>
                        <td><code>${short(m.type)}</code>${m.note ? html`<br><span class="muted small">${m.note}</span>` : ""}</td>
                        <td><code class="break">${m.peer || "—"}</code></td>
                        <td><code>${(m.thid || m.id).slice(0, 8)}</code></td>
                      </tr>`,
                    )}
                  </tbody>
                </table>`
          }
        </section>
      `,
    }),
  );
});

post("/trust/didcomm/send", async (ctx) => {
  const user = ctx.user;
  if (!user) {
    ctx.redirect("/");
    return;
  }
  if (!rateLimit(`didcomm-send:${user.id}`, 10, 60 * 1000).ok) {
    ctx.error("Too many messages; wait a minute.", 429);
    return;
  }
  const form = await ctx.formBody();
  const did = String(form.did || "").trim();
  try {
    if (form.action === "query") await sendQuery(did);
    else await sendPing(did);
  } catch (err) {
    ctx.error(`Could not reach ${did}: ${errorMessage(err)}`, 502);
    return;
  }
  ctx.redirect("/trust/didcomm", 303);
});
