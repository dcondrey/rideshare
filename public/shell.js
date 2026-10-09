// SPDX-License-Identifier: MIT
// Map-first shell: the full-screen map at / with every other page in a
// slide-out panel (a side drawer on wide screens, a bottom sheet on phones).
//
// A panel loads the real page with fetch and lifts out its <main>, so each
// route keeps rendering on its own for no-JS visitors and deep links. The URL
// becomes /?panel=<path>, so reload and the back button reopen the same panel.
// Forms inside the panel post with fetch and show wherever the server
// redirects; the map refreshes after every post.
(() => {
  const panel = document.getElementById("panel");
  if (!panel) return;
  const body = panel.querySelector(".panel-body");
  const title = panel.querySelector(".panel-title");
  const closeBtn = panel.querySelector(".panel-close");
  const grip = panel.querySelector(".panel-grip");
  let current = null;
  let opener = null;
  let loading = 0;

  // Paths that must leave the shell: downloads, JSON, wallet schemes, the
  // shell itself, and pages that need their own full-page scripts.
  const NOT_PANEL =
    /^\/(?:$|map(?:\/|$)|static\/|logo$|\.well-known\/|oid4v|didcomm$|admin\/insights\.csv|trust\/credentials|auth\/)/;

  /** @param {string} href */
  function panelPath(href) {
    let u;
    try {
      u = new URL(href, location.href);
    } catch {
      return null;
    }
    if (u.origin !== location.origin) return null;
    if (NOT_PANEL.test(u.pathname)) return null;
    return u.pathname + u.search;
  }

  function setUrl(path, push) {
    const url = path ? `/?panel=${encodeURIComponent(path)}` : "/";
    if (push) history.pushState({ panel: path }, "", url);
    else history.replaceState({ panel: path }, "", url);
  }

  /** Put a fetched page's <main> into the panel. */
  function show(html, path, push) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const main = doc.querySelector("main");
    if (!main) {
      location.href = path;
      return;
    }
    for (const s of main.querySelectorAll("script")) s.remove();
    // A page head usually repeats the title and a back link; the panel has both.
    const head = main.querySelector(".page-head");
    const h1 = main.querySelector("h1");
    title.textContent = (h1?.textContent || doc.title.split(" · ")[0] || "").trim();
    if (h1 && head?.contains(h1)) h1.remove();
    body.replaceChildren(...Array.from(main.childNodes).map((n) => document.importNode(n, true)));
    for (const fn of window.rideshareEnhancers || []) {
      try {
        fn(body);
      } catch (err) {
        console.error("[shell] enhancer failed:", err);
      }
    }
    current = path;
    panel.hidden = false;
    document.body.classList.add("panel-open");
    body.scrollTop = 0;
    setUrl(path, push);
    body.focus({ preventScroll: true });
  }

  /** @param {string} path @param {{ push?: boolean }} [opts] */
  function open(path, opts = {}) {
    const target = new URL(path, location.origin);
    if (target.origin !== location.origin) return;
    const ticket = ++loading;
    panel.setAttribute("aria-busy", "true");
    if (!opener && document.activeElement instanceof HTMLElement) opener = document.activeElement;
    fetch(target.pathname + target.search, {
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    })
      .then((r) => {
        if (new URL(r.url).pathname === "/" && !new URL(r.url).searchParams.get("panel")) {
          // Signed out, or the page sent us home.
          if (ticket === loading) close({ push: opts.push !== false });
          return null;
        }
        return r
          .text()
          .then((t) => ({ t, finalPath: new URL(r.url).pathname + new URL(r.url).search }));
      })
      .then((res) => {
        if (!res || ticket !== loading) return;
        show(res.t, res.finalPath, opts.push !== false);
      })
      .catch(() => {
        location.href = path;
      })
      .finally(() => {
        if (ticket === loading) panel.removeAttribute("aria-busy");
      });
  }

  function close(opts = {}) {
    panel.hidden = true;
    panel.classList.remove("is-expanded");
    document.body.classList.remove("panel-open");
    body.replaceChildren();
    current = null;
    setUrl(null, opts.push !== false);
    if (opener?.isConnected) opener.focus();
    opener = null;
  }

  function refreshMap() {
    if (!window.RideshareMap) return;
    fetch("/map/data.json", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) window.RideshareMap.setData(d);
      })
      .catch(() => {});
  }

  // Links anywhere in the shell (nav, map popups, panel content).
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a || a.target || a.hasAttribute("download")) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    const url = new URL(href, location.href);
    if (url.origin === location.origin && url.pathname === "/" && !url.search) {
      e.preventDefault();
      if (current) close();
      return;
    }
    const path = panelPath(href);
    if (!path) return;
    e.preventDefault();
    opener = a;
    open(path);
  });

  // Forms inside the panel post with fetch and stay in the panel.
  panel.addEventListener("submit", (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || e.defaultPrevented) return;
    const action = form.getAttribute("action") || current || "/";
    const target = panelPath(action);
    if (!target) return;
    e.preventDefault();
    const method = (form.getAttribute("method") || "get").toLowerCase();
    const data = new URLSearchParams(new FormData(form, e.submitter));
    if (method === "get") {
      const u = new URL(action, location.href);
      u.search = data.toString();
      open(u.pathname + u.search);
      return;
    }
    panel.setAttribute("aria-busy", "true");
    fetch(action, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
      body: data,
    })
      .then((r) => r.text().then((t) => ({ r, t })))
      .then(({ r, t }) => {
        refreshMap();
        const u = new URL(r.url);
        if (u.pathname === "/" && !u.searchParams.get("panel")) close();
        else show(t, u.pathname + u.search, true);
      })
      .catch(() => form.submit())
      .finally(() => panel.removeAttribute("aria-busy"));
  });

  closeBtn.addEventListener("click", () => close());
  grip.addEventListener("click", () => panel.classList.toggle("is-expanded"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && current && !e.defaultPrevented) close();
  });
  window.addEventListener("popstate", () => {
    const p = new URLSearchParams(location.search).get("panel");
    const path = p ? panelPath(p) : null;
    if (path) open(path, { push: false });
    else if (current) close({ push: false });
  });

  // Map layer filters.
  for (const chip of document.querySelectorAll(".shell-filters [data-layer]")) {
    chip.addEventListener("click", () => {
      const on = chip.getAttribute("aria-pressed") !== "true";
      chip.setAttribute("aria-pressed", String(on));
      window.RideshareMap?.setLayer(chip.dataset.layer, on);
    });
  }

  // Keep the board fresh while the page is visible.
  setInterval(() => {
    if (document.visibilityState === "visible") refreshMap();
  }, 30000);

  const initial = new URLSearchParams(location.search).get("panel");
  const initialPath = initial ? panelPath(initial) : null;
  if (initialPath) open(initialPath, { push: false });
})();

