#!/usr/bin/env python3
"""Small web server showing free group study rooms at UB Heidelberg.

Proxies the public JSON API of https://www.ub.uni-heidelberg.de/raumres/
(which has no CORS headers), serves a static frontend and, when VAPID keys are
configured, sends Web Push alerts shortly before a room becomes free.
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

try:
    from pywebpush import WebPushException, webpush
except ImportError:  # push alerts are optional
    webpush = None

UPSTREAM = "https://www.ub.uni-heidelberg.de/raumres/cgi/api.cgi"
BOOKING_URL = "https://www.ub.uni-heidelberg.de/raumres/?building={building}&date={date}"
BUILDINGS = ("Altstadt", "Neuenheim")
CACHE_TTL = int(os.environ.get("CACHE_TTL", "60"))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TZ = ZoneInfo("Europe/Berlin")

SOON_MINUTES = 10
CHECK_INTERVAL = int(os.environ.get("CHECK_INTERVAL", "60"))
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "https://ub-room-finder.onrender.com")
PUSH_ENABLED = bool(webpush and VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)
SUBSCRIPTIONS_FILE = os.path.join(os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data")), "subscriptions.json")
# Render's free tier sleeps after 15 idle minutes; while anyone has alerts on, ping our own URL to stay awake.
KEEP_AWAKE_URL = os.environ.get("KEEP_AWAKE_URL", "")
MAX_SUBSCRIPTIONS = 5000
MAX_BODY = 8192
PUSH_HOSTS = ("fcm.googleapis.com", "jmt17.google.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com")

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


def to_min(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def from_min(minutes):
    return f"{minutes // 60 % 24:02d}:{minutes % 60:02d}"


def rooms_free_soon(data, now_min, min_slots=0, soon=SOON_MINUTES):
    """Rooms whose next free block (>= min_slots slots) starts within `soon` minutes but not right now."""
    slots = data["slots"]
    step = data["slot_minutes"]
    times = [to_min(s["time"]) for s in slots]
    n = len(slots)
    current = next((i for i, t in enumerate(times) if t <= now_min < t + step), -1)
    start = current if current >= 0 else next((i for i, t in enumerate(times) if t > now_min), -1)
    if start < 0:
        return []
    need = max(min_slots, 1)
    result = []
    for j, name in enumerate(data["rooms"]):
        run = [0] * n
        for i in range(n - 1, -1, -1):
            cells = slots[i]["cells"]
            if j < len(cells) and cells[j]["state"] == "free":
                contiguous = i + 1 < n and times[i + 1] - times[i] == step
                run[i] = 1 + (run[i + 1] if contiguous else 0)
        idx = next((i for i in range(start, n) if run[i] >= need), -1)
        if idx < 0 or idx == current:
            continue
        minutes = times[idx] - now_min
        if 0 < minutes <= soon:
            result.append({
                "room": name,
                "from": slots[idx]["time"],
                "to": from_min(times[idx] + run[idx] * step),
                "slots": run[idx],
                "minutes": minutes,
            })
    return result


def fmt_duration(slots, step=30):
    m = slots * step
    h = m // 60
    return f"{h} h{' 30' if m % 60 else ''}" if h else f"{m} min"


def valid_subscription(sub):
    if not isinstance(sub, dict) or not isinstance(sub.get("keys"), dict):
        return False
    endpoint = sub.get("endpoint")
    if not isinstance(endpoint, str) or len(endpoint) > 1000:
        return False
    url = urlparse(endpoint)
    host = url.hostname or ""
    return (url.scheme == "https" and any(host == h or host.endswith("." + h) for h in PUSH_HOSTS)
            and all(isinstance(sub["keys"].get(k), str) for k in ("p256dh", "auth")))


class SubscriptionStore:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        try:
            with open(path) as f:
                self.subs = json.load(f)
        except (OSError, ValueError):
            self.subs = {}

    def _save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.subs, f)
        os.replace(tmp, self.path)

    def upsert(self, sub, buildings, min_slots, sent=None):
        with self.lock:
            old = self.subs.get(sub["endpoint"], {})
            if not old and len(self.subs) >= MAX_SUBSCRIPTIONS:
                return False
            self.subs[sub["endpoint"]] = {
                "subscription": {"endpoint": sub["endpoint"], "keys": {k: sub["keys"][k] for k in ("p256dh", "auth")}},
                "buildings": buildings,
                "min_slots": min_slots,
                "sent": sent if sent is not None else old.get("sent", []),
            }
            self._save()
            return True

    def remove(self, endpoint):
        with self.lock:
            if self.subs.pop(endpoint, None) is not None:
                self._save()

    def get(self, endpoint):
        with self.lock:
            return json.loads(json.dumps(self.subs.get(endpoint))) if endpoint in self.subs else None

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self.subs))

    def mark_sent(self, endpoint, keys, today):
        with self.lock:
            rec = self.subs.get(endpoint)
            if rec is None:
                return
            rec["sent"] = [k for k in rec["sent"] if k.startswith(today)] + keys
            self._save()

    def __len__(self):
        return len(self.subs)


store = SubscriptionStore(SUBSCRIPTIONS_FILE)


def send_push(endpoint, subscription, payload):
    """Returns False if the subscription is gone and was removed."""
    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps(payload),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": VAPID_SUBJECT},
            ttl=SOON_MINUTES * 60,
            headers={"Urgency": "high"},
        )
        return True
    except WebPushException as exc:
        status = getattr(exc.response, "status_code", None)
        if status in (403, 404, 410):
            store.remove(endpoint)
            return False
        print(f"push failed ({status}): {exc}")
        return True
    except Exception as exc:  # network errors etc.
        print(f"push failed: {exc}")
        return True


def check_alerts(now=None):
    now = now or datetime.now(TZ)
    today = now.date().isoformat()
    now_min = now.hour * 60 + now.minute
    subs = store.snapshot()
    data_by_building = {}
    for building in {b for rec in subs.values() for b in rec["buildings"]}:
        try:
            data_by_building[building] = get_availability(building, today)
        except Exception as exc:
            print(f"availability fetch failed for {building}: {exc}")
    for endpoint, rec in subs.items():
        new_keys = []
        for building in rec["buildings"]:
            data = data_by_building.get(building)
            if not data:
                continue
            for r in rooms_free_soon(data, now_min, rec["min_slots"]):
                key = f"{today}|{building}|{r['room']}|{r['from']}"
                if key in rec["sent"] or key in new_keys:
                    continue
                ok = send_push(endpoint, rec["subscription"], {
                    "title": f"{r['room']} is free in {r['minutes']} min",
                    "body": f"{building} · free {r['from']}–{r['to']} ({fmt_duration(r['slots'])})",
                    "tag": key,
                    "url": f"/?building={building}",
                })
                if not ok:
                    break
                new_keys.append(key)
            else:
                continue
            break
        if new_keys or any(not k.startswith(today) for k in rec["sent"]):
            store.mark_sent(endpoint, new_keys, today)


def alert_loop():
    last_ping = 0.0
    while True:
        try:
            if len(store):
                check_alerts()
                if KEEP_AWAKE_URL and time.time() - last_ping > 600:
                    last_ping = time.time()
                    urllib.request.urlopen(KEEP_AWAKE_URL.rstrip("/") + "/healthz", timeout=15).read()
        except Exception as exc:
            print(f"alert loop error: {exc}")
        time.sleep(CHECK_INTERVAL)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/availability":
            return self.api_availability(parse_qs(parsed.query))
        if parsed.path == "/api/push/key":
            return self.send_json({"enabled": PUSH_ENABLED, "publicKey": VAPID_PUBLIC_KEY if PUSH_ENABLED else None})
        if parsed.path == "/healthz":
            return self.send_json({"ok": True})
        return super().do_GET()

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_POST(self):
        routes = {
            "/api/push/subscribe": self.push_subscribe,
            "/api/push/unsubscribe": self.push_unsubscribe,
            "/api/push/resubscribe": self.push_resubscribe,
        }
        route = routes.get(urlparse(self.path).path)
        if not route:
            return self.send_json({"error": "not found"}, 404)
        if not PUSH_ENABLED:
            return self.send_json({"error": "push alerts are not configured on this server"}, 503)
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self.send_json({"error": "request too large"}, 413)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.send_json({"error": "invalid JSON"}, 400)
        if not isinstance(body, dict):
            return self.send_json({"error": "invalid JSON"}, 400)
        return route(body)

    def push_subscribe(self, body):
        sub = body.get("subscription")
        buildings = [b for b in body.get("buildings") or [] if b in BUILDINGS]
        min_slots = body.get("minSlots", 0)
        if not valid_subscription(sub) or not buildings or not isinstance(min_slots, int) or not 0 <= min_slots <= 24:
            return self.send_json({"error": "invalid subscription or settings"}, 400)
        is_new = store.get(sub["endpoint"]) is None
        if not store.upsert(sub, buildings, min_slots):
            return self.send_json({"error": "too many subscriptions"}, 503)
        if is_new and body.get("confirm"):
            threading.Thread(target=send_push, daemon=True, args=(sub["endpoint"], sub, {
                "title": "Alerts are on",
                "body": f"We'll tell you when a room in {' & '.join(buildings)} frees up within {SOON_MINUTES} minutes — even when the app is closed.",
                "tag": "enabled",
            })).start()
        return self.send_json({"ok": True})

    def push_unsubscribe(self, body):
        if isinstance(body.get("endpoint"), str):
            store.remove(body["endpoint"])
        return self.send_json({"ok": True})

    def push_resubscribe(self, body):
        sub = body.get("subscription")
        old = store.get(body.get("oldEndpoint")) if isinstance(body.get("oldEndpoint"), str) else None
        if not valid_subscription(sub) or not old:
            return self.send_json({"error": "unknown subscription"}, 400)
        store.remove(body["oldEndpoint"])
        store.upsert(sub, old["buildings"], old["min_slots"], old["sent"])
        return self.send_json({"ok": True})

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
    if PUSH_ENABLED:
        threading.Thread(target=alert_loop, daemon=True).start()
    print(f"Serving on http://localhost:{port} (push alerts {'on' if PUSH_ENABLED else 'off'}, {len(store)} subscribers)")
    server.serve_forever()


if __name__ == "__main__":
    main()
