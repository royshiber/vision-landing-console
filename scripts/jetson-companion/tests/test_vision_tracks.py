"""Tracks API: stable ids, lock, and a gimbal steer gate that does not fly."""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import vision_tracks
from vision_tracks import (
    ByteTracker,
    REASON_GIMBAL_ABSENT,
    REASON_NO_STREAM,
    REASON_OFF,
    REASON_STEER_OFF,
    VisionTracks,
    decode_yolo_v8,
    read_ppm,
    reset_service,
    sample_frame,
    set_service,
    try_handle,
    write_ppm,
)

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "vision"


class FakeHandler:
    def __init__(self, path, command="GET"):
        self.path = path
        self.command = command
        self.status = None
        self.body = None

    def _path(self):
        return self.path.split("?", 1)[0]

    def _json(self, code, obj):
        self.status = code
        self.body = obj


def _ensure_fixture():
    FIXTURE.mkdir(parents=True, exist_ok=True)
    manifest = {"width": 96, "height": 64, "frames": []}
    for index in range(3):
        width, height, rgb, truth = sample_frame(index)
        name = f"frame_{index:03d}.ppm"
        write_ppm(FIXTURE / name, width, height, rgb)
        manifest["frames"].append({"file": name, "objects": truth})
    (FIXTURE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


class VisionTrackTests(unittest.TestCase):
    def setUp(self):
        reset_service()
        self.sent = []
        self.fc = []

        def gimbal_command(action, body):
            self.sent.append((action, body))
            self.fc.append("fc")
            return 200, {"ok": True, "sent": True}

        self.svc = VisionTracks(
            enabled=False,
            backend="cpu",
            gimbal_command=gimbal_command,
            gimbal_status=lambda: {"present": False, "control_enabled": False},
        )
        set_service(self.svc)

    def tearDown(self):
        reset_service()

    def test_off_returns_no_boxes(self):
        handler = FakeHandler("/api/v1/vision/tracks?camera=cam3")
        self.assertTrue(try_handle(handler))
        self.assertEqual(handler.status, 200)
        self.assertIs(handler.body["enabled"], False)
        self.assertEqual(handler.body["tracks"], [])
        self.assertEqual(handler.body["reason_he"], REASON_OFF)
        self.assertIs(handler.body["flight_commands"], False)
        self.assertIs(handler.body["performance"]["measured"], False)

    def test_enabled_without_a_frame_is_empty(self):
        code, body = self.svc.configure({"enabled": True, "camera": "cam3"})
        self.assertEqual(code, 200)
        self.svc.step()
        body = self.svc.snapshot("cam3")
        self.assertEqual(body["tracks"], [])
        self.assertEqual(body["reason_he"], REASON_NO_STREAM)
        self.assertIs(body["stream"], False)
        self.assertIsNone(body["frame_seq"])
        self.assertIsNone(body["captured_at"])

    def test_detection_reports_the_frame_it_saw(self):
        width, height, rgb, _truth = sample_frame(1)
        self.svc.configure({"enabled": True, "camera": "cam3"})
        self.svc.push_frame("cam3", width, height, rgb, seq=41, captured_at=1_700_000_000_200)
        body = self.svc.step()
        self.assertEqual(body["frame_seq"], 41)
        self.assertEqual(body["captured_at"], 1700000000200)
        self.assertIn("truck", {row["class"] for row in body["tracks"]})
        self.svc.push_frame("cam3", width, height, rgb, seq=42, captured_at=1_700_000_000_280)
        body = self.svc.step()
        self.assertEqual(body["frame_seq"], 42)
        self.assertEqual(body["captured_at"], 1700000000280)

    def test_fixture_keeps_stable_ids_and_lock_cycle(self):
        manifest = _ensure_fixture()
        self.svc.configure({"enabled": True, "camera": "cam3", "gimbal_steer": False})
        ids = []
        for frame in manifest["frames"]:
            width, height, rgb = read_ppm(FIXTURE / frame["file"])
            self.svc.push_frame("cam3", width, height, rgb)
            body = self.svc.step()
            self.assertEqual(body["reason_he"], "")
            found = {row["class"]: row for row in body["tracks"]}
            self.assertIn("person", found)
            self.assertIn("car", found)
            for truth in frame["objects"]:
                row = found[truth["class"]]
                self.assertGreaterEqual(vision_tracks.iou(row["bbox"], truth["bbox"]), 0.8)
            ids.append({row["class"]: row["id"] for row in body["tracks"]})
        self.assertEqual(ids[0]["person"], ids[1]["person"])
        self.assertEqual(ids[0]["person"], ids[2]["person"])
        self.assertEqual(ids[0]["car"], ids[2]["car"])
        self.assertIn("truck", ids[1])
        self.assertEqual(ids[1]["truck"], ids[2]["truck"])
        self.assertNotEqual(ids[0]["person"], ids[0]["car"])

        person = ids[2]["person"]
        handler = FakeHandler("/api/v1/vision/lock", "POST")
        self.assertTrue(try_handle(handler, {"camera": "cam3", "id": person}))
        self.assertEqual(handler.body["lock"]["id"], person)
        self.assertEqual(handler.body["lock"]["class"], "person")
        self.assertEqual(self.sent, [])

        handler = FakeHandler("/api/v1/vision/lock", "POST")
        try_handle(handler, {"action": "next", "camera": "cam3", "sort": "class"})
        self.assertNotEqual(handler.body["lock"]["id"], person)
        self.assertIn(handler.body["lock"]["class"], {"person", "car", "truck"})

        handler = FakeHandler("/api/v1/vision/lock", "POST")
        try_handle(handler, {"action": "unlock", "camera": "cam3"})
        self.assertIsNone(handler.body["lock"])
        self.assertEqual(self.sent, [])
        self.assertEqual(self.fc, [])

    def test_other_camera_stays_off(self):
        width, height, rgb, _truth = sample_frame(0)
        self.svc.configure({"enabled": True, "camera": "cam3"})
        self.svc.push_frame("cam3", width, height, rgb)
        self.svc.step()
        other = self.svc.snapshot("cam0")
        self.assertEqual(other["tracks"], [])
        self.assertEqual(other["reason_he"], REASON_OFF)

    def test_steer_stays_blocked_when_the_gimbal_is_absent(self):
        width, height, rgb, _truth = sample_frame(2)
        self.svc.configure({"enabled": True, "camera": "cam3", "gimbal_steer": True})
        self.svc.push_frame("cam3", width, height, rgb)
        body = self.svc.step()
        self.svc.lock({"camera": "cam3", "id": body["tracks"][0]["id"]})
        steered = self.svc.step()
        self.assertIs(steered["gimbal_steer"]["enabled"], True)
        self.assertIs(steered["gimbal_steer"]["sent"], False)
        self.assertIs(steered["gimbal_steer"]["blocked"], True)
        self.assertEqual(steered["gimbal_steer"]["reason_he"], REASON_GIMBAL_ABSENT)
        self.assertIs(steered["flight_commands"], False)
        self.assertEqual(self.sent, [])
        self.assertEqual(steered["commands_sent"], 0)

    def test_steer_off_does_not_send_even_if_the_gimbal_answers(self):
        self.svc.gimbal_status = lambda: {"present": True, "control_enabled": True}
        width, height, rgb, _truth = sample_frame(0)
        self.svc.configure({"enabled": True, "camera": "cam3", "gimbal_steer": False})
        self.svc.push_frame("cam3", width, height, rgb)
        body = self.svc.step()
        self.svc.lock({"camera": "cam3", "id": body["tracks"][0]["id"]})
        steered = self.svc.step()
        self.assertEqual(steered["gimbal_steer"]["reason_he"], REASON_STEER_OFF)
        self.assertEqual(self.sent, [])

    def test_steer_sends_only_a_gimbal_rate(self):
        self.svc.gimbal_status = lambda: {"present": True, "control_enabled": True}
        width, height, rgb, _truth = sample_frame(0)
        self.svc.configure({"enabled": True, "camera": "cam3", "gimbal_steer": True})
        self.svc.push_frame("cam3", width, height, rgb)
        body = self.svc.step()
        locked = self.svc.lock({"camera": "cam3", "id": body["tracks"][0]["id"]})[1]
        self.assertEqual(len(self.sent), 1)
        action, rate = self.sent[0]
        self.assertEqual(action, "rate")
        self.assertIn("yaw", rate)
        self.assertIn("pitch", rate)
        self.assertNotIn("command", rate)
        self.assertIs(locked["flight_commands"], False)
        self.assertIs(locked["gimbal_steer"]["sent"], True)
        self.assertEqual(self.fc, ["fc"])

    def test_yolo_decode_keeps_two_classes(self):
        def row(cx, cy, w, h, index, score):
            values = [0.0] * 84
            values[0:4] = [cx, cy, w, h]
            values[4 + index] = score
            return values

        output = [
            row(320, 240, 100, 80, 0, 0.91),
            row(100, 80, 40, 30, 2, 0.77),
        ]
        dets = decode_yolo_v8(output, 640, 480, ratio=1, pad_x=0, pad_y=0)
        classes = {det["class"] for det in dets}
        self.assertEqual(classes, {"person", "car"})
        self.assertTrue(all("color_he" not in det for det in dets))

    def test_sample_film_keeps_ids_through_motion_and_a_short_gap(self):
        detector = vision_tracks.CpuBlobDetector()
        tracker = ByteTracker()
        seen = {"person": set(), "car": set(), "truck": set()}
        for index in range(16):
            width, height, rgb, _truth = sample_frame(index)
            rows = tracker.update(detector.detect(width, height, rgb))
            by_class = {}
            for row in rows:
                by_class.setdefault(row["class"], []).append(row["id"])
            self.assertEqual(len(by_class["person"]), 1)
            self.assertEqual(len(by_class["car"]), 1)
            person = next(row for row in rows if row["class"] == "person")
            car = next(row for row in rows if row["class"] == "car")
            self.assertEqual(person["color_he"], "אדום")
            self.assertEqual(car["color_he"], "ירוק")
            if index >= 1:
                truck = next(row for row in rows if row["class"] == "truck")
                self.assertEqual(truck["color_he"], "כחול")
            seen["person"].add(by_class["person"][0])
            seen["car"].add(by_class["car"][0])
            if index >= 1:
                self.assertEqual(len(by_class["truck"]), 1)
                seen["truck"].add(by_class["truck"][0])
        self.assertEqual(len(seen["person"]), 1)
        self.assertEqual(len(seen["car"]), 1)
        self.assertEqual(len(seen["truck"]), 1)
        self.assertLessEqual(tracker._next, 4)

        self.svc.configure({"enabled": True, "camera": "cam3", "gimbal_steer": False})
        body = None
        for index in range(8):
            width, height, rgb, _truth = sample_frame(index)
            self.svc.push_frame("cam3", width, height, rgb)
            body = self.svc.step()
        person = next(row for row in body["tracks"] if row["class"] == "person")
        self.assertEqual(person["color_he"], "אדום")
        car = next(row for row in body["tracks"] if row["class"] == "car")
        self.assertEqual(car["color_he"], "ירוק")
        locked = self.svc.lock({"camera": "cam3", "id": person["id"]})[1]
        lock_id = locked["lock"]["id"]
        for _gap in range(3):
            width, height, rgb, _truth = sample_frame(8)
            raw = bytearray(rgb)
            for offset in range(0, len(raw), 3):
                red, green, blue = raw[offset], raw[offset + 1], raw[offset + 2]
                if red > 160 and red > green + 40 and red > blue + 40:
                    raw[offset:offset + 3] = bytes((16, 16, 16))
            self.svc.push_frame("cam3", width, height, bytes(raw))
            gap = self.svc.step()
            self.assertEqual(gap["lock"]["id"], lock_id)
            self.assertTrue(any(row["id"] == lock_id and row["class"] == "person" for row in gap["tracks"]))
        width, height, rgb, _truth = sample_frame(9)
        self.svc.push_frame("cam3", width, height, rgb)
        back = self.svc.step()
        self.assertEqual(back["lock"]["id"], lock_id)
        self.assertTrue(any(row["id"] == lock_id and row["class"] == "person" for row in back["tracks"]))
        self.assertEqual(self.sent, [])

    def test_tracker_does_not_start_from_a_low_score(self):
        tracker = ByteTracker()
        tracks = tracker.update([{"class": "person", "confidence": 0.2, "bbox": [0, 0, 10, 10]}])
        self.assertEqual(tracks, [])
        tracks = tracker.update([{"class": "person", "confidence": 0.8, "bbox": [0, 0, 10, 10]}])
        self.assertEqual(len(tracks), 1)
        kept = tracker.update([{"class": "person", "confidence": 0.2, "bbox": [2, 0, 10, 10]}])
        self.assertEqual(kept[0]["id"], tracks[0]["id"])

    def test_source_has_no_flight_command(self):
        text = (ROOT / "vision_tracks.py").read_text(encoding="utf-8")
        self.assertNotIn("COMMAND_LONG", text)
        self.assertNotIn("MAV_CMD", text)
        self.assertNotIn("uart", text.lower())


if __name__ == "__main__":
    unittest.main()
