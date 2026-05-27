// @ts-check
/**
 * Trust + identity routes.
 *
 *   GET  /trust                         → educational dashboard (user's DID,
 *                                         credentials, import + export, profile)
 *   POST /trust/bind/challenge          → returns one-time challenge to sign
 *   POST /trust/bind                    → binds DID:key after verifying signature
 *   POST /trust/import                  → import a JWT credential from another event
 *   POST /trust/import-bundle           → import many at once (JSON array)
 *   GET  /trust/credentials.json        → all credentials issued to this user (export)
 *   GET  /trust/credentials/:id         → single credential by id
 *   GET  /trust/profile.json            → cumulative trust profile (for badges)
 *
 *   POST /rides/:id/confirm             → "I made it" — issues credentials when
 *                                         BOTH parties to the accepted claim confirm
 *
 *   GET  /trust/verify                  → verifier playground (paste a JWT)
 *   POST /trust/verify                  → verify any credential, return reasoned result
 */

import { get, post } from "../lib/router.js";
import { layout, html, raw } from "../lib/html.js";
import {
  getDeploymentKey,
  issueDidChallenge,
  bindDid,
  getUserDid,
  confirmRide,
  credentialsIssuedTo,
  importCredential,
  trustProfileFor,
} from "../lib/trust.js";
import { verifyCredential, decodeJwt } from "../lib/vc.js";
import { config } from "../lib/config.js";
import { reqString } from "../lib/validate.js";

function requireUser(ctx) {
  if (!ctx.user) {
    ctx.redirect("/");
    return null;
  }
  return ctx.user;
}

// ── /trust dashboard ─────────────────────────────────────────────────────────
get("/trust", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const userDid = getUserDid(user.id);
  const profile = trustProfileFor(user.id);
  const issued = credentialsIssuedTo(user.id);
  const dep = getDeploymentKey();

  ctx.html(
    layout({
      title: "Portable trust",
      user,
      children: html`
        <section class="page-head">
          <h1>Portable trust</h1>
          <a class="link" href="/trust/verify">Verifier playground →</a>
        </section>

        <section class="trust-explainer card">
          <p class="lead">
            Your reputation here is yours, and it travels with you to other events.
          </p>
          <p class="muted">
            When you and a ride partner confirm that a ride happened, this deployment
            issues both of you a <strong>Verifiable Credential</strong> — a small
            cryptographically signed certificate. You hold the credentials in your
            browser; you can export them, and you can present them to a different
            event using this same software (or any standards-compliant verifier).
            Your portable identity is a <code>did:key</code>: a public key that you
            generated, controlled by a private key that never leaves your device.
          </p>
          <p class="muted small">
            This deployment's identity: <code class="break">${dep.did}</code>
            (<a href="/.well-known/did.json" target="_blank">DID document</a>).
            Every credential we issue is signed with this Ed25519 key. Anyone can
            fetch our DID document and verify our signatures themselves — no trust
            in us required, only in the math.
          </p>
        </section>

        ${
          userDid
            ? html`
              <section class="card">
                <h2>Your portable identity</h2>
                <p><strong>Your DID:</strong> <code class="break">${userDid.did}</code></p>
                <p class="muted small">
                  Bound on ${new Date(userDid.bound_at).toISOString().slice(0, 10)}.
                  Your private key lives only in this browser. Back it up below.
                </p>
                <div class="row">
                  <button class="button" id="trust-export-key">Download key backup</button>
                  <button class="button" id="trust-rotate-key">Generate new key (revokes old)</button>
                </div>
              </section>`
            : html`
              <section class="card">
                <h2>Generate your portable identity</h2>
                <p class="muted">
                  We'll generate an Ed25519 keypair right in your browser using the
                  Web Crypto API. The private key is stored only on this device,
                  never sent to us.
                </p>
                <button class="button button-primary" id="trust-create-key">
                  Generate did:key
                </button>
                <p class="muted small" id="trust-create-status"></p>
              </section>`
        }

        <section class="stat-grid trust-stats">
          ${stat("Verifiable credentials", profile.totalCredentials)}
          ${stat("From this event", profile.fromThisEvent)}
          ${stat("From other events", profile.fromOtherEvents)}
          ${stat("Distinct events", profile.distinctEvents)}
          ${stat("Distinct counterparts", profile.distinctCounterparts)}
        </section>

        <section class="card">
          <h2>Credentials issued to you here</h2>
          ${
            issued.length === 0
              ? html`<p class="muted">
                  None yet. After a ride, both parties confirm "I made it" on the
                  ride page. Once both confirm, you both receive a credential.
                </p>`
              : html`<ul class="cred-list">
                  ${issued.map(
                    (c) => html`
                      <li class="cred-item">
                        <code class="break">${c.id}</code>
                        <p class="muted small">
                          Counterpart: <code class="break">${c.counterpart_did || "—"}</code><br>
                          Issued ${new Date(c.issued_at).toISOString().slice(0, 19)}Z
                        </p>
                        <details>
                          <summary>Show JWT</summary>
                          <textarea readonly rows="4" class="cred-jwt">${c.jwt}</textarea>
                        </details>
                      </li>`,
                  )}
                </ul>
                <a class="button" href="/trust/credentials.json" download>Download all as JSON</a>`
          }
        </section>

        <section class="card">
          <h2>Import credentials from another event</h2>
          <p class="muted">
            Paste any VC-JWTs you've received elsewhere — one per line, or as a
            JSON array, or as the JSON bundle file you exported. We'll resolve
            each issuer's DID document, verify the signature, and add to your
            profile here.
          </p>
          <form id="trust-import-form" class="stacked">
            <textarea id="trust-import-text" rows="6"
              placeholder="eyJhbGciOiJFZERTQSIs...&#10;eyJhbGciOiJFZERTQSIs..."></textarea>
            <input type="file" id="trust-import-file" accept=".json,.txt,application/json,text/plain" hidden>
            <div class="row">
              <button type="button" class="button" id="trust-import-pick">Choose file…</button>
              <button type="submit" class="button button-primary">Import + verify</button>
            </div>
            <div id="trust-import-results"></div>
          </form>
        </section>

        <p class="muted small">
          <a href="/trust/verify">Open the verifier playground</a> to inspect any
          credential without importing it.
        </p>

        <script src="/trust.js" defer></script>
      `,
    }),
  );
});

