// @ts-check
/**
 * Admin routes (gated by ADMIN_EMAILS).
 *
 *   GET  /admin                  → dashboard (insights + links)
 *   GET  /admin/allowlist        → upload / wipe / count
 *   POST /admin/allowlist        → import (replace or append)
 *   POST /admin/allowlist/wipe   → erase all hashes
 *   POST /admin/allowlist/check  → "is X on the allowlist?" (rate-limited)
 *   GET  /admin/config           → editable event config
 *   POST /admin/config           → save overrides
 *   GET  /admin/insights.csv     → CSV export of aggregate metrics
 *   GET  /admin/audit            → recent audit log entries
 */

import { get, post } from "../lib/router.js";
import { layout, html } from "../lib/html.js";
import {
  parseAllowlistCsv,
  replaceAllowlist,
  appendAllowlist,
  wipeAllowlist,
  allowlistCount,
  isAllowed,
} from "../lib/allowlist.js";
import {
  getEventConfig,
  setOverride,
  listOverridableKeys,
} from "../lib/event-config.js";
import {
  funnel,
  activity,
  medianTimeToMatchHours,
  byAirport,
  byDirection,
  byDate,
  unmetDemand,
  metricsCsv,
} from "../lib/insights.js";
import { db } from "../lib/db.js";
import { rateLimit } from "../lib/rate-limit.js";
import {
  email as emailField,
  oneOf,
  reqString,
  optString,
  reqInt,
} from "../lib/validate.js";
import { listMeetups, createMeetup, deleteMeetup } from "../lib/meetups.js";
import { uploadLogo, removeLogo, hasLogo, MAX_LOGO_BYTES } from "../lib/assets.js";
import { listStyles } from "../lib/map-styles.js";

function requireAdmin(ctx) {
  if (!ctx.user) {
    ctx.redirect("/");
    return null;
  }
  if (!ctx.user.isAdmin) {
    ctx.error("Admin only.", 403);
    return null;
  }
  return ctx.user;
}

