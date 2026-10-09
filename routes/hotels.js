// @ts-check
/**
 * Hotel room sharing (lib/hotels.js). Every route 404s unless the event turns
 * on `features.hotelSharing`.
 *   GET  /hotels                         open listings
 *   GET  /hotels/new                     post a room or a search
 *   POST /hotels                         create
 *   GET  /hotels/:id                     details; requests (poster); reveal after accept
 *   POST /hotels/:id/request             ask to share
 *   POST /hotels/:id/close               poster closes it
 *   POST /hotel-requests/:id/accept|decline|withdraw
 */

import { onHotelListed, onHotelRequested } from "../lib/demo.js";
import { errorMessage } from "../lib/errors.js";
import { getEventConfig } from "../lib/event-config.js";
import {
  closeListing,
  createListing,
  decideRequest,
  getListing,
  hotelSharingEnabled,
  myRequest,
  openListings,
  requestListing,
  requestsFor,
  withdrawRequest,
} from "../lib/hotels.js";
import { html, layout } from "../lib/html.js";
import { rateLimit } from "../lib/rate-limit.js";
import { get, post } from "../lib/router.js";
import { isoDate, oneOf, optString, reqInt, reqString, ValidationError } from "../lib/validate.js";

/** @param {import("../lib/router.js").RouteCtx} ctx */
function gate(ctx) {
  if (!hotelSharingEnabled()) {
    ctx.error("That page doesn't exist.", 404);
    return null;
  }
  if (!ctx.user) {
    ctx.redirect("/");
    return null;
  }
  return ctx.user;
}

/** @param {boolean} open */
const safety = (open) => html`<details class="card safety-note" ${open ? "open" : ""}>
  <summary><strong>Sharing a room safely</strong></summary>
  <ul>
    <li>Meet or talk first. Use Chat, a meeting, or a video call before you commit.</li>
    <li>The hotel's name and contacts stay hidden until the poster accepts you.</li>
    <li>Agree on money, beds and quiet hours in writing before you book.</li>
    <li>You can withdraw any time. Block anyone who makes you uncomfortable, and tell the organizers.</li>
  </ul>
</details>`;

/** @param {import("../lib/hotels.js").HotelListing} l */
const nights = (l) => Math.round((Date.parse(l.check_out) - Date.parse(l.check_in)) / 86_400_000);

/** @param {import("../lib/hotels.js").HotelListing} l @param {number} viewerId */
function listingCard(l, viewerId) {
  return html`<article class="ride-card hotel-card">
    <header class="ride-card-head">
      <span class="badge badge-${l.kind === "room" ? "offer" : "request"}">${l.kind === "room" ? "Room to share" : "Looking for a room"}</span>
      ${l.user_id === viewerId ? html`<span class="muted small">yours</span>` : ""}
    </header>
    <h3 class="ride-card-title"><a href="/hotels/${l.id}">${l.area}</a></h3>
    <dl class="ride-card-meta">
      <div><dt>Dates</dt><dd>${l.check_in} → ${l.check_out} (${nights(l)} night${nights(l) === 1 ? "" : "s"})</dd></div>
      <div><dt>${l.kind === "room" ? "Places" : "People"}</dt><dd>${l.spots}</dd></div>
      ${l.price_each ? html`<div><dt>Each pays</dt><dd>about $${l.price_each}/night</dd></div>` : ""}
      <div><dt>Posted by</dt><dd>${l.poster || "Attendee"}</dd></div>
    </dl>
    ${l.prefs ? html`<p class="ride-card-notes">${l.prefs}</p>` : ""}
  </article>`;
}

get("/hotels", async (ctx) => {
  const user = gate(ctx);
  if (!user) return;
  const listings = openListings(user.id);
  ctx.html(
    layout({
      title: "Hotels",
      user,
      path: ctx.pathname,
      children: html`
        <section class="page-head">
          <div><h1>Share a hotel room</h1><p class="muted">Split a room with another attendee. ${listings.length} open listing${listings.length === 1 ? "" : "s"}.</p></div>
          <a class="button button-primary" href="/hotels/new">Post</a>
        </section>
        ${safety(false)}
        ${
          listings.length === 0
            ? html`<p class="muted">No listings yet.</p>`
            : html`<div class="ride-grid">${listings.map((l) => listingCard(l, user.id))}</div>`
        }
      `,
    }),
  );
});

