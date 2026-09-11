// SPDX-License-Identifier: MIT
// Browser-side portable trust: did:key generation, signing, IndexedDB
// storage, bind/import/export flows.
//
// The user's private key never leaves this device unless the user clicks
// "Download key backup."
//
// Requires Web Crypto Ed25519 (Chrome 113+, Firefox 130+, Safari 17+).

(() => {
  // ── Multibase / DID:key encoding ──────────────────────────────────────────
  const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  function base58btcEncode(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let zeroes = 0;
    while (zeroes < u8.length && u8[zeroes] === 0) zeroes++;
    const size = Math.ceil(((u8.length - zeroes) * 138) / 100) + 1;
    const b58 = new Uint8Array(size);
    let length = 0;
    for (let i = zeroes; i < u8.length; i++) {
      let carry = u8[i];
      let j = 0;
      for (let k = b58.length - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
        carry += 256 * b58[k];
        b58[k] = carry % 58;
        carry = Math.floor(carry / 58);
      }
      length = j;
    }
    let it = b58.length - length;
    while (it < b58.length && b58[it] === 0) it++;
    let out = "";
    for (let z = 0; z < zeroes; z++) out += "1";
    for (; it < b58.length; it++) out += BASE58[b58[it]];
    return out;
  }

  function pubKeyToDidKey(rawPubKey32) {
    const raw = new Uint8Array(rawPubKey32);
    if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
    const prefixed = new Uint8Array(2 + 32);
    prefixed[0] = 0xed;
    prefixed[1] = 0x01;
    prefixed.set(raw, 2);
    return `did:key:z${base58btcEncode(prefixed)}`;
  }

  function bytesToB64u(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function _b64uToBytes(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ── IndexedDB storage ─────────────────────────────────────────────────────
  const DB_NAME = "rideshare-trust";
  const STORE = "keys";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(req.error);
      };
    });
  }

  function idbGet(key) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).get(key);
          req.onsuccess = () => {
            resolve(req.result);
          };
          req.onerror = () => {
            reject(req.error);
          };
        }),
    );
  }
  function idbPut(key, val) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          const req = tx.objectStore(STORE).put(val, key);
          req.onsuccess = () => {
            resolve();
          };
          req.onerror = () => {
            reject(req.error);
          };
        }),
    );
  }
  function idbDel(key) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          const req = tx.objectStore(STORE).delete(key);
          req.onsuccess = () => {
            resolve();
          };
          req.onerror = () => {
            reject(req.error);
          };
        }),
    );
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
      .then(() => true)
      .catch(() => false);
  }

  function generateAndStore() {
    return crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]).then((kp) =>
      crypto.subtle.exportKey("raw", kp.publicKey).then((raw) => {
        const did = pubKeyToDidKey(raw);
        // Store the CryptoKeyPair directly — IndexedDB supports structured-clone
        // of CryptoKey objects without re-export.
        return idbPut("kp", {
          keyPair: kp,
          did: did,
          createdAt: Date.now(),
        }).then(() => ({ keyPair: kp, did: did }));
      }),
    );
  }

  function loadKey() {
    return idbGet("kp").then((rec) => {
      if (!rec) return null;
      return rec;
    });
  }

  function deleteKey() {
    return idbDel("kp");
  }

  function signWithKey(keyPair, message) {
    const msg = typeof message === "string" ? new TextEncoder().encode(message) : message;
    return crypto.subtle
      .sign({ name: "Ed25519" }, keyPair.privateKey, msg)
      .then((sig) => bytesToB64u(sig));
  }

  // ── Bind flow ─────────────────────────────────────────────────────────────
  function bindCurrentKey() {
    return loadKey().then((rec) => {
      if (!rec) throw new Error("No key in this browser yet.");
      return fetch("/trust/bind/challenge", { method: "POST" })
        .then((r) => r.json())
        .then((body) => {
          if (!body.challenge) throw new Error("Server didn't issue a challenge");
          return signWithKey(rec.keyPair, body.challenge).then((sig) =>
            fetch("/trust/bind", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                did: rec.did,
                challenge: body.challenge,
                signature: sig,
              }),
            }).then((r) => r.json()),
          );
        });
    });
  }

  // ── Backup / restore ──────────────────────────────────────────────────────
  function exportKeyJwk() {
    return loadKey().then((rec) => {
      if (!rec) throw new Error("No key to export");
      return crypto.subtle.exportKey("jwk", rec.keyPair.privateKey).then((priv) =>
        crypto.subtle.exportKey("jwk", rec.keyPair.publicKey).then((pub) => ({
          "@context": "https://eventrideshare.org/contexts/v1",
          type: "RideshareKeyBackup",
          exportedAt: new Date().toISOString(),
          did: rec.did,
          privateKeyJwk: priv,
          publicKeyJwk: pub,
        })),
      );
    });
  }

  function _importKeyJwk(backup) {
    if (!backup?.privateKeyJwk || !backup.publicKeyJwk) {
      throw new Error("Backup file missing key material");
    }
    return Promise.all([
      crypto.subtle.importKey("jwk", backup.privateKeyJwk, { name: "Ed25519" }, true, ["sign"]),
      crypto.subtle.importKey("jwk", backup.publicKeyJwk, { name: "Ed25519" }, true, ["verify"]),
    ]).then((pair) => {
      const kp = { privateKey: pair[0], publicKey: pair[1] };
      return crypto.subtle.exportKey("raw", pair[1]).then((raw) => {
        const did = pubKeyToDidKey(raw);
        return idbPut("kp", {
          keyPair: kp,
          did: did,
          createdAt: Date.now(),
        }).then(() => ({ did: did }));
      });
    });
  }

  function downloadFile(name, content, type) {
    const blob = new Blob([content], {
      type: type || "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }

  // ── Page bindings ─────────────────────────────────────────────────────────
  function bindCreateButton(btn, status) {
    btn.addEventListener("click", () => {
      btn.disabled = true;
      status.textContent = "Checking browser support…";
      try {
        ensureSupport();
      } catch (err) {
        status.textContent = err.message;
        btn.disabled = false;
        return;
      }
      probeEd25519Support()
        .then((ok) => {
          if (!ok) {
            status.textContent =
              "Your browser doesn't support Ed25519 in Web Crypto yet. " +
              "Try Chrome 113+, Firefox 130+, or Safari 17+.";
            btn.disabled = false;
            return;
          }
          status.textContent = "Generating Ed25519 keypair…";
          return generateAndStore().then((rec) => {
            status.textContent = "Generated. Binding to your account…";
            return bindCurrentKey().then((res) => {
              if (!res.ok) {
                status.textContent = `Bind failed: ${res.error || "unknown"}`;
                btn.disabled = false;
                return;
              }
              status.textContent = `✓ Bound: ${rec.did}. Reloading…`;
              setTimeout(() => {
                location.reload();
              }, 600);
            });
          });
        })
        .catch((err) => {
          status.textContent = `Error: ${err.message}`;
          btn.disabled = false;
        });
    });
  }

  function bindExportButton(btn) {
    btn.addEventListener("click", () => {
      exportKeyJwk()
        .then((backup) => {
          downloadFile(
            `rideshare-key-backup-${new Date().toISOString().slice(0, 10)}.json`,
            JSON.stringify(backup, null, 2),
            "application/json",
          );
        })
        .catch((err) => {
          alert(`Export failed: ${err.message}`);
        });
    });
  }

  function bindRotateButton(btn) {
    btn.addEventListener("click", () => {
      if (
        !confirm(
          "Generating a new key revokes credentials issued under your old DID. " + "Continue?",
        )
      )
        return;
      deleteKey()
        .then(generateAndStore)
        .then(() => bindCurrentKey())
        .then((res) => {
          if (res?.ok) location.reload();
          else alert(`Rotate failed: ${res?.error}`);
        })
        .catch((err) => {
          alert(err.message);
        });
    });
  }

  function bindImportForm(form, ta, file, pickBtn, results) {
    pickBtn.addEventListener("click", () => {
      file.click();
    });
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        ta.value = String(reader.result || "");
      };
      reader.readAsText(f);
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      results.textContent = "Verifying…";
      const text = (ta.value || "").trim();
      if (!text) {
        results.textContent = "Paste at least one credential.";
        return;
      }
      // Parse: try JSON first (bundle), then newline-separated JWTs
      let jwts = [];
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          jwts = parsed.filter((x) => typeof x === "string");
        } else if (parsed && Array.isArray(parsed.credentials)) {
          jwts = parsed.credentials.map((c) => (typeof c === "string" ? c : c.jwt)).filter(Boolean);
        } else if (parsed && Array.isArray(parsed.jwts)) {
          jwts = parsed.jwts.filter((x) => typeof x === "string");
        } else if (typeof parsed === "string") {
          jwts = [parsed];
        }
      } catch (_) {
        jwts = text.split(/\s+/).filter((l) => l && l.split(".").length === 3);
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
        .then((r) => r.json())
        .then((body) => {
          let html = `<p><strong>${body.imported} of ${body.total} imported.</strong></p>`;
          html += "<ul>";
          (body.results || []).forEach((r, i) => {
            if (r.ok) {
              html += `<li class="check-pass">#${i + 1} — ${r.id || "imported"}</li>`;
            } else {
              html += `<li class="check-fail">#${i + 1} — ${r.error || "failed"}`;
              if (r.errors?.length) html += ` · ${r.errors.join(", ")}`;
              html += "</li>";
            }
          });
          html += "</ul>";
          if (body.imported > 0) html += '<p><a href="/trust">Reload to see them →</a></p>';
          results.innerHTML = html;
        })
        .catch((err) => {
          results.textContent = `Import failed: ${err.message}`;
        });
    });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(() => {
    const create = document.getElementById("trust-create-key");
    const status = document.getElementById("trust-create-status");
    if (create && status) bindCreateButton(create, status);

    const exp = document.getElementById("trust-export-key");
    if (exp) bindExportButton(exp);

    const rot = document.getElementById("trust-rotate-key");
    if (rot) bindRotateButton(rot);

    const form = document.getElementById("trust-import-form");
    const ta = document.getElementById("trust-import-text");
    const file = document.getElementById("trust-import-file");
    const pick = document.getElementById("trust-import-pick");
    const results = document.getElementById("trust-import-results");
    if (form && ta && file && pick && results) {
      bindImportForm(form, ta, file, pick, results);
    }
  });
})();
