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

import { config } from "../lib/config.js";
import { db } from "../lib/db.js";
import { onClaimCreated, onRideCreated } from "../lib/demo.js";
import { errorMessage } from "../lib/errors.js";
import { tripEstimate } from "../lib/estimates.js";
import { getEventConfig } from "../lib/event-config.js";
import { html, layout } from "../lib/html.js";
import { notifyRide } from "../lib/live.js";
import { listMeetups } from "../lib/meetups.js";
import { rateLimit } from "../lib/rate-limit.js";
import {
  browseRides,
  claimsByUser,
  claimsForRide,
  createClaim,
  createRide,
  decideClaim,
  FEATURES,
  featureList,
  getRide,
  latestRideUpdates,
  postRideUpdate,
  rideParticipants,
  ridesPostedBy,
  TRIP_STATUSES,
  updateRideStatus,
  updateUserProfile,
  withdrawClaim,
} from "../lib/rides.js";
import { get, post } from "../lib/router.js";
import { aboutJsonLd, socialCard } from "../lib/seo.js";
import {
  activeTripShares,
  createTripShare,
  lookupTripShare,
  revokeTripShare,
} from "../lib/trip-share.js";
import { trustBadgeFor } from "../lib/trust.js";
import {
  hhmm,
  isoDate,
  oneOf,
  optString,
  reqInt,
  reqString,
  ValidationError,
} from "../lib/validate.js";
import { demoRidesPanel } from "./demo.js";

// Helpers ────────────────────────────────────────────────────────────────────
function requireUser(ctx) {
  if (!ctx.user) {
    ctx.redirect("/");
    return null;
  }
  return ctx.user;
}

/**
 * Human label for a ride's pickup point. `OTHER` is not in event.airports, so
 * without other_place it renders as the bare word OTHER and the counterparty
 * has no way to learn where the pickup is.
 * @param {{ airport: string, other_place?: string | null }} ride
 */
function airportName(ride) {
  if (ride.airport === "OTHER") return ride.other_place || "Other pickup point";
  const a = getEventConfig().airports.find((x) => x.code === ride.airport);
  return a ? `${a.code} — ${a.name}` : ride.airport;
}
function directionLabel(d) {
  return d === "to_venue" ? "→ to venue" : "← from venue";
}
const MODE_LABEL = { taxi: "Sharing a taxi", transit: "Transit together" };
/** @param {{ kind: string, mode?: string }} ride */
function kindLabel(ride) {
  if (ride.mode && ride.mode !== "car") return MODE_LABEL[ride.mode];
  return ride.kind === "offer" ? "Offering a ride" : "Looking for a ride";
}
/** @param {{ kind: string, mode?: string }} ride */
const isGroup = (ride) => !!ride.mode && ride.mode !== "car";
/** CSS modifier for the ride's badge and pin. @param {{ kind: string, mode?: string }} ride */
const kindClass = (ride) => (isGroup(ride) ? "group" : ride.kind);

const STATUS_LABEL = {
  on_time: "On time",
  early: "Running early",
  late: "Running late",
  missed: "Missed a connection",
  arrived: "Arrived",
};
/** @param {{ status: string, minutes: number | null }} u */
function statusText(u) {
  const base = STATUS_LABEL[u.status] || u.status;
  return u.minutes && (u.status === "early" || u.status === "late")
    ? `${base} (${u.minutes} min)`
    : base;
}
function fmtDateTime(date, time) {
  return `${date} · ${time}`;
}

function rideCard(ride, { showActions = true } = {}) {
  const trust = trustBadgeFor(ride.user_id);
  return html`
    <article class="ride-card">
      <header class="ride-card-head">
        <span class="badge badge-${kindClass(ride)}">${kindLabel(ride)}</span>
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
        <a href="/rides/${ride.id}">${airportName(ride)}</a>
      </h3>
      <dl class="ride-card-meta">
        <div><dt>When</dt><dd>${fmtDateTime(ride.depart_date, ride.depart_time)}${ride.flex_minutes ? html` <span class="muted">±${ride.flex_minutes}m</span>` : ""}</dd></div>
        <div><dt>${isGroup(ride) ? "Places" : ride.kind === "offer" ? "Seats" : "Needs"}</dt><dd>${ride.seats}</dd></div>
        <div><dt>Posted by</dt><dd>${ride.poster_name || maskEmail(ride.poster_email)}</dd></div>
      </dl>
      ${
        featureList(ride.features).length
          ? html`<ul class="feature-chips" aria-label="${ride.kind === "request" ? "Needs" : "Has"}">${featureList(ride.features).map((f) => html`<li>${FEATURES[f]}</li>`)}</ul>`
          : ""
      }
      ${ride.notes ? html`<p class="ride-card-notes">${ride.notes}</p>` : ""}
      ${showActions ? html`<a class="button" href="/rides/${ride.id}">View details</a>` : ""}
    </article>
  `;
}

