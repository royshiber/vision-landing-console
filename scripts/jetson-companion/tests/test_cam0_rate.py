# -*- coding: utf-8 -*-
"""Cam0 capture rate, AE cap, and lazy encode. No camera."""

from __future__ import annotations

import errno
import sys
import threading
import time
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cam0.ae import AeConfig, AeLimits, AutoExposure  # noqa: E402
from cam0.jpegenc import JpegWorker, cv2_module, encode_gray_jpeg, jpeg_encoder_name, last_jpeg_encoder  # noqa: E402
from cam0.rawfmt import mean_and_percentile, pack_code10, stats_raw, to_mono8  # noqa: E402
from cam0.service import Cam0Service, load_config  # noqa: E402
from cam0.synthetic import SyntheticSource  # noqa: E402
from cam0.v4l2cap import (  # noqa: E402
    V4l2Source,
    device_busy_message,
    exposure_control_unit,
    exposure_driver_value,
    gain_driver_value,
)


class AeCapTests(unittest.TestCase):
    def test_starts_short_at_unity_gain(self):
        ae = AutoExposure()
        self.assertEqual(ae.state.exposure_us, 2000)
        self.assertEqual(ae.state.gain, 16)

    def test_one_dark_step_raises_gain_and_holds_exposure(self):
        ae = AutoExposure()
        ae.update(0.25, 0.25, fps=60)
        self.assertEqual(ae.state.exposure_us, 2000)
        self.assertGreater(ae.state.gain, 16)
        self.assertLessEqual(ae.state.exposure_us, 4000)

    def test_dark_scene_stops_at_prefer_and_frame_time(self):
        ae = AutoExposure()
        for _ in range(40):
            ae.update(0.05, 0.05, fps=60)
            self.assertLessEqual(ae.state.exposure_us, 4000)
            self.assertLessEqual(ae.state.exposure_us, int(1_000_000 / 60))
        self.assertEqual(ae.state.gain, 256)
        self.assertEqual(ae.state.exposure_us, 4000)
        self.assertNotEqual(ae.state.exposure_us, 100000)

    def test_frame_time_caps_exposure_when_prefer_is_long(self):
        lim = AeLimits(prefer_exposure_us_max=100000, flicker_quantum_us=0)
        ae = AutoExposure(AeConfig(limits=lim), exposure_us=2000, gain=256)
        for _ in range(30):
            ae.update(0.05, 0.05, fps=30)
        self.assertLessEqual(ae.state.exposure_us, int(1_000_000 / 30))
        self.assertGreater(ae.state.exposure_us, 4000)

    def test_manual_is_not_capped_to_prefer(self):
        ae = AutoExposure()
        ae.set_manual(1500, 48)
        self.assertEqual(ae.state.exposure_us, 1500)
        self.assertEqual(ae.state.gain, 48)
        self.assertTrue(ae.state.manual)


class DriverUnitTests(unittest.TestCase):
    def test_queryctrl_range_picks_lines_or_microseconds(self):
        self.assertEqual(exposure_control_unit(1, 1120), "lines")
        self.assertEqual(exposure_control_unit(1, 100000), "us")
        self.assertEqual(exposure_driver_value(2000, "lines", 1, 1120, fps=60), 134)
        self.assertEqual(exposure_driver_value(2000, "us", 1, 100000, fps=60), 2000)
        self.assertEqual(gain_driver_value(16, 1, 16), 1)
        self.assertEqual(gain_driver_value(256, 16, 256), 256)

    def test_ioctl_only_when_the_driver_value_changes(self):
        src = V4l2Source()
        self.assertFalse(src.set_exposure_gain(2000, 16, fps=60))
        self.assertIsNone(src._applied_exposure)
        src.fd = 3
        src._ctrls = {
            "exposure": {"id": 1, "minimum": 1, "maximum": 100000, "step": 1, "unit": "us"},
            "gain": {"id": 2, "minimum": 16, "maximum": 256, "step": 1},
        }
        calls = []

        def record(name, value):
            calls.append((name, value))
            return True

        src._set_named = record
        self.assertTrue(src.set_exposure_gain(2000, 16, fps=60))
        self.assertEqual(calls, [("exposure", 2000), ("gain", 16)])
        calls.clear()
        self.assertFalse(src.set_exposure_gain(2000, 16, fps=60))
        self.assertEqual(calls, [])
        self.assertTrue(src.set_exposure_gain(2000, 32, fps=60))
        self.assertEqual(calls, [("exposure", 2000), ("gain", 32)])
        self.assertEqual(src.exposure_driver, 2000)
        self.assertEqual(src.exposure_unit, "us")
        self.assertEqual(src.gain_driver, 32)


