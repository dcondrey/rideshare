// @ts-check
/**
 * Ride routes:
 *   GET  /rides                  → browse + filter
 *   GET  /rides/new              → post form
 *   POST /rides/new              → create ride
 *   GET  /rides/mine             → my posts + my claims (with revealed contact)
 *   GET  /rides/:id              → ride detail + claim form / claim list
 *   POST /rides/:id/claim        → create claim
 *   POST /rides/:id/cancel       → poster: cancel ride
 *   POST /rides/:id/full         → poster: mark full
 *   POST /claims/:id/accept      → poster: accept claim
 *   POST /claims/:id/decline     → poster: decline claim
 *   POST /claims/:id/withdraw    → claimer: withdraw their pending claim
 *   GET  /me                     → profile (display name + contact method)
 *   POST /me                     → save profile
 */

import { get, post } from "../lib/router.js";
import { layout, html } from "../lib/html.js";
import {
  browseRides,
  getRide,
  ridesPostedBy,
  claimsByUser,
  claimsForRide,
  createRide,
  createClaim,
  decideClaim,
  withdrawClaim,
  updateRideStatus,
  updateUserProfile,
} from "../lib/rides.js";
import { getEventConfig } from "../lib/event-config.js";
import {
  reqString,
  optString,
  reqInt,
  oneOf,
  isoDate,
  hhmm,
} from "../lib/validate.js";
import { listMeetups } from "../lib/meetups.js";
import { trustBadgeFor } from "../lib/trust.js";
import { db } from "../lib/db.js";

// Helpers ────────────────────────────────────────────────────────────────────
function requireUser(ctx) {
  if (!ctx.user) {
    ctx.redirect("/");
    return null;
  }
  return ctx.user;
}

function airportName(code) {
  const a = getEventConfig().airports.find((x) => x.code === code);
  return a ? `${a.code} — ${a.name}` : code;
}
function directionLabel(d) {
  return d === "to_venue" ? "→ to venue" : "← from venue";
}
function kindLabel(k) {
  return k === "offer" ? "Offering a ride" : "Looking for a ride";
}
function fmtDateTime(date, time) {
  return `${date} · ${time}`;
}

function rideCard(ride, { showActions = true } = {}) {
  const trust = trustBadgeFor(ride.user_id);
  return html`
    <article class="ride-card">
      <header class="ride-card-head">
        <span class="badge badge-${ride.kind}">${kindLabel(ride.kind)}</span>
        <span class="ride-card-direction">${directionLabel(ride.direction)}</span>
        ${
          trust
            ? html`<span class="trust-badge"
                title="${trust.totalCredentials} confirmed ride${trust.totalCredentials === 1 ? "" : "s"} across ${trust.distinctEvents} event${trust.distinctEvents === 1 ? "" : "s"}">
                ✓ ${trust.totalCredentials}
              </span>`
            : ""
        }
      </header>
      <h3 class="ride-card-title">
        <a href="/rides/${ride.id}">${airportName(ride.airport)}</a>
      </h3>
      <dl class="ride-card-meta">
        <div><dt>When</dt><dd>${fmtDateTime(ride.depart_date, ride.depart_time)}${ride.flex_minutes ? html` <span class="muted">±${ride.flex_minutes}m</span>` : ""}</dd></div>
        <div><dt>${ride.kind === "offer" ? "Seats" : "Needs"}</dt><dd>${ride.seats}</dd></div>
        <div><dt>Posted by</dt><dd>${ride.poster_name || maskEmail(ride.poster_email)}</dd></div>
      </dl>
      ${ride.notes ? html`<p class="ride-card-notes">${ride.notes}</p>` : ""}
      ${showActions ? html`<a class="button" href="/rides/${ride.id}">View details</a>` : ""}
    </article>
  `;
}

/** Mask email for display before contact reveal. */
function maskEmail(email) {
  const at = email.indexOf("@");
  if (at < 2) return "—";
  return email[0] + "•••" + email.slice(at - 1);
}

