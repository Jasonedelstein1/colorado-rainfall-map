"""Static server for the forage map + MRMS refresh endpoint.

  python serve.py            -> http://localhost:8642

Adds to plain http.server:
  GET /api/mrms/status   -> {"ageMinutes": 42} or {"ageMinutes": null}
  GET /api/mrms/refresh  -> runs fetch_mrms.refresh() (30-90 s), returns summary
  no-cache headers on /data/ so refreshed JSON is picked up immediately
On startup, refreshes MRMS data in the background if missing or older than 6 h.
"""
import json
import os
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import fetch_mrms

PORT = 8642
STALE_S = 6 * 3600
HERE = os.path.dirname(os.path.abspath(__file__))
refresh_lock = threading.Lock()


def mrms_age_s():
    try:
        return time.time() - os.path.getmtime(fetch_mrms.OUT_PATH)
    except OSError:
        return None


def do_refresh():
    if not refresh_lock.acquire(blocking=False):
        return {"busy": True}
    try:
        out = fetch_mrms.refresh()
        return {"ok": True, "cells": len(out["cells"]), "valid24": out["valid24"]}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        refresh_lock.release()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def do_GET(self):
        if self.path.startswith("/api/mrms/status"):
            age = mrms_age_s()
            return self.send_json({"ageMinutes": None if age is None else round(age / 60)})
        if self.path.startswith("/api/mrms/refresh"):
            return self.send_json(do_refresh())
        super().do_GET()

    def send_json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if "/data/" in self.path:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


def startup_refresh():
    age = mrms_age_s()
    if age is None or age > STALE_S:
        print("MRMS data %s - refreshing in background..." %
              ("missing" if age is None else f"{age/3600:.1f}h old"), flush=True)
        do_refresh()
        print("MRMS background refresh done.", flush=True)


if __name__ == "__main__":
    threading.Thread(target=startup_refresh, daemon=True).start()
    print(f"Serving forage map at http://localhost:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