function stat(label, value) {
  return html`<div class="stat-card">
    <div class="stat-value">${String(value)}</div>
    <div class="stat-label">${label}</div>
  </div>`;
}

// ── DID bind: challenge + bind ──────────────────────────────────────────────
post("/trust/bind/challenge", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const out = issueDidChallenge(user.id);
  ctx.json(out);
});

post("/trust/bind", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const body = /** @type {any} */ (await ctx.jsonBody());
  if (!body || typeof body !== "object") {
    ctx.json({ ok: false, error: "JSON body required" }, 400);
    return;
  }
  try {
    bindDid({
      userId: user.id,
      did: reqString(body.did, "did", { max: 200 }),
      challenge: reqString(body.challenge, "challenge", { max: 200 }),
      signatureB64u: reqString(body.signature, "signature", { max: 200 }),
    });
    ctx.json({ ok: true, did: body.did });
  } catch (err) {
    ctx.json({ ok: false, error: err.message }, 400);
  }
});

// ── Import credentials ──────────────────────────────────────────────────────
post("/trust/import", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const body = /** @type {any} */ (await ctx.jsonBody());
  if (!body?.jwt) {
    ctx.json({ ok: false, error: "jwt required" }, 400);
    return;
  }
  const r = await importCredential({ userId: user.id, jwt: body.jwt });
  ctx.json(r, r.ok ? 200 : 400);
});

post("/trust/import-bundle", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const body = /** @type {any} */ (await ctx.jsonBody());
  /** @type {string[]} */
  let jwts = [];
  if (Array.isArray(body)) jwts = body.filter((x) => typeof x === "string");
  else if (Array.isArray(body?.credentials)) {
    jwts = body.credentials
      .map((c) => (typeof c === "string" ? c : c?.jwt))
      .filter(Boolean);
  } else if (body?.jwts && Array.isArray(body.jwts)) {
    jwts = body.jwts.filter((x) => typeof x === "string");
  }
  /** @type {Array<{ ok: boolean, id?: string, error?: string }>} */
  const results = [];
  for (const jwt of jwts) {
    try {
      results.push(await importCredential({ userId: user.id, jwt }));
    } catch (err) {
      results.push({ ok: false, error: err.message });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  ctx.json({ imported: okCount, total: results.length, results });
});

// ── Credential export ───────────────────────────────────────────────────────
get("/trust/credentials.json", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const issued = credentialsIssuedTo(user.id);
  ctx.res.statusCode = 200;
  ctx.res.setHeader("Content-Type", "application/json; charset=utf-8");
  ctx.res.setHeader(
    "Content-Disposition",
    `attachment; filename="rideshare-credentials-${new Date().toISOString().slice(0, 10)}.json"`,
  );
  ctx.res.end(
    JSON.stringify(
      {
        "@context": "https://eventrideshare.org/contexts/v1",
        type: "RideshareCredentialBundle",
        exportedAt: new Date().toISOString(),
        subjectDid: getUserDid(user.id)?.did || null,
        credentials: issued.map((c) => ({
          id: c.id,
          jwt: c.jwt,
          counterpartDid: c.counterpart_did,
          issuedAt: new Date(c.issued_at).toISOString(),
        })),
      },
      null,
      2,
    ),
  );
});

