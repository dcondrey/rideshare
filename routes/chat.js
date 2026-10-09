// @ts-check
/**
 * Chat (lib/chat.js):
 *   GET  /chat                     the attendee room
 *   POST /chat                     post to the room
 *   POST /chat/:id/report          report a room message
 *   POST /chat/:id/delete          organizer: delete a room message
 *   GET  /messages                 your conversations
 *   GET  /messages/:userId         one conversation
 *   POST /messages/:userId         send a direct message
 *   POST /dm/:id/report            report a direct message sent to you
 *   POST /people/:id/block|unblock
 *   GET  /admin/reports            organizer: open reports
 *   POST /admin/reports/:id        organizer: delete, mute or dismiss
 */

import {
  block,
  canMessage,
  conversations,
  deleteChatMessage,
  displayNameFor,
  hasBlocked,
  isNewConversation,
  MAX_MESSAGE,
  openReports,
  postChat,
  recentChat,
  report,
  resolveReport,
  sendDirect,
  thread,
  unblock,
  unreadCount,
} from "../lib/chat.js";
import { onChatPosted, onDirectMessage } from "../lib/demo.js";
import { errorMessage } from "../lib/errors.js";
import { html, layout } from "../lib/html.js";
import { rateLimit } from "../lib/rate-limit.js";
import { get, post } from "../lib/router.js";
import { optString } from "../lib/validate.js";

/** @param {import("../lib/router.js").RouteCtx} ctx */
function signedIn(ctx) {
  if (!ctx.user) {
    ctx.redirect("/");
    return null;
  }
  return ctx.user;
}

/** @param {import("../lib/router.js").RouteCtx} ctx @param {string} key @param {number} limit @param {number} windowMs */
function limited(ctx, key, limit, windowMs) {
  const rl = rateLimit(key, limit, windowMs);
  if (rl.ok) return false;
  ctx.res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
  ctx.error("Slow down a little; try again in a minute.", 429);
  return true;
}

const time = (ms) => new Date(ms).toISOString().slice(11, 16);

/** @param {'room' | 'messages'} active @param {number} userId */
function tabs(active, userId) {
  const unread = unreadCount(userId);
  return html`<nav class="chat-tabs" aria-label="Chat">
    <a href="/chat" ${active === "room" ? 'aria-current="page"' : ""}>Room</a>
    <a href="/messages" ${active === "messages" ? 'aria-current="page"' : ""}>Messages${unread ? html` <span class="count-badge">${unread}</span>` : ""}</a>
  </nav>`;
}

get("/chat", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  const messages = recentChat(user.id);
  ctx.html(
    layout({
      title: "Chat",
      user,
      path: ctx.pathname,
      children: html`
        ${tabs("room", user.id)}
        <section class="card chat-room">
          <p class="muted small chat-rules">One room for everyone at the event. Be kind, keep it about the event, and report anything that crosses a line; organizers review every report. Messages aren't end-to-end encrypted.</p>
          <ol class="chat-log" data-chat-log data-viewer="${user.id}" data-admin="${user.isAdmin ? "1" : ""}">
            ${messages.map(
              (
                m,
              ) => html`<li class="chat-msg ${m.user_id === user.id ? "is-mine" : ""}" data-id="${m.id}">
                <span class="chat-meta"><strong>${m.user_id === user.id ? "You" : m.name || "Attendee"}</strong> <time>${time(m.created_at)}</time></span>
                <span class="chat-body">${m.body}</span>
                ${
                  m.user_id !== user.id
                    ? html`<form method="post" action="/chat/${m.id}/report" class="chat-action"><button class="link-button" title="Report this message">Report</button></form>`
                    : ""
                }
                ${
                  user.isAdmin
                    ? html`<form method="post" action="/chat/${m.id}/delete" class="chat-action"><button class="link-button">Delete</button></form>`
                    : ""
                }
              </li>`,
            )}
          </ol>
          ${messages.length === 0 ? html`<p class="muted" data-chat-empty>No messages yet. Say hi.</p>` : ""}
          <form method="post" action="/chat" class="chat-form">
            <label class="sr-only" for="chat-body">Message</label>
            <input id="chat-body" name="body" maxlength="${MAX_MESSAGE}" required autocomplete="off" placeholder="Message everyone">
            <button class="button button-primary">Send</button>
          </form>
        </section>
      `,
    }),
  );
});