// ── Browse ───────────────────────────────────────────────────────────────────
get("/rides", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const event = getEventConfig();
  const q = ctx.query;
  const filters = {
    kind: q.kind || "any",
    direction: q.direction || "any",
    airport: q.airport || "any",
    date: q.date || "any",
  };
  const rides = browseRides({
    kind: filters.kind === "any" ? "any" : filters.kind,
    direction: filters.direction === "any" ? "any" : filters.direction,
    airport: filters.airport === "any" ? "any" : filters.airport,
    date: filters.date === "any" ? "any" : filters.date,
  });
  ctx.html(
    layout({
      title: "Browse rides",
      user,
      children: html`
        <section class="page-head">
          <div>
            <h1>Browse rides</h1>
            <p class="muted">${rides.length} open ride${rides.length === 1 ? "" : "s"}.</p>
          </div>
          <a class="button button-primary" href="/rides/new">Post a ride</a>
        </section>

        <form class="filter-bar" method="get" action="/rides">
          <label><span>Type</span>
            <select name="kind">
              <option value="any" ${filters.kind === "any" ? "selected" : ""}>All</option>
              <option value="offer" ${filters.kind === "offer" ? "selected" : ""}>Offers</option>
              <option value="request" ${filters.kind === "request" ? "selected" : ""}>Requests</option>
            </select>
          </label>
          <label><span>Direction</span>
            <select name="direction">
              <option value="any" ${filters.direction === "any" ? "selected" : ""}>Both</option>
              <option value="to_venue" ${filters.direction === "to_venue" ? "selected" : ""}>To venue</option>
              <option value="from_venue" ${filters.direction === "from_venue" ? "selected" : ""}>From venue</option>
            </select>
          </label>
          <label><span>Airport</span>
            <select name="airport">
              <option value="any" ${filters.airport === "any" ? "selected" : ""}>Any</option>
              ${event.airports.map(
                (a) => html`<option value="${a.code}" ${filters.airport === a.code ? "selected" : ""}>${a.code}</option>`,
              )}
              <option value="OTHER" ${filters.airport === "OTHER" ? "selected" : ""}>Other</option>
            </select>
          </label>
          <label><span>Date</span>
            <input type="date" name="date" value="${filters.date === "any" ? "" : filters.date}"
                   min="${event.dates.start}" max="${event.dates.end}">
          </label>
          <button type="submit" class="button">Apply</button>
          <a class="link" href="/rides">Clear</a>
        </form>

        ${
          rides.length === 0
            ? html`<section class="empty">
                <p>No rides match those filters.</p>
                <p><a class="button button-primary" href="/rides/new">Post the first one</a></p>
              </section>`
            : html`<div class="ride-grid">${rides.map((r) => rideCard(r))}</div>`
        }
      `,
    }),
  );
});

// ── Post a ride ──────────────────────────────────────────────────────────────
get("/rides/new", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  ctx.html(layout({ title: "Post a ride", user, children: postForm({}) }));
});

post("/rides/new", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const body = await ctx.formBody();
  const event = getEventConfig();
  const airportCodes = [...event.airports.map((a) => a.code), "OTHER"];

  const kind = oneOf(body.kind, "kind", ["offer", "request"]);
  const direction = oneOf(body.direction, "direction", ["to_venue", "from_venue"]);
  const airport = oneOf(body.airport, "airport", airportCodes);
  const otherPlace = airport === "OTHER" ? reqString(body.other_place, "other_place", { max: 100 }) : null;
  const departDate = isoDate(body.depart_date, "depart_date");
  const departTime = hhmm(body.depart_time, "depart_time");
  const flexMinutes = reqInt(body.flex_minutes ?? "0", "flex_minutes", { min: 0, max: 720 });
  const seats = reqInt(body.seats ?? "1", "seats", { min: 1, max: 8 });
  const notes = optString(body.notes, "notes", { max: 500 });

  const meetupIdRaw = (body.meetup_id ?? "").trim();
  const meetupId = meetupIdRaw === "" ? null : parseInt(meetupIdRaw, 10);
  let pickupLat = null, pickupLng = null;
  const latRaw = (body.pickup_lat ?? "").trim();
  const lngRaw = (body.pickup_lng ?? "").trim();
  if (latRaw !== "" || lngRaw !== "") {
    pickupLat = parseFloat(latRaw);
    pickupLng = parseFloat(lngRaw);
    if (!Number.isFinite(pickupLat) || pickupLat < -90 || pickupLat > 90) {
      ctx.error("Pickup latitude must be a number between -90 and 90.", 400);
      return;
    }
    if (!Number.isFinite(pickupLng) || pickupLng < -180 || pickupLng > 180) {
      ctx.error("Pickup longitude must be a number between -180 and 180.", 400);
      return;
    }
  }

  const id = createRide({
    userId: user.id,
    kind,
    direction,
    airport,
    otherPlace,
    departDate,
    departTime,
    flexMinutes,
    seats,
    notes,
    meetupId,
    pickupLat,
    pickupLng,
  });
  ctx.redirect(`/rides/${id}`);
});

