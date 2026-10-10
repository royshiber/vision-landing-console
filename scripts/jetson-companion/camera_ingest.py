#!/usr/bin/env python3
"""Observe-only camera ingest for companion_agent 2.3.11.

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
  VLC_CAM3_RTSP_TRANSPORT          udp|tcp|auto  (default udp, TCP fallback)
  VLC_CAM3_JPEG_WIDTH / HEIGHT     tile JPEG, default 640x360
  VLC_CAM3_JPEG_QUALITY            default 55 (same as cam0)
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


# rtspsrc timeout is microseconds. Two seconds matches the fail-fast open budget.
RTSP_TIMEOUT_US = 2_000_000
RTSP_FAIL_FAST_S = 2.5
_RTSP_BAD_UNTIL = {}


def rtsp_transport(env=None):
    raw = _env_str("VLC_CAM3_RTSP_TRANSPORT", "udp", env).lower()
    if raw in {"tcp", "udp", "auto"}:
        return raw
    return "udp"


def rtsp_jpeg_size(env=None):
    """Tile-sized JPEG, same idea as cam0's 640-wide stream. Default 640×360."""
    width = _env_int("VLC_CAM3_JPEG_WIDTH", 0, env)
    height = _env_int("VLC_CAM3_JPEG_HEIGHT", 0, env)
    if width <= 0:
        explicit = _env_str("VLC_CAM3_WIDTH", "", env)
        width = int(explicit) if explicit.isdigit() else 640
    if height <= 0:
        explicit = _env_str("VLC_CAM3_HEIGHT", "", env)
        height = int(explicit) if explicit.isdigit() else 360
    quality = _env_int("VLC_CAM3_JPEG_QUALITY", 55, env)
    quality = max(30, min(85, int(quality)))
    width = max(160, int(width) - (int(width) % 2))
    height = max(120, int(height) - (int(height) % 2))
    return width, height, quality


def rtsp_transport_blocked(transport, now=None):
    until = _RTSP_BAD_UNTIL.get(str(transport or "")) or 0
    return (time.monotonic() if now is None else now) < until


def note_rtsp_transport_failure(transport, hold_s=20):
    """A transport that opened and then produced no frame is skipped for a bit."""
    if transport:
        _RTSP_BAD_UNTIL[str(transport)] = time.monotonic() + float(hold_s)


def rtsp_gstreamer_pipeline(url, codec, transport="udp", width=640, height=360, mode="bgr", decoder="hardware", quality=55):
    """Low-latency SIYI pipeline.

    UDP on the gimbal Ethernet, drop late RTP, one appsink buffer, hardware
    H.264/H.265 decode, and a tile-sized frame before any CPU JPEG.
    `decoder="hardware-dpb"` keeps the decoder's picture buffer for pipelines
    that reject `disable-dpb`. `mode="jpeg"` encodes with nvjpegenc.
    """
    proto = "tcp" if str(transport).lower() == "tcp" else "udp"
    if str(codec).lower() == "h265":
        depay = "rtph265depay ! h265parse"
        soft = "avdec_h265"
    else:
        depay = "rtph264depay ! h264parse"
        soft = "avdec_h264"
    src = (
        f"rtspsrc location={url} protocols={proto} latency=0 "
        f"drop-on-latency=true do-retransmission=false "
        f"timeout={RTSP_TIMEOUT_US} tcp-timeout={RTSP_TIMEOUT_US} ! "
        f"{depay} ! "
    )
    w = int(width)
    h = int(height)
    q = max(30, min(85, int(quality)))
    if str(decoder) == "software":
        body = (
            f"{soft} ! videoscale ! videoconvert ! "
            f"video/x-raw,format=BGR,width={w},height={h} ! "
        )
    elif str(mode) == "jpeg":
        body = (
            "nvv4l2decoder enable-max-performance=1 disable-dpb=true ! "
            f"nvvidconv ! video/x-raw(memory:NVMM),format=I420,width={w},height={h} ! "
            f"nvjpegenc quality={q} ! "
        )
    else:
        dpb = "" if str(decoder) == "hardware-dpb" else " disable-dpb=true"
        body = (
            f"nvv4l2decoder enable-max-performance=1{dpb} ! "
            f"nvvidconv ! video/x-raw,format=BGRx,width={w},height={h} ! "
            "videoconvert ! video/x-raw,format=BGR ! "
        )
    sink = (
        "appsink name=jpeg drop=true max-buffers=1 sync=false"
        if str(mode) == "jpeg"
        else "appsink drop=true max-buffers=1 sync=false"
    )
    return src + body + sink


