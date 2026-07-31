/* Colorado Rainfall Forage Map
 * Data: Open-Meteo (gridded precip + elevation), USDA AWDB (SNOTEL gauges),
 * OSM Overpass (trailheads), USGS National Map (topo tiles).
 * All client-side; APIs are keyless and CORS-enabled.
 */
"use strict";

// ---------- config ----------
const BBOX = { latMin: 36.95, latMax: 41.05, lonMin: -109.1, lonMax: -102.0 };
const GRID_STEP = 0.2;                // ~11 mi cells
const CHUNK = 150;                    // locations per Open-Meteo request
const OM_CALLS_PER_MIN = 550;         // stay under Open-Meteo's 600/min limit
const GRID_TTL_MS = 30 * 60 * 1000;   // cache grid 30 min
const TRAILS_TTL_MS = 7 * 24 * 3600 * 1000;
const RAIN_DAY_IN = 0.1;              // >= 0.1 in counts as a rain day
const MM_PER_IN = 25.4;
const M_TO_FT = 3.28084;

const MODES = {
  t24:    { label: "24 hr total",  hint: "Rainfall in the last 24 hours (inches).", unit: "inches",
            stops: [0.01, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0] },
  t72:    { label: "72 hr total",  hint: "Rainfall in the last 3 days (inches).", unit: "inches",
            stops: [0.01, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0] },
  t7:     { label: "7 day total",  hint: "Rainfall in the last 7 days (inches).", unit: "inches",
            stops: [0.01, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0] },
  steady: { label: "Steadiness",   hint: "Days with measurable rain (≥0.1 in) out of the last 7. More days = steadier moisture — what mycelium wants.", unit: "rain days / 7",
            stops: [1, 2, 3, 4, 5, 6, 7] },
};
// NWS-style QPE ramp: green -> yellow -> orange -> red -> magenta (hotspots pop)
const AMT_COLORS = ["#6fc464", "#2f9e4f", "#127a38", "#f2d21f", "#f29b1d", "#e85d1f", "#d42a2e", "#b01ba8"];
// steadiness ramp: slate -> teal -> bright cyan
const STEADY_COLORS = ["#3a4d52", "#33656a", "#2b7f80", "#219a95", "#16b5a8", "#0bd0bb", "#41f0d4"];

// ---------- state ----------
let mode = "t7";
let source = "om";        // "mrms" (radar+gauge) or "om" (model); auto-switches to mrms when loaded
let elevMinFt = 0, elevMaxFt = 14500;
const datasets = {
  om:   { cells: [], step: GRID_STEP, label: "model estimate" },
  mrms: { cells: [], step: 0.1, label: "MRMS radar + gauges", updated: null },
};
const activeCells = () => datasets[source].cells;
let snotelStations = [];  // {name, lat, lon, elevFt, t24, t72, t7, days, rainDays}
let trailheads = [];      // {name, lat, lon}

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function setStatus(msg, isErr) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("err", !!isErr);
}

// ---------- map ----------
const map = L.map("map", { zoomControl: false, minZoom: 6, maxZoom: 16 })
  .setView([39.1, -105.9], 8);
L.control.zoom({ position: "bottomright" }).addTo(map);

const BASEMAPS = {
  usgstopo: L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 16, attribution: "USGS The National Map" }),
  usgsimg: L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 16, attribution: "USGS The National Map" }),
  opentopo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 16, attribution: "&copy; OpenStreetMap, SRTM | OpenTopoMap (CC-BY-SA)" }),
};
let currentBase = BASEMAPS.usgstopo.addTo(map);

const canvasRenderer = L.canvas({ padding: 0.3 });
const gridLayer = L.layerGroup().addTo(map);
const snotelLayer = L.layerGroup().addTo(map);
const trailLayer = L.layerGroup().addTo(map);

// ---------- helpers ----------
function colorFor(cell) {
  if (mode === "steady") {
    const d = cell.rainDays;
    if (d < 1) return null;
    return STEADY_COLORS[Math.min(d, 7) - 1];
  }
  const v = cell[mode];
  const stops = MODES[mode].stops;
  if (v < stops[0]) return null;
  let i = 0;
  while (i < stops.length - 1 && v >= stops[i + 1]) i++;
  return AMT_COLORS[i];
}

function inBand(elevFt) { return elevFt >= elevMinFt && elevFt <= elevMaxFt; }

const fmtIn = (v) => v >= 10 ? v.toFixed(1) : v.toFixed(2);
const fmtFt = (v) => Math.round(v).toLocaleString() + " ft";

