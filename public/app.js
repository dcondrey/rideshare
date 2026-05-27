// Tiny progressive-enhancement script.
// Loaded with `defer` and only hooks up things that benefit from JS.
(function () {
  "use strict";

  // 1. Reveal "other place" input when the airport selector is set to OTHER.
  var sel = document.getElementById("airport-select");
  var otherLabel = document.getElementById("other-place-label");
  if (sel && otherLabel) {
    var sync = function () {
      if (sel.value === "OTHER") otherLabel.removeAttribute("hidden");
      else otherLabel.setAttribute("hidden", "");
    };
    sel.addEventListener("change", sync);
    sync();
  }

  // 2. Allowlist file picker → load into textarea (no upload, never on disk).
  var pick = document.getElementById("allowlist-pick");
  var file = document.getElementById("allowlist-file");
  var ta = document.getElementById("allowlist-csv");
  if (pick && file && ta) {
    pick.addEventListener("click", function () { file.click(); });
    file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      if (!f) return;
      if (f.size > 9 * 1024 * 1024) {
        alert("That file is larger than 9MB. Try splitting it.");
        return;
      }
      var reader = new FileReader();
      reader.onload = function () { ta.value = String(reader.result || ""); };
      reader.readAsText(f);
    });
  }

  // 3. "I made this ride" confirmation buttons.
  Array.prototype.forEach.call(
    document.querySelectorAll("[data-confirm-ride]"),
    function (btn) {
      btn.addEventListener("click", function () {
        var rideId = btn.getAttribute("data-confirm-ride");
        var status = btn.parentElement.querySelector("[data-confirm-status]");
        btn.disabled = true;
        if (status) status.textContent = " · saving…";
        fetch("/rides/" + rideId + "/confirm", { method: "POST" })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            if (body && body.recorded) {
              btn.textContent = "✓ You've confirmed";
              if (status) {
                status.textContent = body.dualConfirmed
                  ? " · dual-confirmed! " + (body.issuedCredentialIds || []).length + " credential(s) issued"
                  : " · waiting for the other side";
              }
            } else {
              btn.disabled = false;
              if (status) status.textContent = " · " + (body.error || "failed");
            }
          })
          .catch(function (err) {
            btn.disabled = false;
            if (status) status.textContent = " · " + err.message;
          });
      });
    },
  );

  // 4. Logo file picker → base64 → hidden input.
  var lpick = document.getElementById("logo-pick");
  var lfile = document.getElementById("logo-file");
  var lhidden = document.getElementById("logo-data-url");
  var lpreview = document.getElementById("logo-preview-row");
  var lpreviewImg = document.getElementById("logo-preview-img");
  var lsize = document.getElementById("logo-size");
  var lsubmit = document.getElementById("logo-submit");
  if (lpick && lfile && lhidden) {
    lpick.addEventListener("click", function () { lfile.click(); });
    lfile.addEventListener("change", function () {
      var f = lfile.files && lfile.files[0];
      if (!f) return;
      var maxBytes = 200 * 1024;
      if (f.size > maxBytes) {
        alert("Image is " + Math.round(f.size / 1024) + "KB; max is " + Math.round(maxBytes / 1024) + "KB.");
        lfile.value = "";
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = String(reader.result || "");
        lhidden.value = dataUrl;
        if (lpreviewImg) lpreviewImg.src = dataUrl;
        if (lpreview) lpreview.removeAttribute("hidden");
        if (lsize) lsize.textContent = " (" + Math.round(f.size / 1024) + "KB)";
        if (lsubmit) lsubmit.disabled = false;
      };
      reader.readAsDataURL(f);
    });
  }
})();
