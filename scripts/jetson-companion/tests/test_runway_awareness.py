"""Synthetic runway images, centerline geometry, and the command gate."""

import base64
import inspect
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import runway_awareness as rw
from runway_awareness import (
    advice_he,
    authorize,
    command_plan,
    detect_runway,
    emit_commands,
    hazards_on_runway,
    pose_from_polygon,
    rect_hits_polygon,
    reset_service,
    roll_pwm,
    synthetic_runway,
    try_handle,
)


class FakeHandler:
    def __init__(self, path, command="GET"):
        self.path = path
        self.command = command
        self.status = None
        self.body = None

    def _path(self):
        return self.path.split("?", 1)[0]

    def _json(self, status, body):
        self.status = status
        self.body = body


class GeometryTests(unittest.TestCase):
    def test_centered_strip_has_no_offset(self):
        polygon = [(68, 15), (92, 15), (124, 105), (36, 105)]
        pose = pose_from_polygon(polygon, 160, 120, alt_m=30, hfov_deg=60, camera="down")
        self.assertTrue(pose["detected"])
        self.assertLess(abs(pose["offset_px"]), 1.5)
        self.assertLess(abs(pose["heading_error_deg"]), 2.0)
        self.assertAlmostEqual(pose["progress"], 0.5, delta=0.08)
        self.assertIsNotNone(pose["offset_m"])
        self.assertGreater(pose["confidence"]["offset"], 0.4)
        self.assertGreater(pose["confidence"]["heading"], 0.4)
        self.assertGreater(pose["confidence"]["along"], 0.4)

    def test_aircraft_right_of_centerline_is_positive(self):
        polygon = [(48, 15), (72, 15), (104, 105), (16, 105)]
        pose = pose_from_polygon(polygon, 160, 120, camera="down")
        self.assertGreater(pose["offset_px"], 10)
        self.assertGreater(pose["offset_norm"], 0)

    def test_far_end_right_means_turn_right(self):
        polygon = [(90, 20), (110, 20), (80, 100), (60, 100)]
        pose = pose_from_polygon(polygon, 160, 120)
        self.assertGreater(pose["heading_error_deg"], 5)
        self.assertGreater(roll_pwm(pose), 1500)

    def test_right_offset_rolls_left(self):
        pose = {
            "detected": True,
            "heading_error_deg": 0,
            "offset_m": 2,
            "offset_norm": 0.4,
        }
        self.assertLess(roll_pwm(pose), 1500)

    def test_hazard_box_must_meet_the_polygon(self):
        polygon = [(40, 20), (120, 20), (140, 100), (20, 100)]
        self.assertTrue(rect_hits_polygon([60, 40, 20, 20], polygon))
        self.assertFalse(rect_hits_polygon([0, 0, 10, 10], polygon))
        tracks = [
            {"class": "person", "confidence": 0.9, "bbox": [70, 50, 16, 28]},
            {"class": "car", "confidence": 0.8, "bbox": [0, 0, 12, 12]},
            {"class": "dog", "confidence": 0.7, "bbox": [80, 60, 18, 14]},
            {"class": "suitcase", "confidence": 0.6, "bbox": [90, 70, 10, 10]},
        ]
        found = hazards_on_runway(tracks, polygon)
        kinds = [row["kind"] for row in found]
        self.assertEqual(kinds, ["person", "animal", "obstacle"])
        self.assertEqual(found[0]["label_he"], "אדם")
        self.assertIn("ללכת סביב", advice_he(2, found))
        self.assertEqual(advice_he(1, found), "")


class ImageTests(unittest.TestCase):
    def test_synthetic_center_runway(self):
        width, height, rgb = synthetic_runway()
        pose = detect_runway(width, height, rgb, alt_m=40, hfov_deg=50, camera="down")
        self.assertTrue(pose["detected"])
        self.assertLess(abs(pose["offset_px"]), 6)
        self.assertLess(abs(pose["heading_error_deg"]), 6)
        self.assertGreater(pose["progress"], 0.2)
        self.assertLess(pose["progress"], 0.8)
        self.assertIsNotNone(pose["centerline"])

    def test_synthetic_shift_matches_sign(self):
        width, height, rgb = synthetic_runway(shift_x=-24)
        pose = detect_runway(width, height, rgb, camera="down")
        self.assertTrue(pose["detected"])
        self.assertGreater(pose["offset_px"], 8)

    def test_empty_frame_is_not_a_runway(self):
        pose = detect_runway(80, 60, bytes([20, 80, 30]) * 80 * 60)
        self.assertFalse(pose["detected"])
        self.assertIsNone(pose["offset_px"])
        self.assertIsNone(pose["heading_error_deg"])


