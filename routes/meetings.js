// @ts-check
/**
 * Meetings (lib/meetings.js):
 *   GET  /meetings               your meetings and invites
 *   GET  /meetings/new?with=ID   invite someone to meet
 *   POST /meetings               create
 *   GET  /meetings/:id           details, answers, your private note
 *   POST /meetings/:id/respond   accept or decline
 *   POST /meetings/:id/notes     save your private note
 *   POST /meetings/:id/cancel    organizer cancels
 *   GET  /meetings/pins.json     your meeting pins for the map
 */

import { canMessage, conversations, displayNameFor } from "../lib/chat.js";
import { db } from "../lib/db.js";
import { onMeetingCreated } from "../lib/demo.js";
import { errorMessage } from "../lib/errors.js";
import { getEventConfig } from "../lib/event-config.js";
import { html, layout } from "../lib/html.js";
import {
  cancelMeeting,
  createMeeting,
  getMeeting,
  MAX_INVITEES,
  meetingPeople,
  meetingPins,
  myMeetings,
  myNote,
  respond,
  saveNote,
} from "../lib/meetings.js";
import { listMeetups } from "../lib/meetups.js";
import { rateLimit } from "../lib/rate-limit.js";
import { get, post } from "../lib/router.js";
import { hhmm, isoDate, oneOf, reqString } from "../lib/validate.js";

/** @param {import("../lib/router.js").RouteCtx} ctx */
function signedIn(ctx) {
  if (!ctx.user) {
    ctx.redirect("/");
    return null;
  }
  return ctx.user;
}

const STATUS = { invited: "Invited", accepted: "Going", declined: "Can't make it" };

/**
 * People the viewer could invite: the person named in ?with, ride partners
 * and anyone they've been messaging.
 * @param {number} viewerId @param {number | null} withId
 */
function invitable(viewerId, withId) {
  const ids = new Set();
  if (withId) ids.add(withId);
  for (const c of conversations(viewerId)) ids.add(c.other);
  const partners = /** @type {{ uid: number }[]} */ (
    db
      .prepare(
        `SELECT DISTINCT CASE WHEN r.user_id = ?1 THEN c.claimer_id ELSE r.user_id END AS uid
           FROM rides r JOIN claims c ON c.ride_id = r.id AND c.status = 'accepted'
          WHERE r.status != 'cancelled' AND (r.user_id = ?1 OR c.claimer_id = ?1)`,
      )
      .all(viewerId)
  );
  for (const p of partners) ids.add(p.uid);
  ids.delete(viewerId);
  return [...ids]
    .filter((id) => canMessage(viewerId, id))
    .map((id) => ({ id, name: displayNameFor(viewerId, id) || "Attendee" }));
}

get("/meetings", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  const list = myMeetings(user.id);
  ctx.html(
    layout({
      title: "Meetings",
      user,
      path: ctx.pathname,
      children: html`
        <section class="page-head">
          <div><h1>Meetings</h1><p class="muted">Set a time and a spot on the map. Start one from someone's profile or a conversation.</p></div>
          <a class="button button-primary" href="/meetings/new">New meeting</a>
        </section>
        ${
          list.length === 0
            ? html`<p class="muted">No meetings yet.</p>`
            : html`<ul class="meeting-list">${list.map(
                (m) => html`<li>
                  <a href="/meetings/${m.id}" class="meeting-row">
                    <strong>${m.title}</strong>
                    <span class="status-pill">${STATUS[m.my_status] || m.my_status}</span>
                    <span class="muted small">${m.meet_date} · ${m.meet_time} · ${m.place_name}${m.organizer_id === user.id ? "" : ` · from ${m.organizer || "attendee"}`}</span>
                  </a>
                </li>`,
              )}</ul>`
        }
      `,
    }),
  );
});

