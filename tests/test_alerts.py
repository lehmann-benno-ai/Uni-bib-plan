import os
import sys
import tempfile
import time
import unittest
from datetime import datetime
from unittest import mock

os.environ["DATA_DIR"] = tempfile.mkdtemp()
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

F, B, C = "free", "booked", "closed"


def make_data(times, columns, rooms=None):
    rooms = rooms or [f"R{j}" for j in range(len(columns))]
    slots = [{"time": t, "cells": [{"state": col[i]} for col in columns]} for i, t in enumerate(times)]
    return {"building": "Altstadt", "date": "2026-10-25", "rooms": rooms, "slot_minutes": 30, "slots": slots}


TIMES = ["17:00", "17:30", "18:00", "18:30", "19:00"]


class UpstreamFailureTest(unittest.TestCase):
    RAW = {"rooms": [{"name": "R0"}], "slots": [{"hour_min": "17:00", "time_rooms": [{"state": ["could_new"]}]}]}

    def setUp(self):
        server._cache.clear()
        server._failures.clear()

    def test_serves_stale_data_when_upstream_breaks(self):
        with mock.patch.object(server, "fetch_upstream", return_value=self.RAW):
            good = server.get_availability("Altstadt", "2026-11-06")
        server._cache[("Altstadt", "2026-11-06")] = (time.time() - server.CACHE_TTL - 1, good)
        with mock.patch.object(server, "fetch_upstream", side_effect=ValueError("Expecting value")) as up:
            data = server.get_availability("Altstadt", "2026-11-06")
            again = server.get_availability("Altstadt", "2026-11-06")
        self.assertTrue(data["stale"] and again["stale"])
        self.assertEqual(data["rooms"], ["R0"])
        self.assertEqual(up.call_count, 1)  # failure is remembered, upstream not hammered

    def test_raises_without_cached_data(self):
        with mock.patch.object(server, "fetch_upstream", side_effect=ValueError("Expecting value")):
            with self.assertRaises(server.UpstreamError):
                server.get_availability("Neuenheim", "2026-11-06")


class RoomsFreeSoonTest(unittest.TestCase):
    def test_room_freeing_within_ten_minutes(self):
        data = make_data(TIMES, [[B, B, F, F, B]])
        [r] = server.rooms_free_soon(data, server.to_min("17:52"))
        self.assertEqual((r["room"], r["from"], r["to"], r["slots"], r["minutes"]), ("R0", "18:00", "19:00", 2, 8))

    def test_too_early_and_free_now_are_ignored(self):
        data = make_data(TIMES, [[B, B, F, F, B], [B, F, F, B, B]])
        self.assertEqual(server.rooms_free_soon(data, server.to_min("17:45")), [])
        self.assertEqual(server.rooms_free_soon(data, server.to_min("17:49")), [])

    def test_min_slots_skips_short_blocks(self):
        data = make_data(TIMES, [[B, B, F, B, F]])
        self.assertEqual(len(server.rooms_free_soon(data, server.to_min("17:55"), 1)), 1)
        self.assertEqual(server.rooms_free_soon(data, server.to_min("17:55"), 2), [])

    def test_before_opening(self):
        data = make_data(TIMES, [[F, F, B, B, C]])
        [r] = server.rooms_free_soon(data, server.to_min("16:55"))
        self.assertEqual((r["from"], r["minutes"]), ("17:00", 5))

    def test_after_closing(self):
        self.assertEqual(server.rooms_free_soon(make_data(TIMES, [[F] * 5]), server.to_min("20:00")), [])


class CheckAlertsTest(unittest.TestCase):
    def setUp(self):
        server.store.subs.clear()
        self.sub = {"endpoint": "https://fcm.googleapis.com/fcm/send/abc", "keys": {"p256dh": "x", "auth": "y"}}

    def test_sends_once_per_slot(self):
        data = make_data(TIMES, [[B, B, F, F, B]], rooms=["W3.3"])
        server.store.upsert(self.sub, ["Altstadt"], 0)
        now = datetime(2026, 10, 25, 17, 52, tzinfo=server.TZ)
        with mock.patch.object(server, "get_availability", return_value=data), \
             mock.patch.object(server, "send_push", return_value=True) as send:
            server.check_alerts(now)
            server.check_alerts(now)
        self.assertEqual(send.call_count, 1)
        payload = send.call_args.args[2]
        self.assertEqual(payload["title"], "W3.3 is free in 8 min")
        self.assertIn("18:00–19:00", payload["body"])

    def test_german_payload(self):
        data = make_data(TIMES, [[B, B, F, F, B]], rooms=["W3.3"])
        server.store.upsert(self.sub, ["Altstadt"], 0, lang="de")
        now = datetime(2026, 10, 25, 17, 52, tzinfo=server.TZ)
        with mock.patch.object(server, "get_availability", return_value=data), \
             mock.patch.object(server, "send_push", return_value=True) as send:
            server.check_alerts(now)
        payload = send.call_args.args[2]
        self.assertEqual(payload["title"], "W3.3 ist in 8 Min. frei")
        self.assertIn("frei 18:00–19:00", payload["body"])

    def test_validates_push_endpoints(self):
        self.assertTrue(server.valid_subscription(self.sub))
        self.assertTrue(server.valid_subscription({**self.sub, "endpoint": "https://web.push.apple.com/abc"}))
        self.assertTrue(server.valid_subscription({**self.sub, "endpoint": "https://jmt17.google.com/fcm/send/abc"}))
        self.assertFalse(server.valid_subscription({**self.sub, "endpoint": "https://evil.example.com/x"}))
        self.assertFalse(server.valid_subscription({**self.sub, "endpoint": "http://fcm.googleapis.com/x"}))


if __name__ == "__main__":
    unittest.main()
