# -*- coding: utf-8 -*-
"""Detector expectations against the committed fixtures."""

from __future__ import print_function

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from flight_detector import FlightDetector, observations_to_samples  # noqa: E402
from flight_packager import observations_from_tlog  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures"


def _play(name):
    truth = json.loads((FIX / (name + ".json")).read_text(encoding="utf-8"))
    obs = observations_from_tlog(str(FIX / (name + ".tlog")))
    samples = observations_to_samples(obs)
    tail = float(truth.get("tail_s") or 0)
    if samples and tail > 0:
        last = samples[-1]
        steps = int(tail / 0.5) + 4
        for i in range(1, steps):
            sample = dict(last)
            sample["t"] = last["t"] + i * 0.5
            sample["hb_fresh"] = False
            sample["hb_events"] = []
            sample["airspeed"] = None
            sample["groundspeed"] = None
            sample["groundspeed_meas"] = None
            sample["rel_alt"] = None
            sample["climb"] = None
            sample["gps_valid"] = False
            sample["lat"] = None
            sample["lon"] = None
            sample["has_telemetry"] = False
            samples.append(sample)
    det = FlightDetector()
    events = []
    for sample in samples:
        events.extend(det.tick(sample) or [])
    return det.snapshot(), events, truth


class DetectorTests(unittest.TestCase):
    def _check(self, name):
        snap, events, truth = _play(name)
        self.assertEqual(snap["classification"], truth["classification"], name)
        self.assertEqual(snap["end_reason"], truth["end_reason"], name)
        self.assertEqual(snap["segment_count"], truth["segments"], name)
        t0 = float(truth["t0"])
        if truth.get("takeoff_offset") is None:
            self.assertIsNone(snap["takeoff_t"], name)
        else:
            self.assertIsNotNone(snap["takeoff_t"], name)
            self.assertLessEqual(abs(snap["takeoff_t"] - (t0 + float(truth["takeoff_offset"]))), 1.0, name)
        if truth.get("landing_offset") is None:
            self.assertIsNone(snap["landed_t"], name)
        else:
            self.assertIsNotNone(snap["landed_t"], name)
            self.assertLessEqual(abs(snap["landed_t"] - (t0 + float(truth["landing_offset"]))), 1.0, name)
        return snap, events, truth

    def test_bench_is_not_a_flight(self):
        snap, _events, _truth = self._check("bench")
        self.assertNotEqual(snap["classification"], "flight")

    def test_taxi_is_not_a_flight(self):
        snap, _events, _truth = self._check("taxi")
        self.assertEqual(snap["classification"], "ground_run")

    def test_normal_flight(self):
        self._check("normal")

    def test_hand_launch(self):
        self._check("hand")

    def test_glitch_does_not_take_off_on_the_ground_spike(self):
        snap, events, truth = self._check("glitch")
        t0 = float(truth["t0"])
        self.assertGreater(abs(snap["takeoff_t"] - (t0 + 22.0)), 5.0)
        types = [ev["type"] for ev in events]
        self.assertIn("fc.gps_glitch_suspected", types)

    def test_touch_and_go_two_segments(self):
        snap, _events, truth = self._check("touch")
        t0 = float(truth["t0"])
        self.assertEqual(len(snap["segments"]), 2)
        self.assertLessEqual(abs(snap["segments"][0]["takeoff_t"] - (t0 + 20.0)), 1.0)
        self.assertLessEqual(abs(snap["segments"][1]["takeoff_t"] - (t0 + 150.0)), 1.0)

    def test_link_loss(self):
        _snap, events, _truth = self._check("linkloss")
        types = [ev["type"] for ev in events]
        self.assertIn("fc.heartbeat_lost", types)
        self.assertIn("fc.heartbeat_restored", types)

    def test_disarm_in_air(self):
        self._check("disarm_air")

    def test_heartbeat_only(self):
        self._check("heartbeat_only")

    def test_gcs_heartbeats_are_ignored(self):
        self._check("gcs_ignored")


if __name__ == "__main__":
    unittest.main()
