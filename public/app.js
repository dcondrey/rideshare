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

  // 1. Reveal "other place" input when the airport selector is set to OTHER.
  const sel = document.getElementById("airport-select");
  const otherLabel = document.getElementById("other-place-label");
  if (sel && otherLabel) {
    const sync = () => {
      if (sel.value === "OTHER") otherLabel.removeAttribute("hidden");
      else otherLabel.setAttribute("hidden", "");
    };
    sel.addEventListener("change", sync);
    sync();
  }

  // 2. Allowlist file picker → load into textarea (no upload, never on disk).
  const pick = document.getElementById("allowlist-pick");
  const file = document.getElementById("allowlist-file");
  const ta = document.getElementById("allowlist-csv");
  const fileStatus = document.getElementById("allowlist-file-status");
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
          say(fileStatus, `Loaded ${f.name} (${Math.round(f.size / 1024)}KB) into the CSV field.`);
        });
      };
      reader.readAsText(f);
    });
  }

  // 3. "I made this ride" confirmation buttons.
  Array.prototype.forEach.call(document.querySelectorAll("[data-confirm-ride]"), (btn) => {
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
  });

  // 4. Logo file picker → base64 → hidden input.
  const lpick = document.getElementById("logo-pick");
  const lfile = document.getElementById("logo-file");
  const lhidden = document.getElementById("logo-data-url");
  const lpreview = document.getElementById("logo-preview-row");
  const lpreviewImg = document.getElementById("logo-preview-img");
  const lsize = document.getElementById("logo-size");
  const lsubmit = document.getElementById("logo-submit");
  const lstatus = document.getElementById("logo-status");
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
})();