function postForm({ values = {} }) {
  const event = getEventConfig();
  return html`
    <section class="page-head"><h1>Post a ride</h1></section>
    <form method="post" action="/rides/new" class="card stacked form-grid">
      <fieldset class="radio-pair">
        <legend>I'm…</legend>
        <label class="radio-tile">
          <input type="radio" name="kind" value="offer" ${values.kind === "offer" || !values.kind ? "checked" : ""}>
          <strong>Offering a ride</strong>
          <span class="muted">I have seats; others can claim them.</span>
        </label>
        <label class="radio-tile">
          <input type="radio" name="kind" value="request" ${values.kind === "request" ? "checked" : ""}>
          <strong>Looking for a ride</strong>
          <span class="muted">I need a seat; drivers can offer.</span>
        </label>
      </fieldset>

      <label><span>Direction</span>
        <select name="direction" required>
          <option value="to_venue">→ To venue (arrival)</option>
          <option value="from_venue">← From venue (departure)</option>
        </select>
      </label>

      <label><span>Airport / location</span>
        <select name="airport" required id="airport-select">
          ${event.airports.map((a) => html`<option value="${a.code}">${a.code} — ${a.name}</option>`)}
          <option value="OTHER">Other (specify)</option>
        </select>
      </label>

      <label id="other-place-label" hidden><span>Other location</span>
        <input type="text" name="other_place" maxlength="100" placeholder="e.g. Caltrain Mountain View">
      </label>

      <label><span>Date</span>
        <input type="date" name="depart_date" required min="${event.dates.start}" max="${event.dates.end}">
      </label>

      <label><span>Time (24h)</span>
        <input type="time" name="depart_time" required>
      </label>

      <label><span>Flexibility (± minutes)</span>
        <input type="number" name="flex_minutes" min="0" max="720" value="0">
      </label>

      <label><span>Seats <span class="muted">(offering: available; requesting: needed)</span></span>
        <input type="number" name="seats" min="1" max="8" value="1" required>
      </label>

      <label class="full"><span>Notes <span class="muted">(optional)</span></span>
        <textarea name="notes" maxlength="500" rows="3"
                  placeholder="Driving a Tesla, can take ski gear, splitting the toll, etc."></textarea>
      </label>

      <fieldset class="full"><legend>Pickup location on map <span class="muted">(optional)</span></legend>
        ${
          listMeetups().length > 0
            ? html`
              <label><span>Use a defined meetup</span>
                <select name="meetup_id">
                  <option value="">— None —</option>
                  ${listMeetups().map(
                    (m) => html`<option value="${m.id}">${m.name}</option>`,
                  )}
                </select>
              </label>`
            : ""
        }
        <div class="form-grid">
          <label><span>Custom latitude <span class="muted">(optional)</span></span>
            <input type="text" name="pickup_lat" inputmode="decimal" placeholder="37.4143">
          </label>
          <label><span>Custom longitude <span class="muted">(optional)</span></span>
            <input type="text" name="pickup_lng" inputmode="decimal" placeholder="-122.0773">
          </label>
        </div>
        <p class="muted small">
          If you skip both, your ride pins at the airport (or venue, for departures).
          To grab coordinates, right-click a spot on Google Maps — the first item
          in the menu is "lat, lng" — click it to copy.
        </p>
      </fieldset>

      <div class="form-actions full">
        <a href="/rides" class="link">Cancel</a>
        <button type="submit" class="button button-primary">Post ride</button>
      </div>
    </form>
    <script src="/app.js" defer></script>
  `;
}

