// @ts-check
/**
 * Attendee directory (lib/people.js):
 *   GET /people        listed attendees, searchable
 *   GET /people/:id    one profile
 */

import { canMessage, hasBlocked } from "../lib/chat.js";
import { html, layout } from "../lib/html.js";
import { getProfile, listDirectory } from "../lib/people.js";
import { get } from "../lib/router.js";
import { trustBadgeFor } from "../lib/trust.js";

/** @param {number} userId */
function badge(userId) {
  const t = trustBadgeFor(userId);
  return t
    ? html`<span class="trust-badge" title="${t.totalCredentials} confirmed ride${t.totalCredentials === 1 ? "" : "s"} across ${t.distinctEvents} event${t.distinctEvents === 1 ? "" : "s"}">✓ ${t.totalCredentials}</span>`
    : "";
}

/** @param {import("../lib/people.js").Profile} p */
function profileLink(p) {
  return p.link
    ? html`<a href="${p.link}" rel="nofollow ugc noopener" target="_blank">${new URL(p.link).host}</a>`
    : "";
}

get("/people", async (ctx) => {
  const user = ctx.user;
  if (!user) {
    ctx.redirect("/");
    return;
  }
  const q = String(ctx.query.q || "");
  const people = listDirectory({ q, viewerId: user.id });
  ctx.html(
    layout({
      title: "People",
      user,
      path: ctx.pathname,
      children: html`
        <section class="page-head">
          <div>
            <h1>People</h1>
            <p class="muted">Attendees who chose to be listed. <a href="/me">Edit your profile</a> to add yourself.</p>
          </div>
        </section>
        <form class="filter-bar" method="get" action="/people" role="search">
          <label><span>Search</span>
            <input type="search" name="q" value="${q}" maxlength="60" placeholder="Name, affiliation or interest">
          </label>
          <button class="button" type="submit">Search</button>
        </form>
        ${
          people.length === 0
            ? html`<p class="muted">Nobody matches${q ? html` "${q}"` : ""} yet.</p>`
            : html`<ul class="people-grid">${people.map(
                (p) => html`<li class="person-card">
                  <a href="/people/${p.id}" class="person-name">${p.name || "Attendee"}</a>
                  ${badge(p.id)}
                  ${p.affiliation ? html`<span class="muted small">${p.affiliation}</span>` : ""}
                  ${p.bio ? html`<p>${p.bio}</p>` : ""}
                </li>`,
              )}</ul>`
        }
      `,
    }),
  );
});

get("/people/:id", async (ctx) => {
  const user = ctx.user;
  if (!user) {
    ctx.redirect("/");
    return;
  }
  const p = getProfile(parseInt(ctx.params.id, 10), user.id);
  if (!p) {
    ctx.error("That profile isn't listed.", 404);
    return;
  }
  ctx.html(
    layout({
      title: p.name || "Attendee",
      user,
      path: ctx.pathname,
      children: html`
        <section class="page-head"><a class="link" href="/people">← People</a></section>
        <section class="card profile">
          <h1>${p.name || "Attendee"} ${badge(p.id)}</h1>
          ${p.affiliation ? html`<p class="muted">${p.affiliation}</p>` : ""}
          ${p.bio ? html`<p>${p.bio}</p>` : ""}
          ${p.link ? html`<p>${profileLink(p)}</p>` : ""}
          ${
            p.id !== user.id
              ? html`<p class="row">
                  ${
                    canMessage(user.id, p.id)
                      ? html`<a class="button button-primary" href="/messages/${p.id}">Message</a>
                        <a class="button" href="/meetings/new?with=${p.id}">Invite to meet</a>`
                      : ""
                  }
                  <form method="post" action="/people/${p.id}/${hasBlocked(user.id, p.id) ? "unblock" : "block"}" class="inline">
                    <button class="button">${hasBlocked(user.id, p.id) ? "Unblock" : "Block"}</button>
                  </form>
                </p>`
              : ""
          }
          ${p.id === user.id ? html`<p><a class="button" href="/me">Edit profile</a>${p.listed ? "" : html` <span class="muted small">Not listed in the directory.</span>`}</p>` : ""}
        </section>
      `,
    }),
  );
});
