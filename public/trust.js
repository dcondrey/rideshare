// Browser-side portable trust: did:key generation, signing, IndexedDB
// storage, bind/import/export flows.
//
// The user's private key never leaves this device unless the user clicks
// "Download key backup."
//
// Requires Web Crypto Ed25519 (Chrome 113+, Firefox 130+, Safari 17+).

(function () {
  "use strict";

  // ── Multibase / DID:key encoding ──────────────────────────────────────────
  var BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  function base58btcEncode(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var zeroes = 0;
    while (zeroes < u8.length && u8[zeroes] === 0) zeroes++;
    var size = Math.ceil((u8.length - zeroes) * 138 / 100) + 1;
    var b58 = new Uint8Array(size);
    var length = 0;
    for (var i = zeroes; i < u8.length; i++) {
      var carry = u8[i];
      var j = 0;
      for (var k = b58.length - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
        carry += 256 * b58[k];
        b58[k] = carry % 58;
        carry = Math.floor(carry / 58);
      }
      length = j;
    }
    var it = b58.length - length;
    while (it < b58.length && b58[it] === 0) it++;
    var out = "";
    for (var z = 0; z < zeroes; z++) out += "1";
    for (; it < b58.length; it++) out += BASE58[b58[it]];
    return out;
  }

  function pubKeyToDidKey(rawPubKey32) {
    var raw = new Uint8Array(rawPubKey32);
    if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
    var prefixed = new Uint8Array(2 + 32);
    prefixed[0] = 0xed; prefixed[1] = 0x01;
    prefixed.set(raw, 2);
    return "did:key:z" + base58btcEncode(prefixed);
  }

  function bytesToB64u(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64uToBytes(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ── IndexedDB storage ─────────────────────────────────────────────────────
  var DB_NAME = "rideshare-trust";
  var STORE = "keys";

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readonly");
        var req = tx.objectStore(STORE).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function idbPut(key, val) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        var req = tx.objectStore(STORE).put(val, key);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function idbDel(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        var req = tx.objectStore(STORE).delete(key);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ── Key lifecycle ─────────────────────────────────────────────────────────
  // Capabilities check: Web Crypto Ed25519 is required.
  function ensureSupport() {
    if (!window.crypto || !crypto.subtle || typeof crypto.subtle.generateKey !== "function") {
      throw new Error("Web Crypto API not available in this browser.");
    }
  }

  function probeEd25519Support() {
    return crypto.subtle
      .generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  function generateAndStore() {
    return crypto.subtle
      .generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
      .then(function (kp) {
        return crypto.subtle.exportKey("raw", kp.publicKey).then(function (raw) {
          var did = pubKeyToDidKey(raw);
          // Store the CryptoKeyPair directly — IndexedDB supports structured-clone
          // of CryptoKey objects without re-export.
          return idbPut("kp", { keyPair: kp, did: did, createdAt: Date.now() })
            .then(function () { return { keyPair: kp, did: did }; });
        });
      });
  }

  function loadKey() {
    return idbGet("kp").then(function (rec) {
      if (!rec) return null;
      return rec;
    });
  }

  function deleteKey() {
    return idbDel("kp");
  }

  function signWithKey(keyPair, message) {
    var msg = typeof message === "string" ? new TextEncoder().encode(message) : message;
    return crypto.subtle
      .sign({ name: "Ed25519" }, keyPair.privateKey, msg)
      .then(function (sig) { return bytesToB64u(sig); });
  }

  // ── Bind flow ─────────────────────────────────────────────────────────────
  function bindCurrentKey() {
    return loadKey().then(function (rec) {
      if (!rec) throw new Error("No key in this browser yet.");
      return fetch("/trust/bind/challenge", { method: "POST" })
        .then(function (r) { return r.json(); })
        .then(function (body) {
          if (!body.challenge) throw new Error("Server didn't issue a challenge");
          return signWithKey(rec.keyPair, body.challenge).then(function (sig) {
            return fetch("/trust/bind", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                did: rec.did,
                challenge: body.challenge,
                signature: sig,
              }),
            }).then(function (r) { return r.json(); });
          });
        });
    });
  }

  // ── Backup / restore ──────────────────────────────────────────────────────
  function exportKeyJwk() {
    return loadKey().then(function (rec) {
      if (!rec) throw new Error("No key to export");
      return crypto.subtle
        .exportKey("jwk", rec.keyPair.privateKey)
        .then(function (priv) {
          return crypto.subtle
            .exportKey("jwk", rec.keyPair.publicKey)
            .then(function (pub) {
              return {
                "@context": "https://eventrideshare.org/contexts/v1",
                type: "RideshareKeyBackup",
                exportedAt: new Date().toISOString(),
                did: rec.did,
                privateKeyJwk: priv,
                publicKeyJwk: pub,
              };
            });
        });
    });
  }

  function importKeyJwk(backup) {
    if (!backup || !backup.privateKeyJwk || !backup.publicKeyJwk) {
      throw new Error("Backup file missing key material");
    }
    return Promise.all([
      crypto.subtle.importKey(
        "jwk",
        backup.privateKeyJwk,
        { name: "Ed25519" },
        true,
        ["sign"],
      ),
      crypto.subtle.importKey(
        "jwk",
        backup.publicKeyJwk,
        { name: "Ed25519" },
        true,
        ["verify"],
      ),
    ]).then(function (pair) {
      var kp = { privateKey: pair[0], publicKey: pair[1] };
      return crypto.subtle.exportKey("raw", pair[1]).then(function (raw) {
        var did = pubKeyToDidKey(raw);
        return idbPut("kp", { keyPair: kp, did: did, createdAt: Date.now() })
          .then(function () { return { did: did }; });
      });
    });
  }

  function downloadFile(name, content, type) {
    var blob = new Blob([content], { type: type || "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }

  // ── Page bindings ─────────────────────────────────────────────────────────
  function bindCreateButton(btn, status) {
    btn.addEventListener("click", function () {
      btn.disabled = true;
      status.textContent = "Checking browser support…";
      try { ensureSupport(); }
      catch (err) { status.textContent = err.message; btn.disabled = false; return; }
      probeEd25519Support().then(function (ok) {
        if (!ok) {
          status.textContent =
            "Your browser doesn't support Ed25519 in Web Crypto yet. " +
            "Try Chrome 113+, Firefox 130+, or Safari 17+.";
          btn.disabled = false;
          return;
        }
        status.textContent = "Generating Ed25519 keypair…";
        return generateAndStore().then(function (rec) {
          status.textContent = "Generated. Binding to your account…";
          return bindCurrentKey().then(function (res) {
            if (!res.ok) {
              status.textContent = "Bind failed: " + (res.error || "unknown");
              btn.disabled = false;
              return;
            }
            status.textContent = "✓ Bound: " + rec.did + ". Reloading…";
            setTimeout(function () { location.reload(); }, 600);
          });
        });
      }).catch(function (err) {
        status.textContent = "Error: " + err.message;
        btn.disabled = false;
      });
    });
  }

  function bindExportButton(btn) {
    btn.addEventListener("click", function () {
      exportKeyJwk().then(function (backup) {
        downloadFile(
          "rideshare-key-backup-" + new Date().toISOString().slice(0, 10) + ".json",
          JSON.stringify(backup, null, 2),
          "application/json",
        );
      }).catch(function (err) {
        alert("Export failed: " + err.message);
      });
    });
  }

  function bindRotateButton(btn) {
    btn.addEventListener("click", function () {
      if (!confirm(
        "Generating a new key revokes credentials issued under your old DID. " +
        "Continue?",
      )) return;
      deleteKey().then(generateAndStore).then(function () {
        return bindCurrentKey();
      }).then(function (res) {
        if (res && res.ok) location.reload();
        else alert("Rotate failed: " + (res && res.error));
      }).catch(function (err) { alert(err.message); });
    });
  }

  function bindImportForm(form, ta, file, pickBtn, results) {
    pickBtn.addEventListener("click", function () { file.click(); });
    file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { ta.value = String(reader.result || ""); };
      reader.readAsText(f);
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      results.textContent = "Verifying…";
      var text = (ta.value || "").trim();
      if (!text) { results.textContent = "Paste at least one credential."; return; }
      // Parse: try JSON first (bundle), then newline-separated JWTs
      var jwts = [];
      try {
        var parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          jwts = parsed.filter(function (x) { return typeof x === "string"; });
        } else if (parsed && Array.isArray(parsed.credentials)) {
          jwts = parsed.credentials
            .map(function (c) { return typeof c === "string" ? c : c.jwt; })
            .filter(Boolean);
        } else if (parsed && Array.isArray(parsed.jwts)) {
          jwts = parsed.jwts.filter(function (x) { return typeof x === "string"; });
        } else if (typeof parsed === "string") {
          jwts = [parsed];
        }
      } catch (_) {
        jwts = text.split(/\s+/).filter(function (l) {
          return l && l.split(".").length === 3;
        });
      }
      if (jwts.length === 0) {
        results.textContent = "Couldn't find any JWTs in that input.";
        return;
      }
      fetch("/trust/import-bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jwts: jwts }),
      })
        .then(function (r) { return r.json(); })
        .then(function (body) {
          var html = "<p><strong>" + body.imported + " of " + body.total + " imported.</strong></p>";
          html += "<ul>";
          (body.results || []).forEach(function (r, i) {
            if (r.ok) {
              html += "<li class=\"check-pass\">#" + (i + 1) + " — " + (r.id || "imported") + "</li>";
            } else {
              html += "<li class=\"check-fail\">#" + (i + 1) + " — " + (r.error || "failed");
              if (r.errors && r.errors.length) html += " · " + r.errors.join(", ");
              html += "</li>";
            }
          });
          html += "</ul>";
          if (body.imported > 0) html += "<p><a href=\"/trust\">Reload to see them →</a></p>";
          results.innerHTML = html;
        })
        .catch(function (err) { results.textContent = "Import failed: " + err.message; });
    });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function () {
    var create = document.getElementById("trust-create-key");
    var status = document.getElementById("trust-create-status");
    if (create && status) bindCreateButton(create, status);

    var exp = document.getElementById("trust-export-key");
    if (exp) bindExportButton(exp);

    var rot = document.getElementById("trust-rotate-key");
    if (rot) bindRotateButton(rot);

    var form = document.getElementById("trust-import-form");
    var ta = document.getElementById("trust-import-text");
    var file = document.getElementById("trust-import-file");
    var pick = document.getElementById("trust-import-pick");
    var results = document.getElementById("trust-import-results");
    if (form && ta && file && pick && results) {
      bindImportForm(form, ta, file, pick, results);
    }
  });
})();