class EncodeOffCaptureTests(unittest.TestCase):
    def test_png_is_lazy_and_jpeg_is_off_thread(self):
        import cam0.service as svc

        calls = []

        def wrapped(raw):
            calls.append(raw.shape)
            return b"png"

        previous = svc.encode_png16
        svc.encode_png16 = wrapped
        caller = threading.get_ident()
        seen = []

        def encode(gray, quality=70, max_width=None):
            seen.append(threading.get_ident())
            return b"jpeg"

        service = Cam0Service(load_config(env={"VLC_CAM0_SOURCE": "synthetic"}))
        service._encoder = JpegWorker(encode=encode)
        service._encoder.start()
        service.source = SyntheticSource(width=32, height=24, fps=200)
        published = {}

        class _Bus:
            def publish(self, mono, meta, code10=None):
                published["code10"] = code10

        service.bus = _Bus()
        try:
            frame = service.source.read()
            service._publish(frame)
            self.assertEqual(calls, [])
            self.assertIsNone(published["code10"])
            self.assertIsNone(service.snapshot_png)
            self.assertEqual(service.snapshot_bytes(), b"png")
            self.assertEqual(len(calls), 1)
            deadline = time.monotonic() + 1.0
            while service._encoder.latest() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(service._encoder.latest(), b"jpeg")
            self.assertTrue(seen)
            self.assertNotEqual(seen[0], caller)
            stages = service.status()["stages_ms"]
            self.assertIn("stats", stages)
            self.assertIn("publish", stages)
        finally:
            svc.encode_png16 = previous
            service._encoder.stop()

    def test_stale_frame_clears_fps(self):
        service = Cam0Service(load_config(env={"VLC_CAM0_SOURCE": "synthetic"}))
        service.state = "streaming"
        service.camera_ok = True
        service.fps = 30.0
        service.latest_meta = {
            "t_monotonic_ns": time.monotonic_ns() - 2_000_000_000,
            "real": True,
            "source": "v4l2",
            "index": 3,
        }
        st = service.status()
        self.assertFalse(st["camera_ok"])
        self.assertIsNone(st["fps"])
        health = service.health()
        self.assertFalse(health["camera_ok"])
        self.assertIsNone(health["fps"])
        service.latest_meta["t_monotonic_ns"] = time.monotonic_ns()
        fresh = service.status()
        self.assertTrue(fresh["camera_ok"])
        self.assertEqual(fresh["fps"], 30.0)

    def test_flat_field_stats_match_when_subsampled(self):
        code = np.full((800, 1280), 430, dtype=np.uint16)
        mean, pct = mean_and_percentile(code, 90)
        self.assertAlmostEqual(mean, 430 / 1023, places=4)
        self.assertAlmostEqual(pct, 430 / 1023, places=4)
        got, pct2 = stats_raw(pack_code10(code), 90, step=16)
        self.assertAlmostEqual(got, mean, places=4)
        self.assertAlmostEqual(pct2, pct, places=4)

    def test_mono8_is_the_high_byte(self):
        raw = np.array([[0xAB00]], dtype=np.uint16)
        self.assertEqual(int(to_mono8(raw)[0, 0]), 0xAB)

    def test_busy_names_the_companion_service(self):
        msg = device_busy_message(OSError(errno.EBUSY, "Device or resource busy"))
        self.assertIn("airvix-companion", msg)
        self.assertIn("/dev/video0", msg)
        self.assertIsNone(device_busy_message(OSError(errno.EINVAL, "Invalid argument")))