get("/hotels/new", async (ctx) => {
  const user = gate(ctx);
  if (!user) return;
  const event = getEventConfig();
  ctx.html(
    layout({
      title: "Share a room",
      user,
      path: ctx.pathname,
      children: html`
        <section class="page-head"><h1>Share a room</h1></section>
        <form method="post" action="/hotels" class="card stacked form-grid">
          <fieldset class="radio-pair full">
            <legend>I…</legend>
            <label class="radio-tile"><input type="radio" name="kind" value="room" checked><strong>Have a room to share</strong><span class="muted">I've booked, or will, and want to split it.</span></label>
            <label class="radio-tile"><input type="radio" name="kind" value="seeking"><strong>Am looking for a room</strong><span class="muted">I'd join someone's room.</span></label>
          </fieldset>
          <label class="full"><span>Area</span><input name="area" required maxlength="80" placeholder="Walking distance to the venue"></label>
          <label><span>Check-in</span><input type="date" name="check_in" required value="${event.dates.start}"></label>
          <label><span>Check-out</span><input type="date" name="check_out" required value="${event.dates.end}"></label>
          <label><span>Places for others / people in your group</span><input type="number" name="spots" min="1" max="3" value="1" required></label>
          <label><span>Each pays per night <span class="muted">(optional, USD)</span></span><input type="number" name="price_each" min="0" max="2000" inputmode="numeric"></label>
          <label class="full"><span>Preferences <span class="muted">(optional)</span></span>
            <textarea name="prefs" maxlength="300" rows="2" placeholder="Two beds, non-smoking, early riser, quiet after 11"></textarea></label>
          <label class="full"><span>Hotel name <span class="muted">(optional; shown only to people you accept)</span></span>
            <input name="hotel_name" maxlength="100" placeholder="Hotel and room type"></label>
          <div class="form-actions full"><a href="/hotels" class="link">Cancel</a><button class="button button-primary">Post</button></div>
        </form>
        ${safety(true)}
      `,
    }),
  );
});

post("/hotels", async (ctx) => {
  const user = gate(ctx);
  if (!user) return;
  if (!rateLimit(`hotel-post:${user.id}`, 5, 60 * 60_000).ok) {
    ctx.error("Too many listings for now. Try again later.", 429);
    return;
  }
  const b = await ctx.formBody();
  const priceRaw = String(b.price_each ?? "").trim();
  let id;
  try {
    id = createListing({
      userId: user.id,
      kind: /** @type {'room' | 'seeking'} */ (oneOf(b.kind, "kind", ["room", "seeking"])),
      area: reqString(b.area, "area", { max: 80 }),
      checkIn: isoDate(b.check_in, "check_in"),
      checkOut: isoDate(b.check_out, "check_out"),
      spots: reqInt(b.spots ?? "1", "spots", { min: 1, max: 3 }),
      priceEach: priceRaw ? reqInt(priceRaw, "price_each", { min: 0, max: 2000 }) : null,
      prefs: optString(b.prefs, "prefs", { max: 300 }),
      hotelName: optString(b.hotel_name, "hotel_name", { max: 100 }),
    });
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    ctx.error(errorMessage(err), 400);
    return;
  }
  onHotelListed(id);
  ctx.redirect(`/hotels/${id}`);
});

