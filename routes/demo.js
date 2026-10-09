// @ts-check
/**
 * Live-demo routes and fragments (DEMO_MODE=true only):
 *   POST /demo/signin → one-click sign-in with a published demo account
 *   GET  /demo        → guided tour with the visitor's live progress
 *
 * The fragments exported here are rendered by routes/auth.js (landing page)
 * and routes/rides.js (browse page). Every export returns "" outside demo
 * mode, and both routes 404, so a real deployment shows none of it.
 */

import { sessionCookieHeader } from "../lib/auth.js";
import { config, DEMO_ATTENDEE_EMAIL, DEMO_ORGANIZER_EMAIL } from "../lib/config.js";
import { DemoSignInError, recentActivity, signInDemo, tourState } from "../lib/demo.js";
import { html, layout } from "../lib/html.js";
import { error as logError } from "../lib/log.js";
import { get, post } from "../lib/router.js";

post("/demo/signin", async (ctx) => {
  if (!config.demoMode) {
    ctx.error("Not found", 404);
    return;
  }
  const body = await ctx.formBody();
  try {
    const { sessionId, role } = signInDemo(
      String(body.email || ""),
      ctx.ip(),
      String(ctx.req.headers["user-agent"] || ""),
    );
    ctx.redirect(role === "organizer" ? "/?panel=%2Fadmin" : "/?panel=%2Fdemo", 303, {
      "Set-Cookie": sessionCookieHeader(sessionId),
    });
  } catch (err) {
    if (!(err instanceof DemoSignInError)) {
      logError("demo sign-in failed", { component: "demo", err });
    }
    ctx.error(
      err instanceof DemoSignInError ? err.message : "Demo sign-in failed. Try again.",
      400,
    );
  }
});

/** @param {string} email @param {string} role @param {string} blurb @param {boolean} primary */
function accountRow(email, role, blurb, primary) {
  return html`
    <form method="post" action="/demo/signin" class="demo-account">
      <input type="hidden" name="email" value="${email}">
      <div class="demo-account-text">
        <strong>${role}</strong>
        <code class="demo-account-email">${email}</code>
        <span class="muted small">${blurb}</span>
      </div>
      <button type="submit" class="button ${primary ? "button-primary" : ""}">Sign in as ${role.toLowerCase()}</button>
    </form>`;
}

/** Landing-page sign-in card shown in place of the magic-link form. */
export function demoSignInCard() {
  if (!config.demoMode) return "";
  return html`
    <section class="card sign-in-card demo-card" aria-labelledby="demo-title">
      <h2 id="demo-title">Try the live demo</h2>
      <p class="muted">
        Sign-in is passwordless, so there is nothing to remember. Pick a demo
        account; on a real deployment this is a one-time link sent to an
        invited attendee's email.
      </p>
      ${accountRow(
        DEMO_ATTENDEE_EMAIL,
        "Attendee",
        "Your own private sandbox: post rides, claim seats, earn a verifiable credential.",
        true,
      )}
      ${accountRow(
        DEMO_ORGANIZER_EMAIL,
        "Organizer",
        "Read-only admin: insights, allowlist, event config and the audit log.",
        false,
      )}
      <form method="post" action="/demo/signin" class="stacked demo-type-in">
        <label>
          <span>Or type a demo email</span>
          <input type="email" name="email" required autocomplete="off"
                 inputmode="email" autocapitalize="none" value="${DEMO_ATTENDEE_EMAIL}">
        </label>
        <button type="submit" class="button">Sign in</button>
      </form>
    </section>

    <section class="card demo-about" aria-labelledby="demo-about-title">
      <h2 id="demo-about-title">About this demo</h2>
      <p>
        The <strong>Internet Demo Workshop</strong> is a fictional event: a
        participant-driven demo unconference, modeled on the Internet Identity
        Workshop, where live software demonstrations, technical building and
        cross-ecosystem interoperability testing take the place of standards
        talk. Its manifesto is <em>Show me, don't tell me</em>.
      </p>
      <ul class="demo-manifesto">
        <li>No slide decks.</li>
        <li>Bugs are celebrated.</li>
        <li>Every presenter shares a public URL or local network address, so the
            audience can use the software from their seats.</li>
      </ul>
      <p class="muted small">
        Everyone else on the board is a synthetic attendee. They post rides,
        answer your claims and confirm trips, so you can walk the whole flow,
        from claiming a seat to holding a W3C Verifiable Credential, on your own.
        Then try selective disclosure (SD-JWT VC), OpenID4VCI and OpenID4VP with a
        wallet, and DIDComm between events. Data resets whenever the demo restarts.
      </p>
    </section>`;
}

/** @param {number} at */
function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** @param {import("../lib/demo.js").ActivityItem} a */
function describe(a) {
  const route = a.direction === "to_venue" ? `${a.airport} → venue` : `venue → ${a.airport}`;
  switch (a.kind) {
    case "ride":
      return a.rideKind === "offer" ? `offered seats, ${route}` : `asked for a ride, ${route}`;
    case "claim":
      return `asked to join a ride, ${route}`;
    case "match":
      return `accepted a rider, ${route}`;
    case "credential":
      return `received a ride credential, ${route}`;
  }
}

/**
 * Browse-page panel: tour progress and the live activity feed.
 * @param {{ id: number }} user
 */
