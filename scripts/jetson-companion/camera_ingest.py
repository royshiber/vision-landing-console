#!/usr/bin/env python3
"""Observe-only camera ingest for companion_agent 2.3.10.

Slots: cam1 forward, cam2 down, cam3 gimbal (RTSP, off unless enabled).
A per-slot supervisor discovers and reopens devices without touching the
MAVLink relay. Never invent camera_ok or frames.

States: absent, opening, streaming, read_failed, opencv_unavailable,
csi_requires_gstreamer_opencv, disabled.

Env:
  VLC_CAM1_DEVICE / VLC_CAM2_DEVICE / VLC_CAM3_DEVICE
      auto | path | /dev/v4l/by-id/* | /dev/v4l/by-path/* | index | csi:N | rtsp://
      defaults: auto, auto, rtsp://192.168.144.25:8554/main.264
  VLC_CAM3_ENABLED                 0|1   (default 0)
  VLC_CAM1_ROLE / VLC_CAM2_ROLE / VLC_CAM3_ROLE
  VLC_CAMERA_DRY_RUN               0|1|absent|synthetic
  VLC_CAMERA_WIDTH / HEIGHT / FPS  defaults, overridable per slot
  VLC_CAM3_CODEC                   h264|h265|auto  (default auto)
  VLC_CAMERA_DISCOVER_S            default 2
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from pathlib import Path

CAM_IDS = ("cam1", "cam2", "cam3")
DEFAULT_DEVICES = {
    "cam1": "auto",
    "cam2": "auto",
    "cam3": "rtsp://192.168.144.25:8554/main.264",
}
DEFAULT_ROLES = {"cam1": "forward", "cam2": "down", "cam3": "gimbal"}
DEFAULT_ENABLED = {"cam1": True, "cam2": True, "cam3": False}
NAV_ROLES = {
    "forward": "vio_forward",
    "down": "optical_flow_down",
    "gimbal": "gimbal_observe",
}
CAP_WIDTH = 3
CAP_HEIGHT = 4
CAP_FPS = 5
CAP_FOURCC = 6
CAP_BUFFERS = 38
V4L2_CAP_VIDEO_CAPTURE = 0x00000001
V4L2_CAP_DEVICE_CAPS = 0x80000000
VIDIOC_QUERYCAP = 0x80685600

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


class CaptureError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _env_str(name, default="", env=None):
    src = env if env is not None else os.environ
    return str(src.get(name, default) or default).strip()


def _env_int(name, default, env=None):
    raw = _env_str(name, "", env)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _flag(name, default=False, env=None):
    src = env if env is not None else os.environ
    raw = src.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


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
    if key in {"gimbal", "גימבל", "cam3", "siyi"}:
        return "gimbal"
    return fallback


def fourcc_int(text):
    raw = str(text or "MJPG")[:4].ljust(4, " ")
    return (
        (ord(raw[0]) & 255)
        + ((ord(raw[1]) & 255) << 8)
        + ((ord(raw[2]) & 255) << 16)
        + ((ord(raw[3]) & 255) << 24)
    )


def parse_device_spec(raw):
    text = str(raw or "").strip()
    low = text.lower()
    if not text or low == "auto":
        return {"kind": "auto", "raw": "auto" if text else "", "path": None, "index": None, "url": None}
    if low.startswith("rtsp://") or low.startswith("rtsps://"):
        return {"kind": "rtsp", "raw": text, "path": None, "index": None, "url": text}
    if low.startswith("csi:"):
        rest = text.split(":", 1)[1]
        try:
            index = int(rest)
        except ValueError:
            index = None
        return {"kind": "csi", "raw": text, "path": None, "index": index, "url": None}
    if text.isdigit():
        index = int(text)
        return {"kind": "index", "raw": text, "path": f"/dev/video{index}", "index": index, "url": None}
    return {"kind": "path", "raw": text, "path": text, "index": None, "url": None}


def _claim_key(path):
    text = str(path or "").strip()
    if not text:
        return ""
    if text.isdigit():
        return f"/dev/video{int(text)}"
    return text


def discover_capture_nodes(sysroot="/", capture_probe=None):
    """Stable capture nodes.

    Prefer /dev/v4l/by-id/*-video-index0 (skips metadata nodes).
    Otherwise /dev/video* that actually advertise video capture.
    """
    root = Path(sysroot)
    by_id = root / "dev" / "v4l" / "by-id"
    if by_id.is_dir():
        names = sorted(
            p.name
            for p in by_id.iterdir()
            if p.name.endswith("-video-index0") and not p.name.startswith(".")
        )
        if names:
            return [f"/dev/v4l/by-id/{name}" for name in names]
    dev = root / "dev"
    if not dev.is_dir():
        return []
    nodes = []
    for entry in dev.iterdir():
        match = re.fullmatch(r"video(\d+)", entry.name)
        if match:
            nodes.append((int(match.group(1)), entry.name))
    nodes.sort()
    found = []
    for _idx, name in nodes:
        logical = f"/dev/{name}"
        real = str(dev / name) if str(root) not in {"", "/"} else logical
        if capture_probe is not None:
            ok = bool(capture_probe(logical))
        else:
            ok = node_supports_capture(real)
        if ok:
            found.append(logical)
    return found


def node_supports_capture(path):
    """True when a V4L2 node advertises video capture. False if it cannot be opened."""
    try:
        fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)
    except OSError:
        return False
    try:
        import fcntl

        buf = bytearray(104)
        try:
            fcntl.ioctl(fd, VIDIOC_QUERYCAP, buf, True)
        except OSError:
            return False
        caps = int.from_bytes(buf[84:88], "little")
        device_caps = int.from_bytes(buf[88:92], "little")
        use = device_caps if (caps & V4L2_CAP_DEVICE_CAPS) else caps
        return (use & V4L2_CAP_VIDEO_CAPTURE) != 0
    finally:
        os.close(fd)


def slot_enabled(env, cam_id):
    default = DEFAULT_ENABLED.get(cam_id, False)
    return _flag(f"VLC_{cam_id.upper()}_ENABLED", default, env)


def slot_device_raw(env, cam_id):
    key = f"VLC_{cam_id.upper()}_DEVICE"
    raw = env.get(key) if env is not None else None
    if raw is None or str(raw).strip() == "":
        return DEFAULT_DEVICES[cam_id]
    return str(raw).strip()


def slot_geometry(env, cam_id):
    width = _env_int(f"VLC_{cam_id.upper()}_WIDTH", _env_int("VLC_CAMERA_WIDTH", 640, env), env)
    height = _env_int(f"VLC_{cam_id.upper()}_HEIGHT", _env_int("VLC_CAMERA_HEIGHT", 480, env), env)
    fps = max(1, _env_int(f"VLC_{cam_id.upper()}_FPS", _env_int("VLC_CAMERA_FPS", 10, env), env))
    return {"width": width, "height": height, "fps": fps}


def slot_codec(env, cam_id):
    specific = _env_str(f"VLC_{cam_id.upper()}_CODEC", "", env).lower()
    if specific in {"h264", "h265", "auto"}:
        return specific
    shared = _env_str("VLC_RTSP_CODEC", "auto", env).lower()
    if shared in {"h264", "h265", "auto"}:
        return shared
    return "auto"


def plan_slot_devices(env, discovered, exists_fn=None):
    """Assign devices. Explicit specs win. auto takes remaining nodes in order."""
    exists = exists_fn or (lambda path: Path(path).exists())
    discovered = list(discovered or [])
    requests = []
    for cam_id in CAM_IDS:
        raw = slot_device_raw(env, cam_id)
        spec = parse_device_spec(raw)
        requests.append({
            "id": cam_id,
            "enabled": slot_enabled(env, cam_id),
            "role": normalize_role(env.get(f"VLC_{cam_id.upper()}_ROLE", DEFAULT_ROLES[cam_id]), DEFAULT_ROLES[cam_id]),
            "requested": spec.get("raw") or raw,
            "spec": spec,
            "geometry": slot_geometry(env, cam_id),
            "codec": slot_codec(env, cam_id),
        })
    resolved = {}
    claimed = set()
    for req in requests:
        if not req["enabled"]:
            resolved[req["id"]] = {
                **req,
                "kind": "disabled",
                "resolved": None,
                "node_present": False,
            }
            continue
        spec = req["spec"]
        if spec["kind"] == "auto":
            continue
        item = {
            **req,
            "kind": spec["kind"],
            "resolved": _explicit_resolved(spec),
        }
        key = _claim_key(item["resolved"] if spec["kind"] in {"path", "index"} else "")
        if key:
            claimed.add(key)
        item["node_present"] = _node_present(item, exists)
        resolved[req["id"]] = item
    pool = [node for node in discovered if _claim_key(node) not in claimed]
    for req in requests:
        if req["id"] in resolved:
            continue
        if not pool:
            resolved[req["id"]] = {
                **req,
                "kind": "auto",
                "resolved": None,
                "node_present": False,
            }
            continue
        path = pool.pop(0)
        spec = {"kind": "path", "raw": "auto", "path": path, "index": None, "url": None}
        item = {
            **req,
            "spec": spec,
            "kind": "path",
            "resolved": path,
        }
        item["node_present"] = _node_present(item, exists)
        resolved[req["id"]] = item
    return resolved


def _explicit_resolved(spec):
    if spec["kind"] == "rtsp":
        return spec.get("url")
    if spec["kind"] == "csi":
        return spec.get("raw")
    if spec["kind"] == "index":
        return spec.get("path")
    if spec["kind"] == "path":
        return spec.get("path")
    return None


def _node_present(item, exists):
    kind = item.get("kind")
    if kind in {"rtsp", "csi"}:
        return True
    if kind in {"path", "index"}:
        path = item.get("resolved")
        return bool(path) and bool(exists(path))
    return False


def csi_gstreamer_pipeline(sensor_id, width, height, fps):
    return (
        f"nvarguscamerasrc sensor-id={int(sensor_id)} ! "
        f"video/x-raw(memory:NVMM),width={int(width)},height={int(height)},framerate={int(fps)}/1 ! "
        "nvvidconv ! video/x-raw,format=BGRx ! videoconvert ! video/x-raw,format=BGR ! "
        "appsink drop=true max-buffers=1 sync=false"
    )


def rtsp_gstreamer_pipeline(url, codec):
    if str(codec).lower() == "h265":
        depay = "rtph265depay ! h265parse"
    else:
        depay = "rtph264depay ! h264parse"
    return (
        f"rtspsrc location={url} protocols=tcp latency=0 ! "
        f"{depay} ! nvv4l2decoder ! nvvidconv ! video/x-raw,format=BGRx ! "
        "videoconvert ! video/x-raw,format=BGR ! appsink drop=true max-buffers=1 sync=false"
    )


def apply_usb_pixel_format(cap, width, height, fps):
    """Request MJPG, then YUYV. Returns the format that stuck, or 'unknown'."""
    mjpg = fourcc_int("MJPG")
    yuyv = fourcc_int("YUYV")
    try:
        cap.set(CAP_FOURCC, mjpg)
    except Exception:
        pass
    try:
        current = int(cap.get(CAP_FOURCC) or 0)
    except Exception:
        current = 0
    chosen = "MJPG" if current == mjpg else None
    if chosen is None:
        try:
            cap.set(CAP_FOURCC, yuyv)
            current = int(cap.get(CAP_FOURCC) or 0)
        except Exception:
            current = 0
        chosen = "YUYV" if current == yuyv else "unknown"
    for prop, value in ((CAP_WIDTH, width), (CAP_HEIGHT, height), (CAP_FPS, fps), (CAP_BUFFERS, 1)):
        try:
            cap.set(prop, value)
        except Exception:
            pass
    return chosen


def _try_cv2():
    try:
        import cv2  # optional; not required at import time
    except ImportError:
        return None
    return cv2


def cv2_has_gstreamer(cv2):
    try:
        info = cv2.getBuildInformation()
    except Exception:
        return False
    for line in str(info).splitlines():
        if "GStreamer" in line:
            return "YES" in line.upper()
    return False


class CvCapture:
    def __init__(self, cap, cv2, pixel_format=None, codec=None):
        self.cap = cap
        self.cv2 = cv2
        self.pixel_format = pixel_format
        self.codec = codec
        self.released = False

    def read_frame(self):
        ok, frame = self.cap.read()
        if not ok or frame is None:
            return None
        ok_jpg, buf = self.cv2.imencode(".jpg", frame, [int(self.cv2.IMWRITE_JPEG_QUALITY), 80])
        if not ok_jpg:
            return None
        return {"jpeg": buf.tobytes(), "bgr": frame}

    def release(self):
        if self.released:
            return
        self.released = True
        try:
            self.cap.release()
        except Exception:
            pass


def _open_capture(cv2, target, api):
    cap = cv2.VideoCapture()
    if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
        try:
            cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 3000)
        except Exception:
            pass
    if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
        try:
            cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 3000)
        except Exception:
            pass
    opened = cap.open(target, api) if api is not None else cap.open(target)
    if not opened or not cap.isOpened():
        try:
            cap.release()
        except Exception:
            pass
        return None
    return cap


def open_hardware(spec, plan):
    cv2 = _try_cv2()
    if cv2 is None:
        raise CaptureError("opencv_unavailable")
    kind = spec.get("kind")
    geom = plan.get("geometry") or {"width": 640, "height": 480, "fps": 10}
    if kind == "csi":
        if spec.get("index") is None:
            raise CaptureError("read_failed")
        if not cv2_has_gstreamer(cv2):
            raise CaptureError("csi_requires_gstreamer_opencv")
        pipeline = csi_gstreamer_pipeline(spec["index"], geom["width"], geom["height"], geom["fps"])
        cap = _open_capture(cv2, pipeline, getattr(cv2, "CAP_GSTREAMER", None))
        if cap is None:
            raise CaptureError("read_failed")
        return CvCapture(cap, cv2, codec="csi")
    if kind == "rtsp":
        return _open_rtsp(cv2, spec.get("url"), plan.get("codec") or "auto")
    api = getattr(cv2, "CAP_V4L2", None)
    target = spec.get("path") if kind == "path" else int(spec.get("index") if spec.get("index") is not None else 0)
    cap = _open_capture(cv2, target, api)
    if cap is None:
        raise CaptureError("read_failed")
    pixel = apply_usb_pixel_format(cap, geom["width"], geom["height"], geom["fps"])
    wrapped = CvCapture(cap, cv2, pixel_format=pixel)
    return wrapped


def _open_rtsp(cv2, url, codec):
    if not url:
        raise CaptureError("read_failed")
    if cv2_has_gstreamer(cv2):
        order = ["h264", "h265"] if codec == "auto" else [codec]
        for name in order:
            pipeline = rtsp_gstreamer_pipeline(url, name)
            cap = _open_capture(cv2, pipeline, getattr(cv2, "CAP_GSTREAMER", None))
            if cap is not None:
                return CvCapture(cap, cv2, codec=name)
    prev = os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS")
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay|max_delay;500000"
    try:
        cap = _open_capture(cv2, url, getattr(cv2, "CAP_FFMPEG", None))
    finally:
        if prev is None:
            os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)
        else:
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = prev
    if cap is None:
        raise CaptureError("read_failed")
    try:
        cap.set(CAP_BUFFERS, 1)
    except Exception:
        pass
    return CvCapture(cap, cv2, codec="ffmpeg")


class FrameBus:
    """In-process latest-frame bus. One packet per slot; older frames are dropped."""

    def __init__(self):
        self._latest = {}
        self._subs = []
        self._lock = threading.Lock()

    def publish(self, cam_id, packet):
        with self._lock:
            self._latest[cam_id] = packet
            subs = list(self._subs)
        for callback in subs:
            try:
                callback(cam_id, packet)
            except Exception:
                pass

    def subscribe(self, callback):
        with self._lock:
            self._subs.append(callback)

        def unsubscribe():
            with self._lock:
                if callback in self._subs:
                    self._subs.remove(callback)

        return unsubscribe

    def latest(self, cam_id=None):
        with self._lock:
            if cam_id is None:
                return dict(self._latest)
            return self._latest.get(cam_id)


class SlotSupervisor:
    """One thread per slot. Open, read, release, and backoff never run on the relay."""

    def __init__(
        self,
        cam_id,
        *,
        role,
        enabled,
        resolve_fn,
        open_fn,
        geometry,
        now_fn=None,
        discover_s=2.0,
        backoff_max_s=8.0,
        bus=None,
        dry_run=False,
    ):
        self.cam_id = cam_id
        self.role = role
        self.enabled = bool(enabled)
        self.resolve_fn = resolve_fn
        self.open_fn = open_fn
        self.geometry = geometry or {"width": 640, "height": 480, "fps": 10}
        self.fps = max(1, int(self.geometry.get("fps") or 10))
        self.now_fn = now_fn or time.monotonic
        self.discover_s = float(discover_s)
        self.backoff_max_s = float(backoff_max_s)
        self.backoff_s = 0.5
        self.bus = bus
        self.dry_run = bool(dry_run)
        self.lock = threading.Lock()
        self.state = "disabled" if not self.enabled else "absent"
        self.error = "disabled" if not self.enabled else "device_absent"
        self.present = False
        self.camera_ok = False
        self.source = "absent"
        self.requested = None
        self.resolved = None
        self.kind = None
        self.frame_jpeg = None
        self.frame_count = 0
        self.last_frame_mono = None
        self.intervals = []
        self.capture = None
        self.pixel_format = None
        self.codec = None
        self._next_attempt = 0.0
        self._stop = threading.Event()
        self.thread = None

    def snapshot(self, now=None):
        now = self.now_fn() if now is None else now
        with self.lock:
            age = None
            fps = None
            if self.camera_ok and self.last_frame_mono is not None:
                age = max(0, int(round((now - self.last_frame_mono) * 1000)))
            if self.camera_ok and self.intervals:
                mean = sum(self.intervals) / len(self.intervals)
                if mean > 0:
                    fps = round(1.0 / mean, 2)
            count = self.frame_count if self.frame_count > 0 else None
            return {
                "id": self.cam_id,
                "role": self.role,
                "nav_role": NAV_ROLES.get(self.role, "landing_vision"),
                "shared_with": "landing_vision",
                "enabled": self.enabled,
                "state": self.state,
                "present": bool(self.present),
                "camera_ok": bool(self.camera_ok),
                "fps": fps,
                "frame_count": count,
                "last_frame_age_ms": age,
                "error": None if self.camera_ok else self.error,
                "source": self.source,
                "dry_run": self.dry_run,
                "real": self.source == "real" and self.camera_ok and not self.dry_run,
                "device": self.resolved,
                "requested_device": self.requested,
                "resolved_device": self.resolved,
                "pixel_format": self.pixel_format,
                "codec": self.codec,
                "has_frame": self.frame_jpeg is not None and self.camera_ok,
            }

    def latest_jpeg(self):
        with self.lock:
            if not self.camera_ok:
                return None
            return self.frame_jpeg

    def step(self):
        if not self.enabled:
            self._release()
            self._mark(state="disabled", error="disabled", present=False, camera_ok=False, source="absent")
            return self.state
        now = self.now_fn()
        if self.state != "streaming" and now < self._next_attempt:
            return self.state
        plan = self.resolve_fn() or {}
        spec = plan.get("spec") or {"kind": "empty", "raw": "", "path": None, "index": None, "url": None}
        kind = plan.get("kind") or spec.get("kind")
        resolved = plan.get("resolved")
        self._set_identity(plan.get("requested"), resolved, kind)
        if kind == "disabled" or not plan.get("node_present"):
            self._release()
            self._drop_live_frame()
            self.backoff_s = 0.5
            self._next_attempt = now + self.discover_s
            self._mark(state="absent", error="device_absent", present=False, camera_ok=False, source="absent")
            return self.state
        if self.capture is None:
            self._mark(state="opening", error=None, present=True, camera_ok=False, source="absent")
            try:
                cap = self.open_fn(spec, plan)
            except CaptureError as exc:
                self._fail_open(exc.code, now)
                return self.state
            except Exception:
                self._fail_open("read_failed", now)
                return self.state
            if cap is None:
                self._fail_open("read_failed", now)
                return self.state
            self.capture = cap
            self.pixel_format = getattr(cap, "pixel_format", None)
            self.codec = getattr(cap, "codec", None)
        frame = None
        try:
            frame = self.capture.read_frame()
        except Exception:
            frame = None
        jpeg = frame.get("jpeg") if isinstance(frame, dict) else None
        if not jpeg:
            self._release()
            self._drop_live_frame()
            self._mark(state="read_failed", error="read_failed", present=True, camera_ok=False, source="absent")
            self._schedule_backoff(now)
            return self.state
        self._note_frame(jpeg, frame.get("bgr") if isinstance(frame, dict) else None)
        self.backoff_s = 0.5
        self._next_attempt = now
        return self.state

    def start(self):
        if not self.enabled or self.thread is not None:
            return

        def loop():
            while not self._stop.is_set():
                self.step()
                if self.state == "streaming":
                    wait = 1.0 / float(self.fps)
                else:
                    wait = max(0.05, self._next_attempt - self.now_fn())
                if self._stop.wait(min(wait, self.discover_s)):
                    break
            self._release()

        self.thread = threading.Thread(target=loop, name=f"cam-{self.cam_id}", daemon=True)
        self.thread.start()

    def stop(self):
        self._stop.set()
        self._release()
        thread = self.thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)

    def _fail_open(self, code, now):
        self._release()
        self._drop_live_frame()
        if code == "opencv_unavailable":
            state = "opencv_unavailable"
        elif code == "csi_requires_gstreamer_opencv":
            state = "csi_requires_gstreamer_opencv"
        else:
            state = "read_failed"
            code = code or "read_failed"
        self._mark(state=state, error=code, present=True, camera_ok=False, source="absent")
        self._schedule_backoff(now)

    def _schedule_backoff(self, now):
        self._next_attempt = now + self.backoff_s
        self.backoff_s = min(self.backoff_max_s, max(0.5, self.backoff_s * 2))

    def _set_identity(self, requested, resolved, kind):
        changed = (requested, resolved, kind) != (self.requested, self.resolved, self.kind)
        self.requested = requested
        self.resolved = resolved
        self.kind = kind
        if changed and resolved:
            print(f"[camera] {self.cam_id} resolved {resolved}", flush=True)

    def _mark(self, *, state, error, present, camera_ok, source):
        with self.lock:
            prev = self.state
            self.state = state
            self.error = error
            self.present = bool(present)
            self.camera_ok = bool(camera_ok)
            self.source = source
            resolved = self.resolved
        if prev != state:
            print(f"[camera] {self.cam_id} state {state} device {resolved or '-'}", flush=True)

    def _note_frame(self, jpeg, bgr):
        now = self.now_fn()
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
            self.source = "real"
            self.state = "streaming"
            count = self.frame_count
            resolved = self.resolved
        if self.bus is not None:
            self.bus.publish(self.cam_id, {
                "cam_id": self.cam_id,
                "jpeg": jpeg,
                "bgr": bgr,
                "frame_count": count,
                "monotonic": now,
                "device": resolved,
                "role": self.role,
            })

    def _drop_live_frame(self):
        with self.lock:
            self.frame_jpeg = None
            self.camera_ok = False
            self.last_frame_mono = None
            self.intervals = []

    def _release(self):
        cap = self.capture
        self.capture = None
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass


class _DrySlot:
    def __init__(self, cam_id, role, enabled, dry_run, requested):
        self.cam_id = cam_id
        self.role = role
        self.enabled = enabled
        self.dry_run = dry_run
        self.requested = requested
        self.lock = threading.Lock()
        self.present = False
        self.camera_ok = False
        self.error = "disabled" if not enabled else "device_absent"
        self.source = "absent"
        self.state = "disabled" if not enabled else "absent"
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
            if self.camera_ok and self.last_frame_mono is not None:
                age = max(0, int(round((now - self.last_frame_mono) * 1000)))
            if self.camera_ok and self.intervals:
                mean = sum(self.intervals) / len(self.intervals)
                if mean > 0:
                    fps = round(1.0 / mean, 2)
            count = self.frame_count if self.frame_count > 0 else None
            return {
                "id": self.cam_id,
                "role": self.role,
                "nav_role": NAV_ROLES.get(self.role, "landing_vision"),
                "shared_with": "landing_vision",
                "enabled": self.enabled,
                "state": self.state,
                "present": bool(self.present),
                "camera_ok": bool(self.camera_ok),
                "fps": fps,
                "frame_count": count,
                "last_frame_age_ms": age,
                "error": None if self.camera_ok else self.error,
                "source": self.source,
                "dry_run": True,
                "real": False,
                "device": None,
                "requested_device": self.requested,
                "resolved_device": None,
                "pixel_format": None,
                "codec": None,
                "has_frame": self.frame_jpeg is not None and self.camera_ok,
            }

    def latest_jpeg(self):
        with self.lock:
            if not self.camera_ok:
                return None
            return self.frame_jpeg

    def start_synthetic(self, fps, bus):
        if not self.enabled:
            return
        self.present = True
        self.source = "synthetic"
        self.state = "streaming"
        self.error = None
        period = 1.0 / max(1.0, float(fps))

        def loop():
            while not self.stop_event.wait(period):
                self._note(bus)

        self.thread = threading.Thread(target=loop, name=f"cam-{self.cam_id}-syn", daemon=True)
        self.thread.start()
        self._note(bus)

    def _note(self, bus):
        now = time.monotonic()
        with self.lock:
            if self.last_frame_mono is not None:
                self.intervals.append(now - self.last_frame_mono)
                self.intervals = self.intervals[-30:]
            self.last_frame_mono = now
            self.frame_count += 1
            self.frame_jpeg = SYNTHETIC_JPEG
            self.camera_ok = True
            self.present = True
            self.error = None
            self.source = "synthetic"
            self.state = "streaming"
            count = self.frame_count
        if bus is not None:
            bus.publish(self.cam_id, {
                "cam_id": self.cam_id,
                "jpeg": SYNTHETIC_JPEG,
                "bgr": None,
                "frame_count": count,
                "monotonic": now,
                "device": None,
                "role": self.role,
                "synthetic": True,
            })

    def stop(self):
        self.stop_event.set()


class CameraIngest:
    def __init__(self, env=None, discover_fn=None, open_fn=None, exists_fn=None, now_fn=None):
        self.env = env if env is not None else os.environ
        self.dry_run = parse_dry_run(self.env)
        self.discover_s = max(0.2, float(_env_int("VLC_CAMERA_DISCOVER_S", 2, self.env)))
        self.bus = FrameBus()
        self.discover_fn = discover_fn or (lambda: discover_capture_nodes("/"))
        self.open_fn = open_fn or open_hardware
        self.exists_fn = exists_fn
        self.now_fn = now_fn
        self.slots = {}
        self._build_slots()

    def _build_slots(self):
        plan = plan_slot_devices(self.env, [], exists_fn=self.exists_fn)
        for cam_id in CAM_IDS:
            item = plan[cam_id]
            if self.dry_run is not None:
                self.slots[cam_id] = _DrySlot(
                    cam_id,
                    item["role"],
                    item["enabled"],
                    dry_run=True,
                    requested=item["requested"],
                )
                continue
            sup = SlotSupervisor(
                cam_id,
                role=item["role"],
                enabled=item["enabled"],
                resolve_fn=lambda cam_id=cam_id: self._resolve(cam_id),
                open_fn=self.open_fn,
                geometry=item["geometry"],
                now_fn=self.now_fn,
                discover_s=self.discover_s,
                bus=self.bus,
                dry_run=False,
            )
            sup.requested = item["requested"]
            self.slots[cam_id] = sup

    def _resolve(self, cam_id):
        try:
            discovered = self.discover_fn() or []
        except Exception:
            discovered = []
        plan = plan_slot_devices(self.env, discovered, exists_fn=self.exists_fn)
        return plan.get(cam_id)

    def start(self):
        if self.dry_run == "synthetic":
            fps = max(1, _env_int("VLC_CAMERA_FPS", 10, self.env))
            for slot in self.slots.values():
                slot.start_synthetic(fps, self.bus)
            return self
        if self.dry_run == "absent":
            return self
        for slot in self.slots.values():
            slot.start()
        return self

    def stop(self):
        for slot in self.slots.values():
            slot.stop()

    def cameras(self):
        now = time.monotonic() if self.now_fn is None else self.now_fn()
        return {cam_id: self.slots[cam_id].snapshot(now) for cam_id in CAM_IDS}

    def frame_jpeg(self, cam_id):
        key = str(cam_id or "").strip().lower()
        slot = self.slots.get(key)
        if not slot:
            return None
        return slot.latest_jpeg()

    def snapshot(self):
        cameras = self.cameras()
        live = [c for c in cameras.values() if c.get("enabled") and c.get("camera_ok") is True]
        ages = [c["last_frame_age_ms"] for c in live if c.get("last_frame_age_ms") is not None]
        fpss = [c["fps"] for c in live if c.get("fps") is not None]
        frames = [c["frame_count"] for c in live if c.get("frame_count") is not None]
        any_ok = bool(live)
        dry = self.dry_run is not None
        source = "synthetic" if self.dry_run == "synthetic" and any_ok else (
            "real" if any_ok and not dry else "absent"
        )
        return {
            "observe_only": True,
            "implemented": True,
            "dry_run": dry,
            "dry_run_mode": self.dry_run,
            "source": source,
            "real": source == "real",
            "camera_ok": any_ok,
            "running": any_ok or self.dry_run == "synthetic",
            "health": "valid" if any_ok else "unavailable",
            "fps": max(fpss) if fpss else None,
            "frame_count": max(frames) if frames else None,
            "last_frame_age_ms": min(ages) if ages else None,
            "latency_ms": None,
            "cameras": cameras,
            "slots": list(CAM_IDS),
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


def get_frame_bus():
    return get_ingest().bus


def ingest_snapshot():
    return get_ingest().snapshot()


def ingest_frame_jpeg(cam_id):
    return get_ingest().frame_jpeg(cam_id)


def main(argv=None):
    parser = argparse.ArgumentParser(description="AIRVIX observe-only camera ingest")
    parser.add_argument("--json", action="store_true", help="print one snapshot and exit")
    parser.add_argument("--dry-run", action="store_true", help="absent dry-run")
    parser.add_argument("--dry-run-synthetic", action="store_true", help="synthetic frames")
    parser.add_argument("--resolve", action="store_true", help="print device plan and exit")
    parser.add_argument("--seconds", type=float, default=0.0)
    args = parser.parse_args(argv)
    if args.dry_run_synthetic:
        os.environ["VLC_CAMERA_DRY_RUN"] = "synthetic"
    elif args.dry_run:
        os.environ["VLC_CAMERA_DRY_RUN"] = "1"
    if args.resolve:
        discovered = discover_capture_nodes("/")
        plan = plan_slot_devices(os.environ, discovered)
        printable = {}
        for cam_id, item in plan.items():
            printable[cam_id] = {
                "enabled": item["enabled"],
                "role": item["role"],
                "requested": item["requested"],
                "resolved": item["resolved"],
                "kind": item["kind"],
                "node_present": item["node_present"],
                "codec": item["codec"],
                "geometry": item["geometry"],
            }
        print(json.dumps({"discovered": discovered, "slots": printable}, indent=2))
        return 0
    ingest = CameraIngest().start()
    wait = max(0.0, float(args.seconds))
    if wait:
        time.sleep(wait)
    snap = ingest.snapshot()
    print(json.dumps(snap, indent=2))
    ingest.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
