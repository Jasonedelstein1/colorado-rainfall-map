"""Fetch NOAA MRMS MultiSensor QPE Pass 2 (gauge-corrected radar precipitation)
and sample it onto a 0.1-degree grid over Colorado -> data/mrms.json.

Sources:
  - NCEP real-time:  https://mrms.ncep.noaa.gov/2D/MultiSensor_QPE_{24H,72H}_Pass2/ (rolling, hourly)
  - IEM mtarchive:   daily 12z 24H files for the last 7 days (rain-day pattern + 7-day total)
  - Open-Meteo elevation API (one-time, cached to data/elev01.json)

Run directly (python fetch_mrms.py) or via serve.py's /api/mrms/refresh endpoint.
Requires: numpy, eccodes  (pip install numpy eccodes)
"""
import gzip
import json
import os
import ssl
import time
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np
import eccodes

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
OUT_PATH = os.path.join(DATA_DIR, "mrms.json")
ELEV_PATH = os.path.join(DATA_DIR, "elev01.json")

# MRMS CONUS grid: 0.01 deg, lat 54.995 -> 20.005 (N to S), lon 230.005 -> 299.995 (0-360)
NATIVE_LAT0 = 54.995
NATIVE_LON0 = -129.995
# Colorado window on the native grid, chosen so each 0.1-deg output cell is an exact 10x10 block
ROW0, NROWS = 1400, 400   # lats 40.995 .. 37.005
COL0, NCOLS = 2100, 700   # lons -108.995 .. -102.005
BLOCK = 10                # 10 x 10 native points per output cell
MM_PER_IN = 25.4
M_TO_FT = 3.28084
RAIN_DAY_IN = 0.1

NCEP = "https://mrms.ncep.noaa.gov/2D"
ARCHIVE = "https://mtarchive.geol.iastate.edu"


def log(msg):
    print(msg, flush=True)


def download(url, timeout=180, tries=4):
    req = urllib.request.Request(url, headers={"User-Agent": "rainfall-forage-map/1.0"})
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429:
                wait = 25 * (i + 1)
                log(f"  rate limited, waiting {wait}s...")
                time.sleep(wait)
                continue
            raise
        except Exception as e:
            last = e
            time.sleep(3 * (i + 1))
    raise last


def grib_to_grid(gz_bytes):
    """Decode a gzipped MRMS GRIB2 message -> (40, 70) array of inches over the CO window."""
    raw = gzip.decompress(gz_bytes)
    gid = eccodes.codes_new_from_message(raw)
    try:
        ni = eccodes.codes_get(gid, "Ni")
        nj = eccodes.codes_get(gid, "Nj")
        date = eccodes.codes_get(gid, "dataDate")
        time_ = eccodes.codes_get(gid, "dataTime")
        vals = eccodes.codes_get_values(gid).reshape(nj, ni)
    finally:
        eccodes.codes_release(gid)
    sub = vals[ROW0:ROW0 + NROWS, COL0:COL0 + NCOLS].astype(np.float64)
    sub[sub < 0] = np.nan                       # -1/-3 = missing / no coverage
    blocks = sub.reshape(NROWS // BLOCK, BLOCK, NCOLS // BLOCK, BLOCK)
    with np.errstate(invalid="ignore"):
        cell = np.nanmean(blocks, axis=(1, 3))
    cell = np.nan_to_num(cell, nan=0.0) / MM_PER_IN
    valid = f"{date:08d}T{time_:04d}"
    return cell, valid


def cell_centers():
    lats = [40.95 - 0.1 * i for i in range(NROWS // BLOCK)]     # N -> S, matches array rows
    lons = [-108.95 + 0.1 * j for j in range(NCOLS // BLOCK)]
    return lats, lons


def load_elevations(lats, lons):
    """Elevation (ft) for every output cell, fetched once from Open-Meteo and cached."""
    n = len(lats) * len(lons)
    if os.path.exists(ELEV_PATH):
        with open(ELEV_PATH) as f:
            elev = json.load(f)
        if len(elev) == n:
            return elev
    log("Fetching elevations for %d cells (one-time)..." % n)
    pts = [(la, lo) for la in lats for lo in lons]
    elev = []
    for i in range(0, n, 100):
        batch = pts[i:i + 100]
        url = ("https://api.open-meteo.com/v1/elevation?latitude=" +
               ",".join(f"{p[0]:.2f}" for p in batch) +
               "&longitude=" + ",".join(f"{p[1]:.2f}" for p in batch))
        data = json.loads(download(url, timeout=60))
        elev.extend(round(e * M_TO_FT) for e in data["elevation"])
        time.sleep(0.6)
    with open(ELEV_PATH, "w") as f:
        json.dump(elev, f)
    return elev


def daily_12z_dates(now_utc):
    """Last 7 hydrologic days (24H accumulations valid at 12z), oldest first."""
    latest = now_utc.replace(hour=12, minute=0, second=0, microsecond=0)
    if now_utc.hour < 13:                        # today's 12z file not posted yet
        latest -= timedelta(days=1)
    return [latest - timedelta(days=d) for d in range(6, -1, -1)]


def refresh():
    os.makedirs(DATA_DIR, exist_ok=True)
    now = datetime.now(timezone.utc)

    log("Downloading MRMS 24H Pass2 (latest)...")
    g24, valid24 = grib_to_grid(download(
        f"{NCEP}/MultiSensor_QPE_24H_Pass2/MRMS_MultiSensor_QPE_24H_Pass2.latest.grib2.gz"))
    log("Downloading MRMS 72H Pass2 (latest)...")
    g72, _ = grib_to_grid(download(
        f"{NCEP}/MultiSensor_QPE_72H_Pass2/MRMS_MultiSensor_QPE_72H_Pass2.latest.grib2.gz"))

    day_grids = []
    for dt in daily_12z_dates(now):
        stamp = dt.strftime("%Y%m%d-%H0000")
        url = (f"{ARCHIVE}/{dt:%Y/%m/%d}/mrms/ncep/MultiSensor_QPE_24H_Pass2/"
               f"MultiSensor_QPE_24H_Pass2_00.00_{stamp}.grib2.gz")
        log(f"Downloading daily 24H file {dt:%Y-%m-%d} 12z...")
        try:
            g, _ = grib_to_grid(download(url))
        except Exception as e:
            log(f"  missing ({e}); treating day as zero")
            g = np.zeros_like(g24)
        day_grids.append(g)

    g7 = np.sum(day_grids, axis=0)
    lats, lons = cell_centers()
    elev = load_elevations(lats, lons)

    cells = []
    k = 0
    for i, la in enumerate(lats):
        for j, lo in enumerate(lons):
            days = [bool(day_grids[d][i, j] >= RAIN_DAY_IN) for d in range(7)]
            cells.append({
                "lat": round(la, 2), "lon": round(lo, 2), "elevFt": elev[k],
                "t24": round(float(g24[i, j]), 3),
                "t72": round(float(g72[i, j]), 3),
                "t7":  round(float(g7[i, j]), 3),
                "days": days,
                "rainDays": sum(days),
            })
            k += 1

    out = {
        "updated": now.isoformat(timespec="seconds"),
        "valid24": valid24,
        "step": 0.1,
        "source": "NOAA MRMS MultiSensor QPE Pass 2 (gauge-corrected radar)",
        "cells": cells,
    }
    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    os.replace(tmp, OUT_PATH)
    log(f"Wrote {OUT_PATH}: {len(cells)} cells, valid {valid24}Z")
    return out


if __name__ == "__main__":
    refresh()
