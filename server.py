#!/usr/bin/env python3
"""Small web server showing free group study rooms at UB Heidelberg.

Proxies the public JSON API of https://www.ub.uni-heidelberg.de/raumres/
(which has no CORS headers) and serves a static frontend.
"""
import json
import os
import re
import threading
import time
import urllib.request
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

UPSTREAM = "https://www.ub.uni-heidelberg.de/raumres/cgi/api.cgi"
BOOKING_URL = "https://www.ub.uni-heidelberg.de/raumres/?building={building}&date={date}"
BUILDINGS = ("Altstadt", "Neuenheim")
CACHE_TTL = int(os.environ.get("CACHE_TTL", "60"))
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TZ = ZoneInfo("Europe/Berlin")

_cache = {}
_cache_lock = threading.Lock()


def classify(states):
    if "closed" in states:
        return "closed"
    if "to_be_confirmed" in states:
        return "pending"
    if any(s.startswith("booked") for s in states):
        return "booked"
    if "could_new" in states:
        return "free"
    return "unknown"


def fetch_upstream(building, day):
    url = f"{UPSTREAM}?building={building}&date={day}"
    req = urllib.request.Request(url, headers={"User-Agent": "ub-heidelberg-rooms/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def normalize(raw, building, day):
    rooms = [r["name"] for r in raw.get("rooms", [])]
    slots = []
    for slot in raw.get("slots", []):
        cells = []
        for tr in slot.get("time_rooms", []):
            res = tr.get("reservation") or {}
            cells.append({
                "state": classify(tr.get("state", [])),
                "from": (res.get("res_from_hourmin") or "").strip() or None,
                "to": (res.get("res_to_hourmin") or "").strip() or None,
            })
        slots.append({"time": slot.get("hour_min"), "cells": cells})
    return {
        "building": building,
        "date": day,
        "fetched_at": int(time.time()),
        "booking_url": BOOKING_URL.format(building=building, date=day),
        "rooms": rooms,
        "slot_minutes": 30,
        "slots": slots,
    }


def get_availability(building, day):
    key = (building, day)
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL:
            return hit[1]
    data = normalize(fetch_upstream(building, day), building, day)
    with _cache_lock:
        _cache[key] = (now, data)
    return data


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/availability":
            return self.api_availability(parse_qs(parsed.query))
        return super().do_GET()

    def api_availability(self, qs):
        building = qs.get("building", ["Altstadt"])[0]
        day = qs.get("date", [datetime.now(TZ).date().isoformat()])[0]
        if building not in BUILDINGS:
            return self.send_json({"error": f"building must be one of {BUILDINGS}"}, 400)
        if not DATE_RE.match(day):
            return self.send_json({"error": "date must be YYYY-MM-DD"}, 400)
        try:
            data = get_availability(building, day)
        except Exception as exc:  # upstream down / bad JSON
            return self.send_json({"error": f"upstream error: {exc}"}, 502)
        return self.send_json(data)

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main():
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Serving on http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