function tipHtml(title, sub, c) {
  const flags = c.days || Array.from({ length: 7 }, (_, i) => i < c.rainDays);
  const steadyBars = flags.map(on => `<i class="${on ? "on" : ""}"></i>`).join("");
  return `<div class="tip-title">${title}</div>
    <div class="tip-sub">${sub}</div>
    <div class="tip-rows">
      <span class="k">24 hr</span><span class="v${c.t24 >= 0.25 ? " hot" : ""}">${fmtIn(c.t24)} in</span>
      <span class="k">72 hr</span><span class="v${c.t72 >= 0.75 ? " hot" : ""}">${fmtIn(c.t72)} in</span>
      <span class="k">7 day</span><span class="v${c.t7 >= 1.5 ? " hot" : ""}">${fmtIn(c.t7)} in</span>
      <span class="k">Elevation</span><span class="v">${fmtFt(c.elevFt)}</span>
      <span class="k">Rain days</span><span class="v${c.rainDays >= 4 ? " hot" : ""}">${c.rainDays} of 7</span>
    </div>
    <div class="tip-steady" title="Rain days, last 7 (oldest to newest)">${steadyBars}</div>`;
}

function haversineMi(a, b) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function cacheGet(key, ttl) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > ttl) return null;
    return obj.data;
  } catch { return null; }
}
function cacheSet(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function fetchJson(url, opts, tries = 3, on429wait = 20000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429) {
        lastErr = new Error("HTTP 429 (rate limited)");
        await sleep(on429wait * (i + 1));
        continue;
      }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (j && j.error) throw new Error(j.reason || "API error");
      return j;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

// ---------- precip grid (Open-Meteo) ----------
function buildGridPoints() {
  const pts = [];
  for (let lat = BBOX.latMin; lat <= BBOX.latMax + 1e-9; lat += GRID_STEP)
    for (let lon = BBOX.lonMin; lon <= BBOX.lonMax + 1e-9; lon += GRID_STEP)
      pts.push({ lat: +lat.toFixed(4), lon: +lon.toFixed(4) });
  return pts;
}

async function loadGrid(force) {
  if (!force) {
    const cached = cacheGet("rf_grid_v3", GRID_TTL_MS);
    if (cached) { datasets.om.cells = cached; return; }
  }
  const pts = buildGridPoints();
  const nowSec = Date.now() / 1000;
  const out = [];
  const nChunks = Math.ceil(pts.length / CHUNK);
  let failedChunks = 0;
  let windowStart = Date.now(), windowCalls = 0;
  for (let c = 0; c < nChunks; c++) {
    // Open-Meteo counts each location as one call; pause before crossing the per-minute cap
    const chunk = pts.slice(c * CHUNK, (c + 1) * CHUNK);
    if (windowCalls + chunk.length > OM_CALLS_PER_MIN) {
      const waitMs = Math.max(0, 62000 - (Date.now() - windowStart));
      if (waitMs > 0) {
        setStatus(`Rainfall grid ${c}/${nChunks} — pausing ${Math.ceil(waitMs / 1000)}s for API rate limit…`);
        await sleep(waitMs);
      }
      windowStart = Date.now(); windowCalls = 0;
    }
    setStatus(`Fetching rainfall grid ${c + 1}/${nChunks}…`);
    const lats = chunk.map(p => p.lat).join(",");
    const lons = chunk.map(p => p.lon).join(",");
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
      `&hourly=precipitation&past_days=7&forecast_days=1&timeformat=unixtime&timezone=UTC`;
    windowCalls += chunk.length;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      console.warn("grid chunk failed", c, e);
      failedChunks++;
      continue;
    }
    const arr = Array.isArray(data) ? data : [data];
    arr.forEach((loc, i) => {
      if (!loc || !loc.hourly) return;
      const t = loc.hourly.time, p = loc.hourly.precipitation;
      let t24 = 0, t72 = 0, t7 = 0;
      const dayTotals = new Array(7).fill(0);
      for (let k = 0; k < t.length; k++) {
        const age = nowSec - t[k];               // seconds ago (hour start)
        if (age < 0 || age > 7 * 86400) continue;
        const mm = p[k] || 0;
        t7 += mm;
        if (age <= 72 * 3600) t72 += mm;
        if (age <= 24 * 3600) t24 += mm;
        const d = Math.min(6, Math.floor(age / 86400));
        dayTotals[d] += mm;
      }
      // chronological rain-day flags, oldest -> newest (dayTotals[6] is 6-7 days ago)
      const days = [6, 5, 4, 3, 2, 1, 0].map(d => dayTotals[d] / MM_PER_IN >= RAIN_DAY_IN);
      out.push({
        lat: chunk[i].lat, lon: chunk[i].lon,
        elevFt: (loc.elevation || 0) * M_TO_FT,
        t24: t24 / MM_PER_IN, t72: t72 / MM_PER_IN, t7: t7 / MM_PER_IN,
        days, rainDays: days.filter(Boolean).length,
      });
    });
    await sleep(250);
  }
  datasets.om.cells = out;
  if (failedChunks === 0) cacheSet("rf_grid_v3", out);
  return failedChunks;
}