export function demoRidesPanel(user) {
  if (!config.demoMode) return "";
  const t = tourState(user.id);
  const feed = recentActivity(user.id, 6);
  return html`
    <section class="demo-panel" aria-label="Live demo">
      <div class="card demo-next">
        <h2>Your next step</h2>
        ${nextStep(t)}
        <p class="small"><a href="/demo">See the whole tour →</a></p>
      </div>
      <div class="card demo-feed">
        <h2>Happening now</h2>
        <ul class="activity" aria-live="polite">
          ${feed.map(
            (a) => html`<li class="${a.mine ? "activity-mine" : ""}">
              <span class="activity-who">${a.who}</span> ${describe(a)}
              <span class="muted small">· ${ago(a.at)}</span>
            </li>`,
          )}
        </ul>
      </div>
    </section>`;
}

/** @param {ReturnType<typeof tourState>} t */
function nextStep(t) {
  if (!t.didBound) {
    return html`<p>Create your decentralized identifier. Your browser generates a
      <code>did:key</code> and keeps the private key; the server only learns the public half.</p>
      <p><a class="button button-primary" href="/trust">Create my DID</a></p>`;
  }
  if (t.seatRideId && !t.confirmed) {
    return html`<p>${t.driver} accepted you on their ride and has already confirmed it happened.
      Confirm it too and both of you are issued a credential.</p>
      <p><a class="button button-primary" href="/rides/${t.seatRideId}">Open the ride</a></p>`;
  }
  if (t.credentialCount > 0) {
    return html`<p>You hold ${t.credentialCount} RideAttendanceCredential${t.credentialCount === 1 ? "" : "s"},
      signed by this event's <code>did:web</code> issuer, plus an SD-JWT VC copy. Reveal only some of its
      claims to the verifier, or send it to a wallet.</p>
      <p><a class="button button-primary" href="/trust#selective-disclosure">Try selective disclosure</a></p>`;
  }
  return html`<p>Post a ride or claim a seat. Someone usually answers within a minute.</p>
    <p><a class="button button-primary" href="/rides/new">Post a ride</a></p>`;
}

get("/demo", async (ctx) => {
  if (!config.demoMode) {
    ctx.error("Not found", 404);
    return;
  }
  const user = ctx.user;
  if (!user) {
    ctx.redirect("/");
    return;
  }
  const t = tourState(user.id);
  /** @param {boolean} done @param {unknown} body */
  const step = (done, body) =>
    html`<li class="${done ? "tour-done" : ""}"><span class="tour-mark" aria-hidden="true">${done ? "✓" : ""}</span><div>${body}</div></li>`;
  ctx.html(
    layout({
      title: "Demo tour",
      user,
      path: ctx.pathname,
      children: html`
        <section class="page-head">
          <div>
            <h1>Welcome, ${user.displayName || "guest"}</h1>
            <p class="muted">Five steps through the rideshare and its decentralized trust layer, then four more protocols to try.</p>
          </div>
          <a class="button" href="/rides">Browse rides</a>
        </section>
        <ol class="tour">
          ${step(
            t.pendingOnOwnRide === 0 && t.ownRideId != null,
            html`<strong>Answer a seat request.</strong> You are offering a ride to the airport and someone
              wants a seat. <a href="/rides/${t.ownRideId ?? ""}">Accept or decline it</a>.`,
          )}
          ${step(
            t.didBound,
            html`<strong>Create your DID.</strong> On <a href="/trust">Trust</a>, your browser generates an
              Ed25519 <code>did:key</code> with WebCrypto, keeps the private key in IndexedDB, and proves
              control by signing a server challenge.`,
          )}
          ${step(
            t.confirmed,
            html`<strong>Confirm a ride.</strong> ${t.driver ?? "A driver"} already confirmed the ride you share.
              ${t.seatRideId ? html`<a href="/rides/${t.seatRideId}">Confirm it too</a>.` : ""}
              Two confirmations are what the issuer requires.`,
          )}
          ${step(
            t.credentialCount > 0,
            html`<strong>Hold a credential.</strong> Each side receives a W3C Verifiable Credential (VC-JWT,
              EdDSA) naming both DIDs. Download it from <a href="/trust">Trust</a>.`,
          )}
          ${step(
            false,
            html`<strong>Verify it anywhere.</strong> Paste it into the <a href="/trust/verify">verifier</a>,
              which resolves the issuer from <a href="/.well-known/did.json">/.well-known/did.json</a>
              and checks the signature, or verify it with any VC-JWT tool.`,
          )}
        </ol>
        <h2>Go further</h2>
        <ul class="tour-more">
          <li><strong>Selective disclosure.</strong> On <a href="/trust#selective-disclosure">Trust</a>, tick only
            the claims to reveal from your SD-JWT VC; your browser signs a key-binding proof for one verifier, once.</li>
          <li><strong>Add it to a wallet.</strong> "Add to a wallet" on <a href="/trust">Trust</a> shows an
            OpenID4VCI offer as a QR code and PIN for any wallet that supports the pre-authorized flow.</li>
          <li><strong>Verify someone.</strong> <a href="/verify">Verify an attendee</a> creates an OpenID4VP request
            signed by this event's DID; answer it from a wallet, or from this browser.</li>
          <li><strong>Talk to another event.</strong> <a href="/trust/didcomm">DIDComm</a> sends an encrypted trust
            ping or feature query to any deployment's DID and shows the authenticated reply.</li>
        </ul>
        <p class="muted small">Want the organizer's view? Sign out and sign in as
          <code>${DEMO_ORGANIZER_EMAIL}</code>.</p>
      `,
    }),
  );
});
