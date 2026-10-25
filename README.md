# UB Heidelberg – Free Group Study Rooms

Unofficial website that shows which group study rooms (Gruppenarbeitsräume) at the
[Universitätsbibliothek Heidelberg](https://www.ub.uni-heidelberg.de/de/service/lsa/gruppenarbeitsraeume)
are free, and when — for both **Altstadt** and **Neuenheim**, up to 14 days ahead.

Features:
- Room cards sorted by availability ("Free now", "In 8 min", "Free from 18:00 …") with a mini day timeline
- Full room × time timeline grid, filter by how long you need a room (30 min – 3 h)
- **Room alerts**: click *Notify me* to get a browser notification when a room becomes free within the
  next 10 minutes (choose buildings and minimum free duration). Works while the page is open
  (desktop, Android; on iOS after "Add to Home Screen").
- Light/dark mode, mobile-friendly, installable as a PWA

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
