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
    const ticket = ++loading;
    panel.setAttribute("aria-busy", "true");
    if (!opener && document.activeElement instanceof HTMLElement) opener = document.activeElement;
    fetch(path, { credentials: "same-origin", headers: { Accept: "text/html" } })
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