function renderGrid() {
  gridLayer.clearLayers();
  const ds = datasets[source];
  const half = ds.step / 2;
  for (const c of ds.cells) {
    const col = colorFor(c);
    if (!col) continue;
    const banded = inBand(c.elevFt);
    const rect = L.rectangle(
      [[c.lat - half, c.lon - half], [c.lat + half, c.lon + half]],
      { renderer: canvasRenderer, stroke: false, fillColor: col,
        fillOpacity: banded ? 0.48 : 0.08, interactive: banded });
    if (banded) {
      rect.bindTooltip(() => tipHtml(
        "Grid cell", `${c.lat.toFixed(2)}, ${c.lon.toFixed(2)} · ${ds.label}`, c),
        { className: "rf-tip", sticky: true, direction: "top", opacity: 1 });
      rect.on("mouseover", () => rect.setStyle({ stroke: true, color: "#ffffff", weight: 1.5 }));
      rect.on("mouseout", () => rect.setStyle({ stroke: false }));
    }
    rect.addTo(gridLayer);
  }
}

// ---------- SNOTEL ----------
async function loadSnotel() {
  setStatus("Fetching SNOTEL gauges…");
  const meta = await fetchJson(
    "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations?stationTriplets=*:CO:SNTL&activeOnly=true");
  const byTriplet = Object.fromEntries(meta.map(s => [s.stationTriplet, s]));
  const end = new Date(), begin = new Date(Date.now() - 8 * 86400 * 1000);
  const dstr = (d) => d.toISOString().slice(0, 10);
  const data = await fetchJson(
    `https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?stationTriplets=*:CO:SNTL` +
    `&elements=PRCP&duration=DAILY&beginDate=${dstr(begin)}&endDate=${dstr(end)}`);
  snotelStations = [];
  for (const st of data) {
    const m = byTriplet[st.stationTriplet];
    const vals = st.data?.[0]?.values;
    if (!m || !vals || !vals.length) continue;
    const nums = vals.map(v => v.value ?? 0);
    const lastN = (n) => nums.slice(-n).reduce((a, b) => a + b, 0);
    const last7 = nums.slice(-7);
    const days = last7.map(v => v >= RAIN_DAY_IN);      // already oldest -> newest
    while (days.length < 7) days.unshift(false);
    snotelStations.push({
      name: m.name, lat: m.latitude, lon: m.longitude, elevFt: m.elevation,
      t24: lastN(1), t72: lastN(3), t7: lastN(7),
      days, rainDays: days.filter(Boolean).length,
      lastDate: vals[vals.length - 1].date,
    });
  }
}

function renderSnotel() {
  snotelLayer.clearLayers();
  for (const s of snotelStations) {
    if (!inBand(s.elevFt)) continue;
    const col = colorFor(s) || "#5a6a72";
    const mk = L.circleMarker([s.lat, s.lon], {
      renderer: canvasRenderer, radius: 7, fillColor: col, fillOpacity: 0.95,
      color: "#101416", weight: 2 });
    mk.bindTooltip(() => tipHtml(
      s.name + " · SNOTEL",
      `Measured gauge · through ${s.lastDate}`, s),
      { className: "rf-tip", sticky: true, direction: "top", opacity: 1 });
    mk.addTo(snotelLayer);
  }
}

// ---------- trailheads ----------
async function loadTrailheads() {
  const cached = cacheGet("rf_trails_v1", TRAILS_TTL_MS);
  if (cached) { trailheads = cached; return; }
  setStatus("Fetching trailheads…");
  const q = `[out:json][timeout:90];node["highway"="trailhead"]` +
    `(${BBOX.latMin},${BBOX.lonMin},${BBOX.latMax},${BBOX.lonMax});out;`;
  const data = await fetchJson("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(q),
  });
  trailheads = data.elements.map(e => ({
    name: e.tags?.name || "Trailhead", lat: e.lat, lon: e.lon,
  }));
  cacheSet("rf_trails_v1", trailheads);
}

