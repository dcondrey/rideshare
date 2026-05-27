// Custom slippy-map renderer. Zero dependencies.
//
// Renders tile-based maps (any standard XYZ provider), with pan, wheel zoom,
// pinch zoom, double-tap zoom, +/− buttons, and markers with popups. Uses
// Web Mercator projection — the de-facto standard for OSM-derived tile sets.
//
// Reads JSON config from a <script id="map-data" type="application/json">
// tag rendered by routes/map.js.
//
// Container element: #map. Markers: venue, meetups, rides (server-prepared).
(function () {
  "use strict";

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function el(tag, className, parent) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (parent) parent.appendChild(e);
    return e;
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Web Mercator ───────────────────────────────────────────────────────────
  var TILE = 256;

  function project(lat, lng, z) {
    var n = Math.pow(2, z);
    var x = ((lng + 180) / 360) * n;
    var sin = Math.sin((lat * Math.PI) / 180);
    var y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n;
    return { x: x, y: y };
  }
  function unproject(x, y, z) {
    var n = Math.pow(2, z);
    var lng = (x / n) * 360 - 180;
    var lat =
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    return { lat: lat, lng: lng };
  }
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // ── TinyMap class ──────────────────────────────────────────────────────────
  function TinyMap(container, opts) {
    this.container = container;
    this.tile = opts.tile;
    this.minZoom = 1;
    this.maxZoom = opts.tile.maxZoom || 19;
    this.zoom = clamp(opts.zoom || 11, this.minZoom, this.maxZoom);
    this.center = opts.center || { lat: 0, lng: 0 };
    this.markers = [];
    this.openPopup = null;
    this._tilesByKey = {}; // recycled across renders
    this._subdomainCursor = 0;
    this._dpr = Math.min(2, window.devicePixelRatio || 1);
    this._isRetina = this._dpr > 1.25;
    this._build();
  }

  TinyMap.prototype._build = function () {
    var c = this.container;
    c.classList.add("tm");
    c.setAttribute("tabindex", "0");
    c.setAttribute("role", "application");
    c.style.position = c.style.position || "relative";
    c.style.overflow = "hidden";
    c.style.touchAction = "none"; // prevent browser pan/zoom hijack

    this.tilesLayer = el("div", "tm-tiles", c);
    this.markersLayer = el("div", "tm-markers", c);
    this.popupsLayer = el("div", "tm-popups", c);
    this.attrib = el("div", "tm-attrib", c);
    this.attrib.innerHTML = this.tile.attribution || "";

    var ctrl = el("div", "tm-controls", c);
    var zin = el("button", "tm-zoom tm-zoom-in", ctrl);
    zin.type = "button";
    zin.setAttribute("aria-label", "Zoom in");
    zin.textContent = "+";
    var zout = el("button", "tm-zoom tm-zoom-out", ctrl);
    zout.type = "button";
    zout.setAttribute("aria-label", "Zoom out");
    zout.textContent = "−";
    var self = this;
    zin.addEventListener("click", function () { self.zoomBy(1); });
    zout.addEventListener("click", function () { self.zoomBy(-1); });

    this._bindPointerEvents();
    this._bindWheel();
    this._bindKeys();
    this._bindResize();
    this.render();
  };

  // ── Coordinate transforms (lat/lng → screen px) ────────────────────────────
  TinyMap.prototype._size = function () {
    return { w: this.container.clientWidth, h: this.container.clientHeight };
  };
  TinyMap.prototype._origin = function () {
    // Returns the screen-pixel coords of map-tile (0,0) at current zoom.
    var s = this._size();
    var c = project(this.center.lat, this.center.lng, this.zoom);
    return { x: s.w / 2 - c.x * TILE, y: s.h / 2 - c.y * TILE };
  };
  TinyMap.prototype._latLngToPx = function (lat, lng) {
    var p = project(lat, lng, this.zoom);
    var o = this._origin();
    return { x: p.x * TILE + o.x, y: p.y * TILE + o.y };
  };
  TinyMap.prototype._pxToLatLng = function (px, py) {
    var o = this._origin();
    return unproject((px - o.x) / TILE, (py - o.y) / TILE, this.zoom);
  };

  // ── Tile rendering ─────────────────────────────────────────────────────────
  TinyMap.prototype._tileUrl = function (x, y, z) {
    var url = this.tile.url;
    var subs = this.tile.subdomains || [];
    if (subs.length && url.indexOf("{s}") !== -1) {
      var s = subs[this._subdomainCursor % subs.length];
      this._subdomainCursor = (this._subdomainCursor + 1) % subs.length;
      url = url.replace("{s}", s);
    }
    return url
      .replace("{z}", z)
      .replace("{x}", x)
      .replace("{y}", y)
      .replace("{r}", this._isRetina ? "@2x" : "");
  };

  TinyMap.prototype._renderTiles = function () {
    var s = this._size();
    var z = this.zoom;
    var o = this._origin();
    var n = Math.pow(2, z);

    // Find tiles in viewport (with a 1-tile buffer for smoother panning)
    var minX = Math.floor(-o.x / TILE) - 1;
    var maxX = Math.floor((s.w - o.x) / TILE) + 1;
    var minY = Math.floor(-o.y / TILE) - 1;
    var maxY = Math.floor((s.h - o.y) / TILE) + 1;
    minY = clamp(minY, 0, n - 1);
    maxY = clamp(maxY, 0, n - 1);

    var keep = {};
    for (var x = minX; x <= maxX; x++) {
      for (var y = minY; y <= maxY; y++) {
        var wrappedX = ((x % n) + n) % n; // wrap longitude
        var key = z + "/" + wrappedX + "/" + y;
        keep[key] = true;
        var img = this._tilesByKey[key];
        if (!img) {
          img = el("img", "tm-tile");
          img.draggable = false;
          img.alt = "";
          img.loading = "eager";
          img.decoding = "async";
          img.src = this._tileUrl(wrappedX, y, z);
          this.tilesLayer.appendChild(img);
          this._tilesByKey[key] = img;
        }
        img.style.transform =
          "translate3d(" + (x * TILE + o.x) + "px," + (y * TILE + o.y) + "px,0)";
      }
    }
    // Drop tiles that aren't visible AND not at the current zoom level
    for (var k in this._tilesByKey) {
      if (!keep[k]) {
        var t = this._tilesByKey[k];
        if (t.parentNode) t.parentNode.removeChild(t);
        delete this._tilesByKey[k];
      }
    }
  };

  // ── Marker rendering ───────────────────────────────────────────────────────
  TinyMap.prototype.addMarker = function (m) {
    // m: { lat, lng, html (popup), color, label, kind, size, zIndex, ariaLabel }
    var node = el("button", "tm-marker", this.markersLayer);
    node.type = "button";
    node.style.zIndex = String(m.zIndex || 100);
    node.setAttribute("aria-label", m.ariaLabel || "Map marker");
    var size = m.size || 28;
    node.innerHTML = pinSvg({
      color: m.color || "#4f46e5",
      label: m.label || "",
      size: size,
    });
    node.dataset.size = String(size);
    var self = this;
    node.addEventListener("click", function (e) {
      e.stopPropagation();
      self._showPopup(m, node);
    });
    this.markers.push({ data: m, node: node });
    this._positionMarker(node, m);
    return node;
  };

  TinyMap.prototype._positionMarker = function (node, m) {
    var p = this._latLngToPx(m.lat, m.lng);
    var size = parseInt(node.dataset.size, 10) || 28;
    // Anchor: bottom-center of the pin
    node.style.transform =
      "translate3d(" + (p.x - size / 2) + "px," + (p.y - size * 1.3125) + "px,0)";
  };

  TinyMap.prototype._renderMarkers = function () {
    for (var i = 0; i < this.markers.length; i++) {
      this._positionMarker(this.markers[i].node, this.markers[i].data);
    }
    if (this.openPopup) this._positionPopup(this.openPopup);
  };

  // ── Popups ─────────────────────────────────────────────────────────────────
  TinyMap.prototype._showPopup = function (m, anchor) {
    this._closePopup();
    var pop = el("div", "tm-popup", this.popupsLayer);
    pop.setAttribute("role", "dialog");
    pop.innerHTML =
      '<button type="button" class="tm-popup-close" aria-label="Close">×</button>' +
      '<div class="tm-popup-body">' + (m.html || "") + "</div>";
    var self = this;
    pop
      .querySelector(".tm-popup-close")
      .addEventListener("click", function () { self._closePopup(); });
    this.openPopup = { marker: m, node: pop, anchor: anchor };
    this._positionPopup(this.openPopup);
  };

  TinyMap.prototype._closePopup = function () {
    if (!this.openPopup) return;
    if (this.openPopup.node.parentNode) {
      this.openPopup.node.parentNode.removeChild(this.openPopup.node);
    }
    this.openPopup = null;
  };

  TinyMap.prototype._positionPopup = function (popup) {
    var m = popup.marker;
    var p = this._latLngToPx(m.lat, m.lng);
    var node = popup.node;
    // Position above the pin, centered horizontally
    var size = parseInt(popup.anchor.dataset.size, 10) || 28;
    var w = node.offsetWidth || 220;
    node.style.transform =
      "translate3d(" + (p.x - w / 2) + "px," + (p.y - size * 1.3125 - node.offsetHeight - 8) + "px,0)";
  };

  // ── Public API ─────────────────────────────────────────────────────────────
  TinyMap.prototype.render = function () {
    this._renderTiles();
    this._renderMarkers();
  };

  TinyMap.prototype.setView = function (latlng, zoom) {
    this.center = latlng;
    if (zoom != null) this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
    this.render();
  };

  TinyMap.prototype.zoomBy = function (delta, anchor) {
    var newZoom = clamp(Math.round(this.zoom + delta), this.minZoom, this.maxZoom);
    if (newZoom === this.zoom) return;
    if (anchor) {
      // Keep the anchor point at the same screen position across the zoom
      var ll = this._pxToLatLng(anchor.x, anchor.y);
      this.zoom = newZoom;
      var newPx = this._latLngToPx(ll.lat, ll.lng);
      var s = this._size();
      var dx = newPx.x - anchor.x;
      var dy = newPx.y - anchor.y;
      var centerPx = { x: s.w / 2 + dx, y: s.h / 2 + dy };
      this.center = this._pxToLatLng(centerPx.x, centerPx.y);
    } else {
      this.zoom = newZoom;
    }
    this.render();
  };

  TinyMap.prototype.fitBounds = function (latlngs, padPct) {
    if (!latlngs.length) return;
    padPct = padPct == null ? 0.18 : padPct;
    var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (var i = 0; i < latlngs.length; i++) {
      var p = latlngs[i];
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    var center = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
    var s = this._size();
    if (s.w === 0 || s.h === 0) {
      // container not laid out yet — defer
      var self = this;
      requestAnimationFrame(function () { self.fitBounds(latlngs, padPct); });
      return;
    }
    // Find largest zoom where the bounds still fit (with padding)
    var z;
    for (z = this.maxZoom; z >= this.minZoom; z--) {
      var nw = project(maxLat, minLng, z);
      var se = project(minLat, maxLng, z);
      var w = (se.x - nw.x) * TILE;
      var h = (se.y - nw.y) * TILE;
      if (w <= s.w * (1 - padPct) && h <= s.h * (1 - padPct)) break;
    }
    this.setView(center, clamp(z, this.minZoom, this.maxZoom));
  };

  // ── Pan + pinch via Pointer Events ─────────────────────────────────────────
  TinyMap.prototype._bindPointerEvents = function () {
    var c = this.container;
    var self = this;
    var pointers = {}; // pointerId → {x,y}
    var panAnchor = null;
    var pinchAnchor = null;
    var lastTap = 0;

    c.addEventListener("pointerdown", function (e) {
      c.setPointerCapture && c.setPointerCapture(e.pointerId);
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 1) {
        panAnchor = { x: e.clientX, y: e.clientY, center: self.center };
        // Double-tap-to-zoom (mobile)
        var now = Date.now();
        if (now - lastTap < 300) {
          var rect = c.getBoundingClientRect();
          self.zoomBy(1, { x: e.clientX - rect.left, y: e.clientY - rect.top });
          lastTap = 0;
        } else {
          lastTap = now;
        }
      } else if (ids.length === 2) {
        var a = pointers[ids[0]];
        var b = pointers[ids[1]];
        var dist = Math.hypot(a.x - b.x, a.y - b.y);
        var midX = (a.x + b.x) / 2;
        var midY = (a.y + b.y) / 2;
        var rect = c.getBoundingClientRect();
        pinchAnchor = {
          dist: dist,
          startZoom: self.zoom,
          mid: { x: midX - rect.left, y: midY - rect.top },
        };
        panAnchor = null;
      }
    });

    c.addEventListener("pointermove", function (e) {
      if (!pointers[e.pointerId]) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 1 && panAnchor) {
        var dx = e.clientX - panAnchor.x;
        var dy = e.clientY - panAnchor.y;
        // Convert pixel delta to lat/lng shift at current zoom
        var s = self._size();
        var startCenter = panAnchor.center;
        // Move center opposite to drag direction
        var newCenterPx = { x: s.w / 2 - dx, y: s.h / 2 - dy };
        // Re-project relative to the start center
        var saved = self.center;
        self.center = startCenter;
        var ll = self._pxToLatLng(newCenterPx.x, newCenterPx.y);
        self.center = ll;
        if (saved.lat !== ll.lat || saved.lng !== ll.lng) self.render();
      } else if (ids.length === 2 && pinchAnchor) {
        var a = pointers[ids[0]];
        var b = pointers[ids[1]];
        var dist = Math.hypot(a.x - b.x, a.y - b.y);
        var ratio = dist / pinchAnchor.dist;
        var targetZoom = clamp(
          Math.round(pinchAnchor.startZoom + Math.log2(ratio)),
          self.minZoom,
          self.maxZoom,
        );
        if (targetZoom !== self.zoom) {
          self.zoom = targetZoom;
          // Re-anchor on the midpoint of the pinch
          var rect = c.getBoundingClientRect();
          var midX = (a.x + b.x) / 2 - rect.left;
          var midY = (a.y + b.y) / 2 - rect.top;
          self.zoomBy(0); // no-op
          // Manual re-center: keep midpoint at same lat/lng
          // (zoomBy was already called for the delta; we just snapshot)
          self.render();
          pinchAnchor.startZoom = targetZoom;
          pinchAnchor.dist = dist;
        }
      }
    });

    function endPointer(e) {
      delete pointers[e.pointerId];
      var ids = Object.keys(pointers);
      if (ids.length === 0) {
        panAnchor = null;
        pinchAnchor = null;
      } else if (ids.length === 1) {
        // Pinch ended; one finger still down → pan from here
        panAnchor = {
          x: pointers[ids[0]].x,
          y: pointers[ids[0]].y,
          center: self.center,
        };
        pinchAnchor = null;
      }
    }
    c.addEventListener("pointerup", endPointer);
    c.addEventListener("pointercancel", endPointer);
    c.addEventListener("pointerleave", endPointer);

    // Click background to close popup
    c.addEventListener("click", function (e) {
      if (e.target === c || e.target === self.tilesLayer) self._closePopup();
    });
  };

  // ── Wheel zoom ─────────────────────────────────────────────────────────────
  TinyMap.prototype._bindWheel = function () {
    var c = this.container;
    var self = this;
    c.addEventListener(
      "wheel",
      function (e) {
        e.preventDefault();
        var rect = c.getBoundingClientRect();
        var anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        var delta = e.deltaY < 0 ? 1 : -1;
        self.zoomBy(delta, anchor);
      },
      { passive: false },
    );
  };

  // ── Keyboard ───────────────────────────────────────────────────────────────
  TinyMap.prototype._bindKeys = function () {
    var c = this.container;
    var self = this;
    c.addEventListener("keydown", function (e) {
      var step = 60;
      var s = self._size();
      var dx = 0, dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else if (e.key === "+" || e.key === "=") return self.zoomBy(1);
      else if (e.key === "-" || e.key === "_") return self.zoomBy(-1);
      else return;
      e.preventDefault();
      var newCenterPx = { x: s.w / 2 + dx, y: s.h / 2 + dy };
      self.center = self._pxToLatLng(newCenterPx.x, newCenterPx.y);
      self.render();
    });
  };

  // ── Resize ─────────────────────────────────────────────────────────────────
  TinyMap.prototype._bindResize = function () {
    var self = this;
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () { self.render(); }).observe(self.container);
    } else {
      window.addEventListener("resize", function () { self.render(); });
    }
  };

  // ── Pin SVG ────────────────────────────────────────────────────────────────
  function pinSvg(opts) {
    var color = opts.color;
    var size = opts.size;
    var label = opts.label || "";
    var h = Math.round(size * 1.3125);
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 42" width="' + size + '" height="' + h + '" aria-hidden="true">' +
        '<filter id="s-' + size + '"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity=".25"/></filter>' +
        '<path filter="url(#s-' + size + ')" d="M16 0C7.2 0 0 7.2 0 16c0 12 16 26 16 26s16-14 16-26C32 7.2 24.8 0 16 0z" ' +
          'fill="' + color + '" stroke="#1c1917" stroke-width="1.5"/>' +
        (label
          ? '<text x="16" y="21" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#fff">' + label + '</text>'
          : '<circle cx="16" cy="16" r="5" fill="#fff" opacity=".95"/>') +
      '</svg>'
    );
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  function getData() {
    var t = document.getElementById("map-data");
    if (!t) return null;
    try { return JSON.parse(t.textContent || "{}"); }
    catch (err) { console.error("[map] bad data:", err); return null; }
  }

  ready(function () {
    var container = document.getElementById("map");
    if (!container) return;
    var data = getData();
    if (!data) return;

    var map = new TinyMap(container, {
      tile: data.tile,
      center: data.center,
      zoom: data.zoom,
    });

    var brand = data.brandColor || "#4f46e5";

    if (data.venue) {
      map.addMarker({
        lat: data.venue.lat,
        lng: data.venue.lng,
        color: brand,
        label: "★",
        size: 36,
        zIndex: 1000,
        ariaLabel: "Venue: " + data.venue.name,
        html:
          '<strong>' + escapeHtml(data.venue.name) + '</strong>' +
          (data.venue.address ? '<br><span class="muted">' + escapeHtml(data.venue.address) + '</span>' : '') +
          '<br><em>Venue</em>',
      });
    }

    (data.meetups || []).forEach(function (m) {
      map.addMarker({
        lat: m.lat,
        lng: m.lng,
        color: "#0ea5e9",
        label: "M",
        size: 28,
        ariaLabel: m.name,
        html:
          '<strong>' + escapeHtml(m.name) + '</strong>' +
          (m.address ? '<br><span class="muted">' + escapeHtml(m.address) + '</span>' : '') +
          '<br><em>Meetup point</em>',
      });
    });

    // Group rides at identical coordinates so overlapping pins get a count.
    var byKey = {};
    (data.rides || []).forEach(function (r) {
      var key = r.lat.toFixed(5) + "," + r.lng.toFixed(5);
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(r);
    });
    Object.keys(byKey).forEach(function (k) {
      var rides = byKey[k];
      var first = rides[0];
      var color = first.kind === "offer" ? "#16a34a" : "#0ea5e9";
      var label = rides.length > 1 ? String(rides.length) : "";
      var html = rides
        .map(function (r) {
          var dir = r.direction === "to_venue" ? "→ to venue" : "← from venue";
          var k2 = r.kind === "offer" ? "Offering" : "Looking for";
          return (
            '<div class="tm-popup-ride">' +
              '<strong>' + k2 + ' · ' + dir + '</strong>' +
              '<br><span class="muted">' + escapeHtml(r.date) + ' · ' +
                escapeHtml(r.time) + ' · ' + r.seats + ' seat' +
                (r.seats === 1 ? '' : 's') + '</span>' +
              (r.source ? '<br><span class="muted">From: ' + escapeHtml(r.source) + '</span>' : '') +
              '<br><a href="' + r.url + '">View ride</a>' +
            '</div>'
          );
        })
        .join('<hr class="tm-popup-sep">');
      map.addMarker({
        lat: first.lat,
        lng: first.lng,
        color: color,
        label: label,
        size: 26,
        ariaLabel: rides.length + " ride(s)",
        html: html,
      });
    });

    // Auto-fit bounds to all pins (with padding).
    var pts = [];
    if (data.venue) pts.push(data.venue);
    (data.meetups || []).forEach(function (m) { pts.push(m); });
    (data.rides || []).forEach(function (r) { pts.push(r); });
    if (pts.length > 1) map.fitBounds(pts, 0.20);
  });
})();