def rtsp_open_plan(url, codec, transport, width, height, quality=55):
    """UDP then TCP for each decoder, so a hung UDP attempt still reaches TCP.

    OpenCV hardware decode is first. nvjpegenc is next when GStreamer is
    importable. The picture-buffer decoder is last, for a Jetson that rejects
    disable-dpb.
    """
    if str(transport).lower() == "tcp":
        protos = ["tcp"]
    else:
        protos = ["udp", "tcp"]
    protos = [proto for proto in protos if not rtsp_transport_blocked(proto)]
    stages = (
        ("opencv", "nvv4l2decoder", "bgr", "hardware"),
        ("gst-jpeg", "nvv4l2decoder", "jpeg", "hardware"),
        ("opencv", "nvv4l2decoder-dpb", "bgr", "hardware-dpb"),
    )
    plan = []
    for backend, decoder_name, mode, decoder in stages:
        for proto in protos:
            plan.append({
                "backend": backend,
                "decoder": decoder_name,
                "transport": proto,
                "width": width,
                "height": height,
                "pipeline": rtsp_gstreamer_pipeline(
                    url, codec, transport=proto, width=width, height=height,
                    mode=mode, decoder=decoder, quality=quality,
                ),
            })
    return plan


def jpeg_timing_headers(packet):
    """Same JPEG timing headers the console shelf already reads for every camera."""
    extra = [("Cache-Control", "no-store")]
    if not isinstance(packet, dict):
        return extra
    utc = packet.get("captured_utc_ns")
    if utc:
        extra.append(("X-Airvix-Capture-At", str(int(int(utc) // 1_000_000))))
    raw_seq = packet.get("seq", packet.get("frame_count"))
    try:
        seq = int(raw_seq) if raw_seq is not None and str(raw_seq) != "" else 0
    except (TypeError, ValueError):
        seq = 0
    if seq > 0:
        extra.append(("X-Airvix-Frame-Seq", str(seq)))
    enc = packet.get("encode_ms")
    if enc is not None:
        extra.append(("X-Encode-Ms", str(round(float(enc), 3))))
    dec = packet.get("decode_ms")
    if dec is not None:
        extra.append(("X-Airvix-Decode-Ms", str(round(float(dec), 3))))
    return extra


class NewestFrameShelf:
    """One decoded frame and one JPEG. A newer decode replaces a queued older one."""

    def __init__(self):
        self._lock = threading.Lock()
        self._decoded_seq = 0
        self._decoded = None
        self._jpeg = None
        self._jpeg_seq = 0
        self._encode_ms = None
        self._decode_ms = None
        self._cap_utc = None
        self._cap_mono = None
        self._width = None
        self._height = None

    def note_decoded(self, payload, captured_utc_ns, captured_mono_ns, decode_ms):
        with self._lock:
            self._decoded_seq += 1
            self._decoded = (
                self._decoded_seq,
                payload,
                captured_utc_ns,
                captured_mono_ns,
                decode_ms,
            )
            return self._decoded_seq

    def take_decoded(self):
        """The newest decoded frame. Older ones waiting behind it are dropped."""
        with self._lock:
            item = self._decoded
            self._decoded = None
            return item

    def note_jpeg(self, seq, jpeg, encode_ms, captured_utc_ns, captured_mono_ns, decode_ms, width, height):
        with self._lock:
            if int(seq) < self._jpeg_seq:
                return False
            self._jpeg_seq = int(seq)
            self._jpeg = jpeg
            self._encode_ms = encode_ms
            self._decode_ms = decode_ms
            self._cap_utc = captured_utc_ns
            self._cap_mono = captured_mono_ns
            self._width = width
            self._height = height
            return True

    def latest(self):
        with self._lock:
            if self._jpeg is None:
                return None
            return {
                "jpeg": self._jpeg,
                "seq": self._jpeg_seq,
                "encode_ms": self._encode_ms,
                "decode_ms": self._decode_ms,
                "captured_utc_ns": self._cap_utc,
                "captured_mono_ns": self._cap_mono,
                "width": self._width,
                "height": self._height,
            }

    def clear(self):
        with self._lock:
            self._decoded = None
            self._jpeg = None
            self._jpeg_seq = 0
            self._encode_ms = None
            self._decode_ms = None
            self._cap_utc = None
            self._cap_mono = None


def _encode_bgr(cv2, frame, width, height, quality):
    t0 = time.perf_counter()
    try:
        h, w = frame.shape[:2]
    except Exception:
        return None, 0.0
    if int(w) != int(width) or int(h) != int(height):
        frame = cv2.resize(frame, (int(width), int(height)))
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    ms = (time.perf_counter() - t0) * 1000.0
    if not ok:
        return None, ms
    return buf.tobytes(), ms


def _call_with_deadline(fn, timeout_s):
    """Run fn on a daemon thread. A hang becomes read_failed. A late open is released."""
    box = {}

    def run():
        try:
            box["value"] = fn()
        except Exception as exc:
            box["error"] = exc

    thread = threading.Thread(target=run, name="rtsp-open", daemon=True)
    thread.start()
    thread.join(timeout_s)
    if thread.is_alive():
        def reap():
            thread.join()
            value = box.get("value")
            if value is not None and hasattr(value, "release"):
                try:
                    value.release()
                except Exception:
                    pass

        threading.Thread(target=reap, name="rtsp-open-reap", daemon=True).start()
        raise CaptureError("read_failed")
    if "error" in box:
        raise box["error"]
    return box.get("value")


def _try_gst():
    try:
        import gi

        gi.require_version("Gst", "1.0")
        from gi.repository import Gst

        Gst.init(None)
        return Gst
    except Exception:
        return None


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


class RtspCapture:
    """Pull the newest RTSP frame and JPEG it off the pull thread.

    `read_frame` returns `{"pending": True}` while the sink is healthy and
    no newer JPEG is ready. A stall longer than `fail_after_s` returns None
    so the supervisor fails fast and reopens.
    """

    keeps_open_on_empty = True

    def __init__(self, cap, cv2, *, transport, decoder, pipeline, width, height, quality, codec, backend):
        self.cap = cap
        self.cv2 = cv2
        self.transport = transport
        self.decoder = decoder
        self.pipeline = pipeline
        self.width = int(width)
        self.height = int(height)
        self.quality = int(quality)
        self.codec = codec
        self.backend = backend
        self.pixel_format = "BGR"
        self.shelf = NewestFrameShelf()
        self.failed = False
        self.fail_after_s = 2.0
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._handed = 0
        self._released = False
        self._opened_mono = time.monotonic()
        self._last_frame_mono = self._opened_mono
        self._pull_thread = threading.Thread(target=self._pull, name="rtsp-pull", daemon=True)
        self._encode_thread = threading.Thread(target=self._encode, name="rtsp-jpeg", daemon=True)
        self._pull_thread.start()
        self._encode_thread.start()

    def _mark_idle(self):
        if time.monotonic() - self._last_frame_mono > self.fail_after_s:
            self.failed = True
            return True
        return False

    def _pull(self):
        while not self._stop.is_set() and not self.failed:
            cap = self.cap
            if cap is None:
                return
            t_grab = time.perf_counter()
            try:
                grabbed = bool(cap.grab())
            except Exception:
                grabbed = False
            t_got = time.perf_counter()
            if not grabbed:
                if self._mark_idle():
                    return
                if self._stop.wait(0.02):
                    return
                continue
            try:
                ok, frame = cap.retrieve()
            except Exception:
                ok, frame = False, None
            t_ret = time.perf_counter()
            if not ok or frame is None:
                if self._mark_idle():
                    return
                continue
            self._last_frame_mono = time.monotonic()
            decode_ms = max(0.0, (t_ret - t_got) * 1000.0)
            # grab() waits for the next sample. That wait is not decode time.
            _ = t_grab
            self.shelf.note_decoded(frame, time.time_ns(), time.monotonic_ns(), decode_ms)
            self._wake.set()

    def _encode(self):
        while not self._stop.is_set():
            item = self.shelf.take_decoded()
            if item is None:
                self._wake.wait(0.05)
                self._wake.clear()
                continue
            seq, payload, utc, mono, decode_ms = item
            try:
                if isinstance(payload, (bytes, bytearray)):
                    jpeg, enc_ms = bytes(payload), 0.0
                else:
                    jpeg, enc_ms = _encode_bgr(self.cv2, payload, self.width, self.height, self.quality)
            except Exception:
                continue
            if not jpeg:
                continue
            self.shelf.note_jpeg(seq, jpeg, enc_ms, utc, mono, decode_ms, self.width, self.height)

    def read_frame(self):
        if self.failed:
            return None
        packet = self.shelf.latest()
        if packet is None or packet.get("seq") == self._handed:
            if packet is None and self._mark_idle():
                return None
            return {"pending": True}
        self._handed = packet["seq"]
        out = dict(packet)
        out["transport"] = self.transport
        out["decoder"] = self.decoder
        out["backend"] = self.backend
        out["codec"] = self.codec
        return out

    def release(self):
        if self._released:
            return
        self._released = True
        self.failed = True
        self._stop.set()
        self._wake.set()
        cap = self.cap
        self.cap = None
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass


class GstJpegCapture(RtspCapture):
    """nvjpegenc appsink. The sample is already a JPEG, so encode time is ~0."""

    def __init__(self, pipeline, Gst, *, transport, decoder, width, height, quality, codec):
        self.Gst = Gst
        self.pipeline = pipeline
        self.transport = transport
        self.decoder = decoder
        self.width = int(width)
        self.height = int(height)
        self.quality = int(quality)
        self.codec = codec
        self.backend = "nvjpegenc"
        self.pixel_format = "JPEG"
        self.cv2 = None
        self.cap = None
        self.shelf = NewestFrameShelf()
        self.failed = False
        self.fail_after_s = 2.0
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._handed = 0
        self._released = False
        self._opened_mono = time.monotonic()
        self._last_frame_mono = self._opened_mono
        self._pipe = Gst.parse_launch(pipeline)
        self._sink = self._pipe.get_by_name("jpeg")
        if self._sink is None:
            self._pipe.set_state(Gst.State.NULL)
            raise CaptureError("read_failed")
        self._pipe.set_state(Gst.State.PLAYING)
        _change, state, _pending = self._pipe.get_state(int(1.5 * Gst.SECOND))
        if state != Gst.State.PLAYING:
            self._pipe.set_state(Gst.State.NULL)
            raise CaptureError("read_failed")
        self._pull_thread = threading.Thread(target=self._pull, name="rtsp-gst", daemon=True)
        self._encode_thread = threading.Thread(target=self._encode, name="rtsp-jpeg", daemon=True)
        self._pull_thread.start()
        self._encode_thread.start()

    def _pull(self):
        Gst = self.Gst
        while not self._stop.is_set() and not self.failed:
            sample = self._sink.emit("try-pull-sample", int(0.4 * Gst.SECOND))
            if sample is None:
                if self._mark_idle():
                    return
                continue
            buf = sample.get_buffer()
            ok, info = buf.map(Gst.MapFlags.READ)
            if not ok:
                continue
            try:
                jpeg = bytes(info.data)
            finally:
                buf.unmap(info)
            if not jpeg:
                continue
            self._last_frame_mono = time.monotonic()
            self.shelf.note_decoded(jpeg, time.time_ns(), time.monotonic_ns(), 0.0)
            self._wake.set()

    def release(self):
        if self._released:
            return
        super().release()
        pipe = getattr(self, "_pipe", None)
        self._pipe = None
        if pipe is not None:
            try:
                pipe.set_state(self.Gst.State.NULL)
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
        return _open_rtsp(cv2, spec.get("url"), plan.get("codec") or "auto", plan.get("geometry"))
    api = getattr(cv2, "CAP_V4L2", None)
    target = spec.get("path") if kind == "path" else int(spec.get("index") if spec.get("index") is not None else 0)
    cap = _open_capture(cv2, target, api)
    if cap is None:
        raise CaptureError("read_failed")
    pixel = apply_usb_pixel_format(cap, geom["width"], geom["height"], geom["fps"])
    wrapped = CvCapture(cap, cv2, pixel_format=pixel)
    return wrapped


def _open_rtsp_candidate(cv2, gst, cand, quality, codec):
    if cand["backend"] == "gst-jpeg":
        if gst is None:
            return None
        return GstJpegCapture(
            cand["pipeline"],
            gst,
            transport=cand["transport"],
            decoder=cand["decoder"],
            width=cand["width"],
            height=cand["height"],
            quality=quality,
            codec=codec,
        )
    if not cv2_has_gstreamer(cv2):
        return None
    cap = _open_capture(cv2, cand["pipeline"], getattr(cv2, "CAP_GSTREAMER", None))
    if cap is None:
        return None
    try:
        cap.set(CAP_BUFFERS, 1)
    except Exception:
        pass
    return RtspCapture(
        cap,
        cv2,
        transport=cand["transport"],
        decoder=cand["decoder"],
        pipeline=cand["pipeline"],
        width=cand["width"],
        height=cand["height"],
        quality=quality,
        codec=codec,
        backend="opencv",
    )


def _ffmpeg_rtsp_options(transport):
    proto = "tcp" if str(transport).lower() == "tcp" else "udp"
    return f"rtsp_transport;{proto}|fflags;nobuffer|flags;low_delay|max_delay;0|reorder_queue_size;0"


def _open_rtsp(cv2, url, codec, geometry=None, env=None):
    if not url:
        raise CaptureError("read_failed")
    src_env = env if env is not None else os.environ
    width, height, quality = rtsp_jpeg_size(src_env)
    _ = geometry
    transport = rtsp_transport(src_env)
    names = ["h264", "h265"] if str(codec).lower() == "auto" else [str(codec).lower()]
    budget = time.monotonic() + RTSP_FAIL_FAST_S
    gst = _try_gst()
    for name in names:
        for cand in rtsp_open_plan(url, name, transport, width, height, quality):
            remaining = budget - time.monotonic()
            if remaining <= 0.05:
                break
            try:
                opened = _call_with_deadline(
                    lambda c=cand, codec_name=name: _open_rtsp_candidate(cv2, gst, c, quality, codec_name),
                    min(0.9, remaining),
                )
            except CaptureError:
                continue
            except Exception:
                continue
            if opened is not None:
                return opened
        if time.monotonic() >= budget:
            break
    remaining = budget - time.monotonic()
    if remaining > 0.05:
        proto = "tcp" if transport == "tcp" or rtsp_transport_blocked("udp") else transport
        if proto == "auto":
            proto = "udp"
        prev = os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS")
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = _ffmpeg_rtsp_options(proto)
        try:
            cap = _call_with_deadline(
                lambda: _open_capture(cv2, url, getattr(cv2, "CAP_FFMPEG", None)),
                min(1.2, remaining),
            )
        except CaptureError:
            cap = None
        finally:
            if prev is None:
                os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)
            else:
                os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = prev
        if cap is not None:
            try:
                cap.set(CAP_BUFFERS, 1)
            except Exception:
                pass
            return RtspCapture(
                cap,
                cv2,
                transport=proto if proto in {"tcp", "udp"} else "udp",
                decoder="ffmpeg",
                pipeline=url,
                width=width,
                height=height,
                quality=quality,
                codec="ffmpeg",
                backend="ffmpeg",
            )
    raise CaptureError("read_failed")


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
        open_timeout_s=3.0,
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
        self.open_timeout_s = float(open_timeout_s)
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
        self.capture_utc_ns = None
        self.capture_mono_ns = None
        self.decode_ms = None
        self.encode_ms = None
        self.rtsp_transport = None
        self.rtsp_decoder = None
        self.rtsp_backend = None
        self.jpeg_width = None
        self.jpeg_height = None
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
            count = self.frame_count if self.camera_ok and self.frame_count > 0 else None
            stages = {}
            if self.decode_ms is not None:
                stages["decode"] = round(float(self.decode_ms), 3)
            if self.encode_ms is not None:
                stages["jpeg"] = round(float(self.encode_ms), 3)
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
                "stages_ms": stages or None,
                "t_utc_ns": self.capture_utc_ns,
                "t_monotonic_ns": self.capture_mono_ns,
                "transport": self.rtsp_transport,
                "decoder": self.rtsp_decoder,
                "encoder": self.rtsp_backend,
                "jpeg_width": self.jpeg_width,
                "jpeg_height": self.jpeg_height,
            }

    def latest_jpeg(self):
        packet = self.latest_packet()
        if not packet:
            return None
        return packet.get("jpeg")

    def latest_packet(self):
        with self.lock:
            if not self.camera_ok or self.frame_jpeg is None:
                return None
            return {
                "jpeg": self.frame_jpeg,
                "seq": self.frame_count,
                "captured_utc_ns": self.capture_utc_ns,
                "captured_mono_ns": self.capture_mono_ns,
                "encode_ms": self.encode_ms,
                "decode_ms": self.decode_ms,
                "width": self.jpeg_width,
                "height": self.jpeg_height,
                "transport": self.rtsp_transport,
                "decoder": self.rtsp_decoder,
                "encoder": self.rtsp_backend,
            }

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
            self._drop_live_frame()
            try:
                if kind == "rtsp":
                    cap = _call_with_deadline(lambda: self.open_fn(spec, plan), self.open_timeout_s)
                else:
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
            self.rtsp_transport = getattr(cap, "transport", None)
            self.rtsp_decoder = getattr(cap, "decoder", None)
            self.rtsp_backend = getattr(cap, "backend", None)
        frame = None
        try:
            frame = self.capture.read_frame()
        except Exception:
            frame = None
        if isinstance(frame, dict) and frame.get("pending") and not frame.get("jpeg"):
            if getattr(self.capture, "failed", False):
                transport = getattr(self.capture, "transport", None) if self.kind == "rtsp" else None
                if transport:
                    note_rtsp_transport_failure(transport)
                self._release()
                self._drop_live_frame()
                self._mark(state="read_failed", error="read_failed", present=True, camera_ok=False, source="absent")
                self._schedule_backoff(now)
                return self.state
            return self.state
        jpeg = frame.get("jpeg") if isinstance(frame, dict) else None
        if not jpeg:
            transport = getattr(self.capture, "transport", None) if self.kind == "rtsp" else None
            if transport and getattr(self.capture, "failed", False):
                note_rtsp_transport_failure(transport)
            self._release()
            self._drop_live_frame()
            self._mark(state="read_failed", error="read_failed", present=True, camera_ok=False, source="absent")
            self._schedule_backoff(now)
            return self.state
        self._note_frame(jpeg, frame.get("bgr") if isinstance(frame, dict) else None, frame)
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
                    if getattr(self.capture, "keeps_open_on_empty", False):
                        wait = 0.02
                    else:
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

    def _note_frame(self, jpeg, bgr, timing=None):
        now = self.now_fn()
        timing = timing if isinstance(timing, dict) else {}
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
            if timing.get("captured_utc_ns"):
                self.capture_utc_ns = timing.get("captured_utc_ns")
            if timing.get("captured_mono_ns"):
                self.capture_mono_ns = timing.get("captured_mono_ns")
            if timing.get("encode_ms") is not None:
                self.encode_ms = timing.get("encode_ms")
            if timing.get("decode_ms") is not None:
                self.decode_ms = timing.get("decode_ms")
            if timing.get("transport"):
                self.rtsp_transport = timing.get("transport")
            if timing.get("decoder"):
                self.rtsp_decoder = timing.get("decoder")
            if timing.get("backend"):
                self.rtsp_backend = timing.get("backend")
            if timing.get("width"):
                self.jpeg_width = timing.get("width")
            if timing.get("height"):
                self.jpeg_height = timing.get("height")
            count = self.frame_count
            resolved = self.resolved
        if self.bus is not None:
            self.bus.publish(self.cam_id, {
                "cam_id": self.cam_id,
                "jpeg": jpeg,
                "bgr": bgr,
                "seq": count,
                "frame_count": count,
                "captured_utc_ns": timing.get("captured_utc_ns"),
                "captured_mono_ns": timing.get("captured_mono_ns"),
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
            self.capture_utc_ns = None
            self.capture_mono_ns = None
            self.decode_ms = None
            self.encode_ms = None

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

    def latest_packet(self):
        jpeg = self.latest_jpeg()
        if not jpeg:
            return None
        with self.lock:
            return {
                "jpeg": jpeg,
                "seq": self.frame_count,
                "captured_utc_ns": getattr(self, "capture_utc_ns", None),
            }

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
            self.capture_utc_ns = time.time_ns()
            captured = self.capture_utc_ns
        if bus is not None:
            bus.publish(self.cam_id, {
                "cam_id": self.cam_id,
                "jpeg": SYNTHETIC_JPEG,
                "bgr": None,
                "seq": count,
                "frame_count": count,
                "captured_utc_ns": captured,
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
        packet = self.frame_packet(cam_id)
        if not packet:
            return None
        return packet.get("jpeg")

    def frame_packet(self, cam_id):
        key = str(cam_id or "").strip().lower()
        slot = self.slots.get(key)
        if not slot:
            return None
        if hasattr(slot, "latest_packet"):
            return slot.latest_packet()
        jpeg = slot.latest_jpeg()
        if not jpeg:
            return None
        return {"jpeg": jpeg}

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


def ingest_frame_packet(cam_id):
    return get_ingest().frame_packet(cam_id)


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
