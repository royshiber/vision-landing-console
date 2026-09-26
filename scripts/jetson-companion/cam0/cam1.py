"""Second OV9281 (CAM1). Capture runs only while a client holds the stream.

Cam0 already spends about one core at 60 fps. This instance stays idle at
boot, opens its own device, and caps capture at 30 fps with JPEG at 15 Hz.
It never sends flight commands and never touches the cam0 pipeline.
"""

from __future__ import annotations

import os
import threading
import time

from .devices import resolve_device
from .jpegenc import encode_gray_jpeg
from .png16 import encode_png16

CAPTURE_FPS_MAX = 30
JPEG_HZ = 15
_SERVICE = None
_SERVICE_LOCK = threading.Lock()


def load_config(env=None):
    src = env if env is not None else os.environ
    source = (src.get("VLC_CAM1_SOURCE") or "v4l2").strip().lower()
    if src.get("VLC_CAM1_DEVICE"):
        device = src["VLC_CAM1_DEVICE"].strip()
    elif source == "synthetic":
        device = "/dev/airvix-cam1"
    else:
        device = resolve_device(
            stable_path="/dev/airvix-cam1",
            name_token="10-0060",
            fallback="/dev/airvix-cam1",
            sysfs_root=src.get("VLC_V4L_SYSFS") or "/sys/class/video4linux",
        )
    return {
        "source": source,
        "device": device,
        "width": 1280,
        "height": 800,
        "fps": CAPTURE_FPS_MAX,
        "ae_enabled": True,
        "exposure_us": 2000,
        "gain": 16,
        "stream": {"fps": JPEG_HZ, "quality": 55, "max_width": 640},
        "flight_commands": False,
    }


