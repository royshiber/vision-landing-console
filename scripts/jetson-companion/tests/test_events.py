# -*- coding: utf-8 -*-
"""Event normalization: modes, collapse, cause link, redaction."""

from __future__ import print_function

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from flight_events import EventNormalizer  # noqa: E402
from flightlog_common import redact_text  # noqa: E402


def _hb(t, mode, armed=True):
    return {
        "t": t,
        "name": "HEARTBEAT",
        "sysid": 1,
        "comp": 1,
        "mav_type": 1,
        "autopilot": 3,
        "custom_mode": mode,
        "armed": armed,
        "base_mode": 217 if armed else 89,
    }


class EventTests(unittest.TestCase):
    def test_mode_line_is_hebrew_rtl(self):
        norm = EventNormalizer()
        norm.feed_obs(_hb(10, 5))
        norm.feed_obs(_hb(12, 10))
        rows = norm.finalize(10)
        change = [row for row in rows if row["type"] == "fc.mode_change"][0]
        self.assertEqual(change["msg_he"], "מצב טיסה FBWA ← AUTO")
        self.assertEqual(change["id"], "E0001" if rows[0]["type"] == "fc.mode_change" else change["id"])
        self.assertTrue(change["id"].startswith("E"))

    def test_ids_stable(self):
        def build():
            norm = EventNormalizer()
            norm.feed_obs(_hb(1, 5))
            norm.feed_obs(_hb(2, 10))
            return [row["id"] + row["type"] for row in norm.finalize(1)]

        self.assertEqual(build(), build())

    def test_statustext_collapse(self):
        norm = EventNormalizer()
        for t in (1, 4, 9):
            norm.feed_obs({"t": t, "name": "STATUSTEXT", "text": "gps failsafe", "severity": 2, "sysid": 1, "comp": 1})
        rows = norm.finalize(1)
        texts = [row for row in rows if row["type"] == "fc.failsafe"]
        self.assertEqual(len(texts), 1)
        self.assertEqual(texts[0]["count"], 3)
        self.assertEqual(texts[0]["msg_he"], None)

    def test_cause_id_links_mode_within_three_seconds(self):
        norm = EventNormalizer()
        norm.feed_obs(_hb(1, 5))
        norm.feed_obs({"t": 10, "name": "STATUSTEXT", "text": "battery failsafe", "severity": 2, "sysid": 1, "comp": 1})
        norm.feed_obs(_hb(12, 11))
        rows = norm.finalize(1)
        fail = [row for row in rows if row["type"] == "fc.failsafe"][0]
        mode = [row for row in rows if row["type"] == "fc.mode_change"][0]
        self.assertEqual(mode["data"]["to"], "RTL")
        self.assertEqual(mode["cause_id"], fail["id"])

    def test_redaction(self):
        raw = "Authorization: Bearer abc123\nAIRVIX_UPLOAD_APP_KEY=supersecretvalue\nAIRVIX_UPLOAD_SECRET=othersecretvalue\n"
        clean = redact_text(raw)
        self.assertNotIn("abc123", clean)
        self.assertNotIn("supersecretvalue", clean)
        self.assertNotIn("othersecretvalue", clean)
        self.assertIn("[redacted]", clean)


if __name__ == "__main__":
    unittest.main()