const thIcon = L.divIcon({
  className: "th-icon",
  iconSize: [18, 18], iconAnchor: [9, 16],
  html: `<svg width="18" height="18" viewBox="0 0 24 24">
    <path d="M7 21V4m0 1h10l-2 3.5L17 12H7" fill="#e0a63c" stroke="#14181a" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
});

function renderTrailheads() {
  trailLayer.clearLayers();
  if (!$("lyrTrails").checked || map.getZoom() < 10) return;
  const b = map.getBounds().pad(0.2);
  for (const t of trailheads) {
    if (!b.contains([t.lat, t.lon])) continue;
    L.marker([t.lat, t.lon], { icon: thIcon, keyboard: false })
      .bindTooltip(t.name, { className: "rf-tip", direction: "top", offset: [0, -14] })
      .addTo(trailLayer);
  }
}
map.on("moveend zoomend", renderTrailheads);

// ---------- MRMS (gauge-corrected radar) ----------
// Local serve.py can rebuild data on demand; hosted copies read the JSON kept
// fresh by the repo's GitHub Action instead.
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const MRMS_FALLBACK_URL =
  "https://raw.githubusercontent.com/Jasonedelstein1/colorado-rainfall-map/main/data/mrms.json";

async function loadMrmsFile() {
  let r = await fetch("data/mrms.json", { cache: "no-store" }).catch(() => null);
  if (!r || !r.ok) r = await fetch(MRMS_FALLBACK_URL, { cache: "no-store" });
  if (!r.ok) throw new Error("no mrms.json");
  const j = await r.json();
  datasets.mrms.cells = j.cells;
  datasets.mrms.step = j.step || 0.1;
  datasets.mrms.updated = j.updated;
  datasets.mrms.valid24 = j.valid24;
}

async function loadMrms(force) {
  if (force && IS_LOCAL) {
    try {
      setStatus("Refreshing radar QPE from NOAA MRMS (30–90 s)…");
      await fetch("/api/mrms/refresh");
    } catch {}
  }
  try {
    await loadMrmsFile();
  } catch {
    // file absent — ask the local server to build it (serve.py only)
    if (!IS_LOCAL) return false;
    try {
      setStatus("Building radar QPE from NOAA MRMS (1–2 min)…");
      const r = await fetch("/api/mrms/refresh");
      const j = await r.json();
      if (!j.ok && !j.busy) throw new Error(j.error || "refresh failed");
      await loadMrmsFile();
    } catch (e) {
      console.warn("mrms unavailable", e);
      return false;
    }
  }
  // stale data: kick a background refresh, keep showing what we have
  const ageH = (Date.now() - Date.parse(datasets.mrms.updated)) / 3.6e6;
  if (ageH > 6 && IS_LOCAL) {
    fetch("/api/mrms/refresh").then(r => r.json()).then(j => {
      if (j.ok) loadMrmsFile().then(() => { if (source === "mrms") { renderGrid(); renderHotspots(); } });
    }).catch(() => {});
  }
  return true;
}

function setSource(src) {
  if (!datasets[src].cells.length && src === "mrms") return;
  source = src;
  document.querySelectorAll(".src-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.src === src));
  const hint = $("srcHint");
  if (src === "mrms") {
    const upd = datasets.mrms.updated
      ? new Date(datasets.mrms.updated).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })
      : "";
    hint.textContent = `NOAA MRMS: radar corrected by real rain gauges, ~7 mi cells. Best accuracy. Updated ${upd}. Rain days run 6 AM–6 AM.`;
  } else {
    hint.textContent = "Open-Meteo model analysis, ~11 mi cells. Smoother, less accurate in steep terrain — useful as a cross-check.";
  }
  renderGrid(); renderHotspots();
}

document.querySelectorAll(".src-btn").forEach(btn =>
  btn.addEventListener("click", () => {
    if (btn.classList.contains("disabled")) return;
    setSource(btn.dataset.src);
  }));

// ---------- hotspots ----------
function renderHotspots() {
  const list = $("hotspots");
  const ranked = activeCells()
    .filter(c => c.rainDays >= 4 && c.t7 >= 0.5 && inBand(c.elevFt))
    .sort((a, b) => b.rainDays - a.rainDays || b.t7 - a.t7);
  // keep spots at least ~20 mi apart so the list spans distinct areas
  const qualifying = [];
  for (const c of ranked) {
    if (qualifying.length >= 10) break;
    if (qualifying.every(q => haversineMi(q, c) > 20)) qualifying.push(c);
  }
  list.innerHTML = "";
  if (!qualifying.length) {
    list.innerHTML = `<li class="empty">No cells with 4+ rain days in this elevation band. It has been dry — widen the band or check back after the next storm cycle.</li>`;
    return;
  }
  for (let i = 0; i < qualifying.length; i++) {
    const c = qualifying[i];
    let nearest = null, best = Infinity;
    for (const t of trailheads) {
      const d = haversineMi(c, t);
      if (d < best) { best = d; nearest = t; }
    }
    const li = document.createElement("li");
    li.className = "hotspot";
    li.setAttribute("role", "button");
    li.tabIndex = 0;
    const nameTxt = nearest && best < 20
      ? `${nearest.name} (${best.toFixed(1)} mi)`
      : `${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}`;
    li.innerHTML = `<span class="rank">${i + 1}</span>
      <span class="name">${nameTxt}</span>
      <span class="amt">${fmtIn(c.t7)} in</span>
      <span class="meta">${c.rainDays}/7 rain days · ${fmtFt(c.elevFt)}</span>`;
    const fly = () => map.flyTo([c.lat, c.lon], 11, { duration: 0.9 });
    li.addEventListener("click", fly);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fly(); } });
    list.appendChild(li);
  }
}

// ---------- legend ----------
function renderLegend() {
  const m = MODES[mode];
  $("legendUnit").textContent = m.unit;
  $("modeHint").textContent = m.hint;
  const colors = mode === "steady" ? STEADY_COLORS : AMT_COLORS;
  const labels = mode === "steady"
    ? m.stops.map(String)
    : m.stops.map(s => (s === 0.01 ? "tr" : String(s)));
  $("legend").innerHTML =
    `<div class="legend-scale">${colors.map(c => `<i style="background:${c}"></i>`).join("")}</div>
     <div class="legend-labels">${labels.map(l => `<span>${l}</span>`).join("")}</div>`;
}

// ---------- UI wiring ----------
document.querySelectorAll(".seg-btn[data-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn[data-mode]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mode = btn.dataset.mode;
    renderLegend(); renderGrid(); renderSnotel();
  });
});

$("lyrGrid").addEventListener("change", (e) =>
  e.target.checked ? map.addLayer(gridLayer) : map.removeLayer(gridLayer));
$("lyrSnotel").addEventListener("change", (e) =>
  e.target.checked ? map.addLayer(snotelLayer) : map.removeLayer(snotelLayer));
$("lyrTrails").addEventListener("change", renderTrailheads);

$("basemap").addEventListener("change", (e) => {
  map.removeLayer(currentBase);
  currentBase = BASEMAPS[e.target.value].addTo(map);
  currentBase.bringToBack();
});

function applyElev() {
  elevMinFt = +$("elevMin").value || 0;
  elevMaxFt = +$("elevMax").value || 14500;
  renderGrid(); renderSnotel(); renderHotspots();
}
$("elevMin").addEventListener("change", applyElev);
$("elevMax").addEventListener("change", applyElev);
document.querySelectorAll(".elev-presets .chip").forEach(ch =>
  ch.addEventListener("click", () => {
    $("elevMin").value = ch.dataset.lo;
    $("elevMax").value = ch.dataset.hi;
    applyElev();
  }));

$("collapseBtn").addEventListener("click", () => {
  $("panel").classList.add("collapsed");
  $("expandBtn").hidden = false;
});
$("expandBtn").addEventListener("click", () => {
  $("panel").classList.remove("collapsed");
  $("expandBtn").hidden = true;
});

$("refreshBtn").addEventListener("click", () => boot(true));

// ---------- boot ----------
let booting = false;
async function boot(force) {
  if (booting) return;
  booting = true;
  try {
    renderLegend();
    await loadTrailheads().catch(e => { console.warn("trailheads", e); trailheads = []; });
    renderTrailheads();
    await loadSnotel().catch(e => { console.warn("snotel", e); });
    renderSnotel();
    // radar first — it's a fast local file and the better source
    const haveMrms = await loadMrms(force);
    if (haveMrms) setSource("mrms");
    else {
      document.querySelector('.src-btn[data-src="mrms"]').classList.add("disabled");
      $("srcHint").textContent = "Radar unavailable — start the app with `python serve.py` to enable NOAA MRMS.";
      setSource("om");
    }
    const failed = await loadGrid(force);
    if (source === "om") { renderGrid(); renderHotspots(); }
    const stamp = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (failed) setStatus(`Partial model grid — refresh to fill in`, true);
    else setStatus(`Updated ${stamp} · radar ${datasets.mrms.cells.length} + model ${datasets.om.cells.length} cells · ${snotelStations.length} gauges`);
  } catch (e) {
    console.error(e);
    setStatus("Data load failed — hit refresh to retry", true);
  } finally {
    booting = false;
  }
}
boot(false);