get("/trust/credentials/:id", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const row = /** @type {any} */ (
    await import("../lib/db.js").then(({ db }) =>
      db
        .prepare(
          `SELECT id, jwt FROM credentials_issued WHERE id = ? AND subject_user_id = ?`,
        )
        .get(ctx.params.id, user.id),
    )
  );
  if (!row) {
    ctx.res.statusCode = 404;
    ctx.res.end();
    return;
  }
  ctx.res.statusCode = 200;
  ctx.res.setHeader("Content-Type", "application/jwt");
  ctx.res.setHeader(
    "Content-Disposition",
    `attachment; filename="${row.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.jwt"`,
  );
  ctx.res.end(row.jwt);
});

// ── Profile JSON (for the badge data on ride cards) ─────────────────────────
get("/trust/profile.json", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  ctx.json({
    did: getUserDid(user.id)?.did || null,
    profile: trustProfileFor(user.id),
  });
});

// ── Ride confirmation ──────────────────────────────────────────────────────
post("/rides/:id/confirm", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  try {
    const r = confirmRide({
      rideId: parseInt(ctx.params.id, 10),
      userId: user.id,
    });
    ctx.json(r);
  } catch (err) {
    ctx.json({ ok: false, error: err.message }, 400);
  }
});

// ── Verifier playground ────────────────────────────────────────────────────
get("/trust/verify", async (ctx) => {
  ctx.html(
    layout({
      title: "Verify a credential",
      user: ctx.user,
      children: html`
        <section class="page-head">
          <a class="link" href="/trust">← Trust</a>
          <h1>Verifier playground</h1>
        </section>
        <p class="muted">
          Paste any RideAttendanceCredential (compact JWT). We'll resolve the
          issuer's DID, verify the Ed25519 signature, and show every check we
          ran. This works for credentials from any deployment, not just ours.
        </p>
        <form method="post" action="/trust/verify" class="stacked card">
          <textarea name="jwt" rows="6" required
            placeholder="eyJhbGciOiJFZERTQSIs..."></textarea>
          <button class="button button-primary">Verify</button>
        </form>
      `,
    }),
  );
});

post("/trust/verify", async (ctx) => {
  let jwt;
  // Support both form post and JSON
  const ct = String(ctx.req.headers["content-type"] || "");
  if (ct.includes("application/json")) {
    const b = /** @type {any} */ (await ctx.jsonBody());
    jwt = b?.jwt;
  } else {
    const f = await ctx.formBody();
    jwt = f.jwt;
  }
  if (!jwt) {
    ctx.error("Provide a JWT.", 400);
    return;
  }
  const result = await verifyCredential(jwt);
  let decoded = null;
  try { decoded = decodeJwt(jwt); } catch {}
  ctx.html(
    layout({
      title: result.ok ? "Verified ✓" : "Verification failed",
      user: ctx.user,
      children: html`
        <section class="page-head">
          <a class="link" href="/trust/verify">← Verify</a>
          <h1>${result.ok ? "Verified ✓" : "Verification failed"}</h1>
        </section>
        <section class="card">
          <h2>Checks</h2>
          <ul class="check-list">
            ${(result.checks || []).map((c) => html`<li class="check-pass">${c}</li>`)}
            ${(result.errors || []).map((e) => html`<li class="check-fail">${e}</li>`)}
          </ul>
        </section>
        ${
          decoded
            ? html`<section class="card">
                <h2>Decoded</h2>
                <h3>Header</h3>
                <pre class="code-block">${JSON.stringify(decoded.header, null, 2)}</pre>
                <h3>Payload</h3>
                <pre class="code-block">${JSON.stringify(decoded.payload, null, 2)}</pre>
              </section>`
            : ""
        }
      `,
    }),
    result.ok ? 200 : 400,
  );
});