get("/meetings/new", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  const withId = parseInt(String(ctx.query.with || ""), 10) || null;
  const people = invitable(user.id, withId);
  const event = getEventConfig();
  const meetups = listMeetups();
  ctx.html(
    layout({
      title: "New meeting",
      user,
      path: ctx.pathname,
      children: html`
        <section class="page-head"><h1>New meeting</h1></section>
        ${
          people.length === 0
            ? html`<p class="card muted">Nobody to invite yet. Find people in <a href="/people">People</a>, message them, then invite them here.</p>`
            : html`<form method="post" action="/meetings" class="card stacked form-grid" data-meeting-form>
          <label class="full"><span>What</span>
            <input name="title" required maxlength="80" placeholder="Coffee and a wallet demo">
          </label>
          <label><span>Date</span>
            <input type="date" name="date" required min="${event.dates.start}" max="${event.dates.end}" value="${event.dates.start}">
          </label>
          <label><span>Time</span><input type="time" name="time" required></label>
          <fieldset class="full"><legend>Where</legend>
            <select name="place" data-place-select>
              ${event.venue ? html`<option value="venue">${event.venue.name || "The venue"}</option>` : ""}
              ${meetups.map((m) => html`<option value="meetup:${m.id}">${m.name}</option>`)}
              <option value="custom">Somewhere else (pick on the map)</option>
            </select>
            <div class="form-grid" data-custom-place>
              <label><span>Place name</span><input name="place_name" maxlength="80" placeholder="Café by gate B"></label>
              <div class="pick-row">
                <button type="button" class="button" data-pick-on-map>Pick on the map</button>
                <span class="muted small" data-pick-label>No spot picked yet</span>
              </div>
              <input type="hidden" name="lat"><input type="hidden" name="lng">
            </div>
          </fieldset>
          <fieldset class="full"><legend>Invite <span class="muted">(up to ${MAX_INVITEES})</span></legend>
            ${people.map(
              (p) =>
                html`<label class="check"><input type="checkbox" name="invite_${p.id}" value="1" ${p.id === withId ? "checked" : ""}> ${p.name}</label>`,
            )}
          </fieldset>
          <div class="form-actions full">
            <a href="/meetings" class="link">Cancel</a>
            <button class="button button-primary">Send invite</button>
          </div>
        </form>`
        }
      `,
    }),
  );
});

post("/meetings", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  const rl = rateLimit(`meeting:${user.id}`, 10, 60 * 60_000);
  if (!rl.ok) {
    ctx.error("That's a lot of meetings. Try again later.", 429);
    return;
  }
  const body = await ctx.formBody();
  const event = getEventConfig();
  const title = reqString(body.title, "title", { max: 80 });
  const date = isoDate(body.date, "date");
  const time = hhmm(body.time, "time");
  const place = String(body.place || "");
  let placeName;
  let lat;
  let lng;
  if (place === "venue" && event.venue) {
    placeName = event.venue.name || "The venue";
    lat = event.venue.lat;
    lng = event.venue.lng;
  } else if (place.startsWith("meetup:")) {
    const m = listMeetups().find((x) => x.id === parseInt(place.slice(7), 10));
    if (!m) {
      ctx.error("That meetup point no longer exists.", 400);
      return;
    }
    placeName = m.name;
    lat = m.lat;
    lng = m.lng;
  } else {
    oneOf(place, "place", ["custom"]);
    placeName = reqString(body.place_name, "place_name", { max: 80 });
    lat = Number(body.lat);
    lng = Number(body.lng);
    if (
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(lng) ||
      lng < -180 ||
      lng > 180
    ) {
      ctx.error("Pick the spot on the map first.", 400);
      return;
    }
  }
  const invitees = Object.keys(body)
    .filter((k) => /^invite_\d+$/.test(k) && body[k] === "1")
    .map((k) => parseInt(k.slice(7), 10));
  let id;
  try {
    id = createMeeting({ organizerId: user.id, title, date, time, placeName, lat, lng, invitees });
  } catch (err) {
    ctx.error(errorMessage(err), 400);
    return;
  }
  onMeetingCreated(id);
  ctx.redirect(`/meetings/${id}`);
});

