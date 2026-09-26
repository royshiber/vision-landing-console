"""CAM1 stays idle until a client streams, and device identity is by name."""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

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
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            health = svc.health()
            if fast.closed and not health["camera_ok"] and health["fps"] is None:
                break
            time.sleep(0.02)
        self.assertTrue(fast.closed)
        self.assertFalse(svc.health()["camera_ok"])
        self.assertIsNone(svc.health()["fps"])

    def test_gain_only_keeps_capture_fps(self):
        svc = self._service()
        self.assertEqual(svc.config["fps"], 30)
        body = svc.apply_settings({"gain": 40, "stream": {"fps": 8}})
        self.assertEqual(body["fps"], 30)
        self.assertEqual(body["gain"], 40)
        self.assertEqual(body["stream"]["fps"], 8)
        self.assertEqual(svc.status()["capture_fps"], 30)
        self.assertIsNone(svc._thread)

    def test_failed_open_retries_without_a_new_acquire(self):
        svc = self._service()
        fast = FastSource()
        calls = {"n": 0}

        def open_source():
            calls["n"] += 1
            if calls["n"] == 1:
                return None
            return fast

        svc._open_source = open_source
        svc.acquire()
        try:
            self.assertEqual(svc.clients, 1)
            self.assertTrue(svc.wait_camera(3), "a failed open must retry while the client holds")
            self.assertGreaterEqual(calls["n"], 2)
        finally:
            svc.release()

    def test_stop_start_while_thread_alive_does_not_fail_wait(self):
        svc = self._service()
        fast = FastSource()
        hold = threading.Event()

        def read():
            fast.reads += 1
            if fast.reads > 1:
                hold.wait(3)
            return _fast_frame()

        fast.read = read
        svc._open_source = lambda: fast
        svc.config["source"] = "synthetic"
        svc.acquire()
        self.assertTrue(svc.wait_camera(2))
        self.assertTrue(svc._thread.is_alive())
        with svc._lock:
            svc.clients = 0
            svc._stop.set()
        svc.acquire()
        try:
            self.assertTrue(svc._thread.is_alive())
            self.assertFalse(svc._stop.is_set())
            self.assertTrue(svc.wait_camera(2), "stop/start must not 404 the next stream")
        finally:
            hold.set()
            svc.release()

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


class Cam1IdleHonestyTests(unittest.TestCase):
    def tearDown(self):
        reset_service()
        os.environ.pop("VLC_CAM1_DEVICE", None)
        os.environ.pop("VLC_CAM1_SOURCE", None)
        os.environ.pop("VLC_V4L_SYSFS", None)

    def test_present_device_idles_and_does_not_say_auto(self):
        with tempfile.NamedTemporaryFile() as fh:
            cfg = load_config(env={"VLC_CAM1_SOURCE": "v4l2", "VLC_CAM1_DEVICE": fh.name})
            svc = Cam1Service(cfg)
            health = svc.health()
            self.assertEqual(health["state"], "idle")
            self.assertIsNone(health["error"])
            self.assertFalse(health["camera_ok"])
            self.assertIsNone(health["fps"])
            self.assertEqual(health["requested_device"], fh.name)
            self.assertEqual(health["resolved_device"], fh.name)
            self.assertNotEqual(health["requested_device"], "auto")
            self.assertEqual(svc.clients, 0)
            self.assertIsNone(svc._thread)

    def test_missing_device_is_device_absent_with_the_request(self):
        cfg = load_config(env={"VLC_CAM1_SOURCE": "v4l2", "VLC_CAM1_DEVICE": "/dev/vlc-cam1-absent"})
        svc = Cam1Service(cfg)
        health = svc.health()
        self.assertEqual(health["state"], "absent")
        self.assertEqual(health["error"], "device_absent")
        self.assertIsNone(health["resolved_device"])
        self.assertEqual(health["requested_device"], "/dev/vlc-cam1-absent")

    def test_absent_frame_route_falls_through_to_ingest(self):
        os.environ["VLC_CAM1_SOURCE"] = "v4l2"
        os.environ["VLC_CAM1_DEVICE"] = "/dev/vlc-cam1-absent"
        reset_service()

        class Handler:
            path = "/api/v1/cameras/cam1/frame"
            command = "GET"

            def _json(self, code, obj):
                raise AssertionError("absent cam1 must not claim the ingest frame")

        self.assertFalse(try_handle(Handler()))

    def test_idle_present_frame_says_no_signal(self):
        with tempfile.NamedTemporaryFile() as fh:
            os.environ["VLC_CAM1_SOURCE"] = "v4l2"
            os.environ["VLC_CAM1_DEVICE"] = fh.name
            reset_service()

            class Handler:
                path = "/api/v1/cameras/cam1/frame.jpg"
                command = "GET"

                def _json(self, code, obj):
                    self.code = code
                    self.obj = obj

            handler = Handler()
            self.assertTrue(try_handle(handler))
            self.assertEqual(handler.code, 404)
            self.assertEqual(handler.obj["note"], "אין אות")
            self.assertEqual(handler.obj["reason"], "no_frame")

    def test_idle_reresolve_picks_up_the_stable_symlink(self):
        import cam0.cam1 as cam1
        svc = Cam1Service(load_config(env={"VLC_CAM1_SOURCE": "v4l2", "VLC_V4L_SYSFS": "/tmp/vlc-no-such-sysfs"}))
        self.assertEqual(svc.health()["state"], "absent")
        self.assertEqual(svc.health()["requested_device"], "/dev/airvix-cam1")
        self.assertIsNone(svc.health()["resolved_device"])
        with tempfile.NamedTemporaryFile() as fh:
            original = cam1.resolve_device

            def fake(**kwargs):
                self.assertEqual(kwargs["stable_path"], "/dev/airvix-cam1")
                self.assertEqual(kwargs["name_token"], "10-0060")
                return fh.name

            cam1.resolve_device = fake
            try:
                health = svc.health()
            finally:
                cam1.resolve_device = original
            self.assertEqual(health["state"], "idle")
            self.assertIsNone(health["error"])
            self.assertEqual(health["resolved_device"], fh.name)
            self.assertEqual(health["requested_device"], "/dev/airvix-cam1")
            self.assertNotEqual(health["requested_device"], "auto")

    def test_health_slot_replaces_an_auto_absent_ingest_row(self):
        import companion_agent
        with tempfile.NamedTemporaryFile() as fh:
            os.environ["VLC_CAM1_SOURCE"] = "v4l2"
            os.environ["VLC_CAM1_DEVICE"] = fh.name
            reset_service()
            slot = companion_agent._cam1_slot()
            merged = companion_agent._apply_ov9281({
                "cam1": {
                    "state": "absent",
                    "error": "device_absent",
                    "requested_device": "auto",
                    "resolved_device": None,
                    "camera_ok": False,
                },
                "cam2": {"id": "cam2"},
            })
            self.assertEqual(slot["state"], "idle")
            self.assertIsNone(slot["error"])
            self.assertEqual(slot["resolved_device"], fh.name)
            self.assertNotEqual(slot["requested_device"], "auto")
            self.assertEqual(merged["cam1"]["state"], "idle")
            self.assertEqual(merged["cam1"]["resolved_device"], fh.name)
            self.assertNotEqual(merged["cam1"].get("requested_device"), "auto")
            self.assertEqual(merged["cam2"]["id"], "cam2")


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
