"""Saved field of view replaces a hardcoded focal length."""

import math
import unittest

from cam0.fov import intrinsics_from_fov, parse_fov
from cam0.service import Cam0Service, load_config


class FovTests(unittest.TestCase):
    def test_range_and_defaults(self):
        self.assertIsNone(parse_fov(19))
        self.assertIsNone(parse_fov(181))
        self.assertEqual(parse_fov(20), 20.0)
        self.assertEqual(parse_fov(180), 180.0)
        cfg = load_config(env={"VLC_CAM0_SOURCE": "synthetic"})
        self.assertEqual(cfg["fov_deg"], 120.0)
        svc = Cam0Service(cfg)
        self.assertEqual(svc.settings()["fov_deg"], 120.0)
        applied = svc.apply_settings({"fov_deg": 90})
        self.assertEqual(applied["fov_deg"], 90.0)
        kept = svc.apply_settings({"fov_deg": 10})
        self.assertEqual(kept["fov_deg"], 90.0)

    def test_nominal_intrinsics_follow_fov_not_800(self):
        k = intrinsics_from_fov(1280, 800, 120)
        expected = 640.0 / math.tan(math.radians(60))
        self.assertAlmostEqual(k["fx"], expected, places=6)
        self.assertAlmostEqual(k["fy"], expected, places=6)
        self.assertNotAlmostEqual(k["fx"], 800.0, places=3)
        wide = intrinsics_from_fov(1280, 800, 79)
        self.assertGreater(wide["fx"], k["fx"])
        self.assertTrue(math.isfinite(intrinsics_from_fov(1280, 800, 180)["fx"]))


if __name__ == "__main__":
    unittest.main()