class GateTests(unittest.TestCase):
    def setUp(self):
        reset_service()

    def tearDown(self):
        reset_service()

    def test_levels_zero_one_two_emit_nothing_in_sitl(self):
        estimate = {"detected": True, "heading_error_deg": 4, "offset_m": 1, "offset_norm": 0.2}
        for level in (0, 1, 2):
            sent = []
            plan = command_plan(level, estimate, [], sitl=True, unlock=True, confirmed=True)
            self.assertEqual(plan["commands"], [])
            self.assertEqual(emit_commands(plan, sent.append, True), 0)
            self.assertEqual(sent, [])
            self.assertFalse(authorize(level, True)["allow"])

    def test_level_three_sends_only_in_sitl(self):
        estimate = {"detected": True, "heading_error_deg": 4, "offset_m": 0, "offset_norm": 0}
        blocked = []
        plan = command_plan(3, estimate, [], sitl=False)
        self.assertEqual(emit_commands(plan, blocked.append, False), 0)
        self.assertEqual(blocked, [])
        sent = []
        allowed = command_plan(3, estimate, [], sitl=True)
        self.assertEqual(emit_commands(allowed, sent.append, True), 1)
        self.assertEqual(sent[0]["kind"], "ROLL_OVERRIDE")
        self.assertTrue(sent[0]["sitl_only"])
        hazard = [{"kind": "person", "label_he": "אדם"}]
        held = command_plan(3, estimate, hazard, sitl=True)
        self.assertEqual(held["reason"], "hazard")
        self.assertEqual(emit_commands(held, sent.append, True), 0)

    def test_level_four_stays_locked(self):
        estimate = {"detected": True, "heading_error_deg": 2, "offset_m": 0, "offset_norm": 0}
        locked = command_plan(4, estimate, [], sitl=True, unlock=False, confirmed=True)
        self.assertEqual(locked["reason"], "level4_locked")
        self.assertEqual(emit_commands(locked, lambda _cmd: None, True), 0)
        unconfirmed = command_plan(4, estimate, [], sitl=True, unlock=True, confirmed=False)
        self.assertEqual(unconfirmed["reason"], "level4_locked")
        outside = command_plan(4, estimate, [], sitl=False, unlock=True, confirmed=True)
        self.assertEqual(outside["reason"], "not_sitl")
        self.assertEqual(emit_commands(outside, lambda _cmd: None, False), 0)
        opened = []
        ready = command_plan(4, estimate, [], sitl=True, unlock=True, confirmed=True)
        self.assertEqual(emit_commands(ready, opened.append, True), 1)
        self.assertEqual(len(opened), 1)

    def test_http_never_emits(self):
        source = inspect.getsource(try_handle)
        self.assertNotIn("emit_commands", source)
        handler = FakeHandler("/api/v1/runway/awareness")
        self.assertTrue(try_handle(handler))
        self.assertEqual(handler.body["level"], 0)
        self.assertEqual(handler.body["commands_sent"], 0)
        self.assertEqual(handler.body["commands"], [])
        self.assertIs(handler.body["flight_commands"], False)
        self.assertIsNone(handler.body["detected"])
        denied = FakeHandler("/api/v1/runway/level", "POST")
        self.assertTrue(try_handle(denied, {"level": 4, "confirm": True, "phrase": "מאשר"}))
        self.assertEqual(denied.status, 403)
        self.assertIn("נעולה", denied.body["message_he"])
        self.assertEqual(denied.body["commands_sent"], 0)
        width, height, rgb = synthetic_runway()
        shown = FakeHandler("/api/v1/runway/level", "POST")
        self.assertTrue(try_handle(shown, {"level": 1}))
        framed = FakeHandler("/api/v1/runway/frame", "POST")
        self.assertTrue(try_handle(framed, {
            "camera": "cam1",
            "width": width,
            "height": height,
            "rgb_b64": base64.b64encode(rgb).decode("ascii"),
            "tracks": [{"class": "person", "confidence": 0.91, "bbox": [70, 50, 18, 30]}],
            "alt_m": 30,
            "hfov_deg": 60,
            "sitl": True,
        }))
        self.assertEqual(framed.body["commands_sent"], 0)
        self.assertEqual(framed.body["commands"], [])
        self.assertIs(framed.body["allow_send"], False)
        self.assertTrue(framed.body["detected"])
        self.assertEqual(framed.body["hazards"][0]["kind"], "person")


if __name__ == "__main__":
    unittest.main()
