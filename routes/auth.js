// @ts-check
/**
 * Auth routes:
 *   GET  /             → landing + sign-in form (or redirect if signed in)
 *   POST /auth/send    → start magic link
 *   GET  /auth/check   → "check your email" page
 *   GET  /auth/callback → consume token, set session, redirect to /rides
 *   POST /auth/signout → end session
 */

import { get, post } from "../lib/router.js";
import { layout, html } from "../lib/html.js";
import {
  startMagicLink,
  consumeMagicLink,
  signOut,
  sessionCookieHeader,
  clearSessionCookieHeader,
} from "../lib/auth.js";
import { email as emailField } from "../lib/validate.js";
import { getEventConfig } from "../lib/event-config.js";

get("/", async (ctx) => {
  if (ctx.user) {
    ctx.redirect("/rides");
    return;
  }
  const event = getEventConfig();
  ctx.html(
    layout({
      title: "Sign in",
      user: null,
      children: html`
        <section class="hero">
          <h1 class="hero-title">${event.longName}</h1>
          <p class="hero-tagline">${event.tagline}</p>
          <p class="hero-meta">
            <strong>${event.dates.start}</strong> – <strong>${event.dates.end}</strong>
            · ${event.venue.name}
          </p>
        </section>

        <section class="card sign-in-card">
          <h2>Sign in with your email</h2>
          <p class="muted">
            Enter the email you used to register. We'll send you a one-time link.
          </p>
          <form method="post" action="/auth/send" class="stacked">
            <label>
              <span>Email</span>
              <input type="email" name="email" required autocomplete="email"
                     inputmode="email" autocapitalize="none" autofocus
                     placeholder="you@example.com">
            </label>
            <button type="submit" class="button button-primary">Send sign-in link</button>
          </form>
          ${
            event.registrationUrl
              ? html`<p class="muted small">
                  Not yet registered for the event?
                  <a href="${event.registrationUrl}" rel="noopener">Register here</a>.
                </p>`
              : ""
          }
        </section>

        <section class="how-it-works">
          <h2>How it works</h2>
          <ol>
            <li><strong>Sign in</strong> with your registered email.</li>
            <li><strong>Post a ride</strong> you're offering, or <strong>request</strong> one you need.</li>
            <li><strong>Match up</strong> — when someone claims your ride, accept and exchange contact info.</li>
          </ol>
        </section>
      `,
    }),
  );
});

post("/auth/send", async (ctx) => {
  const body = await ctx.formBody();
  let address;
  try {
    address = emailField(body.email);
  } catch {
    // Same response for invalid input as for valid — don't leak.
    ctx.redirect("/auth/check");
    return;
  }
  // Fire-and-forget so timing of the redirect doesn't depend on send latency.
  startMagicLink(address, ctx.ip()).catch((err) =>
    console.error("[auth] magic-link send failed:", err.message),
  );
  ctx.redirect("/auth/check");
});

get("/auth/check", async (ctx) => {
  ctx.html(
    layout({
      title: "Check your email",
      user: ctx.user,
      children: html`
        <section class="card centered">
          <h1>Check your email</h1>
          <p class="muted">
            If your address is registered for the event, a sign-in link is on its way.
            It expires in 15 minutes.
          </p>
          <p class="muted small">
            Didn't get one? Check spam, then try again.
          </p>
          <p><a href="/" class="button">Back</a></p>
        </section>
      `,
    }),
  );
});

get("/auth/callback", async (ctx) => {
  const token = ctx.query.token || "";
  const result = consumeMagicLink(
    token,
    ctx.ip(),
    String(ctx.req.headers["user-agent"] || ""),
  );
  if (!result.ok) {
    ctx.html(
      layout({
        title: "Sign-in failed",
        user: null,
        children: html`
          <section class="card centered">
            <h1>That link didn't work</h1>
            <p class="muted">${result.reason}</p>
            <p><a href="/" class="button button-primary">Request a new link</a></p>
          </section>
        `,
      }),
      400,
    );
    return;
  }
  ctx.redirect("/rides", 303, { "Set-Cookie": sessionCookieHeader(result.sessionId) });
});

post("/auth/signout", async (ctx) => {
  signOut(ctx.req);
  ctx.redirect("/", 303, { "Set-Cookie": clearSessionCookieHeader() });
});
