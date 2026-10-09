// SPDX-License-Identifier: MIT
// Simulated transit and traffic on the map shell. Nothing here is live data:
// vehicles and congestion are pure functions of the clock and the event's
// airports and venue, so every viewer sees the same picture, and both layers
// are labeled as simulated in the UI. The time scrubber previews the next
// twelve hours.
(() => {
  const dataEl = document.getElementById("map-data");
  if (!dataEl || !document.getElementById("map")) return;
  const data = JSON.parse(dataEl.textContent || "{}");
  const venue = data.venue;
  const airports = (data.airports || []).filter((a) => Number.isFinite(a.lat));
  if (!venue || airports.length === 0) return;

  const MIN = 60_000;
  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  let offsetMin = 0;
  let showTransit = true;
  let showTraffic = false;
  const simNow = () => Date.now() + offsetMin * MIN;

  // ── Geometry: a gentle curve from each airport to the venue ──
  /** @param {{lat:number,lng:number}} a @param {{lat:number,lng:number}} b @param {number} bow */
  function curve(a, b, bow) {
    const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    const ctrl = { lat: mid.lat + (b.lng - a.lng) * bow, lng: mid.lng - (b.lat - a.lat) * bow };
    return (t) => ({
      lat: (1 - t) ** 2 * a.lat + 2 * (1 - t) * t * ctrl.lat + t ** 2 * b.lat,
      lng: (1 - t) ** 2 * a.lng + 2 * (1 - t) * t * ctrl.lng + t ** 2 * b.lng,
    });
  }

  // Deterministic pseudo-randomness so every viewer agrees.
  const hash = (n) => {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  const noise = (x, seed) =>
    0.5 +
    0.25 * Math.sin(x * 1.7 + seed) +
    0.15 * Math.sin(x * 4.3 + seed * 2.1) +
    0.1 * Math.sin(x * 9.1 + seed * 0.7);

  // ── Transit lines ──
  const lines = airports.map((a, i) => {
    const rail = i % 2 === 0;
    return {
      id: i,
      name: `${a.code} ${rail ? "Airport Rail" : "Airport Express bus"}`,
      rail,
      color: rail ? "#1a7dff" : "#0f766e",
      headway: rail ? 12 : 20,
      trip: rail ? 32 : 45,
      path: curve(a, venue, rail ? 0.09 : -0.03),
      code: a.code,
    };
  });

  function localMinutes(t) {
    const d = new Date(t);
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  }

  /** Vehicles on every line at time t (ms). */
  function vehicles(t) {
    const out = [];
    const nowMin = Math.floor(t / MIN);
    const local = localMinutes(t);
    if (local < 5 * 60) return out; // no service 00:00–05:00
    for (const line of lines) {
      for (const dir of [0, 1]) {
        const first = Math.floor((nowMin - line.trip - 10) / line.headway);
        for (let k = first; k * line.headway <= nowMin; k++) {
          const seed = line.id * 1000 + dir * 500 + k;
          const delay = hash(seed) < 0.3 ? Math.ceil(hash(seed + 7) * 6) : 0;
          const start = (k * line.headway + delay + line.id * 3) * MIN;
          const p = (t - start) / (line.trip * MIN);
          if (p < 0 || p > 1) continue;
          const pos = line.path(dir === 0 ? p : 1 - p);
          out.push({ key: `t${line.id}-${dir}-${k}`, line, dir, delay, ...pos });
        }
      }
    }
    return out;
  }

  // ── Traffic model ──
  /** Congestion 0..1 for a local time, with morning and evening peaks. */
  function congestion(t) {
    const d = new Date(t);
    const h = d.getHours() + d.getMinutes() / 60;
    const peak = (c, w, a) => a * Math.exp(-(((h - c) / w) ** 2));
    const weekday = d.getDay() !== 0 && d.getDay() !== 6;
    const base = 0.12 + peak(8.5, 1.1, 0.75) + peak(17.5, 1.4, 0.85) + peak(12.5, 1.5, 0.2);
    return Math.min(1, base * (weekday ? 1 : 0.6));
  }
  const roads = airports.map((a, i) => ({ path: curve(a, venue, -0.06), seed: i * 3.7 + 1 }));
  const heatColor = (v) => (v < 0.35 ? "0,204,51" : v < 0.65 ? "255,176,0" : "255,59,48");

  function drawOverlay(ctx, toPx, size) {
    const t = simNow();
    if (showTraffic) {
      const c = congestion(t);
      const radius = Math.max(14, Math.min(46, size.w / 28));
      ctx.globalCompositeOperation = "multiply";
      for (const road of roads) {
        for (let i = 0; i <= 40; i++) {
          const s = i / 40;
          const v = Math.min(
            1,
            c * (0.55 + 0.6 * noise(s * 6, road.seed)) * (0.75 + 0.35 * Math.sin(Math.PI * s)),
          );
          const p = toPx(road.path(s).lat, road.path(s).lng);
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
          g.addColorStop(0, `rgba(${heatColor(v)},${0.22 + 0.3 * v})`);
          g.addColorStop(1, `rgba(${heatColor(v)},0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.lineCap = "round";
      ctx.lineWidth = 4;
      for (const road of roads) {
        for (let i = 0; i < 40; i++) {
          const s = i / 40;
          const v = Math.min(
            1,
            c * (0.55 + 0.6 * noise(s * 6, road.seed)) * (0.75 + 0.35 * Math.sin(Math.PI * s)),
          );
          const a = road.path(s);
          const b = road.path(s + 1 / 40);
          const pa = toPx(a.lat, a.lng);
          const pb = toPx(b.lat, b.lng);
          ctx.strokeStyle = `rgba(${heatColor(v)},0.9)`;
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
      }
    }
    if (showTransit) {
      ctx.lineWidth = 3;
      for (const line of lines) {
        ctx.strokeStyle = line.color;
        ctx.globalAlpha = 0.55;
        ctx.setLineDash(line.rail ? [] : [8, 6]);
        ctx.beginPath();
        for (let i = 0; i <= 48; i++) {
          const pt = line.path(i / 48);
          const p = toPx(pt.lat, pt.lng);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  // ── Vehicle markers ──
  const onMap = new Map(); // key → marker node
  function updateVehicles() {
    const api = window.RideshareMap;
    if (!api) return;
    const now = vehicles(simNow());
    const seen = new Set();
    for (const v of now) {
      seen.add(v.key);
      const where = v.dir === 0 ? "to the venue" : `to ${v.line.code}`;
      const late = v.delay ? `${v.delay} min late` : "on time";
      let node = onMap.get(v.key);
      if (!node) {
        node = api.map.addMarker({
          lat: v.lat,
          lng: v.lng,
          color: v.line.color,
          label: v.line.rail ? "R" : "B",
          size: 18,
          layer: "transit",
          zIndex: 400,
          liveKey: v.key,
          ariaLabel: `Simulated ${v.line.name} ${where}`,
          html: `<strong>${esc(v.line.name)}</strong><br>Heading ${esc(where)} · ${late}<br><em>Simulated vehicle, not live data</em>`,
        });
        onMap.set(v.key, node);
      } else {
        api.map.moveMarker(node, v.lat, v.lng);
      }
      node.hidden = !showTransit;
    }
    for (const [key] of onMap) {
      if (!seen.has(key)) {
        api.map.clearMarkers((d) => d.liveKey === key);
        onMap.delete(key);
      }
    }
  }

  // ── Controls ──
  const card = document.getElementById("sim-card");
  const range = /** @type {HTMLInputElement | null} */ (document.getElementById("sim-time"));
  const label = document.getElementById("sim-label");
  const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  function updateLabel() {
    if (!label) return;
    const h = Math.floor(offsetMin / 60);
    const m = offsetMin % 60;
    label.textContent =
      offsetMin === 0
        ? `Now · ${fmt(simNow())}`
        : `+${h ? `${h}h ` : ""}${m ? `${m}m` : ""} · ${fmt(simNow())}`;
  }
  range?.addEventListener("input", () => {
    offsetMin = Number(range.value) || 0;
    updateLabel();
    tick();
  });

  const chip = (layer) => document.querySelector(`.shell-filters [data-layer="${layer}"]`);
  chip("transit")?.addEventListener("click", (e) => {
    showTransit = /** @type {Element} */ (e.currentTarget).getAttribute("aria-pressed") === "true";
    tick();
  });
  chip("traffic")?.addEventListener("click", (e) => {
    showTraffic = /** @type {Element} */ (e.currentTarget).getAttribute("aria-pressed") === "true";
    if (card) card.hidden = !showTraffic;
    if (!showTraffic && range) {
      range.value = "0";
      offsetMin = 0;
    }
    updateLabel();
    tick();
  });

  function tick() {
    updateVehicles();
    window.RideshareMap?.map.redrawOverlays();
  }

  function start() {
    const api = window.RideshareMap;
    if (!api) return setTimeout(start, 100);
    api.map.addOverlay(drawOverlay);
    updateLabel();
    tick();
    setInterval(() => {
      if (document.visibilityState === "visible") {
        tick();
        updateLabel();
      }
    }, 2000);
  }
  start();
})();
