"""Companion version route and relay heartbeat stay valid JSON."""

import json
import sys
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


if __name__ == "__main__":
    unittest.main()
