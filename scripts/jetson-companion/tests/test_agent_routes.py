"""Companion version route and relay heartbeat stay valid JSON."""

import json
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import companion_agent  # noqa: E402


class AgentRouteTests(unittest.TestCase):
    def test_version_reports_agent_and_api(self):
        body = companion_agent.version_payload()
        self.assertEqual(body["api_version"], "1")
        self.assertTrue(body["agentVersion"])
        self.assertEqual(body["companion_version"], body["agentVersion"])

    def test_relay_heartbeat_survives_nan_sensor(self):
        previous = companion_agent.STATE.get("tempC")
        companion_agent.STATE["tempC"] = float("nan")
        try:
            relay = json.loads(json.dumps(
                companion_agent._json_ready(companion_agent.mavlink_status_payload()),
                allow_nan=False,
            ))
            health = json.loads(json.dumps(
                companion_agent._json_ready(companion_agent.health_payload()),
                allow_nan=False,
            ))
        finally:
            companion_agent.STATE["tempC"] = previous
        self.assertIs(relay["ok"], True)
        self.assertIs(relay["heartbeat_ok"], False)
        self.assertIn("fc_serial_name", relay)
        self.assertIsNone(health["tempC"])
        self.assertNotIn("NaN", json.dumps(health))

    def test_status_exposes_detection_backend_and_track_age(self):
        from vision_tracks import VisionTracks, reset_service, set_service
        svc = VisionTracks(enabled=True, camera="cam3", backend="cpu", thread=False)
        svc.captured_mono_ns = time.monotonic_ns() - 180_000_000
        svc.stream = True
        set_service(svc)
        try:
            body = companion_agent.vision_status_payload()
            lite = companion_agent.status_lite_payload()
        finally:
            reset_service()
        self.assertEqual(body["backend"], "cpu")
        self.assertGreaterEqual(body["track_age_ms"], 100)
        self.assertLess(body["track_age_ms"], 2000)
        self.assertEqual(body["detection"]["backend"], "cpu")
        self.assertEqual(lite["vision"]["backend"], "cpu")
        self.assertGreaterEqual(lite["vision"]["track_age_ms"], 100)
        self.assertLess(abs(lite["vision"]["track_age_ms"] - body["track_age_ms"]), 50)
        self.assertIn("tensorrt_fallback", body)


if __name__ == "__main__":
    unittest.main()