post("/chat", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  if (limited(ctx, `chat:${user.id}`, 8, 60_000)) return;
  const body = await ctx.formBody();
  try {
    onChatPosted(postChat(user.id, body.body ?? ""));
  } catch (err) {
    ctx.error(errorMessage(err), 400);
    return;
  }
  ctx.redirect("/chat");
});

post("/chat/:id/report", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  if (limited(ctx, `report:${user.id}`, 20, 60 * 60_000)) return;
  try {
    report(user.id, "chat", parseInt(ctx.params.id, 10), null);
  } catch (err) {
    ctx.error(errorMessage(err), 404);
    return;
  }
  ctx.html(
    layout({
      title: "Reported",
      user,
      children: html`<section class="card"><h1>Thanks, we've told the organizers</h1>
        <p>They'll review it. You can also block someone from their profile.</p>
        <p><a class="button" href="/chat">Back to the room</a></p></section>`,
    }),
  );
});

post("/chat/:id/delete", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  if (!user.isAdmin) {
    ctx.error("Organizers only.", 403);
    return;
  }
  deleteChatMessage(user.id, parseInt(ctx.params.id, 10));
  ctx.redirect("/chat");
});

get("/messages", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  const list = conversations(user.id);
  ctx.html(
    layout({
      title: "Messages",
      user,
      path: ctx.pathname,
      children: html`
        ${tabs("messages", user.id)}
        <section class="card">
          ${
            list.length === 0
              ? html`<p class="muted">No messages yet. Start one from someone's profile in <a href="/people">People</a>, or with a ride partner.</p>`
              : html`<ul class="convo-list">${list.map(
                  (c) => html`<li>
                    <a href="/messages/${c.other}" class="convo ${c.unread ? "is-unread" : ""}">
                      <strong>${c.name || "Attendee"}</strong>
                      ${c.unread ? html`<span class="count-badge">${c.unread}</span>` : ""}
                      <span class="muted small convo-last">${c.body}</span>
                    </a>
                  </li>`,
                )}</ul>`
          }
        </section>
      `,
    }),
  );
});

get("/messages/:userId", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  const otherId = parseInt(ctx.params.userId, 10);
  const msgs = thread(user.id, otherId);
  const allowed = canMessage(user.id, otherId);
  if (!allowed && msgs.length === 0) {
    ctx.error("You can't message this person.", 404);
    return;
  }
  const name = displayNameFor(user.id, otherId) || "Attendee";
  ctx.html(
    layout({
      title: name,
      user,
      path: ctx.pathname,
      children: html`
        ${tabs("messages", user.id)}
        <section class="card chat-room">
          <div class="thread-head">
            <h1 class="thread-title">${name}</h1>
            ${allowed ? html`<a class="button button-small" href="/meetings/new?with=${otherId}">Invite to meet</a>` : ""}
          </div>
          <ol class="chat-log" data-dm-log data-other="${otherId}">
            ${msgs.map(
              (
                m,
              ) => html`<li class="chat-msg ${m.sender_id === user.id ? "is-mine" : ""}" data-id="${m.id}">
                <span class="chat-meta"><strong>${m.sender_id === user.id ? "You" : name}</strong> <time>${time(m.created_at)}</time></span>
                <span class="chat-body">${m.body}</span>
                ${
                  m.sender_id !== user.id
                    ? html`<form method="post" action="/dm/${m.id}/report" class="chat-action"><button class="link-button">Report</button></form>`
                    : ""
                }
              </li>`,
            )}
          </ol>
          ${
            allowed
              ? html`<form method="post" action="/messages/${otherId}" class="chat-form">
                  <label class="sr-only" for="dm-body">Message</label>
                  <input id="dm-body" name="body" maxlength="${MAX_MESSAGE}" required autocomplete="off" placeholder="Write a message">
                  <button class="button button-primary">Send</button>
                </form>`
              : html`<p class="muted small">You can't reply to this conversation.</p>`
          }
          <form method="post" action="/people/${otherId}/${hasBlocked(user.id, otherId) ? "unblock" : "block"}" class="inline">
            <button class="link-button">${hasBlocked(user.id, otherId) ? "Unblock" : "Block"} ${name}</button>
          </form>
        </section>
      `,
    }),
  );
});

post("/messages/:userId", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  const to = parseInt(ctx.params.userId, 10);
  if (limited(ctx, `dm:${user.id}`, 20, 60_000)) return;
  if (isNewConversation(user.id, to) && limited(ctx, `dm-new:${user.id}`, 10, 60 * 60_000)) return;
  const body = await ctx.formBody();
  try {
    const id = sendDirect(user.id, to, body.body ?? "");
    onDirectMessage(id);
  } catch (err) {
    ctx.error(errorMessage(err), 403);
    return;
  }
  ctx.redirect(`/messages/${to}`);
});

post("/dm/:id/report", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  if (limited(ctx, `report:${user.id}`, 20, 60 * 60_000)) return;
  try {
    report(user.id, "dm", parseInt(ctx.params.id, 10), null);
  } catch (err) {
    ctx.error(errorMessage(err), 404);
    return;
  }
  ctx.html(
    layout({
      title: "Reported",
      user,
      children: html`<section class="card"><h1>Thanks, we've told the organizers</h1>
        <p>They'll review it. You can block this person too.</p>
        <p><a class="button" href="/messages">Back to messages</a></p></section>`,
    }),
  );
});

for (const action of ["block", "unblock"]) {
  post(`/people/:id/${action}`, async (ctx) => {
    const user = signedIn(ctx);
    if (!user) return;
    const other = parseInt(ctx.params.id, 10);
    if (action === "block") block(user.id, other);
    else unblock(user.id, other);
    ctx.redirect(`/messages/${other}`);
  });
}

get("/admin/reports", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  if (!user.isAdmin) {
    ctx.error("Organizers only.", 403);
    return;
  }
  const reports = openReports();
  ctx.html(
    layout({
      title: "Reports",
      user,
      path: ctx.pathname,
      children: html`
        <section class="page-head"><h1>Reported messages</h1></section>
        ${
          reports.length === 0
            ? html`<p class="muted">Nothing to review.</p>`
            : reports.map(
                (r) => html`<section class="card report">
                  <p class="muted small">${r.kind === "chat" ? "Room" : "Direct message"} · reported by ${r.reporter || "attendee"} at ${new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC</p>
                  <blockquote>${r.body ?? "(message gone)"}</blockquote>
                  <p class="small">Written by <strong>${r.author || "unknown"}</strong></p>
                  <form method="post" action="/admin/reports/${r.id}" class="row">
                    <button name="action" value="delete" class="button">Delete message</button>
                    <button name="action" value="mute" class="button button-danger">Delete and mute 24h</button>
                    <button name="action" value="dismiss" class="button">Dismiss</button>
                  </form>
                </section>`,
              )
        }
      `,
    }),
  );
});

post("/admin/reports/:id", async (ctx) => {
  const user = signedIn(ctx);
  if (!user) return;
  if (!user.isAdmin) {
    ctx.error("Organizers only.", 403);
    return;
  }
  const body = await ctx.formBody();
  const action = optString(body.action, "action", { max: 10 });
  if (action !== "delete" && action !== "mute" && action !== "dismiss") {
    ctx.error("Unknown action.", 400);
    return;
  }
  resolveReport(user.id, parseInt(ctx.params.id, 10), action);
  ctx.redirect("/admin/reports");
});