class Cam1Service:
    def __init__(self, config):
        self.config = dict(config)
        self.config["stream"] = dict(config.get("stream") or {})
        self.clients = 0
        self.state = "idle"
        self.camera_ok = False
        self.fps = None
        self.jpeg = None
        self.error = None
        self.jpeg_count = 0
        self._frame = None
        self._raw = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._opened = False

    def acquire(self):
        with self._lock:
            self.clients += 1
            # A thread that is winding down still looks alive. Clear stop so it
            # keeps the new client instead of exiting into a 404.
            self._stop.clear()
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(target=self._run, name="cam1-capture", daemon=True)
            self._thread.start()

    def release(self):
        with self._lock:
            self.clients = max(0, self.clients - 1)
            if self.clients == 0:
                self._stop.set()

    def _should_stop(self):
        """True only when no client remains. A new client clears the stop."""
        with self._lock:
            if self.clients > 0:
                if self._stop.is_set():
                    self._stop.clear()
                return False
            return True

    def wait_camera(self, timeout=1.5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if self.camera_ok:
                    return True
                if self.clients <= 0:
                    return False
            self._stop.wait(0.05)
        with self._lock:
            return self.camera_ok

    def health(self):
        present = self._device_present()
        with self._lock:
            streaming = self.camera_ok and self.state == "streaming"
            payload = {
                "ok": True,
                "camera": "cam1",
                "camera_ok": streaming,
                "state": self.state if present or streaming else "absent",
                "fps": self.fps if streaming else None,
                "dropped": None if self._frame is None else self._frame.get("dropped"),
                "latency_ms": None if not streaming else self._latency_ms_locked(),
                "temperature_c": None if self._frame is None else self._frame.get("temperature_c"),
                "error": self.error,
                "source": "absent" if not present and not streaming else self.config.get("source"),
                "device": self.config.get("device"),
                "clients": self.clients,
                "flight_commands": False,
                "real": bool(streaming and self._frame and self._frame.get("real") is True),
            }
        if not present and not streaming:
            payload["state"] = "absent"
            payload["camera_ok"] = False
            payload["fps"] = None
            payload["source"] = "absent"
            payload["note"] = "לא מחובר"
        return payload

    def status(self):
        health = self.health()
        with self._lock:
            frame = self._frame
            settings = self._settings_locked()
        has = health["camera_ok"] and self.jpeg is not None
        return {
            **health,
            "observe_only": True,
            "has_frame": has,
            "width": None if frame is None else frame.get("width"),
            "height": None if frame is None else frame.get("height"),
            "exposure_us": self.config.get("exposure_us"),
            "gain": self.config.get("gain"),
            "ae": {"enabled": bool(self.config.get("ae_enabled"))},
            "stream": settings["stream"],
            "capture_fps": settings.get("fps"),
            "dry_run": self.config.get("source") == "synthetic",
        }

    def settings(self):
        with self._lock:
            return self._settings_locked()

    def apply_settings(self, body):
        body = body or {}
        with self._lock:
            if "ae_enabled" in body or (isinstance(body.get("ae"), dict) and "enabled" in body["ae"]):
                enabled = body.get("ae_enabled")
                if enabled is None:
                    enabled = body["ae"]["enabled"]
                self.config["ae_enabled"] = bool(enabled)
            if body.get("manual") is True:
                self.config["ae_enabled"] = False
            if "exposure_us" in body and body["exposure_us"] is not None:
                self.config["exposure_us"] = int(body["exposure_us"])
            if "gain" in body and body["gain"] is not None:
                self.config["gain"] = int(body["gain"])
            if "width" in body:
                self.config["width"] = int(body["width"])
            if "height" in body:
                self.config["height"] = int(body["height"])
            if "fps" in body and body["fps"] is not None:
                self.config["fps"] = max(1, min(CAPTURE_FPS_MAX, int(body["fps"])))
            stream = self.config.setdefault("stream", {})
            if isinstance(body.get("stream"), dict) and body["stream"].get("fps") is not None:
                stream["fps"] = max(1, min(JPEG_HZ, int(body["stream"]["fps"])))
            self.config["settings_dirty"] = True
            return self._settings_locked()

    def frame_jpeg(self):
        if not self.health()["camera_ok"]:
            return None
        return self.jpeg

    def snapshot_bytes(self):
        self.acquire()
        try:
            if not self.wait_camera(1.5):
                return None
            with self._lock:
                raw = None if self._raw is None else self._raw.copy()
            if raw is None:
                return None
            return encode_png16(raw)
        finally:
            self.release()

    def _settings_locked(self):
        stream = dict(self.config.get("stream") or {})
        return {
            "ok": True,
            "source": self.config.get("source"),
            "device": self.config.get("device"),
            "width": self.config.get("width"),
            "height": self.config.get("height"),
            "fps": self.config.get("fps"),
            "ae": {"enabled": bool(self.config.get("ae_enabled"))},
            "exposure_us": self.config.get("exposure_us"),
            "gain": self.config.get("gain"),
            "stream": stream,
            "flight_commands": False,
        }

    def _device_present(self):
        if self.config.get("source") == "synthetic":
            return True
        device = self.config.get("device") or ""
        return bool(device) and os.path.exists(device)

    def _latency_ms_locked(self):
        frame = self._frame
        if not frame or not frame.get("t_monotonic_ns"):
            return None
        return round((time.monotonic_ns() - int(frame["t_monotonic_ns"])) / 1e6, 1)

    def _open_source(self):
        if self.config.get("source") == "synthetic":
            from .synthetic import SyntheticSource
            return SyntheticSource(width=160, height=120, fps=min(CAPTURE_FPS_MAX, int(self.config.get("fps") or 30)))
        device = self.config.get("device") or ""
        if not device or not os.path.exists(device):
            return None
        from .v4l2cap import V4l2Source
        src = V4l2Source(
            device=device,
            width=int(self.config.get("width") or 1280),
            height=int(self.config.get("height") or 800),
            fps=max(1, min(CAPTURE_FPS_MAX, int(self.config.get("fps") or CAPTURE_FPS_MAX))),
        )
        src.open()
        return src

    def _mark_open_failed(self, error):
        with self._lock:
            self.error = error or "open_failed"
            self.camera_ok = False
            self.fps = None
            self._opened = False
            self.state = "error"

    def _run(self):
        source = None
        delay = 0.15
        try:
            while not self._should_stop():
                try:
                    source = self._open_source()
                except Exception as exc:
                    source = None
                    self._mark_open_failed(type(exc).__name__)
                if source is None:
                    self._mark_open_failed(self.error or "open_failed")
                    self._stop.wait(delay)
                    delay = min(2.0, delay * 2)
                    continue
                delay = 0.15
                try:
                    self._capture(source)
                finally:
                    try:
                        source.close()
                    except Exception:
                        pass
                    source = None
                with self._lock:
                    self._opened = False
                    self.camera_ok = False
                    self.fps = None
                    if self.clients > 0 and self.state == "streaming":
                        self.state = "error"
                        self.error = self.error or "read_failed"
        finally:
            if source is not None:
                try:
                    source.close()
                except Exception:
                    pass
            with self._lock:
                self._opened = False
                self.camera_ok = False
                self.fps = None
                self.jpeg = None
                self._frame = None
                self._raw = None
                if self._thread is threading.current_thread():
                    self._thread = None
                if self.clients > 0:
                    self._stop.clear()
                    self._thread = threading.Thread(target=self._run, name="cam1-capture", daemon=True)
                    self._thread.start()
                else:
                    self.state = "idle" if self._device_present() else "absent"
                    self.error = None

    def _capture(self, source):
        with self._lock:
            self._opened = True
            self.state = "streaming"
            self.error = None
        cap_fps = max(1, min(CAPTURE_FPS_MAX, int(self.config.get("fps") or CAPTURE_FPS_MAX)))
        next_frame = time.monotonic()
        next_jpeg = 0.0
        win_t = time.monotonic()
        win_n = 0
        while not self._should_stop():
            now = time.monotonic()
            if now < next_frame:
                self._stop.wait(next_frame - now)
                if self._should_stop():
                    return
            cap_fps = max(1, min(CAPTURE_FPS_MAX, int(self.config.get("fps") or CAPTURE_FPS_MAX)))
            next_frame = time.monotonic() + (1.0 / cap_fps)
            try:
                frame = source.read()
            except Exception as exc:
                with self._lock:
                    self.error = type(exc).__name__
                    self.camera_ok = False
                    self.fps = None
                    self.state = "error"
                self._stop.wait(0.5)
                return
            win_n += 1
            elapsed = time.monotonic() - win_t
            fps = None
            if elapsed >= 0.4:
                fps = round(win_n / elapsed, 1)
                win_t = time.monotonic()
                win_n = 0
            with self._lock:
                self._frame = frame
                raw = frame.get("raw_u16")
                self._raw = None if raw is None else raw
                self.camera_ok = True
                self.state = "streaming"
                if fps is not None:
                    self.fps = fps
                dirty = self.config.pop("settings_dirty", False)
                exposure = int(self.config.get("exposure_us") or 2000)
                gain = int(self.config.get("gain") or 16)
            if dirty and hasattr(source, "set_exposure_gain"):
                try:
                    source.set_exposure_gain(exposure, gain, fps=cap_fps)
                except Exception:
                    pass
            if time.monotonic() >= next_jpeg:
                stream = self.config.get("stream") or {}
                jpeg_hz = max(1, min(JPEG_HZ, int(stream.get("fps") or JPEG_HZ)))
                next_jpeg = time.monotonic() + (1.0 / jpeg_hz)
                mono = frame.get("mono8")
                if mono is not None:
                    jpeg = encode_gray_jpeg(
                        mono,
                        quality=int(stream.get("quality") or 55),
                        max_width=int(stream.get("max_width") or 640),
                    )
                    with self._lock:
                        self.jpeg = jpeg
                        self.jpeg_count += 1


def get_service(env=None):
    global _SERVICE
    with _SERVICE_LOCK:
        if _SERVICE is None:
            _SERVICE = Cam1Service(load_config(env=env))
        return _SERVICE


def reset_service():
    """Test helper. Stops capture and drops the singleton."""
    global _SERVICE
    with _SERVICE_LOCK:
        svc = _SERVICE
        _SERVICE = None
    if svc is not None:
        with svc._lock:
            svc.clients = 0
            svc._stop.set()
            thread = svc._thread
        if thread is not None:
            thread.join(timeout=2.0)


def try_handle(handler, body=None):
    path = handler.path.split("?", 1)[0]
    if not path.startswith("/api/v1/cam1"):
        return False
    method = handler.command
    svc = get_service()
    if path in ("/api/v1/cam1/health", "/api/v1/cam1/status") and method == "GET":
        payload = svc.health() if path.endswith("/health") else svc.status()
        handler._json(200, payload)
        return True
    if path == "/api/v1/cam1/settings" and method == "GET":
        handler._json(200, svc.settings())
        return True
    if path == "/api/v1/cam1/settings" and method == "POST":
        handler._json(200, svc.apply_settings(body or {}))
        return True
    if path == "/api/v1/cam1/stream.mjpg" and method == "GET":
        _write_mjpeg(handler, svc)
        return True
    if path in ("/api/v1/cam1/snapshot", "/api/v1/cam1/snapshot.png") and method == "GET":
        png = svc.snapshot_bytes()
        if not png:
            handler._json(404, {"ok": False, "camera_ok": False, "reason": "no_frame", "note": "אין אות", "flight_commands": False})
            return True
        handler._send_bytes(200, png, "image/png", extra=(("Cache-Control", "no-store"),))
        return True
    handler._json(404, {"ok": False, "reason": "not_found", "flight_commands": False})
    return True


def _write_mjpeg(handler, svc):
    handler.close_connection = True
    svc.acquire()
    try:
        if not svc.wait_camera(1.5):
            handler._json(404, {"ok": False, "camera_ok": False, "reason": "no_frame", "note": "אין אות", "flight_commands": False})
            return
        handler.send_response(200)
        handler.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("Connection", "close")
        handler.end_headers()
        boundary = b"--frame\r\n"
        while not svc._stop.is_set():
            jpeg = svc.frame_jpeg()
            if jpeg:
                header = boundary + b"Content-Type: image/jpeg\r\nContent-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
                handler.wfile.write(header)
                handler.wfile.write(jpeg)
                handler.wfile.write(b"\r\n")
                handler.wfile.flush()
            stream = svc.config.get("stream") or {}
            hz = max(1, min(JPEG_HZ, int(stream.get("fps") or JPEG_HZ)))
            if svc._stop.wait(1.0 / hz):
                break
    except Exception:
        handler.close_connection = True
    finally:
        svc.release()
