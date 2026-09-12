#!/usr/bin/env python3
"""Observe-only dual-camera ingest for companion_agent 2.3.4.

CAM1 default role: forward (קדמית). CAM2 default role: down (מטה).
Never invent camera_ok or frames. Absent device → camera_ok false, no JPEG.
Dry-run never claims a real camera (source is absent or synthetic).
No ARM / LAND / FC writes. No optical estimator. No runway detect.

Env:
  VLC_CAM1_DEVICE / VLC_CAM2_DEVICE   path, index, or csi:N  (default /dev/video0, /dev/video1)
  VLC_CAM1_ROLE / VLC_CAM2_ROLE       forward|down
  VLC_CAMERA_DRY_RUN                  0|1|absent|synthetic
  VLC_CAMERA_DRY_RUN_MODE             absent|synthetic  (used when DRY_RUN=1)
  VLC_CAMERA_WIDTH / VLC_CAMERA_HEIGHT / VLC_CAMERA_FPS
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path

CAM_IDS = ("cam1", "cam2")
DEFAULT_DEVICES = {"cam1": "/dev/video0", "cam2": "/dev/video1"}
DEFAULT_ROLES = {"cam1": "forward", "cam2": "down"}
NAV_ROLES = {"forward": "vio_forward", "down": "optical_flow_down"}
# 1x1 gray JPEG — synthetic preview only. Never used as proof of a real sensor.
SYNTHETIC_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000"
    "ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c"
    "20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432"
    "ffc00011080001000103012200021101031101"
    "ffc4001f0000010501010101010100000000000000000102030405060708090a0b"
    "ffc400b5100002010303020403050504040000017d01020300041105122131410613516107"
    "227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a343536"
    "3738393a434445464748494a535455565758595a636465666768696a737475767778797a83"
    "8485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4"
    "c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa"
    "ffda000c03010002110311003f00f9fe8a28af3fffd9"
)


def _env_str(name, default=""):
    return str(os.environ.get(name, default) or default).strip()


def _env_int(name, default):
    raw = _env_str(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def parse_dry_run(env=None):
    """Return None (hardware path), 'absent', or 'synthetic'."""
    src = env if env is not None else os.environ
    raw = str(src.get("VLC_CAMERA_DRY_RUN", "") or "").strip().lower()
    mode = str(src.get("VLC_CAMERA_DRY_RUN_MODE", "") or "").strip().lower()
    if raw in {"synthetic", "syn", "frames"}:
        return "synthetic"
    if raw in {"absent"}:
        return "absent"
    if raw in {"1", "true", "yes", "on"}:
        if mode == "synthetic":
            return "synthetic"
        return "absent"
    if raw in {"0", "false", "no", "off", ""}:
        if mode in {"synthetic", "absent"}:
            return mode
        return None
    return None


def normalize_role(value, fallback):
    key = str(value or "").strip().lower()
    if key in {"forward", "front", "קדמית", "cam1"}:
        return "forward"
    if key in {"down", "nadir", "מטה", "cam2"}:
        return "down"
    return fallback


def parse_device_spec(raw):
    text = str(raw or "").strip()
    if not text:
        return {"kind": "empty", "raw": "", "path": None, "index": None}
    if text.lower().startswith("csi:"):
        rest = text.split(":", 1)[1]
        try:
            return {"kind": "csi", "raw": text, "path": None, "index": int(rest)}
        except ValueError:
            return {"kind": "csi", "raw": text, "path": None, "index": None}
    if text.isdigit():
        return {"kind": "index", "raw": text, "path": None, "index": int(text)}
    return {"kind": "path", "raw": text, "path": text, "index": None}


def device_node_present(spec):
    if spec.get("kind") == "path" and spec.get("path"):
        return Path(spec["path"]).exists()
    if spec.get("kind") == "index" and spec.get("index") is not None:
        return Path(f"/dev/video{spec['index']}").exists()
    if spec.get("kind") == "csi":
        return False
    return False


def _empty_cam(cam_id, role, *, dry_run, error, source):
    return {
        "id": cam_id,
        "role": role,
        "nav_role": NAV_ROLES.get(role, "landing_vision"),
        "shared_with": "landing_vision",
        "present": False,
        "camera_ok": False,
        "fps": None,
        "frame_count": None,
        "last_frame_age_ms": None,
        "error": error,
        "source": source,
        "dry_run": bool(dry_run),
        "real": False,
        "device": None,
    }


class _CameraSlot:
    def __init__(self, cam_id, role, spec, dry_run):
        self.cam_id = cam_id
        self.role = role
        self.spec = spec
        self.dry_run = dry_run
        self.lock = threading.Lock()
        self.present = False
        self.camera_ok = False
        self.error = "device_absent"
        self.source = "absent"
        self.frame_jpeg = None
        self.frame_count = 0
        self.last_frame_mono = None
        self.intervals = []
        self.stop_event = threading.Event()
        self.thread = None

    def snapshot(self, now=None):
        now = time.monotonic() if now is None else now
        with self.lock:
            age = None
            fps = None
            if self.last_frame_mono is not None:
                age = max(0, int(round((now - self.last_frame_mono) * 1000)))
            if len(self.intervals) >= 1:
                mean = sum(self.intervals) / len(self.intervals)
                if mean > 0:
                    fps = round(1.0 / mean, 2)
            count = self.frame_count if self.frame_count > 0 else None
            return {
                "id": self.cam_id,
                "role": self.role,
                "nav_role": NAV_ROLES.get(self.role, "landing_vision"),
                "shared_with": "landing_vision",
                "present": bool(self.present),
                "camera_ok": bool(self.camera_ok),
                "fps": fps,
                "frame_count": count,
                "last_frame_age_ms": age,
                "error": None if self.camera_ok else self.error,
                "source": self.source,
                "dry_run": bool(self.dry_run),
                "real": self.source == "real" and self.camera_ok and not self.dry_run,
                "device": self.spec.get("raw") or None,
                "has_frame": self.frame_jpeg is not None,
            }

    def latest_jpeg(self):
        with self.lock:
            return self.frame_jpeg

    def _note_frame(self, jpeg, source):
        now = time.monotonic()
        with self.lock:
            if self.last_frame_mono is not None:
                self.intervals.append(now - self.last_frame_mono)
                self.intervals = self.intervals[-30:]
            self.last_frame_mono = now
            self.frame_count += 1
            self.frame_jpeg = jpeg
            self.camera_ok = True
            self.present = True
            self.error = None
            self.source = source

    def mark_absent(self, error="device_absent", present=False):
        with self.lock:
            self.present = bool(present)
            self.camera_ok = False
            self.error = error
            self.source = "absent"
            self.frame_jpeg = None
            self.frame_count = 0
            self.last_frame_mono = None
            self.intervals = []

    def start_synthetic(self, fps):
        self.present = True
        self.source = "synthetic"
        self.error = None
        period = 1.0 / max(1.0, float(fps))

        def loop():
            while not self.stop_event.wait(period):
                self._note_frame(SYNTHETIC_JPEG, "synthetic")

        self.thread = threading.Thread(target=loop, name=f"cam-{self.cam_id}-syn", daemon=True)
        self.thread.start()
        self._note_frame(SYNTHETIC_JPEG, "synthetic")

    def start_hardware(self, width, height, fps):
        spec = self.spec
        if spec.get("kind") == "empty":
            self.mark_absent("device_absent", present=False)
            return
        node_ok = device_node_present(spec)
        if not node_ok:
            self.mark_absent("device_absent", present=False)
            return
        self.present = True
        try:
            import cv2  # optional; Jetson install later
        except ImportError:
            self.mark_absent("opencv_unavailable", present=True)
            return
        cap = None
        try:
            if spec.get("kind") == "path":
                cap = cv2.VideoCapture(spec["path"])
            else:
                cap = cv2.VideoCapture(int(spec["index"]))
            if cap is not None:
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
                cap.set(cv2.CAP_PROP_FPS, fps)
            if cap is None or not cap.isOpened():
                self.mark_absent("open_failed", present=True)
                if cap is not None:
                    cap.release()
                return
        except Exception:
            self.mark_absent("open_failed", present=True)
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
            return

        period = 1.0 / max(1.0, float(fps))

        def loop():
            try:
                while not self.stop_event.is_set():
                    ok, frame = cap.read()
                    if not ok or frame is None:
                        with self.lock:
                            self.camera_ok = False
                            self.error = "read_failed"
                            self.source = "absent"
                        self.stop_event.wait(0.2)
                        continue
                    ok_jpg, buf = cv2.imencode(".jpg", frame)
                    if ok_jpg:
                        self._note_frame(buf.tobytes(), "real")
                    self.stop_event.wait(period)
            finally:
                try:
                    cap.release()
                except Exception:
                    pass

        self.thread = threading.Thread(target=loop, name=f"cam-{self.cam_id}-hw", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()


class CameraIngest:
    def __init__(self, env=None):
        self.env = env if env is not None else os.environ
        self.dry_run = parse_dry_run(self.env)
        self.width = _env_int("VLC_CAMERA_WIDTH", 640)
        self.height = _env_int("VLC_CAMERA_HEIGHT", 480)
        self.target_fps = max(1, _env_int("VLC_CAMERA_FPS", 10))
        self.slots = {}
        for cam_id in CAM_IDS:
            role = normalize_role(
                self.env.get(f"VLC_{cam_id.upper()}_ROLE", DEFAULT_ROLES[cam_id]),
                DEFAULT_ROLES[cam_id],
            )
            spec = parse_device_spec(self.env.get(f"VLC_{cam_id.upper()}_DEVICE", DEFAULT_DEVICES[cam_id]))
            self.slots[cam_id] = _CameraSlot(cam_id, role, spec, dry_run=self.dry_run is not None)

    def start(self):
        if self.dry_run == "synthetic":
            for slot in self.slots.values():
                slot.start_synthetic(self.target_fps)
            return self
        if self.dry_run == "absent":
            for slot in self.slots.values():
                slot.mark_absent("device_absent", present=False)
            return self
        for slot in self.slots.values():
            slot.start_hardware(self.width, self.height, self.target_fps)
        return self

    def stop(self):
        for slot in self.slots.values():
            slot.stop()

    def cameras(self):
        now = time.monotonic()
        return {cam_id: self.slots[cam_id].snapshot(now) for cam_id in CAM_IDS}

    def frame_jpeg(self, cam_id):
        key = str(cam_id or "").strip().lower()
        slot = self.slots.get(key)
        if not slot:
            return None
        return slot.latest_jpeg()

    def snapshot(self):
        cameras = self.cameras()
        live = [c for c in cameras.values() if c.get("camera_ok") is True]
        ages = [c["last_frame_age_ms"] for c in live if c.get("last_frame_age_ms") is not None]
        fpss = [c["fps"] for c in live if c.get("fps") is not None]
        frames = [c["frame_count"] for c in live if c.get("frame_count") is not None]
        any_ok = bool(live)
        dry = self.dry_run is not None
        source = "synthetic" if self.dry_run == "synthetic" and any_ok else (
            "real" if any_ok and not dry else "absent"
        )
        ingest_running = any_ok or self.dry_run == "synthetic"
        return {
            "observe_only": True,
            "implemented": True,
            "dry_run": dry,
            "dry_run_mode": self.dry_run,
            "source": source,
            "real": source == "real",
            "camera_ok": any_ok,
            "running": ingest_running,
            "health": "valid" if any_ok else "unavailable",
            "fps": max(fpss) if fpss else None,
            "frame_count": max(frames) if frames else None,
            "last_frame_age_ms": min(ages) if ages else None,
            "latency_ms": None,
            "cameras": cameras,
            "note": _note_for(dry, self.dry_run, any_ok),
        }


def _note_for(dry, mode, any_ok):
    if dry and mode == "synthetic" and any_ok:
        return "dry-run synthetic frames; not a real camera; observe-only"
    if dry:
        return "dry-run absent; no device; camera_ok false; not invented"
    if any_ok:
        return "camera ingest live; observe-only; no estimator; not EKF fused"
    return "no camera device; camera_ok false; not invented"


_INGEST = None
_INGEST_LOCK = threading.Lock()


def get_ingest():
    global _INGEST
    with _INGEST_LOCK:
        if _INGEST is None:
            _INGEST = CameraIngest().start()
        return _INGEST


def ingest_snapshot():
    return get_ingest().snapshot()


def ingest_frame_jpeg(cam_id):
    return get_ingest().frame_jpeg(cam_id)


def main(argv=None):
    parser = argparse.ArgumentParser(description="AIRVIX observe-only dual-camera ingest")
    parser.add_argument("--json", action="store_true", help="print one snapshot and exit")
    parser.add_argument("--dry-run", action="store_true", help="absent dry-run")
    parser.add_argument("--dry-run-synthetic", action="store_true", help="synthetic frames")
    parser.add_argument("--seconds", type=float, default=0.0)
    args = parser.parse_args(argv)
    if args.dry_run_synthetic:
        os.environ["VLC_CAMERA_DRY_RUN"] = "synthetic"
    elif args.dry_run:
        os.environ["VLC_CAMERA_DRY_RUN"] = "1"
    ingest = CameraIngest().start()
    wait = max(0.0, float(args.seconds))
    if wait:
        time.sleep(wait)
    snap = ingest.snapshot()
    print(json.dumps(snap, indent=2))
    ingest.stop()
    if args.json or args.dry_run or args.dry_run_synthetic:
        return 0 if snap.get("dry_run") or snap.get("camera_ok") is False or snap.get("camera_ok") is True else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