get("/hotels/:id", async (ctx) => {
  const user = gate(ctx);
  if (!user) return;
  const id = parseInt(ctx.params.id, 10);
  const l = getListing(id, user.id);
  if (!l) {
    ctx.error("That listing doesn't exist.", 404);
    return;
  }
  const mine = l.user_id === user.id;
  const requests = mine ? requestsFor(id, user.id) : [];
  const own = mine ? undefined : myRequest(id, user.id);
  ctx.html(
    layout({
      title: l.area,
      user,
      path: ctx.pathname,
      children: html`
        <section class="page-head"><a class="link" href="/hotels">← Hotels</a></section>
        ${listingCard(l, user.id)}
        ${l.hotel_name ? html`<section class="card contact-revealed"><strong>Hotel:</strong> ${l.hotel_name}</section>` : ""}
        ${
          mine
            ? html`<section class="card">
                <h2>Requests (${requests.length})</h2>
                ${
                  requests.length === 0
                    ? html`<p class="muted">Nobody has asked yet.</p>`
                    : html`<ul class="claim-list">${requests.map(
                        (q) => html`<li class="claim-row claim-${q.status}">
                          <strong>${q.name || "Attendee"}</strong> <em>${q.status}</em>
                          ${q.message ? html`<p class="muted small">"${q.message}"</p>` : ""}
                          ${q.contact ? html`<p class="muted small">Contact: ${q.contact}</p>` : ""}
                          ${
                            q.status === "pending"
                              ? html`<form method="post" action="/hotel-requests/${q.id}/accept" class="inline"><button class="button button-small button-primary">Accept</button></form>
                                <form method="post" action="/hotel-requests/${q.id}/decline" class="inline"><button class="button button-small">Decline</button></form>`
                              : ""
                          }
                        </li>`,
                      )}</ul>`
                }
                ${
                  l.status === "open"
                    ? html`<form method="post" action="/hotels/${id}/close"><button class="button">Close listing</button></form>`
                    : html`<p class="muted">Closed.</p>`
                }
              </section>`
            : own
              ? html`<section class="card">
                  <h2>Your request: <em>${own.status}</em></h2>
                  ${own.contact ? html`<p class="contact-revealed"><strong>Contact:</strong> ${own.contact}</p>` : ""}
                  ${
                    own.status === "pending" || own.status === "accepted"
                      ? html`<form method="post" action="/hotel-requests/${own.id}/withdraw"><button class="button">Withdraw</button></form>`
                      : ""
                  }
                </section>`
              : l.status === "open"
                ? html`<section class="card">
                    <h2>Ask to share</h2>
                    <p class="muted">If ${l.poster || "they"} accept${l.poster ? "s" : ""}, you'll both see each other's contact${l.kind === "room" ? " and the hotel" : ""}.</p>
                    <form method="post" action="/hotels/${id}/request" class="stacked">
                      <label><span>Message</span><textarea name="message" maxlength="300" rows="2" required placeholder="A bit about you and your schedule"></textarea></label>
                      <button class="button button-primary">Send request</button>
                    </form>
                  </section>`
                : ""
        }
        ${safety(true)}
      `,
    }),
  );
});

post("/hotels/:id/request", async (ctx) => {
  const user = gate(ctx);
  if (!user) return;
  if (!rateLimit(`hotel-req:${user.id}`, 10, 60 * 60_000).ok) {
    ctx.error("Too many requests for now. Try again later.", 429);
    return;
  }
  const id = parseInt(ctx.params.id, 10);
  const b = await ctx.formBody();
  try {
    onHotelRequested(requestListing(id, user.id, optString(b.message, "message", { max: 300 })));
  } catch (err) {
    if (!/UNIQUE/.test(errorMessage(err))) {
      ctx.error(errorMessage(err), 400);
      return;
    }
  }
  ctx.redirect(`/hotels/${id}`);
});

post("/hotels/:id/close", async (ctx) => {
  const user = gate(ctx);
  if (!user) return;
  const id = parseInt(ctx.params.id, 10);
  closeListing(id, user.id);
  ctx.redirect(`/hotels/${id}`);
});

for (const action of ["accept", "decline", "withdraw"]) {
  post(`/hotel-requests/:id/${action}`, async (ctx) => {
    const user = gate(ctx);
    if (!user) return;
    const reqId = parseInt(ctx.params.id, 10);
    try {
      if (action === "withdraw") {
        withdrawRequest(reqId, user.id);
        ctx.redirect("/hotels");
        return;
      }
      const listingId = decideRequest(
        reqId,
        user.id,
        action === "accept" ? "accepted" : "declined",
      );
      ctx.redirect(`/hotels/${listingId}`);
    } catch (err) {
      ctx.error(errorMessage(err), 400);
    }
  });
}