get("/meetings/pins.json", async (ctx) => {
  if (!ctx.user) {
    ctx.json({ error: "sign in" }, 401);
    return;
  }
  ctx.res.setHeader("Cache-Control", "no-store");
  ctx.json(meetingPins(ctx.user.id));
});

get("/meetings/:id", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  const m = getMeeting(parseInt(ctx.params.id, 10), user.id);
  if (!m) {
    ctx.error("That meeting doesn't exist, or you're not on it.", 404);
    return;
  }
  const people = meetingPeople(m.id, user.id);
  const isOrganizer = m.organizer_id === user.id;
  ctx.html(
    layout({
      title: m.title,
      user,
      path: ctx.pathname,
      children: html`
        <section class="page-head"><a class="link" href="/meetings">← Meetings</a></section>
        <section class="card meeting">
          <h1>${m.title}</h1>
          ${m.cancelled_at ? html`<p class="board-flag board-missed">Cancelled</p>` : ""}
          <dl class="ride-card-meta">
            <div><dt>When</dt><dd>${m.meet_date} · ${m.meet_time}</dd></div>
            <div><dt>Where</dt><dd>${m.place_name}</dd></div>
            <div><dt>Organizer</dt><dd>${isOrganizer ? "You" : m.organizer || "Attendee"}</dd></div>
          </dl>
          <p><button type="button" class="button" data-focus-lat="${m.lat}" data-focus-lng="${m.lng}">Show on the map</button></p>
          <h2>Who's coming</h2>
          <ul class="status-list">${people.map(
            (
              p,
            ) => html`<li class="status-${p.status === "accepted" ? "arrived" : p.status === "declined" ? "missed" : "on_time"}">
              <strong>${p.user_id === user.id ? "You" : p.name || "Attendee"}</strong>
              <span class="status-pill">${STATUS[p.status] || p.status}</span>
            </li>`,
          )}</ul>
          ${
            !m.cancelled_at && !isOrganizer
              ? html`<form method="post" action="/meetings/${m.id}/respond" class="row">
                  <button name="answer" value="accepted" class="button ${m.my_status === "accepted" ? "button-primary" : ""}">Going</button>
                  <button name="answer" value="declined" class="button">Can't make it</button>
                </form>`
              : ""
          }
          ${
            isOrganizer && !m.cancelled_at
              ? html`<form method="post" action="/meetings/${m.id}/cancel" class="inline">
                  <button class="button button-danger" data-confirm="Cancel this meeting for everyone?">Cancel meeting</button>
                </form>`
              : ""
          }
        </section>
        <section class="card">
          <h2>Your notes</h2>
          <p class="muted small">Only you can see these. Not even the organizer.</p>
          <form method="post" action="/meetings/${m.id}/notes" class="stacked">
            <label class="sr-only" for="meeting-note">Private notes</label>
            <textarea id="meeting-note" name="body" rows="5" maxlength="4000" placeholder="What to ask, follow-ups, links">${myNote(m.id, user.id)}</textarea>
            <button class="button">Save notes</button>
          </form>
        </section>
      `,
    }),
  );
});

post("/meetings/:id/respond", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  const body = await ctx.formBody();
  const answer = /** @type {'accepted' | 'declined'} */ (
    oneOf(body.answer, "answer", ["accepted", "declined"])
  );
  const id = parseInt(ctx.params.id, 10);
  try {
    respond(id, user.id, answer);
  } catch (err) {
    ctx.error(errorMessage(err), 404);
    return;
  }
  ctx.redirect(`/meetings/${id}`);
});

post("/meetings/:id/notes", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  const body = await ctx.formBody();
  const id = parseInt(ctx.params.id, 10);
  try {
    saveNote(id, user.id, body.body ?? "");
  } catch (err) {
    ctx.error(errorMessage(err), 404);
    return;
  }
  ctx.redirect(`/meetings/${id}`);
});

post("/meetings/:id/cancel", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  const id = parseInt(ctx.params.id, 10);
  cancelMeeting(id, user.id);
  ctx.redirect(`/meetings/${id}`);
});
