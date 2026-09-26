"""CAM1 stays idle until a client streams, and device identity is by name."""

from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path

import numpy as np

from cam0.cam1 import CAPTURE_FPS_MAX, JPEG_HZ, Cam1Service, load_config, reset_service, try_handle
from cam0.devices import resolve_device
from cam0.service import load_config as load_cam0


ROOT = Path(__file__).resolve().parents[1]


def _fast_frame():
    return {
        "mono8": np.zeros((24, 32), dtype=np.uint8),
        "raw_u16": np.zeros((24, 32), dtype=np.uint16),
        "width": 32,
        "height": 24,
        "real": False,
        "dropped": 0,
        "t_monotonic_ns": time.monotonic_ns(),
        "source": "synthetic",
    }


class FastSource:
    def __init__(self):
        self.reads = 0
        self.closed = False

    def read(self):
        self.reads += 1
        return _fast_frame()

    def close(self):
        self.closed = True

    def set_exposure_gain(self, *_args, **_kwargs):
        return False


class DeviceResolveTests(unittest.TestCase):
    def test_env_then_symlink_then_sysfs_then_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "video0").mkdir()
            (root / "video1").mkdir()
            (root / "video0" / "name").write_text("vi-output, ov9281 10-0060\n", encoding="utf-8")
            (root / "video1" / "name").write_text("vi-output, ov9281 9-0060\n", encoding="utf-8")
            stable = root / "airvix-cam0"
            stable.write_text("link", encoding="utf-8")
            self.assertEqual(
                resolve_device(env_value="/dev/custom", stable_path=str(stable), name_token="9-0060", fallback="/dev/video0", sysfs_root=tmp),
                "/dev/custom",
            )
            self.assertEqual(
                resolve_device(stable_path=str(stable), name_token="9-0060", fallback="/dev/video0", sysfs_root=tmp),
                str(stable),
            )
            self.assertEqual(
                resolve_device(stable_path=str(root / "missing"), name_token="9-0060", fallback="/dev/video0", sysfs_root=tmp),
                "/dev/video1",
            )
            self.assertEqual(
                resolve_device(stable_path=str(root / "missing"), name_token="10-0060", fallback="/dev/airvix-cam1", sysfs_root=tmp),
                "/dev/video0",
            )
            self.assertEqual(
                resolve_device(stable_path=str(root / "missing"), name_token="nope", fallback="/dev/video0", sysfs_root=tmp),
                "/dev/video0",
            )

    def test_cam0_default_uses_resolver_and_env_wins(self):
        calls = []

        def fake(**kwargs):
            calls.append(kwargs)
            return "/dev/from-name"

        import cam0.service as service
        original = service.resolve_device
        service.resolve_device = fake
        try:
            cfg = load_cam0(env={"VLC_CAM0_SOURCE": "v4l2"})
            self.assertEqual(cfg["device"], "/dev/from-name")
            self.assertEqual(calls[0]["stable_path"], "/dev/airvix-cam0")
            self.assertEqual(calls[0]["name_token"], "9-0060")
            self.assertEqual(calls[0]["fallback"], "/dev/video0")
            pinned = load_cam0(env={"VLC_CAM0_SOURCE": "v4l2", "VLC_CAM0_DEVICE": "/dev/video9"})
            self.assertEqual(pinned["device"], "/dev/video9")
        finally:
            service.resolve_device = original

    def test_cam1_fallback_does_not_claim_video0(self):
        cfg = load_config(env={"VLC_CAM1_SOURCE": "v4l2", "VLC_V4L_SYSFS": "/tmp/vlc-no-such-sysfs"})
        self.assertEqual(cfg["device"], "/dev/airvix-cam1")
        pinned = load_config(env={"VLC_CAM1_DEVICE": "/dev/video3", "VLC_CAM1_SOURCE": "v4l2"})
        self.assertEqual(pinned["device"], "/dev/video3")


