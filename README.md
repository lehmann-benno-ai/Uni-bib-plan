# UB Heidelberg – Free Group Study Rooms

Unofficial website that shows which group study rooms (Gruppenarbeitsräume) at the
[Universitätsbibliothek Heidelberg](https://www.ub.uni-heidelberg.de/de/service/lsa/gruppenarbeitsraeume)
are free, and when — for both **Altstadt** and **Neuenheim**, up to 14 days ahead.

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
