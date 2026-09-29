"""Camera settings are applied, then judged by the device read-back."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cam0.cam1 import Cam1Service, load_config as load_cam1
from cam0.controls import commit_controls
from cam0.service import Cam0Service, load_config as load_cam0


class MockCamera:
    def __init__(self, fail=()):
        self.exposure_us = 2000
        self.gain = 16
        self.width = 1280
        self.height = 800
        self.fps = 30
        self.ae_enabled = True
        self.fail = set(fail)
        self.calls = []

    def set_auto_exposure(self, enabled):
        self.calls.append(("ae", bool(enabled)))
        if "ae" in self.fail:
            return False
        self.ae_enabled = bool(enabled)
        return True

    def set_exposure_gain(self, exposure_us, gain, fps=None):
        del fps
        self.calls.append(("exp", int(exposure_us), int(gain)))
        if "exposure" in self.fail:
            return False
        self.exposure_us = int(exposure_us)
        self.gain = int(gain)
        return True

    def configure(self, width, height, fps):
        self.calls.append(("fmt", int(width), int(height), int(fps)))
        if "fps" in self.fail:
            return False
        self.width = int(width)
        self.height = int(height)
        self.fps = int(fps)
        return True

    def read_controls(self):
        return {
            "exposure_us": self.exposure_us,
            "gain": self.gain,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "ae_enabled": self.ae_enabled,
        }


class CommitTests(unittest.TestCase):
    def test_manual_write_matches_readback(self):
        cam = MockCamera()
        report = commit_controls(cam, {
            "ae_enabled": False,
            "exposure_us": 2500,
            "gain": 27,
            "width": 1280,
            "height": 720,
            "fps": 20,
            "fov_deg": 90,
        })
        self.assertEqual(report["exposure_us"]["actual"], 2500)
        self.assertTrue(report["exposure_us"]["applied"])
        self.assertEqual(report["gain"]["actual"], 27)
        self.assertTrue(report["gain"]["applied"])
        self.assertTrue(report["ae"]["applied"])
        self.assertFalse(report["ae"]["actual"])
        self.assertEqual(report["width"]["actual"], 1280)
        self.assertEqual(report["height"]["actual"], 720)
        self.assertTrue(report["fps"]["applied"])
        self.assertEqual(report["fps"]["actual"], 20)
        self.assertTrue(report["fov_deg"]["metadata_only"])
        self.assertTrue(report["fov_deg"]["applied"])
        self.assertEqual(cam.exposure_us, 2500)
        self.assertEqual(cam.gain, 27)

    def test_auto_exposure_does_not_write_manual_values(self):
        cam = MockCamera()
        report = commit_controls(cam, {
            "ae_enabled": True,
            "exposure_us": 9000,
            "gain": 80,
        })
        self.assertTrue(report["exposure_us"]["skipped"])
        self.assertFalse(report["exposure_us"]["applied"])
        self.assertTrue(report["gain"]["skipped"])
        self.assertEqual(cam.exposure_us, 2000)
        self.assertEqual(cam.gain, 16)
        self.assertTrue(cam.ae_enabled)
        self.assertFalse(any(call[0] == "exp" for call in cam.calls))

    def test_mismatch_is_not_applied(self):
        cam = MockCamera(fail={"exposure"})
        report = commit_controls(cam, {"ae_enabled": False, "exposure_us": 4000, "gain": 32})
        self.assertFalse(report["exposure_us"]["applied"])
        self.assertEqual(report["exposure_us"]["actual"], 2000)
        self.assertEqual(report["gain"]["actual"], 16)
        self.assertFalse(report["gain"]["applied"])

    def test_missing_camera_is_not_applied(self):
        report = commit_controls(None, {"ae_enabled": False, "exposure_us": 2000, "gain": 16, "fps": 30})
        self.assertFalse(report["exposure_us"]["applied"])
        self.assertIsNone(report["exposure_us"]["actual"])
        self.assertFalse(report["fps"]["applied"])


class ServiceReadbackTests(unittest.TestCase):
    def test_cam0_and_cam1_report_the_same_readback(self):
        for name, svc, attach in (
            ("cam0", Cam0Service(load_cam0(env={"VLC_CAM0_SOURCE": "synthetic"})), "source"),
            ("cam1", Cam1Service(load_cam1(env={"VLC_CAM1_SOURCE": "synthetic"})), "_backend"),
        ):
            cam = MockCamera()
            setattr(svc, attach, cam)
            body = svc.apply_settings({
                "ae": {"enabled": False},
                "manual": True,
                "exposure_us": 1800,
                "gain": 40,
                "width": 1280,
                "height": 800,
                "fps": 15,
                "fov_deg": 79,
            })
            controls = body["controls"]
            self.assertTrue(controls["exposure_us"]["applied"], name)
            self.assertEqual(controls["exposure_us"]["actual"], 1800, name)
            self.assertEqual(controls["gain"]["actual"], 40, name)
            self.assertTrue(controls["fps"]["applied"], name)
            self.assertTrue(controls["fov_deg"]["metadata_only"], name)
            self.assertEqual(cam.gain, 40, name)
            held = svc.apply_settings({"ae": {"enabled": True}, "exposure_us": 9000, "gain": 200})
            self.assertTrue(held["controls"]["exposure_us"]["skipped"], name)
            self.assertEqual(cam.exposure_us, 1800, name)
            self.assertFalse(body["flight_commands"], name)


if __name__ == "__main__":
    unittest.main()