class Cv2EncodeTests(unittest.TestCase):
    def setUp(self):
        import cam0.jpegenc as enc
        self.enc = enc
        self.saved = dict(enc._cv2_state)

    def tearDown(self):
        self.enc._cv2_state.clear()
        self.enc._cv2_state.update(self.saved)

    def test_numpy_fallback_when_cv2_is_absent(self):
        self.enc._cv2_state["tried"] = True
        self.enc._cv2_state["mod"] = None
        gray = np.arange(64, dtype=np.uint8).reshape(8, 8)
        blob = encode_gray_jpeg(gray, quality=70)
        self.assertTrue(blob.startswith(b"\xff\xd8"))
        self.assertTrue(blob.endswith(b"\xff\xd9"))
        self.assertEqual(jpeg_encoder_name(), "numpy")
        self.assertEqual(last_jpeg_encoder(), "numpy")
        from cam0.png16 import encode_png16
        raw = np.arange(16, dtype=np.uint16).reshape(4, 4)
        png = encode_png16(raw)
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_cv2_path_encodes_jpeg_and_png16(self):
        calls = []

        class FakeCv:
            IMWRITE_JPEG_QUALITY = 1
            IMWRITE_PNG_COMPRESSION = 16

            def imencode(self, ext, img, params):
                calls.append((ext, str(img.dtype), tuple(img.shape), list(params)))
                return True, np.array([0xFF, 0xD8, 0x00, 0xD9], dtype=np.uint8)

        self.enc._cv2_state["tried"] = True
        self.enc._cv2_state["mod"] = FakeCv()
        gray = np.arange(64, dtype=np.uint8).reshape(8, 8)
        blob = encode_gray_jpeg(gray, quality=55)
        self.assertEqual(blob, b"\xff\xd8\x00\xd9")
        self.assertEqual(jpeg_encoder_name(), "cv2")
        self.assertEqual(last_jpeg_encoder(), "cv2")
        self.assertEqual(calls[0][0], ".jpg")
        self.assertEqual(calls[0][1], "uint8")
        self.assertIn(55, calls[0][3])
        from cam0.png16 import encode_png16
        raw = np.arange(16, dtype=np.uint16).reshape(4, 4)
        png = encode_png16(raw)
        self.assertEqual(png, b"\xff\xd8\x00\xd9")
        self.assertEqual(calls[1][0], ".png")
        self.assertEqual(calls[1][1], "uint16")

    def test_cv2_import_is_cached(self):
        import builtins
        self.enc._cv2_state["tried"] = False
        self.enc._cv2_state["mod"] = None
        calls = []
        orig = builtins.__import__

        def guarded(name, *args, **kwargs):
            if name == "cv2":
                calls.append(name)
                raise ImportError("cv2 absent")
            return orig(name, *args, **kwargs)

        builtins.__import__ = guarded
        try:
            self.assertIsNone(cv2_module())
            self.assertIsNone(cv2_module())
            self.assertEqual(calls, ["cv2"])
            self.assertEqual(jpeg_encoder_name(), "numpy")
        finally:
            builtins.__import__ = orig

    def test_marker_detect_is_capped_at_15hz(self):
        import cam0.marker as marker
        seen = []
        orig = marker.detect

        def wrapped(mono, *args, **kwargs):
            seen.append(tuple(np.asarray(mono).shape))
            return []

        marker.detect = wrapped
        try:
            mod = marker.MarkerModule()
            view = type("View", (), {"mono8": np.zeros((32, 48), np.uint8), "index": 1})()
            first = mod.on_frame(view)
            second = mod.on_frame(view)
            self.assertEqual(len(seen), 1)
            self.assertEqual(first["detections"], [])
            self.assertIsNone(second)
            self.assertLessEqual(mod.min_interval_s, 1.0 / 15.0 + 1e-9)
            mod._next = 0.0
            third = mod.on_frame(view)
            self.assertEqual(len(seen), 2)
            self.assertEqual(third["frame_index"], 1)
        finally:
            marker.detect = orig


if __name__ == "__main__":
    unittest.main()