/** Mask email for display before contact reveal. */
function maskEmail(email) {
  const at = email.indexOf("@");
  if (at < 2) return "—";
  return `${email[0]}•••${email.slice(at - 1)}`;
}

// ── Browse ───────────────────────────────────────────────────────────────────
get("/rides", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const event = getEventConfig();
  const q = ctx.query;
  const filters = {
    kind: /** @type {'offer'|'request'|'any'} */ (
      ["offer", "request"].includes(q.kind) ? q.kind : "any"
    ),
    direction: /** @type {'to_venue'|'from_venue'|'any'} */ (
      ["to_venue", "from_venue"].includes(q.direction) ? q.direction : "any"
    ),
    airport: q.airport || "any",
    date: q.date || "any",
    feature: /** @type {import("../lib/rides.js").Feature | 'any'} */ (
      q.feature in FEATURES ? q.feature : "any"
    ),
  };
  const rides = browseRides({
    kind: filters.kind === "any" ? "any" : filters.kind,
    direction: filters.direction === "any" ? "any" : filters.direction,
    airport: filters.airport === "any" ? "any" : filters.airport,
    date: filters.date === "any" ? "any" : filters.date,
    feature: filters.feature,
  });
  ctx.html(
    layout({
      title: "Browse rides",
      user,
      path: ctx.pathname,
      children: html`
        <section class="page-head">
          <div>
            <h1>Browse rides</h1>
            <p class="muted">${rides.length} open ride${rides.length === 1 ? "" : "s"}.</p>
          </div>
          <a class="button button-primary" href="/rides/new">Post a ride</a>
        </section>

        ${demoRidesPanel(user)}

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
                (a) =>
                  html`<option value="${a.code}" ${filters.airport === a.code ? "selected" : ""}>${a.code}</option>`,
              )}
              <option value="OTHER" ${filters.airport === "OTHER" ? "selected" : ""}>Other</option>
            </select>
          </label>
          <label><span>Needs</span>
            <select name="feature">
              <option value="any">Anything</option>
              ${Object.entries(FEATURES).map(
                ([k, label]) =>
                  html`<option value="${k}" ${filters.feature === k ? "selected" : ""}>${label}</option>`,
              )}
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
  ctx.html(layout({ title: "Post a ride", user, path: ctx.pathname, children: postForm({}) }));
});

// Spam guard for the public board. Keyed per user, not per IP: attendees at
// a venue often share one NAT address. Every user is already allowlisted.
const POST_WINDOW_MS = 10 * 60 * 1000;

/**
 * Count one submission; on overflow answer 429 with Retry-After.
 * @param {import("../lib/router.js").RouteCtx} ctx @param {string} key @param {number} limit
 * @returns {boolean} true when the request may proceed
 */
function withinLimit(ctx, key, limit) {
  const rl = rateLimit(key, limit, POST_WINDOW_MS);
  if (rl.ok) return true;
  ctx.res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
  ctx.error("You're posting faster than we allow. Try again in a few minutes.", 429);
  return false;
}

post("/rides/new", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  if (!withinLimit(ctx, `ride-post:${user.id}`, 5)) return;
  const body = await ctx.formBody();
  const event = getEventConfig();
  const airportCodes = [...event.airports.map((a) => a.code), "OTHER"];

  const choice = oneOf(body.kind, "kind", ["offer", "request", "group"]);
  // A group is an offer of places in a shared taxi or a transit trip.
  const kind = choice === "group" ? "offer" : choice;
  const mode = choice === "group" ? oneOf(body.mode, "mode", ["taxi", "transit"]) : "car";
  const direction = oneOf(body.direction, "direction", ["to_venue", "from_venue"]);
  const airport = oneOf(body.airport, "airport", airportCodes);
  const otherPlace =
    airport === "OTHER" ? reqString(body.other_place, "other_place", { max: 100 }) : null;
  const departDate = isoDate(body.depart_date, "depart_date");
  // The form carries min/max, so only a direct POST reaches this. Without it a
  // ride dated outside the event shows up in browse as an ordinary open ride.
  if (event.dates?.start && departDate < event.dates.start) {
    throw new ValidationError("depart_date", `must not be before ${event.dates.start}`);
  }
  if (event.dates?.end && departDate > event.dates.end) {
    throw new ValidationError("depart_date", `must not be after ${event.dates.end}`);
  }
  const departTime = hhmm(body.depart_time, "depart_time");
  const flexMinutes = reqInt(body.flex_minutes ?? "0", "flex_minutes", {
    min: 0,
    max: 720,
  });
  const seats = reqInt(body.seats ?? "1", "seats", { min: 1, max: 8 });
  const notes = optString(body.notes, "notes", { max: 500 });

  const meetupIdRaw = (body.meetup_id ?? "").trim();
  const meetupId = meetupIdRaw === "" ? null : parseInt(meetupIdRaw, 10);
  // foreign_keys=ON turns an unknown id into a raw INSERT failure, which
  // dispatch() renders as a 500 rather than a field error.
  if (meetupId !== null && !listMeetups().some((m) => m.id === meetupId)) {
    throw new ValidationError("meetup_id", "is not a meetup on this event");
  }
  let pickupLat = null,
    pickupLng = null;
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
    mode,
    features: /** @type {import("../lib/rides.js").Feature[]} */ (
      Object.keys(FEATURES).filter((k) => body[`feature_${k}`] === "1")
    ),
  });
  onRideCreated(id);
  ctx.redirect(`/rides/${id}`);
});

/**
 * @param {{ values?: { kind?: string, direction?: string, airport?: string,
 *   other_place?: string, depart_date?: string, depart_time?: string,
 *   flex_minutes?: string|number, seats?: string|number, notes?: string,
 *   pickup_lat?: string|number, pickup_lng?: string|number,
 *   meetup_id?: string|number } }} args
 */
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
        <label class="radio-tile">
          <input type="radio" name="kind" value="group" ${values.kind === "group" ? "checked" : ""}>
          <strong>Starting a group</strong>
          <span class="muted">No car? Split a taxi or ride transit together. Anyone can join.</span>
        </label>
      </fieldset>

      <label data-group-only><span>The group will</span>
        <select name="mode">
          <option value="taxi">Share a taxi or rideshare and split the fare</option>
          <option value="transit">Take the train or bus together</option>
        </select>
      </label>

      <label><span>Direction</span>
        <select name="direction" required>
          <option value="to_venue">→ To venue (arrival)</option>
          <option value="from_venue">← From venue (departure)</option>
        </select>
      </label>

      <label><span>Airport / location</span>
        <select name="airport" required id="airport-select" aria-controls="other-place-label">
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

      <label><span>Seats <span class="muted">(offering: available; requesting: needed; group: places for others)</span></span>
        <input type="number" name="seats" min="1" max="8" value="1" required>
      </label>

      <fieldset class="full feature-picks"><legend>Luggage and accessibility <span class="muted">(offer: you have room; request: you need it)</span></legend>
        ${Object.entries(FEATURES).map(
          ([k, label]) =>
            html`<label class="check"><input type="checkbox" name="feature_${k}" value="1"> ${label}</label>`,
        )}
      </fieldset>

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
                  ${listMeetups().map((m) => html`<option value="${m.id}">${m.name}</option>`)}
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
      path: ctx.pathname,
      children: html`
        <section class="page-head">
          <h1>My rides</h1>
          <a class="link" href="/me">Edit profile & contact</a>
        </section>

        <h2>Posted by you</h2>
        ${
          posted.length === 0
            ? html`<p class="muted">You haven't posted anything yet. <a href="/rides/new">Post a ride</a>.</p>`
            : html`<div class="ride-grid">${posted.map(
                (r) =>
                  html`${rideCard(r)}
                <div class="ride-card-claims">
                  ${claimsForRide(r.id).map(
                    (c) => html`
                      <div class="claim-row claim-${c.status}">
                        <strong>${c.claimer_name || maskEmail(c.claimer_email)}</strong>
                        wants ${c.seats} seat${c.seats === 1 ? "" : "s"} —
                        <em>${c.status}</em>
                        ${c.message ? html`<p class="muted small">"${c.message}"</p>` : ""}
                        ${
                          c.status === "accepted"
                            ? html`<p class="muted small">Contact: ${c.claimer_contact || c.claimer_email}</p>`
                            : ""
                        }
                        ${
                          c.status === "pending"
                            ? html`
                            <form method="post" action="/claims/${c.id}/accept" class="inline">
                              <button class="button button-small button-primary">Accept</button>
                            </form>
                            <form method="post" action="/claims/${c.id}/decline" class="inline">
                              <button class="button button-small">Decline</button>
                            </form>`
                            : ""
                        }
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
                      <span class="badge badge-${kindClass(c)}">${kindLabel(c)}</span>
                      <span class="ride-card-direction">${directionLabel(c.direction)}</span>
                    </header>
                    <h3 class="ride-card-title">${airportName(c)}</h3>
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
    .prepare(`SELECT 1 FROM ride_confirmations WHERE ride_id = ? AND user_id = ? LIMIT 1`)
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
    ? (claimsByUser(user.id).find((c) => c.ride_id === ride.id) ?? null)
    : null;
  ctx.html(
    layout({
      title: airportName(ride),
      user,
      children: html`
        <section class="page-head">
          <a class="link" href="/rides">← Browse</a>
          ${
            isOwner
              ? html`<form method="post" action="/rides/${ride.id}/cancel" class="inline">
                <button class="button button-danger" data-confirm="Cancel this ride?">Cancel ride</button>
              </form>`
              : ""
          }
        </section>

        ${rideCard(ride, { showActions: false })}

        ${
          isOwner
            ? html`
              <section class="card">
                <h2>${isGroup(ride) ? "Joined" : "Claims"} (${claims.length})</h2>
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
                            ${
                              c.status === "accepted"
                                ? html`<p class="muted small">Contact: ${c.claimer_contact || c.claimer_email}</p>`
                                : ""
                            }
                            ${
                              c.status === "pending"
                                ? html`
                                <form method="post" action="/claims/${c.id}/accept" class="inline">
                                  <button class="button button-small button-primary">Accept</button>
                                </form>
                                <form method="post" action="/claims/${c.id}/decline" class="inline">
                                  <button class="button button-small">Decline</button>
                                </form>`
                                : ""
                            }
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
                              <span class="confirm-status" data-confirm-status aria-live="polite"></span>
                            </div>`
                          : ""
                      }`
                }
              </section>`
            : myClaim
              ? html`
                <section class="card">
                  <h2>${isGroup(ride) && myClaim.status === "accepted" ? "You're in this group" : html`Your claim — <em>${myClaim.status}</em>`}</h2>
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
                          <span class="confirm-status" data-confirm-status aria-live="polite"></span>
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
                  <h2>${isGroup(ride) ? "Join this group" : "Claim this ride"}</h2>
                  <p class="muted">${
                    isGroup(ride)
                      ? "You're in as soon as you join, and everyone in the group sees each other's contact."
                      : "When the poster accepts, you'll see their contact info and they'll see yours."
                  }</p>
                  <form method="post" action="/rides/${ride.id}/claim" class="stacked">
                    <label><span>${isGroup(ride) ? "Places" : "Seats"}</span>
                      <input type="number" name="seats" min="1" max="${ride.seats}" value="1" required>
                    </label>
                    <label><span>Message <span class="muted">(optional)</span></span>
                      <textarea name="message" maxlength="300" rows="2"
                                placeholder="Hi! Flying in around 5pm, can split the fare."></textarea>
                    </label>
                    <button type="submit" class="button button-primary">${isGroup(ride) ? "Join group" : "Claim seat"}</button>
                  </form>
                </section>`
        }
        ${estimateCard(ride)}
        ${groupMembersCard(ride, user.id)}
        ${tripStatusCard(ride, user.id)}
        ${tripSafetyCard(ride, user.id)}
      `,
    }),
  );
});

/**
 * Everyone in a group, with contacts, shown only to its members.
 * @param {{ id: number, user_id: number, mode?: string, kind: string }} ride @param {number} viewerId
 */
function groupMembersCard(ride, viewerId) {
  if (!isGroup(ride) || !rideParticipants(ride.id).has(viewerId)) return "";
  const members =
    /** @type {{ id: number, name: string | null, email: string, contact: string | null, organizer: number }[]} */ (
      db
        .prepare(
          `SELECT u.id, u.display_name AS name, u.email, u.contact_method AS contact, 1 AS organizer
           FROM rides r JOIN users u ON u.id = r.user_id WHERE r.id = ?1
         UNION ALL
         SELECT u.id, u.display_name, u.email, u.contact_method, 0
           FROM claims c JOIN users u ON u.id = c.claimer_id
          WHERE c.ride_id = ?1 AND c.status = 'accepted'`,
        )
        .all(ride.id)
    );
  return html`
    <section class="card">
      <h2>Who's going (${members.length})</h2>
      <ul class="member-list">
        ${members.map(
          (m) => html`<li>
            <strong>${m.name || maskEmail(m.email)}</strong>${m.organizer ? html` <span class="muted small">organizer</span>` : ""}
            ${m.id === viewerId ? html` <span class="muted small">(you)</span>` : html`<span class="muted small">${m.contact || m.email}</span>`}
          </li>`,
        )}
      </ul>
    </section>`;
}

/**
 * Trip status: each participant's latest report, plus a form to post one.
 * Shown only to the people on the ride, once someone has joined it.
 * @param {{ id: number }} ride @param {number} viewerId
 */
function tripStatusCard(ride, viewerId) {
  const people = rideParticipants(ride.id);
  if (!people.has(viewerId) || people.size < 2) return "";
  const updates = latestRideUpdates(ride.id);
  return html`
    <section class="card trip-status" id="trip-status">
      <h2>Trip status</h2>
      <p class="muted small">Only people on this ride see these.</p>
      ${
        updates.length
          ? html`<ul class="status-list">${updates.map(
              (u) => html`<li class="status-${u.status}">
                <strong>${u.user_id === viewerId ? "You" : u.name || "A ride partner"}</strong>
                <span class="status-pill">${statusText(u)}</span>
                ${u.note ? html`<span class="muted small">${u.note}</span>` : ""}
                <time class="muted small" datetime="${new Date(u.created_at).toISOString()}">${new Date(u.created_at).toISOString().slice(11, 16)} UTC</time>
              </li>`,
            )}</ul>`
          : html`<p class="muted">No updates yet. Running late or missed a flight? Let your partners know.</p>`
      }
      <form method="post" action="/rides/${ride.id}/status" class="stacked status-form">
        <fieldset class="status-choices">
          <legend class="sr-only">How's it going?</legend>
          ${TRIP_STATUSES.map(
            (s, i) => html`<label class="chip-radio">
              <input type="radio" name="status" value="${s}" ${i === 0 ? "checked" : ""}><span>${STATUS_LABEL[s]}</span>
            </label>`,
          )}
        </fieldset>
        <div class="form-grid">
          <label><span>By how many minutes <span class="muted">(early/late)</span></span>
            <input type="number" name="minutes" min="1" max="720" inputmode="numeric">
          </label>
          <label><span>Note <span class="muted">(optional)</span></span>
            <input type="text" name="note" maxlength="140" placeholder="Rebooked on UA 512, landing 18:40">
          </label>
        </div>
        <button type="submit" class="button button-primary">Share update</button>
      </form>
    </section>`;
}

/**
 * Cost split and CO2 saved, as an estimate.
 * @param {{ id: number, kind: string, mode?: string, airport: string, seats: number }} ride
 */
function estimateCard(ride) {
  const accepted = /** @type {{ n: number }} */ (
    db
      .prepare(
        "SELECT COALESCE(SUM(seats), 0) AS n FROM claims WHERE ride_id = ? AND status = 'accepted'",
      )
      .get(ride.id)
  ).n;
  // Offers and groups: the poster plus everyone who joined, or a full car if
  // nobody has yet. Requests: the rider plus a driver.
  const people = ride.kind === "request" ? ride.seats + 1 : 1 + (accepted || ride.seats);
  const e = tripEstimate(ride, people);
  if (!e) return "";
  return html`
    <section class="card estimate">
      <h2>Cost and CO2 <span class="sim-tag">Estimate</span></h2>
      <dl class="estimate-grid">
        <div><dt>Each pays about</dt><dd>$${e.costEach}</dd></div>
        <div><dt>CO2 saved</dt><dd>${e.co2SavedKg} kg</dd></div>
        <div><dt>Trip</dt><dd>${e.miles} mi · ${e.people} ${e.people === 1 ? "person" : "people"}</dd></div>
      </dl>
      <p class="muted small">Total about $${e.totalCost}: ${e.basis}. Rough figures to help you agree a split.</p>
    </section>`;
}

/**
 * Share-my-trip links for a trusted contact.
 * @param {{ id: number }} ride @param {number} viewerId
 */
function tripSafetyCard(ride, viewerId) {
  const people = rideParticipants(ride.id);
  if (!people.has(viewerId) || people.size < 2) return "";
  const shares = activeTripShares(ride.id, viewerId);
  return html`
    <section class="card" id="trip-safety">
      <h2>Trip safety</h2>
      <p class="muted">Send someone you trust a link to this trip: route, time and your own status updates. No account needed to open it. It stops working 12 hours after departure, or when you revoke it.</p>
      ${
        shares.length
          ? html`<ul class="share-list">${shares.map(
              (s) => html`<li>
                <span>Link made ${new Date(s.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC, expires ${new Date(s.expires_at).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
                <form method="post" action="/trip-shares/${s.id}/revoke" class="inline">
                  <input type="hidden" name="ride" value="${ride.id}">
                  <button class="button button-small">Revoke</button>
                </form>
              </li>`,
            )}</ul>`
          : ""
      }
      <form method="post" action="/rides/${ride.id}/share">
        <button class="button">Create a share link</button>
      </form>
      <p class="muted small">Arrived? Post "Arrived" under Trip status so your contact sees it too.</p>
    </section>`;
}

post("/rides/:id/share", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  if (!withinLimit(ctx, `trip-share:${user.id}`, 10)) return;
  const rideId = parseInt(ctx.params.id, 10);
  let share;
  try {
    share = createTripShare(rideId, user.id);
  } catch (err) {
    ctx.error(errorMessage(err), 403);
    return;
  }
  const link = `${config.appUrl.replace(/\/$/, "")}/trip/${share.token}`;
  ctx.res.setHeader("Cache-Control", "no-store");
  ctx.html(
    layout({
      title: "Share your trip",
      user,
      children: html`
        <section class="page-head"><a class="link" href="/rides/${rideId}#trip-safety">← Back to the ride</a></section>
        <section class="card">
          <h1>Share your trip</h1>
          <p>Send this link to someone you trust. It's shown only once; make a new one if you lose it.</p>
          <p><input class="share-link" type="text" readonly value="${link}" aria-label="Trip link"></p>
          <p class="muted small">Expires ${new Date(share.expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC. Revoke it any time from the ride page.</p>
        </section>`,
    }),
  );
});

post("/trip-shares/:id/revoke", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const body = await ctx.formBody();
  revokeTripShare(parseInt(ctx.params.id, 10), user.id);
  const rideId = parseInt(body.ride ?? "", 10);
  ctx.redirect(Number.isFinite(rideId) ? `/rides/${rideId}#trip-safety` : "/rides/mine");
});

// Public: what a trusted contact sees. No account; the token is the capability.
get("/trip/:token", async (ctx) => {
  const view = lookupTripShare(ctx.params.token);
  ctx.res.setHeader("Cache-Control", "no-store");
  if (!view) {
    ctx.error("This trip link has expired or was revoked.", 404);
    return;
  }
  const r = view.ride;
  ctx.html(
    layout({
      title: "Trip",
      user: null,
      children: html`
        <section class="card trip-view">
          <h1>${view.sharerName}'s trip</h1>
          <dl class="ride-card-meta">
            <div><dt>Route</dt><dd>${airportName(r)} ${directionLabel(r.direction)}</dd></div>
            <div><dt>Departs</dt><dd>${fmtDateTime(r.depart_date, r.depart_time)} (local time)</dd></div>
            <div><dt>Travelling by</dt><dd>${isGroup(r) ? MODE_LABEL[r.mode] : r.kind === "offer" ? "Driving" : "Shared car"}</dd></div>
            ${r.status === "cancelled" ? html`<div><dt>Status</dt><dd>Ride cancelled</dd></div>` : ""}
          </dl>
          <h2>Updates</h2>
          ${
            view.updates.length
              ? html`<ul class="status-list">${view.updates.map(
                  (u) => html`<li class="status-${u.status}">
                    <span class="status-pill">${statusText(u)}</span>
                    ${u.note ? html`<span>${u.note}</span>` : ""}
                    <time class="muted small">${new Date(u.created_at).toISOString().slice(11, 16)} UTC</time>
                  </li>`,
                )}</ul>`
              : html`<p class="muted">No updates yet.</p>`
          }
          <p class="muted small">Shared from the event rideshare. This page shows no contact details, and stops working ${new Date(view.expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC.</p>
        </section>`,
    }),
  );
});

post("/rides/:id/status", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  if (!withinLimit(ctx, `ride-status:${user.id}`, 20)) return;
  const rideId = parseInt(ctx.params.id, 10);
  const body = await ctx.formBody();
  const status = oneOf(body.status, "status", [...TRIP_STATUSES]);
  const minutesRaw = (body.minutes ?? "").trim();
  const minutes =
    (status === "early" || status === "late") && minutesRaw !== ""
      ? reqInt(minutesRaw, "minutes", { min: 1, max: 720 })
      : null;
  const note = optString(body.note, "note", { max: 140 });
  try {
    postRideUpdate({ rideId, userId: user.id, status, minutes, note });
  } catch (err) {
    ctx.error(errorMessage(err), 403);
    return;
  }
  notifyRide(
    rideId,
    "ride-status",
    {
      rideId,
      userId: user.id,
      name: user.displayName || "A ride partner",
      status,
      text: statusText({ status, minutes }),
      note,
    },
    user.id,
  );
  ctx.redirect(`/rides/${rideId}#trip-status`);
});

post("/rides/:id/claim", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  if (!withinLimit(ctx, `ride-claim:${user.id}`, 10)) return;
  const rideId = parseInt(ctx.params.id, 10);
  const body = await ctx.formBody();
  const seats = reqInt(body.seats ?? "1", "seats", { min: 1, max: 8 });
  const message = optString(body.message, "message", { max: 300 });
  try {
    onClaimCreated(createClaim({ rideId, claimerId: user.id, seats, message }));
  } catch (err) {
    if (/UNIQUE/.test(errorMessage(err))) {
      // Already claimed — silently redirect to the ride.
    } else {
      ctx.error(errorMessage(err));
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

/**
 * decideClaim throws plain Errors. A poster double-clicking Accept, or acting
 * from two tabs, hits "Already decided" — an ordinary outcome, not a 500.
 * @param {string} message
 */
function claimDecisionStatus(message) {
  if (/not found/i.test(message)) return 404;
  if (/not allowed/i.test(message)) return 403;
  return 400;
}

/** @param {'accepted'|'declined'} decision */
function decideClaimRoute(decision) {
  return async (ctx) => {
    const user = requireUser(ctx);
    if (!user) return;
    try {
      decideClaim(parseInt(ctx.params.id, 10), user.id, decision);
    } catch (err) {
      const message = errorMessage(err);
      ctx.error(message, claimDecisionStatus(message));
      return;
    }
    ctx.redirect("/rides/mine");
  };
}

post("/claims/:id/accept", decideClaimRoute("accepted"));
post("/claims/:id/decline", decideClaimRoute("declined"));

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
  const contactMethod = optString(body.contact_method, "contact_method", {
    max: 200,
  });
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
      description: `How ${event.name} Rideshare works, and what it does with your data.`,
      indexable: true,
      jsonLd: aboutJsonLd(event),
      og: socialCard({
        event,
        title: `About ${event.name} Rideshare`,
        description: `A self-hosted, zero-dependency ride coordination tool for ${event.name} attendees.`,
        path: "/about",
      }),
      children: html`
        <section class="prose" aria-labelledby="about-title">
          <h1 id="about-title">About this app</h1>
          <p>
            ${event.name} Rideshare is a self-hosted, open-source coordination tool
            for event attendees. It runs as a single Node.js process with zero
            third-party dependencies and stores data in a local SQLite database.
          </p>
          <h2 id="about-privacy">Privacy</h2>
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