class Cam1BudgetTests(unittest.TestCase):
    def tearDown(self):
        reset_service()

    def _service(self):
        cfg = load_config(env={"VLC_CAM1_SOURCE": "v4l2", "VLC_CAM1_DEVICE": "/dev/vlc-cam1-absent"})
        return Cam1Service(cfg)

    def test_idle_does_not_open_and_health_has_no_fps(self):
        opened = []

        class Boom:
            def __init__(self, *args, **kwargs):
                opened.append(1)
                raise AssertionError("cam1 opened while idle")

        import cam0.cam1 as cam1
        original = None
        import cam0.v4l2cap as v4l2cap
        original = v4l2cap.V4l2Source
        v4l2cap.V4l2Source = Boom
        try:
            svc = self._service()
            health = svc.health()
            status = svc.status()
            svc.settings()
            self.assertEqual(opened, [])
            self.assertFalse(health["camera_ok"])
            self.assertIsNone(health["fps"])
            self.assertEqual(health["state"], "absent")
            self.assertFalse(health["flight_commands"])
            self.assertIsNone(status["fps"])
            self.assertFalse(status["has_frame"])
            self.assertEqual(svc.clients, 0)
        finally:
            v4l2cap.V4l2Source = original

    def test_settings_do_not_start_capture_and_clamp_rates(self):
        svc = self._service()
        body = svc.apply_settings({"fps": 80, "stream": {"fps": 40}, "exposure_us": 3000})
        self.assertLessEqual(body["fps"], CAPTURE_FPS_MAX)
        self.assertLessEqual(body["stream"]["fps"], JPEG_HZ)
        self.assertEqual(body["exposure_us"], 3000)
        self.assertFalse(body["flight_commands"])
        self.assertIsNone(svc._thread)

    def test_capture_runs_only_while_held_and_stays_under_the_cap(self):
        svc = self._service()
        fast = FastSource()
        svc._open_source = lambda: fast
        svc.config["source"] = "synthetic"
        svc.acquire()
        time.sleep(0.55)
        reads_while = fast.reads
        jpegs_while = svc.jpeg_count
        self.assertGreater(reads_while, 0)
        self.assertLessEqual(reads_while, 22)
        self.assertGreater(jpegs_while, 0)
        self.assertLessEqual(jpegs_while, 12)
        self.assertTrue(svc.status()["camera_ok"])
        self.assertIsNotNone(svc.frame_jpeg())
        svc.release()
        self.assertEqual(svc.clients, 0)
        self.assertTrue(fast.closed)
        self.assertFalse(svc.health()["camera_ok"])
        self.assertIsNone(svc.health()["fps"])

    def test_health_route_does_not_acquire(self):
        reset_service()
        os.environ["VLC_CAM1_SOURCE"] = "v4l2"
        os.environ["VLC_CAM1_DEVICE"] = "/dev/vlc-cam1-absent"
        try:
            class Handler:
                path = "/api/v1/cam1/health"
                command = "GET"

                def _json(self, code, obj):
                    self.code = code
                    self.obj = obj

            handler = Handler()
            self.assertTrue(try_handle(handler))
            self.assertEqual(handler.code, 200)
            self.assertFalse(handler.obj["camera_ok"])
            self.assertIsNone(handler.obj["fps"])
            self.assertFalse(handler.obj["flight_commands"])
            from cam0.cam1 import get_service
            self.assertEqual(get_service().clients, 0)
            self.assertIsNone(get_service()._thread)
        finally:
            os.environ.pop("VLC_CAM1_SOURCE", None)
            os.environ.pop("VLC_CAM1_DEVICE", None)
            reset_service()


class InstallUdevTests(unittest.TestCase):
    def test_rule_and_overlay_exist_and_install_skips_extlinux(self):
        script = (ROOT / "install.sh").read_text(encoding="utf-8")
        self.assertNotIn("extlinux", script.lower())
        self.assertIn("99-airvix-cameras.rules", script)
        self.assertIn("cmp -s", script)
        rules = (ROOT / "ov9281" / "99-airvix-cameras.rules").read_text(encoding="utf-8")
        self.assertIn('ov9281 9-0060', rules)
        self.assertIn('ov9281 10-0060', rules)
        dts = (ROOT / "ov9281" / "tegra234-p3767-camera-p3768-ov9281-dual.dts").read_text(encoding="utf-8")
        self.assertIn("OV9281_CAM1_PORT_INDEX", dts)
        import subprocess
        proc = subprocess.run(["bash", str(ROOT / "install.sh"), "--dry-run"], capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('"udev":false', proc.stdout)