// ── Live layer: people on the move (lib/live.js) ────────────────────────────
// Ride partners' shared positions and, in the live demo, synthetic attendees.
// Markers glide between updates; with reduced motion they jump.
(() => {
  if (!window.EventSource || !document.getElementById("map")) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const live = new Map(); // key → { node, from, to, start }
  const GLIDE_MS = 1800;
  let peopleVisible = true;

  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  function upsert(key, lat, lng, spec) {
    const api = window.RideshareMap;
    if (!api) return;
    let m = live.get(key);
    if (!m) {
      const node = api.map.addMarker({ lat, lng, ...spec, liveKey: key });
      if (!peopleVisible) node.hidden = true;
      m = { node, from: { lat, lng }, to: { lat, lng }, start: 0 };
      live.set(key, m);
      return;
    }
    const cur = m.node.isConnected ? currentPos(m, performance.now()) : m.to;
    m.from = cur;
    m.to = { lat, lng };
    m.start = performance.now();
    if (reduce) api.map.moveMarker(m.node, lat, lng);
  }

  function remove(key) {
    const m = live.get(key);
    if (!m) return;
    window.RideshareMap?.map.clearMarkers((d) => d.liveKey === key);
    live.delete(key);
  }

  function currentPos(m, now) {
    const t = Math.min(1, (now - m.start) / GLIDE_MS);
    return {
      lat: m.from.lat + (m.to.lat - m.from.lat) * t,
      lng: m.from.lng + (m.to.lng - m.from.lng) * t,
    };
  }

  function frame(now) {
    if (!reduce && window.RideshareMap) {
      for (const m of live.values()) {
        if (now - m.start <= GLIDE_MS + 50) {
          const p = currentPos(m, now);
          window.RideshareMap.map.moveMarker(m.node, p.lat, p.lng);
        }
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  const es = new EventSource("/live/stream");
  es.addEventListener("ghosts", (e) => {
    const list = JSON.parse(e.data);
    const seen = new Set();
    for (const g of list) {
      const key = `g${g.id}`;
      seen.add(key);
      upsert(key, g.lat, g.lng, {
        color: "#64748b",
        size: 18,
        layer: "people",
        zIndex: 300,
        ariaLabel: `Synthetic attendee ${g.name}`,
        html: `<strong>${esc(g.name)}</strong><br><em>Synthetic demo attendee on a simulated trip</em>`,
      });
    }
    for (const key of [...live.keys()]) if (key.startsWith("g") && !seen.has(key)) remove(key);
  });
  es.addEventListener("position", (e) => {
    const p = JSON.parse(e.data);
    const key = `u${p.userId}`;
    if (p.gone) return remove(key);
    upsert(key, p.lat, p.lng, {
      color: p.self ? "#2563eb" : "#f59e0b",
      label: p.self ? "•" : (p.name || "?").slice(0, 1).toUpperCase(),
      size: p.self ? 24 : 28,
      layer: "people",
      zIndex: 900,
      ariaLabel: p.self ? "You" : `Ride partner ${p.name}`,
      html: p.self
        ? "<strong>You</strong><br><em>Visible to your ride partners only</em>"
        : `<strong>${esc(p.name)}</strong><br><em>Your ride partner, sharing live</em>`,
    });
  });

  // The People chip covers both partners and synthetic attendees.
  const chip = document.querySelector('.shell-filters [data-layer="people"]');
  chip?.addEventListener("click", () => {
    peopleVisible = chip.getAttribute("aria-pressed") === "true";
    for (const m of live.values()) m.node.hidden = !peopleVisible;
  });

  // ── Sharing my position ──
  const btn = document.querySelector(".shell-share");
  if (!btn || !navigator.geolocation) {
    if (btn) btn.hidden = true;
    return;
  }
  const label = btn.querySelector(".share-label");
  let watch = null;
  let lock = null;
  let lastSent = 0;

  const keepAwake = () =>
    navigator.wakeLock
      ?.request("screen")
      .then((l) => {
        lock = l;
      })
      .catch(() => {});

  function post(path, body, keepalive = false) {
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      keepalive,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : "{}",
    });
  }

  function start() {
    watch = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - lastSent < 4000) return;
        lastSent = now;
        post("/live/position", {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => {
        stop();
        label.textContent = err.code === 1 ? "Location blocked" : "Location unavailable";
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    btn.setAttribute("aria-pressed", "true");
    label.textContent = "Sharing with ride partners";
    keepAwake();
  }

  function stop(keepalive = false) {
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    watch = null;
    lock?.release().catch(() => {});
    lock = null;
    btn.setAttribute("aria-pressed", "false");
    label.textContent = "Share my location";
    post("/live/stop", null, keepalive);
  }

  btn.addEventListener("click", () => (watch === null ? start() : stop()));
  // Closing or leaving the page ends sharing at once, rather than leaving the
  // last point on partners' maps until it expires.
  window.addEventListener("pagehide", () => {
    if (watch !== null) stop(true);
  });
  // The wake lock drops whenever the tab is hidden; take it back on return.
  document.addEventListener("visibilitychange", () => {
    if (watch !== null && document.visibilityState === "visible") keepAwake();
  });
})();