// ── My rides ─────────────────────────────────────────────────────────────────
get("/rides/mine", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const posted = ridesPostedBy(user.id);
  const claimed = claimsByUser(user.id);
  ctx.html(
    layout({
      title: "My rides",
      user,
      children: html`
        <section class="page-head">
          <h1>My rides</h1>
          <a class="link" href="/me">Edit profile & contact</a>
        </section>

        <h2>Posted by you</h2>
        ${
          posted.length === 0
            ? html`<p class="muted">You haven't posted anything yet. <a href="/rides/new">Post a ride</a>.</p>`
            : html`<div class="ride-grid">${posted.map((r) =>
                html`${rideCard(r)}
                <div class="ride-card-claims">
                  ${claimsForRide(r.id).map(
                    (c) => html`
                      <div class="claim-row claim-${c.status}">
                        <strong>${c.claimer_name || maskEmail(c.claimer_email)}</strong>
                        wants ${c.seats} seat${c.seats === 1 ? "" : "s"} —
                        <em>${c.status}</em>
                        ${c.message ? html`<p class="muted small">"${c.message}"</p>` : ""}
                        ${c.status === "accepted"
                          ? html`<p class="muted small">Contact: ${c.claimer_contact || c.claimer_email}</p>`
                          : ""}
                        ${c.status === "pending"
                          ? html`
                            <form method="post" action="/claims/${c.id}/accept" class="inline">
                              <button class="button button-small button-primary">Accept</button>
                            </form>
                            <form method="post" action="/claims/${c.id}/decline" class="inline">
                              <button class="button button-small">Decline</button>
                            </form>`
                          : ""}
                      </div>
                    `,
                  )}
                </div>`,
              )}</div>`
        }

        <h2>Your claims</h2>
        ${
          claimed.length === 0
            ? html`<p class="muted">You haven't claimed any rides. <a href="/rides">Browse</a>.</p>`
            : html`<div class="ride-grid">${claimed.map(
                (c) => html`
                  <article class="ride-card">
                    <header class="ride-card-head">
                      <span class="badge badge-${c.kind}">${kindLabel(c.kind)}</span>
                      <span class="ride-card-direction">${directionLabel(c.direction)}</span>
                    </header>
                    <h3 class="ride-card-title">${airportName(c.airport)}</h3>
                    <dl class="ride-card-meta">
                      <div><dt>When</dt><dd>${fmtDateTime(c.depart_date, c.depart_time)}</dd></div>
                      <div><dt>Status</dt><dd><strong>${c.status}</strong></dd></div>
                      <div><dt>Poster</dt><dd>${c.poster_name || maskEmail(c.poster_email)}</dd></div>
                    </dl>
                    ${
                      c.status === "accepted"
                        ? html`<p class="contact-revealed">
                            <strong>Contact:</strong> ${c.poster_contact || c.poster_email}
                          </p>`
                        : c.status === "pending"
                          ? html`<form method="post" action="/claims/${c.id}/withdraw" class="inline">
                              <button class="button button-small">Withdraw</button>
                            </form>`
                          : ""
                    }
                    <a class="button" href="/rides/${c.ride_id}">Open ride</a>
                  </article>
                `,
              )}</div>`
        }
      `,
    }),
  );
});

/** Map of (ride_id, user_id) → bool: has this user already confirmed? */
function hasConfirmed(rideId, userId) {
  const r = db
    .prepare(
      `SELECT 1 FROM ride_confirmations WHERE ride_id = ? AND user_id = ? LIMIT 1`,
    )
    .get(rideId, userId);
  return !!r;
}

// ── Ride detail + claim ──────────────────────────────────────────────────────
get("/rides/:id", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const ride = getRide(parseInt(ctx.params.id, 10));
  if (!ride) {
    ctx.error("That ride doesn't exist (or was cancelled).", 404);
    return;
  }
  const isOwner = ride.user_id === user.id;
  const claims = isOwner ? claimsForRide(ride.id) : [];
  const myClaim = !isOwner
    ? /** @type {any} */ (
        claimsByUser(user.id).find((c) => c.ride_id === ride.id)
      )
    : null;
  ctx.html(
    layout({
      title: airportName(ride.airport),
      user,
      children: html`
        <section class="page-head">
          <a class="link" href="/rides">← Browse</a>
          ${isOwner
            ? html`<form method="post" action="/rides/${ride.id}/cancel" class="inline">
                <button class="button button-danger" onclick="return confirm('Cancel this ride?')">Cancel ride</button>
              </form>`
            : ""}
        </section>

        ${rideCard(ride, { showActions: false })}

        ${
          isOwner
            ? html`
              <section class="card">
                <h2>Claims (${claims.length})</h2>
                ${
                  claims.length === 0
                    ? html`<p class="muted">No one has claimed this yet.</p>`
                    : html`<ul class="claim-list">
                        ${claims.map(
                          (c) => html`<li class="claim-row claim-${c.status}">
                            <strong>${c.claimer_name || maskEmail(c.claimer_email)}</strong>
                            wants ${c.seats} seat${c.seats === 1 ? "" : "s"} —
                            <em>${c.status}</em>
                            ${c.message ? html`<p class="muted small">"${c.message}"</p>` : ""}
                            ${c.status === "accepted"
                              ? html`<p class="muted small">Contact: ${c.claimer_contact || c.claimer_email}</p>`
                              : ""}
                            ${c.status === "pending"
                              ? html`
                                <form method="post" action="/claims/${c.id}/accept" class="inline">
                                  <button class="button button-small button-primary">Accept</button>
                                </form>
                                <form method="post" action="/claims/${c.id}/decline" class="inline">
                                  <button class="button button-small">Decline</button>
                                </form>`
                              : ""}
                          </li>`,
                        )}
                      </ul>
                      ${
                        claims.some((c) => c.status === "accepted")
                          ? html`<div class="confirm-block">
                              <p class="muted small">
                                After the ride happens, both sides confirm to mint
                                portable trust credentials. <a href="/trust">Learn more</a>.
                              </p>
                              <button type="button" class="button button-primary"
                                      data-confirm-ride="${ride.id}"
                                      ${hasConfirmed(ride.id, user.id) ? "disabled" : ""}>
                                ${hasConfirmed(ride.id, user.id) ? "✓ You've confirmed" : "I made this ride →"}
                              </button>
                              <span class="confirm-status" data-confirm-status></span>
                            </div>`
                          : ""
                      }`
                }
              </section>`
            : myClaim
              ? html`
                <section class="card">
                  <h2>Your claim — <em>${myClaim.status}</em></h2>
                  ${
                    myClaim.status === "accepted"
                      ? html`<p class="contact-revealed">
                          <strong>Contact:</strong> ${myClaim.poster_contact || myClaim.poster_email}
                        </p>
                        <div class="confirm-block">
                          <p class="muted small">
                            After the ride, confirm to mint a portable trust credential.
                            <a href="/trust">Learn more</a>.
                          </p>
                          <button type="button" class="button button-primary"
                                  data-confirm-ride="${ride.id}"
                                  ${hasConfirmed(ride.id, user.id) ? "disabled" : ""}>
                            ${hasConfirmed(ride.id, user.id) ? "✓ You've confirmed" : "I made this ride →"}
                          </button>
                          <span class="confirm-status" data-confirm-status></span>
                        </div>`
                      : myClaim.status === "pending"
                        ? html`<p class="muted">Waiting for the poster to accept or decline.</p>
                          <form method="post" action="/claims/${myClaim.id}/withdraw">
                            <button class="button">Withdraw claim</button>
                          </form>`
                        : html`<p class="muted">This claim is ${myClaim.status}.</p>`
                  }
                </section>`
              : html`
                <section class="card">
                  <h2>Claim this ride</h2>
                  <p class="muted">When the poster accepts, you'll see their contact info and they'll see yours.</p>
                  <form method="post" action="/rides/${ride.id}/claim" class="stacked">
                    <label><span>Seats</span>
                      <input type="number" name="seats" min="1" max="${ride.seats}" value="1" required>
                    </label>
                    <label><span>Message <span class="muted">(optional)</span></span>
                      <textarea name="message" maxlength="300" rows="2"
                                placeholder="Hi! Flying in around 5pm, can split the fare."></textarea>
                    </label>
                    <button type="submit" class="button button-primary">Claim seat</button>
                  </form>
                </section>`
        }
      `,
    }),
  );
});

post("/rides/:id/claim", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const rideId = parseInt(ctx.params.id, 10);
  const body = await ctx.formBody();
  const seats = reqInt(body.seats ?? "1", "seats", { min: 1, max: 8 });
  const message = optString(body.message, "message", { max: 300 });
  try {
    createClaim({ rideId, claimerId: user.id, seats, message });
  } catch (err) {
    if (/UNIQUE/.test(err.message)) {
      // Already claimed — silently redirect to the ride.
    } else {
      ctx.error(err.message);
      return;
    }
  }
  ctx.redirect(`/rides/${rideId}`);
});

post("/rides/:id/cancel", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  updateRideStatus(parseInt(ctx.params.id, 10), user.id, "cancelled");
  ctx.redirect("/rides/mine");
});

post("/rides/:id/full", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  updateRideStatus(parseInt(ctx.params.id, 10), user.id, "full");
  ctx.redirect("/rides/mine");
});

post("/claims/:id/accept", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  decideClaim(parseInt(ctx.params.id, 10), user.id, "accepted");
  ctx.redirect("/rides/mine");
});

post("/claims/:id/decline", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  decideClaim(parseInt(ctx.params.id, 10), user.id, "declined");
  ctx.redirect("/rides/mine");
});

post("/claims/:id/withdraw", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  withdrawClaim(parseInt(ctx.params.id, 10), user.id);
  ctx.redirect("/rides/mine");
});

// ── Profile ──────────────────────────────────────────────────────────────────
get("/me", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  ctx.html(
    layout({
      title: "Your profile",
      user,
      children: html`
        <section class="page-head"><h1>Your profile</h1></section>
        <form method="post" action="/me" class="card stacked">
          <p class="muted">
            Your <strong>display name</strong> shows on your ride posts.
            Your <strong>contact method</strong> is shared only with people
            whose claim you accept (or whose ride accepts you).
          </p>
          <label><span>Display name</span>
            <input type="text" name="display_name" maxlength="80" value="${user.displayName ?? ""}"
                   placeholder="e.g. Alex K.">
          </label>
          <label><span>Contact method <span class="muted">(visible only after a match)</span></span>
            <input type="text" name="contact_method" maxlength="200" value="${user.contactMethod ?? ""}"
                   placeholder="e.g. Signal: +1 555 123-4567 · or @handle on X">
          </label>
          <p class="muted small">Your email (${user.email}) is always usable as a fallback contact.</p>
          <div class="form-actions">
            <a href="/rides" class="link">Cancel</a>
            <button type="submit" class="button button-primary">Save</button>
          </div>
        </form>
      `,
    }),
  );
});

post("/me", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const body = await ctx.formBody();
  const displayName = optString(body.display_name, "display_name", { max: 80 });
  const contactMethod = optString(body.contact_method, "contact_method", { max: 200 });
  updateUserProfile(user.id, { displayName, contactMethod });
  ctx.redirect("/rides/mine");
});

// ── About ────────────────────────────────────────────────────────────────────
get("/about", async (ctx) => {
  const event = getEventConfig();
  ctx.html(
    layout({
      title: "About",
      user: ctx.user,
      children: html`
        <section class="prose">
          <h1>About this app</h1>
          <p>
            ${event.name} Rideshare is a self-hosted, open-source coordination tool
            for event attendees. It runs as a single Node.js process with zero
            third-party dependencies and stores data in a local SQLite database.
          </p>
          <h2>Privacy</h2>
          <ul>
            <li>The attendee allowlist is stored as one-way HMAC hashes.</li>
            <li>No third-party analytics or trackers are loaded.</li>
            <li>Your contact info is shared only with users you match with.</li>
            <li>Insights for organizers are aggregate only and exclude small buckets.</li>
          </ul>
          ${event.supportEmail ? html`<p>Questions? <a href="mailto:${event.supportEmail}">${event.supportEmail}</a></p>` : ""}
        </section>
      `,
    }),
  );
});
