#!/usr/bin/env python3
"""Write UB room availability as static JSON for the GitHub Pages copy of the site.

Usage: python3 scripts/build_pages_data.py OUT_DIR
Creates OUT_DIR/rooms/<building>/<YYYY-MM-DD>.json for today and the next 14 days (Heidelberg time).
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

DAYS = 15
ATTEMPTS = 3


def fetch(building, day):
    for attempt in range(ATTEMPTS):
        try:
            return server.normalize(server.fetch_upstream(building, day), building, day)
        except Exception as exc:
            if attempt == ATTEMPTS - 1:
                raise
            print(f"retrying {building} {day}: {type(exc).__name__}: {exc}", flush=True)
            time.sleep(5 * (attempt + 1))


def main(out_dir):
    today = datetime.now(server.TZ).date()
    for building in server.BUILDINGS:
        folder = os.path.join(out_dir, "rooms", building)
        os.makedirs(folder, exist_ok=True)
        for i in range(DAYS):
            day = (today + timedelta(days=i)).isoformat()
            with open(os.path.join(folder, f"{day}.json"), "w") as f:
                json.dump(fetch(building, day), f, separators=(",", ":"))
    print(f"wrote {len(server.BUILDINGS) * DAYS} files to {out_dir}/rooms")


if __name__ == "__main__":
    main(sys.argv[1])
