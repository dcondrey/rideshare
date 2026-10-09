// SPDX-License-Identifier: MIT
// Tiny progressive-enhancement script.
// Loaded with `defer` and only hooks up things that benefit from JS.
(() => {
  // Hand the main thread back before doing work the user is not waiting on.
  // Everything below runs inside an input handler, and INP measures the whole
  // task, so a multi-megabyte string assignment in the same task as the click
  // is what turns a fast interaction into a slow one. scheduler.postTask lets
  // the browser paint the acknowledgement first; setTimeout is the fallback.
  const defer =
    typeof scheduler === "object" && scheduler && typeof scheduler.postTask === "function"
      ? (fn) => scheduler.postTask(fn, { priority: "user-visible" })
      : (fn) => setTimeout(fn, 0);

  /** @param {Element | null} el @param {string} text */
  const say = (el, text) => {
    if (el) el.textContent = text;
  };

  // 0. Ask before a destructive submit. The CSP forbids inline handlers, so the
  //    prompt text rides on a data attribute instead of onclick="confirm()".
  document.addEventListener("click", (e) => {
    const el = e.target instanceof Element ? e.target.closest("[data-confirm]") : null;
    if (el && !window.confirm(el.getAttribute("data-confirm") || "Are you sure?")) {
      e.preventDefault();
    }
  });

  // A select that applies itself on change (the map style picker).
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el instanceof HTMLSelectElement && el.hasAttribute("data-autosubmit") && el.form) {
      el.form.requestSubmit();
    }
  });

  // Per-page enhancements. They run on the document at load, and again on
  // any fragment the map shell (public/shell.js) loads into a panel, so each
  // one looks inside `root` and marks what it has bound to avoid doubling up.
  function enhance(root) {
    const byId = (id) => {
      const el = root.querySelector(`#${id}`);
      if (!el || el.dataset.enhanced) return null;
      return el;
    };
    // OpenID4VP: poll a presentation request until a wallet answers it.
    const pending = root.querySelector("[data-oid4vp-status]");
    if (pending) {
      const id = pending.getAttribute("data-oid4vp-status");
      const show = (s) => {
        const p = document.createElement("p");
        p.className = s.status === "verified" ? "check-pass" : "check-fail";
        p.textContent =
          s.status === "verified"
            ? "Verified: the wallet proved a ride credential from this event."
            : s.status === "expired"
              ? "The request expired."
              : `Failed: ${(s.errors || []).join("; ") || "the presentation did not verify"}`;
        pending.replaceChildren(p);
        if (s.status === "verified") {
          const pre = document.createElement("pre");
          pre.className = "code-block";
          pre.textContent = JSON.stringify(s.claims, null, 2);
          pending.append(pre);
        }
      };
      const tick = () =>
        fetch(`/oid4vp/status/${encodeURIComponent(id)}`)
          .then((r) => r.json())
          .then((s) => {
            if (s.status !== "pending") return show(s);
            if (s.errors?.length) {
              const p = document.createElement("p");
              p.className = "muted small";
              p.textContent = `A response did not verify (${s.errors.join("; ")}). Still waiting for a valid one…`;
              pending.replaceChildren(p);
            }
            setTimeout(tick, 2000);
          })
          .catch(() => setTimeout(tick, 4000));
      setTimeout(tick, 2000);
    }

    // 1. Reveal "other place" input when the airport selector is set to OTHER.
    const sel = byId("airport-select");
    const otherLabel = byId("other-place-label");
    if (sel && otherLabel) {
      const sync = () => {
        if (sel.value === "OTHER") otherLabel.removeAttribute("hidden");
        else otherLabel.setAttribute("hidden", "");
      };
      sel.addEventListener("change", sync);
      sync();
    }

    // 2. Allowlist file picker → load into textarea (no upload, never on disk).
    const pick = byId("allowlist-pick");
    const file = byId("allowlist-file");
    const ta = byId("allowlist-csv");
    const fileStatus = byId("allowlist-file-status");
    if (pick && file && ta) {
      pick.addEventListener("click", () => {
        file.click();
      });
      file.addEventListener("change", () => {
        const f = file.files?.[0];
        if (!f) return;
        // No alert(): a modal dialog blocks the main thread until dismissed, and
        // the live region beside the control already reports this to everyone,
        // screen-reader users included.
        if (f.size > 9 * 1024 * 1024) {
          say(fileStatus, `${f.name} is larger than 9MB. Try splitting it.`);
          return;
        }
        say(fileStatus, `Reading ${f.name}…`);
        const reader = new FileReader();
        reader.onload = () => {
          const text = String(reader.result || "");
          // Up to 9MB into a textarea. Deferred so the reader's task ends and the
          // "Reading…" acknowledgement paints before the long write starts.
          defer(() => {
            ta.value = text;
            say(
              fileStatus,
              `Loaded ${f.name} (${Math.round(f.size / 1024)}KB) into the CSV field.`,
            );
          });
        };
        reader.readAsText(f);
      });
    }

    // 3. "I made this ride" confirmation buttons.
    Array.prototype.forEach.call(
      root.querySelectorAll("[data-confirm-ride]:not([data-enhanced])"),
      (btn) => {
        btn.dataset.enhanced = "1";
        btn.addEventListener("click", () => {
          const rideId = btn.getAttribute("data-confirm-ride");
          const status = btn.parentElement.querySelector("[data-confirm-status]");
          btn.disabled = true;
          if (status) status.textContent = " · saving…";
          fetch(`/rides/${rideId}/confirm`, { method: "POST" })
            .then((r) => r.json())
            .then((body) => {
              if (body?.recorded) {
                btn.textContent = "✓ You've confirmed";
                if (status) {
                  status.textContent = body.dualConfirmed
                    ? " · dual-confirmed! " +
                      (body.issuedCredentialIds || []).length +
                      " credential(s) issued"
                    : " · waiting for the other side";
                }
              } else {
                btn.disabled = false;
                if (status) status.textContent = ` · ${body.error || "failed"}`;
              }
            })
            .catch((err) => {
              btn.disabled = false;
              if (status) status.textContent = ` · ${err.message}`;
            });
        });
      },
    );

    // 4. Logo file picker → base64 → hidden input.
    const lpick = byId("logo-pick");
    const lfile = byId("logo-file");
    const lhidden = byId("logo-data-url");
    const lpreview = byId("logo-preview-row");
    const lpreviewImg = byId("logo-preview-img");
    const lsize = byId("logo-size");
    const lsubmit = byId("logo-submit");
    const lstatus = byId("logo-status");
    if (lpick && lfile && lhidden) {
      lpick.addEventListener("click", () => {
        lfile.click();
      });
      lfile.addEventListener("change", () => {
        const f = lfile.files?.[0];
        if (!f) return;
        const maxBytes = 200 * 1024;
        if (f.size > maxBytes) {
          say(
            lstatus,
            `${f.name} is ${Math.round(f.size / 1024)}KB — over the ${Math.round(maxBytes / 1024)}KB limit.`,
          );
          lfile.value = "";
          return;
        }
        say(lstatus, `Reading ${f.name}…`);
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result || "");
          defer(() => {
            lhidden.value = dataUrl;
            if (lpreviewImg) lpreviewImg.src = dataUrl;
            if (lpreview) lpreview.removeAttribute("hidden");
            if (lsize) lsize.textContent = ` (${Math.round(f.size / 1024)}KB)`;
            say(lstatus, `${f.name} ready to upload.`);
            if (lsubmit) lsubmit.disabled = false;
          });
        };
        reader.readAsDataURL(f);
      });
    }
    root.querySelectorAll("[id]").forEach((el) => {
      el.dataset.enhanced = "1";
    });
  }

  window.rideshareEnhancers = window.rideshareEnhancers || [];
  window.rideshareEnhancers.push(enhance);
  enhance(document);
})();
