# UB Heidelberg – Free Group Study Rooms

Live: https://ub-room-finder.onrender.com (Render free tier; first load after idle can take ~30 s). Deploys are triggered via the Render API/dashboard (the repo is not connected to Render's GitHub app, so pushes do not auto-deploy).

Unofficial website that shows which group study rooms (Gruppenarbeitsräume) at the
[Universitätsbibliothek Heidelberg](https://www.ub.uni-heidelberg.de/de/service/lsa/gruppenarbeitsraeume)
are free, and when — for both **Altstadt** and **Neuenheim**, up to 14 days ahead.

Features:
- Room cards sorted by availability ("Free now", "In 8 min", "Free from 18:00 …") with a mini day timeline
- Full room × time timeline grid, filter by how long you need a room (30 min – 3 h)
- **Room alerts**: click *Notify me* to get a browser notification when a room becomes free within the
  next 10 minutes (choose buildings and minimum free duration). Works while the page is open
  (desktop, Android; on iOS after "Add to Home Screen").
- Settings panel: room alerts, Light / Dark / Auto theme, English / Deutsch (push alerts arrive in the chosen language)
- Mobile-friendly, installable as a PWA

Booking itself still happens on the official UB site (the "Book on UB site" button links there).

## Run

Requires only Python 3.9+ (no dependencies).

```bash
python3 server.py          # http://localhost:8000
PORT=3000 python3 server.py
```

## How it works

The official booking page (`/raumres/`) loads its data from a public JSON endpoint
`https://www.ub.uni-heidelberg.de/raumres/cgi/api.cgi?building=<Altstadt|Neuenheim>&date=YYYY-MM-DD`.
That endpoint sends no CORS headers, so `server.py` proxies it (cached for 60 s), simplifies the
response, and serves it at `/api/availability?building=...&date=...`. The frontend in `static/`
renders a room × time grid, a "free right now" list, and a filter for how long you need a room.

## Accessibility

The site targets WCAG 2.2 AA:

- Skip link, visible keyboard focus, and Escape closes the alerts panel.
- Toggle buttons expose `aria-pressed`; chip groups and the timeline table have labels, captions and row/column headers.
- Each timeline cell has a screen-reader text (e.g. "Free until 18:00"). Booked and pre-booked slots use stripes/dots too, so colour is never the only cue.
- Changing building, day or duration announces a short summary through a live region; alerts appear in a live region too and can be dismissed.
- Contrast checked in light and dark mode; respects `prefers-reduced-motion` and Windows high-contrast mode.

Checked with axe-core 4.10 (wcag2a/aa, wcag21a/aa, wcag22aa, best-practice): 0 violations.

## Install as an app & push alerts

The site is an installable PWA (manifest, PNG/maskable/apple icons, offline app shell, "Install app" button).

With `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` set (and `pip install -r requirements.txt`), the server stores push
subscriptions in `$DATA_DIR/subscriptions.json`, checks availability every minute and sends a Web Push
notification when a watched room frees up within 10 minutes — also while the app is closed. On iPhone this needs
iOS 16.4+ and the app added to the Home Screen. Without keys the site falls back to in-page alerts.

`KEEP_AWAKE_URL` makes the server ping itself while anyone has alerts on (Render's free tier otherwise sleeps
after 15 idle minutes). Subscriptions are lost when the free instance restarts; the app re-registers on every visit.

Tests: `python3 -m unittest tests.test_alerts`
