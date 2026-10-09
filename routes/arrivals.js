// @ts-check
/**
 * GET /arrivals: the arrivals and departures board (lib/arrivals.js).
 */

import { boardSlots } from "../lib/arrivals.js";
import { getEventConfig } from "../lib/event-config.js";
import { html, layout } from "../lib/html.js";
import { get } from "../lib/router.js";

/** @param {import("../lib/arrivals.js").BoardSlot[]} slots */
function board(slots, emptyText) {
  if (slots.length === 0) return html`<p class="muted">${emptyText}</p>`;
  const days = [...new Set(slots.map((s) => s.date))];
  return days.map(
    (day) => html`
      <h3 class="board-day">${day}</h3>
      <table class="board">
        <thead><tr><th>Hour</th><th>Where</th><th>People</th><th>Rides</th><th>Status</th></tr></thead>
        <tbody>
          ${slots
            .filter((s) => s.date === day)
            .map(
              (s) => html`<tr>
                <td class="board-time">${s.hour}</td>
                <td>${s.airport === "OTHER" ? "Other" : s.airport}</td>
                <td class="board-num">${s.people}</td>
                <td class="board-num">${s.rides}${s.groups ? html` <span class="muted small">(${s.groups} group${s.groups === 1 ? "" : "s"})</span>` : ""}</td>
                <td>${
                  s.missed
                    ? html`<span class="board-flag board-missed">${s.missed} missed</span>`
                    : ""
                }${
                  s.delayed
                    ? html`<span class="board-flag board-late">${s.delayed} late</span>`
                    : ""
                }${!s.missed && !s.delayed ? html`<span class="board-flag board-ok">On time</span>` : ""}</td>
              </tr>`,
            )}
        </tbody>
      </table>`,
  );
}

get("/arrivals", async (ctx) => {
  if (!ctx.user) {
    ctx.redirect("/");
    return;
  }
  const event = getEventConfig();
  ctx.html(
    layout({
      title: "Arrivals",
      user: ctx.user,
      path: ctx.pathname,
      children: html`
        <section class="page-head">
          <div>
            <h1>Arrivals board</h1>
            <p class="muted">Who's landing and leaving when, from every ride on the board. Counts only; no names. "Late" and "missed" come from riders' own trip updates.</p>
          </div>
        </section>
        <section class="card">
          <h2>Arriving at ${event.venue?.name || "the venue"}</h2>
          ${board(boardSlots("to_venue"), "No arrivals posted yet.")}
        </section>
        <section class="card">
          <h2>Leaving</h2>
          ${board(boardSlots("from_venue"), "No departures posted yet.")}
        </section>
      `,
    }),
  );
});
