# Colorado Rainfall — Forage Map

A single-page map for planning mushroom foraging around recent rainfall. Topo basemap with
contours, roads, and labels; a color-graded rainfall overlay; SNOTEL gauge readings; and OSM
trailheads. Hover any cell or gauge to see 24 hr / 72 hr / 7 day totals plus elevation and a
rain-day strip.

## Where it lives

- **Hosted (auto-updating):** <https://jasonedelstein1.github.io/colorado-rainfall-map/> —
  a GitHub Action re-fetches the MRMS radar data every 6 hours, so this stays current with
  no machine running at home. Works on phones.
- **Cloudflare Pages:** project `rainfall-map` exists (`rainfall-map.pages.dev`) but needs a
  one-time `npx wrangler login`, then:
  `npx wrangler pages deploy <folder with index.html/style.css/app.js> --project-name rainfall-map`.
  The Cloudflare copy reads its data from this repo's raw URL, so it stays fresh without redeploys.
- **Local:** desktop shortcut "Rainfall Map", or:

## Run it

```
pip install numpy eccodes certifi   # one-time, for the MRMS radar layer
python serve.py
```

Then open <http://localhost:8642>. No API keys. (Claude Code users: a
`.claude/launch.json` is included, so the preview server can start it automatically.)
`serve.py` also auto-refreshes the MRMS radar data on startup when it's older than 6 h and
exposes `/api/mrms/refresh` for the in-app refresh button. Plain `python -m http.server 8642`
still works but the Radar + gauge source will be disabled unless `data/mrms.json` exists.

## Data sources (all free, keyless)

| Layer | Source | Notes |
|---|---|---|
| **Radar + gauge grid (default)** | [NOAA MRMS](https://mrms.ncep.noaa.gov/) MultiSensor QPE Pass 2 GRIB2 (via `fetch_mrms.py`) | Gauge-corrected radar, sampled to ~7 mi cells; rolling 24 h/72 h + seven 12z daily files for the 7-day total and rain-day pattern (6 AM–6 AM buckets) |
| Model grid | [Open-Meteo](https://open-meteo.com/) forecast API, `past_days=7` hourly precipitation | ~11 mi cells; model analysis, kept as a cross-check source |
| SNOTEL gauges | [USDA AWDB REST API](https://wcc.sc.egov.usda.gov/awdbRestApi/) `PRCP` daily | ~117 measured gauges at forest elevations — point ground truth |
| Trailheads | OSM Overpass, `highway=trailhead` | ~550 points; visible at zoom ≥ 10 |
| Basemap | USGS National Map (Topo / ImageryTopo) or OpenTopoMap | Contour lines, elevation labels, major roads |

Accuracy hierarchy: SNOTEL (measured, but point-scale) > MRMS radar+gauge (areal, ~1 km
native) > model. The app defaults to MRMS with a toggle to the model source; when a SNOTEL
gauge and its MRMS cell agree, believe them both.

Why SNOTEL instead of streamflow: stream gauges convolve rainfall with dam releases and
snowmelt; SNOTEL precipitation gauges measure the thing you actually care about, directly, at
the elevations where mushrooms grow.

## Features

- **Time windows** — 24 hr, 72 hr, 7 day totals (inches, NWS-style color ramp), plus a
  **Steady** mode that colors by number of rain days (≥ 0.1 in) in the last 7 — the best
  proxy for sustained moisture.
- **Steady-rain hotspots** — ranks cells with 4+ rain days by 7-day total, labels each with
  the nearest named trailhead, distance, and elevation. Click to fly there.
- **Elevation band filter** — dims cells/gauges outside a foot range; montane and subalpine
  presets included.
- **Caching** — grid responses cache in localStorage for 30 min, trailheads for 7 days.

## Rate limits

Open-Meteo allows ~600 location-calls/minute. The grid is 756 points fetched in chunks of
150; the loader paces itself and will pause up to ~60 s mid-load when needed. First load
takes 1–2 minutes; subsequent loads within 30 minutes are instant from cache.