// ── Dashboard ────────────────────────────────────────────────────────────────
get("/admin", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  const f = funnel();
  const a = activity();
  const ttm = medianTimeToMatchHours();
  const unmet = unmetDemand();

  ctx.html(
    layout({
      title: "Admin",
      user,
      children: html`
        <section class="page-head">
          <h1>Admin dashboard</h1>
          <nav class="subnav">
            <a href="/admin/allowlist">Attendee allowlist</a>
            <a href="/admin/meetups">Meetup pins</a>
            <a href="/admin/config">Event config & logo</a>
            <a href="/admin/audit">Audit log</a>
            <a href="/admin/insights.csv">Export metrics CSV</a>
          </nav>
        </section>

        <section class="stat-grid">
          ${stat("Allowlisted", f.allowlisted)}
          ${stat("Signed in", f.signedIn)}
          ${stat("Posted a ride", f.posters)}
          ${stat("Matched", f.matched)}
        </section>

        <section class="stat-grid">
          ${stat("Offers", a.offers)}
          ${stat("Requests", a.requests)}
          ${stat("Claims", a.totalClaims)}
          ${stat("Accepted", a.acceptedClaims)}
        </section>

        <section class="stat-grid">
          ${stat("Request match rate", a.requestMatchRate == null ? "—" : `${a.requestMatchRate}%`)}
          ${stat("Offer match rate", a.offerMatchRate == null ? "—" : `${a.offerMatchRate}%`)}
          ${stat("Median time-to-match", ttm == null ? "—" : `${ttm}h`)}
        </section>

        <section class="card">
          <h2>By airport</h2>
          ${groupedTable(byAirport(), ["airport", "kind", "c"])}
        </section>

        <section class="card">
          <h2>By direction</h2>
          ${groupedTable(byDirection(), ["direction", "kind", "c"])}
        </section>

        <section class="card">
          <h2>By date</h2>
          ${groupedTable(byDate(), ["date", "kind", "c"])}
        </section>

        <section class="card">
          <h2>Unmet demand <span class="muted">(open requests with no accepted claim)</span></h2>
          ${unmet.length === 0
            ? html`<p class="muted">None — every open request has at least one accepted claim. Nice.</p>`
            : groupedTable(unmet, ["date", "airport", "direction", "c"])}
        </section>

        <p class="muted small">
          Insights are aggregate. Buckets with fewer than 5 entries are coalesced into "Other"
          to protect attendee privacy.
        </p>
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

function groupedTable(rows, cols) {
  if (rows.length === 0) return html`<p class="muted">No data yet.</p>`;
  return html`<table class="data-table">
    <thead><tr>${cols.map((c) => html`<th>${c}</th>`)}</tr></thead>
    <tbody>${rows.map(
      (r) => html`<tr>${cols.map((c) => html`<td>${String(r[c])}</td>`)}</tr>`,
    )}</tbody>
  </table>`;
}

// ── Allowlist ────────────────────────────────────────────────────────────────
get("/admin/allowlist", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  ctx.html(
    layout({
      title: "Allowlist",
      user,
      children: html`
        <section class="page-head">
          <a class="link" href="/admin">← Admin</a>
          <h1>Attendee allowlist</h1>
        </section>

        <section class="card">
          <h2>Currently <strong>${allowlistCount()}</strong> entries.</h2>
          <p class="muted">
            Emails are stored as one-way HMAC hashes — the original list cannot be exported
            from this app. To rotate the underlying salt, change <code>ALLOWLIST_SALT</code>
            and re-import.
          </p>
        </section>

        <section class="card">
          <h2>Import attendees</h2>
          <p class="muted small">
            Paste your CSV below, or click the file button to load one. Accepts a single column
            of emails, or a multi-column file with an "email" header. Other columns are ignored.
            <strong>The file you upload is never written to disk.</strong>
          </p>
          <form method="post" action="/admin/allowlist" class="stacked" id="allowlist-form">
            <input type="file" accept=".csv,text/csv,text/plain" id="allowlist-file" hidden>
            <button type="button" class="button" id="allowlist-pick">Choose file…</button>
            <label><span>CSV content</span>
              <textarea name="csv" id="allowlist-csv" rows="10" required
                        placeholder="email&#10;alice@example.com&#10;bob@example.com&#10;…"></textarea>
            </label>
            <fieldset class="radio-pair">
              <legend>Mode</legend>
              <label class="radio-tile">
                <input type="radio" name="mode" value="replace" checked>
                <strong>Replace</strong>
                <span class="muted">Erase all existing entries, then import.</span>
              </label>
              <label class="radio-tile">
                <input type="radio" name="mode" value="append">
                <strong>Append</strong>
                <span class="muted">Add new entries, keep existing ones.</span>
              </label>
            </fieldset>
            <button type="submit" class="button button-primary">Import</button>
          </form>
        </section>

        <section class="card">
          <h2>Check membership</h2>
          <p class="muted small">
            Look up whether a single email is on the allowlist. Rate-limited and audited.
          </p>
          <form method="post" action="/admin/allowlist/check" class="row">
            <input type="email" name="email" required placeholder="someone@example.com">
            <button type="submit" class="button">Check</button>
          </form>
        </section>

        <section class="card card-danger">
          <h2>Wipe all attendee data</h2>
          <p class="muted small">
            Removes every hash from the allowlist. Existing user accounts are preserved
            (so anyone already signed in stays signed in), but new sign-ins will be blocked
            until you re-import.
          </p>
          <form method="post" action="/admin/allowlist/wipe">
            <button class="button button-danger"
                    onclick="return confirm('Erase all ${allowlistCount()} allowlist entries?')">
              Wipe allowlist
            </button>
          </form>
        </section>
      `,
    }),
  );
});

post("/admin/allowlist", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  const body = await ctx.formBody();
  const csv = reqString(body.csv, "csv", { max: 9 * 1024 * 1024 });
  const mode = oneOf(body.mode || "replace", "mode", ["replace", "append"]);
  const { emails, skippedInvalid, totalRows } = parseAllowlistCsv(csv);
  if (emails.length === 0) {
    ctx.error("No valid emails found in that CSV.");
    return;
  }
  const result =
    mode === "replace"
      ? replaceAllowlist(emails, {
          actorId: user.id,
          actorEmail: user.email,
          ip: ctx.ip(),
        })
      : appendAllowlist(emails, {
          actorId: user.id,
          actorEmail: user.email,
          ip: ctx.ip(),
        });
  ctx.html(
    layout({
      title: "Imported",
      user,
      children: html`
        <section class="card centered">
          <h1>Imported ${result.added} ${mode === "append" ? "new " : ""}entries</h1>
          <p class="muted">
            Parsed ${totalRows} rows · skipped ${skippedInvalid} invalid · ${result.added} added.
            Total now: <strong>${allowlistCount()}</strong>.
          </p>
          <p><a href="/admin/allowlist" class="button">Back to allowlist</a></p>
        </section>
      `,
    }),
  );
});

post("/admin/allowlist/wipe", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  wipeAllowlist({ actorId: user.id, actorEmail: user.email, ip: ctx.ip() });
  ctx.redirect("/admin/allowlist");
});

post("/admin/allowlist/check", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  const body = await ctx.formBody();
  const target = emailField(body.email);
  const rl = rateLimit(`admincheck:${user.id}`, 30, 60 * 60 * 1000);
  if (!rl.ok) {
    ctx.error("You've checked too many emails recently. Try again later.", 429);
    return;
  }
  const present = isAllowed(target);
  ctx.html(
    layout({
      title: "Allowlist check",
      user,
      children: html`
        <section class="card centered">
          <h1>${present ? "✓ On the allowlist" : "✗ Not on the allowlist"}</h1>
          <p class="muted">${target}</p>
          <p><a class="button" href="/admin/allowlist">Back</a></p>
        </section>
      `,
    }),
  );
});

// ── Event config editor ──────────────────────────────────────────────────────
get("/admin/config", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  const event = getEventConfig();
  const styles = listStyles();
  ctx.html(
    layout({
      title: "Event config",
      user,
      children: html`
        <section class="page-head">
          <a class="link" href="/admin">← Admin</a>
          <h1>Event configuration</h1>
        </section>

        <p class="muted">
          These fields load from <code>event.config.yaml</code> and can be overridden
          here at runtime. Saved overrides take effect immediately. Leave a field
          blank to revert to the file default.
        </p>

        <form method="post" action="/admin/config" class="card stacked form-grid">
          <h2 class="full">Event</h2>
          ${configField("name", "Short name", event.name)}
          ${configField("longName", "Long name", event.longName)}
          ${configField("tagline", "Tagline", event.tagline)}
          ${configField("dates.start", "Start date (YYYY-MM-DD)", event.dates.start)}
          ${configField("dates.end", "End date (YYYY-MM-DD)", event.dates.end)}

          <h2 class="full">Venue</h2>
          ${configField("venue.name", "Venue name", event.venue.name)}
          ${configField("venue.address", "Venue address", event.venue.address)}
          ${configField("venue.lat", "Venue latitude", event.venue.lat ?? "")}
          ${configField("venue.lng", "Venue longitude", event.venue.lng ?? "")}

          <h2 class="full">Map</h2>
          <label>
            <span>Default style <span class="muted small">(map.style)</span></span>
            <select name="map.style">
              ${styles.map(
                (s) => html`<option value="${s.key}" ${event.map?.style === s.key ? "selected" : ""}>${s.label}</option>`,
              )}
              <option value="custom" ${event.map?.style === "custom" ? "selected" : ""}>Custom</option>
            </select>
          </label>
          ${configField("map.defaultZoom", "Default zoom (1–18)", event.map?.defaultZoom ?? 11)}
          ${configField("map.customTileUrl", "Custom tile URL", event.map?.customTileUrl || "")}
          ${configField("map.customAttribution", "Custom attribution (HTML allowed)", event.map?.customAttribution || "")}

          <h2 class="full">Branding</h2>
          ${configField("brand.primaryColor", "Primary colour (hex)", event.brand?.primaryColor || "")}
          ${configField("brand.logoPath", "Logo path (if not using upload)", event.brand?.logoPath || "")}

          <h2 class="full">Optional</h2>
          ${configField("registrationUrl", "Registration URL", event.registrationUrl || "")}
          ${configField("supportEmail", "Support email", event.supportEmail || "")}

          <div class="form-actions full">
            <button class="button button-primary">Save overrides</button>
          </div>
        </form>

        <section class="card">
          <h2>Logo</h2>
          ${
            hasLogo()
              ? html`<p>
                  Current logo: <img src="/logo" alt="" class="logo-preview">
                </p>
                <form method="post" action="/admin/logo/remove" class="inline">
                  <button class="button">Remove logo</button>
                </form>`
              : html`<p class="muted">No logo uploaded. Upload one below, or set <code>brand.logoPath</code> above to point at a file in <code>public/</code>.</p>`
          }
          <form method="post" action="/admin/logo" class="stacked" id="logo-form">
            <input type="file" id="logo-file" accept="image/svg+xml,image/png,image/webp,image/jpeg" hidden>
            <button type="button" class="button" id="logo-pick">Choose image…</button>
            <input type="hidden" name="logo_data_url" id="logo-data-url">
            <p class="muted small" id="logo-preview-row" hidden>
              Preview: <img id="logo-preview-img" alt="" style="max-height:48px;vertical-align:middle">
              <span id="logo-size"></span>
            </p>
            <p class="muted small">
              SVG, PNG, WebP or JPEG. Max ${Math.round(MAX_LOGO_BYTES / 1024)}KB.
              Stored in the database; served from <code>/logo</code>.
            </p>
            <button type="submit" class="button button-primary" id="logo-submit" disabled>Upload logo</button>
          </form>
        </section>
        <script src="/app.js" defer></script>
      `,
    }),
  );
});

function configField(key, label, value) {
  return html`<label>
    <span>${label} <span class="muted small">(${key})</span></span>
    <input type="text" name="${key}" value="${value ?? ""}">
  </label>`;
}

post("/admin/config", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  const body = await ctx.formBody();
  for (const key of listOverridableKeys()) {
    let v = (body[key] ?? "").trim();
    let coerced = v === "" ? null : v;
    // Numeric coercion for known number fields
    if (
      coerced != null &&
      (key === "venue.lat" ||
        key === "venue.lng" ||
        key === "map.defaultZoom")
    ) {
      const n = parseFloat(v);
      if (!Number.isFinite(n)) coerced = null;
      else coerced = key === "map.defaultZoom" ? Math.round(n) : n;
    }
    setOverride(key, coerced);
  }
  ctx.redirect("/admin/config");
});

post("/admin/logo", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  const body = await ctx.formBody();
  const dataUrl = body.logo_data_url || "";
  if (!dataUrl) {
    ctx.error("No image selected.", 400);
    return;
  }
  try {
    uploadLogo(dataUrl, { actorId: user.id, actorEmail: user.email });
  } catch (err) {
    ctx.error(err.message, 400);
    return;
  }
  ctx.redirect("/admin/config");
});

post("/admin/logo/remove", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  removeLogo({ actorId: user.id, actorEmail: user.email });
  ctx.redirect("/admin/config");
});

// ── Meetups ──────────────────────────────────────────────────────────────────
get("/admin/meetups", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  const list = listMeetups();
  ctx.html(
    layout({
      title: "Meetups",
      user,
      children: html`
        <section class="page-head">
          <a class="link" href="/admin">← Admin</a>
          <h1>Meetup pins</h1>
        </section>
        <p class="muted">
          Pre-defined pickup spots. They appear as pins on the map and become
          selectable when posting a ride. Useful for hotels, transit hubs, or
          parking lots near the venue.
        </p>

        <section class="card">
          <h2>Add a meetup</h2>
          <form method="post" action="/admin/meetups" class="stacked form-grid">
            <label class="full">
              <span>Name</span>
              <input type="text" name="name" maxlength="100" required placeholder="Hotel Avante">
            </label>
            <label class="full">
              <span>Address <span class="muted">(optional)</span></span>
              <input type="text" name="address" maxlength="200" placeholder="860 E El Camino Real, Mountain View">
            </label>
            <label>
              <span>Latitude</span>
              <input type="text" name="lat" required placeholder="37.3989" inputmode="decimal">
            </label>
            <label>
              <span>Longitude</span>
              <input type="text" name="lng" required placeholder="-122.0822" inputmode="decimal">
            </label>
            <p class="muted small full">
              Tip: in Google Maps, right-click the spot → first item is "lat, lng" — click to copy.
            </p>
            <div class="form-actions full">
              <button class="button button-primary">Add meetup</button>
            </div>
          </form>
        </section>

        <section class="card">
          <h2>Existing meetups (${list.length})</h2>
          ${
            list.length === 0
              ? html`<p class="muted">None yet.</p>`
              : html`<ul class="claim-list">
                  ${list.map(
                    (m) => html`
                      <li class="claim-row">
                        <strong>${m.name}</strong>
                        <span class="muted small"> — ${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}</span>
                        ${m.address ? html`<p class="muted small">${m.address}</p>` : ""}
                        <form method="post" action="/admin/meetups/${m.id}/delete" class="inline">
                          <button class="button button-small"
                                  onclick="return confirm('Delete this meetup?')">Delete</button>
                        </form>
                      </li>`,
                  )}
                </ul>`
          }
        </section>
      `,
    }),
  );
});

post("/admin/meetups", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  const body = await ctx.formBody();
  const name = reqString(body.name, "name", { max: 100 });
  const address = optString(body.address, "address", { max: 200 });
  const lat = parseFloat(body.lat ?? "");
  const lng = parseFloat(body.lng ?? "");
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    ctx.error("Latitude must be a number between -90 and 90.", 400);
    return;
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    ctx.error("Longitude must be a number between -180 and 180.", 400);
    return;
  }
  createMeetup(
    { name, address, lat, lng },
    { actorId: user.id, actorEmail: user.email },
  );
  ctx.redirect("/admin/meetups");
});

post("/admin/meetups/:id/delete", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  deleteMeetup(parseInt(ctx.params.id, 10), {
    actorId: user.id,
    actorEmail: user.email,
  });
  ctx.redirect("/admin/meetups");
});

// ── Insights export ──────────────────────────────────────────────────────────
get("/admin/insights.csv", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  ctx.res.statusCode = 200;
  ctx.res.setHeader("Content-Type", "text/csv; charset=utf-8");
  ctx.res.setHeader(
    "Content-Disposition",
    `attachment; filename="rideshare-metrics-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  ctx.res.end(metricsCsv());
});

// ── Audit log ────────────────────────────────────────────────────────────────
get("/admin/audit", async (ctx) => {
  const user = requireAdmin(ctx);
  if (!user) return;
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT actor_email, action, detail, ip, created_at
           FROM audit_log ORDER BY created_at DESC LIMIT 200`,
      )
      .all()
  );
  ctx.html(
    layout({
      title: "Audit log",
      user,
      children: html`
        <section class="page-head">
          <a class="link" href="/admin">← Admin</a>
          <h1>Audit log</h1>
        </section>
        ${rows.length === 0
          ? html`<p class="muted">No events recorded yet.</p>`
          : html`<table class="data-table audit-table">
              <thead><tr>
                <th>When</th><th>Actor</th><th>Action</th><th>Detail</th><th>IP</th>
              </tr></thead>
              <tbody>${rows.map(
                (r) => html`<tr>
                  <td>${new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19)}</td>
                  <td>${r.actor_email || "—"}</td>
                  <td><code>${r.action}</code></td>
                  <td class="muted small">${r.detail || ""}</td>
                  <td class="muted small">${r.ip || ""}</td>
                </tr>`,
              )}</tbody>
            </table>`}
      `,
    }),
  );
});
