"""Cam0 service. Fail-soft: any capture error stays inside this thread."""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path

from .ae import AeConfig, AeLimits, AutoExposure
from .attitude import AttitudeTagger
from .bus import FrameBus
from .calibration import (
    calibration_document,
    find_checkerboard,
    load_latest,
    render_checkerboard,
    save_calibration,
    solve_intrinsics,
)
from .jpegenc import JpegWorker
from .marker import MarkerModule
from .modules import ModuleHost
from .png16 import encode_png16
from .rawfmt import frame_stats
from .record import Recorder

_SERVICE = None
_SERVICE_LOCK = threading.Lock()


def load_config(path=None, env=None):
    import json
    src = env if env is not None else os.environ
    defaults = {
        "enabled": True,
        "source": "v4l2",
        "device": "/dev/video0",
        "width": 1280,
        "height": 800,
        "fps": 60,
        "vehicle_id": "airvix",
        "record_root": str(Path.home() / "vlc-companion" / "flight-logs"),
        "calibration_dir": str(Path.home() / "vlc-companion" / "cam0-calibration"),
        "auto_record_on_arm": False,
        "marker_size_m": 0.16,
        "marker_enabled": True,
        "ae": {
            "enabled": True,
            "target_mean": 0.42,
            "target_percentile": 0.78,
            "hysteresis": 0.035,
            "exposure_us_min": 10,
            "exposure_us_max": 100001,
            "prefer_exposure_us_max": 4000,
            "gain_min": 16,
            "gain_max": 256,
            "flicker_quantum_us": 10000,
            "exposure_us": 2000,
            "gain": 16,
        },
        "stream": {"fps": 8, "quality": 55, "max_width": 640},
        "synthetic": {"width": 160, "height": 120, "fps": 15, "marker_id": 7, "marker_px": 54},
        "bus_slots": 3,
    }
    cfg_path = path or src.get("VLC_CAM0_CONFIG") or ""
    if cfg_path and os.path.isfile(cfg_path):
        try:
            loaded = json.loads(Path(cfg_path).read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                defaults = _merge(defaults, loaded)
        except Exception:
            pass
    if src.get("VLC_CAM0_SOURCE"):
        defaults["source"] = src["VLC_CAM0_SOURCE"].strip().lower()
    if src.get("VLC_CAM0_DEVICE"):
        defaults["device"] = src["VLC_CAM0_DEVICE"].strip()
    if src.get("VLC_CAM0_ENABLED"):
        defaults["enabled"] = src["VLC_CAM0_ENABLED"].strip().lower() in {"1", "true", "yes", "on"}
    if src.get("VLC_CAM0_RECORD_ROOT"):
        defaults["record_root"] = src["VLC_CAM0_RECORD_ROOT"]
    if src.get("VLC_CAM0_CALIBRATION_DIR"):
        defaults["calibration_dir"] = src["VLC_CAM0_CALIBRATION_DIR"]
    return defaults


def _merge(base, overlay):
    out = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


class Cam0Service:
    def __init__(self, config):
        self.config = config
        ae_cfg = config.get("ae") or {}
        limits = AeLimits(
            exposure_us_min=int(ae_cfg.get("exposure_us_min", 10)),
            exposure_us_max=int(ae_cfg.get("exposure_us_max", 100001)),
            prefer_exposure_us_max=int(ae_cfg.get("prefer_exposure_us_max", 4000)),
            gain_min=int(ae_cfg.get("gain_min", 16)),
            gain_max=int(ae_cfg.get("gain_max", 256)),
            flicker_quantum_us=int(ae_cfg.get("flicker_quantum_us", 10000)),
        )
        self.ae = AutoExposure(
            AeConfig(
                enabled=bool(ae_cfg.get("enabled", True)),
                target_mean=float(ae_cfg.get("target_mean", 0.42)),
                target_percentile=float(ae_cfg.get("target_percentile", 0.78)),
                hysteresis=float(ae_cfg.get("hysteresis", 0.035)),
                limits=limits,
            ),
            exposure_us=int(ae_cfg.get("exposure_us", 2000)),
            gain=int(ae_cfg.get("gain", 16)),
        )
        self.tagger = AttitudeTagger()
        self.recorder = Recorder(config.get("record_root"), config.get("vehicle_id"))
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self.source = None
        self.bus = None
        self.host = None
        self.state = "absent"
        self.error = None
        self.camera_ok = False
        self.fps = None
        self.jpeg = None
        self.snapshot_png = None
        self._snapshot_raw = None
        self._stages_ms = {}
        self._encoder = JpegWorker()
        self.latest_meta = {}
        self._intervals = []
        self._last_mono = None
        self._calib_views = []
        self._calib_version = 0
        self._was_armed = False
        self._stream_next = 0.0

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        if not self.config.get("enabled", True) or str(self.config.get("source") or "").lower() in {"off", "disabled"}:
            self.state = "disabled"
            self.camera_ok = False
            return
        self._stop.clear()
        self._encoder.start()
        self._thread = threading.Thread(target=self._guard, name="cam0", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._encoder:
            self._encoder.stop()
        if self.host:
            self.host.stop()
        if self.source is not None and hasattr(self.source, "close"):
            try:
                self.source.close()
            except Exception:
                pass

    def observe_mavlink(self, data):
        try:
            self.tagger.observe(data)
        except Exception:
            return

    def _guard(self):
        while not self._stop.is_set():
            try:
                if not self._open_source():
                    self._stop.wait(1.5)
                    continue
                self._pump()
            except Exception as exc:
                from .v4l2cap import describe_capture_error
                self.error = describe_capture_error(exc)
                self.state = "read_failed"
                self.camera_ok = False
                if self.source is not None and hasattr(self.source, "close"):
                    try:
                        self.source.close()
                    except Exception:
                        pass
                self.source = None
                self._stop.wait(1.0)

    def _open_source(self):
        kind = str(self.config.get("source") or "v4l2").lower()
        if kind in {"synthetic", "syn"}:
            from .synthetic import SyntheticSource
            syn = self.config.get("synthetic") or {}
            self.source = SyntheticSource(
                width=int(syn.get("width", 160)),
                height=int(syn.get("height", 120)),
                fps=float(syn.get("fps", 15)),
                marker_id=int(syn.get("marker_id", 7)),
                marker_px=int(syn.get("marker_px", 54)),
            )
        else:
            device = self.config.get("device") or "/dev/video0"
            if not os.path.exists(device):
                self.state = "absent"
                self.error = "device_absent"
                self.camera_ok = False
                self.source = None
                return False
            from .v4l2cap import V4l2Source
            self.source = V4l2Source(
                device=device,
                width=int(self.config.get("width", 1280)),
                height=int(self.config.get("height", 800)),
                fps=int(self.config.get("fps", 60)),
            )
            self.state = "opening"
            self.source.open()
        self.source.set_exposure_gain(
            self.ae.state.exposure_us,
            self.ae.state.gain,
            fps=self.config.get("fps"),
        )
        frame = self.source.read()
        self._ensure_bus(frame["width"], frame["height"])
        self._publish(frame)
        self.state = "streaming"
        self.error = None
        return True

    def _ensure_bus(self, width, height):
        if self.bus is not None and self.bus.width == width and self.bus.height == height:
            return
        if self.host:
            self.host.stop()
        if self.bus:
            self.bus.unlink()
        name = f"cam0-{os.getpid()}"
        self.bus = FrameBus(name=name, width=width, height=height, slots=int(self.config.get("bus_slots", 3)), keep_u16=True)
        calib = load_latest(self.config.get("calibration_dir"))
        intrinsics = (calib or {}).get("intrinsics")
        self.calibration_nominal = False
        if intrinsics is None and str(self.config.get("source") or "").lower() in {"synthetic", "syn"}:
            intrinsics = {
                "fx": 800.0,
                "fy": 800.0,
                "cx": (float(width) - 1) / 2.0,
                "cy": (float(height) - 1) / 2.0,
            }
            self.calibration_nominal = True
        marker = MarkerModule(intrinsics=intrinsics, marker_size_m=float(self.config.get("marker_size_m", 0.16)))
        self.host = ModuleHost(self.bus)
        self.host.register(marker, enabled=bool(self.config.get("marker_enabled", True)))
        self.host.start()

    def _pump(self):
        while not self._stop.is_set():
            frame = self.source.read()
            self._publish(frame)

    def _publish(self, frame):
        t0 = time.perf_counter()
        mean, pct = frame_stats(frame, 90.0)
        t1 = time.perf_counter()
        if self.ae.state.enabled:
            self.ae.update(mean, pct, fps=self.config.get("fps"))
            self.source.set_exposure_gain(
                self.ae.state.exposure_us,
                self.ae.state.gain,
                fps=self.config.get("fps"),
            )
        t2 = time.perf_counter()
        tag = self.tagger.tag(frame["t_monotonic_ns"], frame["t_utc_ns"])
        self._maybe_arm(tag.get("armed"))
        # Marker runs on its own thread. Capture only reads the latest result.
        detections = []
        if self.host:
            latest = self.host.latest("marker")
            if latest:
                detections = latest.get("detections") or []
        meta = {
            "index": frame["index"],
            "t_monotonic_ns": frame["t_monotonic_ns"],
            "t_utc_ns": frame["t_utc_ns"],
            "exposure_us": frame["exposure_us"],
            "gain": frame["gain"],
            "dropped": frame["dropped"],
            "source": frame["source"],
            "real": frame["real"],
            "temperature_c": frame.get("temperature_c"),
            "attitude": tag.get("attitude"),
            "position": tag.get("position"),
            "rangefinder_m": tag.get("rangefinder_m"),
            "armed": tag.get("armed"),
            "latency_ms": tag.get("latency_ms"),
            "clock_offset_ns": tag.get("clock_offset_ns"),
            "clock_source": tag.get("clock_source"),
            "width": frame["width"],
            "height": frame["height"],
        }
        self.bus.publish(frame["mono8"], meta, None)
        t3 = time.perf_counter()
        now = time.monotonic()
        if self._last_mono is not None:
            self._intervals.append(now - self._last_mono)
            self._intervals = self._intervals[-30:]
        self._last_mono = now
        fps = None
        if len(self._intervals) >= 2:
            fps = round((len(self._intervals)) / max(1e-6, sum(self._intervals)), 2)
        stream = self.config.get("stream") or {}
        min_gap = 1.0 / max(1.0, float(stream.get("fps", 8)))
        if now >= self._stream_next or self._encoder.latest() is None:
            self._encoder.submit(
                frame["mono8"],
                quality=int(stream.get("quality", 55)),
                max_width=int(stream.get("max_width", 640)),
            )
            self._stream_next = now + min_gap
        jpeg = self._encoder.latest()
        if self.recorder.active and jpeg:
            meta["detections"] = detections
            self.recorder.write(jpeg, meta)
        stages = dict((frame.get("stages_ms") or {}))
        stages["stats"] = round((t1 - t0) * 1000.0, 3)
        stages["ae"] = round((t2 - t1) * 1000.0, 3)
        stages["publish"] = round((t3 - t2) * 1000.0, 3)
        if self._encoder.stage_ms is not None:
            stages["jpeg"] = self._encoder.stage_ms
        with self._lock:
            self.jpeg = jpeg
            self._snapshot_raw = frame.get("raw_u16")
            self.snapshot_png = None
            self.latest_meta = meta
            self._stages_ms = stages
            self.fps = fps
            self.camera_ok = True
            self.state = "streaming"
            self.error = None

    def _maybe_arm(self, armed):
        if not self.config.get("auto_record_on_arm"):
            self._was_armed = bool(armed)
            return
        if armed is True and not self._was_armed:
            self.recorder.start()
        elif armed is False and self._was_armed:
            self.recorder.stop()
        self._was_armed = bool(armed)

    def apply_settings(self, body):
        body = body or {}
        if "ae" in body and isinstance(body["ae"], dict) and "enabled" in body["ae"]:
            self.ae.set_enabled(bool(body["ae"]["enabled"]))
        if body.get("manual") is True or body.get("ae_enabled") is False:
            self.ae.set_enabled(False)
        if "exposure_us" in body or "gain" in body:
            if body.get("ae_enabled") is not True and (body.get("manual") is True or not self.ae.state.enabled):
                self.ae.set_manual(body.get("exposure_us"), body.get("gain"))
                if self.source is not None:
                    self.source.set_exposure_gain(
                        self.ae.state.exposure_us,
                        self.ae.state.gain,
                        fps=self.config.get("fps"),
                    )
        stream = self.config.setdefault("stream", {})
        if isinstance(body.get("stream"), dict):
            stream.update(body["stream"])
        if "width" in body:
            self.config["width"] = int(body["width"])
        if "height" in body:
            self.config["height"] = int(body["height"])
        if "fps" in body:
            self.config["fps"] = int(body["fps"])
        if "auto_record_on_arm" in body:
            self.config["auto_record_on_arm"] = bool(body["auto_record_on_arm"])
        return self.settings()

    def _ae_status(self):
        ae = self.ae.snapshot()
        src = self.source
        if src is None:
            return ae
        for key in ("exposure_driver", "exposure_unit", "gain_driver"):
            val = getattr(src, key, None)
            if val is not None:
                ae[key] = val
        return ae

    def settings(self):
        return {
            "ok": True,
            "source": self.config.get("source"),
            "device": self.config.get("device"),
            "width": self.config.get("width"),
            "height": self.config.get("height"),
            "fps": self.config.get("fps"),
            "ae": self._ae_status(),
            "stream": self.config.get("stream"),
            "auto_record_on_arm": bool(self.config.get("auto_record_on_arm")),
            "marker_size_m": self.config.get("marker_size_m"),
            "flight_commands": False,
        }

    def status(self):
        with self._lock:
            meta = dict(self.latest_meta)
            fps = self.fps
            state = self.state
            error = self.error
            stages = dict(self._stages_ms)
            camera_ok = self.camera_ok and state == "streaming"
        age = None
        if meta.get("t_monotonic_ns"):
            age = round((time.monotonic_ns() - int(meta["t_monotonic_ns"])) / 1e6, 1)
            if age > 1500:
                camera_ok = False
        temp = meta.get("temperature_c")
        return {
            "ok": True,
            "camera": "cam0",
            "observe_only": True,
            "flight_commands": False,
            "state": state,
            "camera_ok": camera_ok,
            "real": meta.get("real") is True and camera_ok,
            "source": meta.get("source") or ("absent" if state != "streaming" else self.config.get("source")),
            "dry_run": meta.get("source") == "synthetic",
            "fps": fps if camera_ok else None,
            "dropped": meta.get("dropped"),
            "latency_ms": meta.get("latency_ms"),
            "temperature_c": temp,
            "ae": self._ae_status(),
            "stages_ms": stages,
            "exposure_us": meta.get("exposure_us"),
            "gain": meta.get("gain"),
            "width": meta.get("width"),
            "height": meta.get("height"),
            "frame_index": meta.get("index"),
            "last_frame_age_ms": age,
            "recording": self.recorder.status(),
            "modules": self.host.list() if self.host else [],
            "clock_offset_ns": meta.get("clock_offset_ns"),
            "clock_source": meta.get("clock_source"),
            "attitude": meta.get("attitude"),
            "calibration_nominal": bool(getattr(self, "calibration_nominal", False)),
            "error": error,
            "has_frame": self.jpeg is not None and camera_ok,
        }

    def health(self):
        st = self.status()
        return {
            "ok": True,
            "camera_ok": st["camera_ok"],
            "state": st["state"],
            "fps": st["fps"],
            "dropped": st["dropped"],
            "temperature_c": st["temperature_c"],
            "latency_ms": st["latency_ms"],
            "ae": st["ae"],
            "error": st["error"],
            "flight_commands": False,
        }

    def frame_jpeg(self):
        st = self.status()
        if not st["has_frame"]:
            return None
        return self.jpeg

    def snapshot_bytes(self):
        if not self.status()["camera_ok"]:
            return None
        with self._lock:
            raw = self._snapshot_raw
        if raw is None:
            return None
        return encode_png16(raw)

    def detections(self):
        latest = self.host.latest("marker") if self.host else None
        rows = [] if not latest else (latest.get("detections") or [])
        return {
            "ok": True,
            "observe_only": True,
            "flight_commands": False,
            "frame_index": None if not latest else latest.get("frame_index"),
            "detections": rows,
            "latency_ms": None if not latest else latest.get("latency_ms"),
        }

    def capture_calibration(self, body):
        body = body or {}
        cols = int(body.get("inner_cols", 5))
        rows = int(body.get("inner_rows", 4))
        square_m = float(body.get("square_m", 0.025))
        with self._lock:
            mono = None
            if self.bus is not None:
                view = self.bus.latest()
                if view is not None:
                    mono = view.mono8.copy()
            width = (self.latest_meta or {}).get("width") or self.config.get("width")
            height = (self.latest_meta or {}).get("height") or self.config.get("height")
        if body.get("synthetic_board") and str(self.config.get("source")).lower() == "synthetic":
            mono, _known = render_checkerboard(int(width or 160), int(height or 120), cols, rows, int(body.get("square_px", 12)))
        if mono is None:
            return {"ok": False, "reason": "no_frame"}
        corners = find_checkerboard(mono, cols, rows)
        if not corners:
            return {"ok": False, "reason": "board_not_found", "captured": len(self._calib_views)}
        self._calib_views.append({
            "corners": corners,
            "inner_cols": cols,
            "inner_rows": rows,
            "square_m": square_m,
        })
        return {"ok": True, "corners": len(corners), "captured": len(self._calib_views)}

    def solve_calibration(self):
        if not self._calib_views:
            return {"ok": False, "reason": "no_captures"}
        width = int((self.latest_meta or {}).get("width") or self.config.get("width") or 0)
        height = int((self.latest_meta or {}).get("height") or self.config.get("height") or 0)
        solved = solve_intrinsics(self._calib_views, width, height)
        if not solved:
            return {"ok": False, "reason": "solve_failed"}
        self._calib_version += 1
        doc = calibration_document(solved, width, height, self._calib_version)
        path = save_calibration(self.config.get("calibration_dir"), doc)
        if self.host:
            marker = None
            with self.host._lock:
                slot = self.host._mods.get("marker")
                if slot:
                    marker = slot["module"]
            if marker is not None:
                marker.intrinsics = doc["intrinsics"]
        return {"ok": True, "path": str(path), "calibration": doc}

    def calibration(self):
        doc = load_latest(self.config.get("calibration_dir"))
        return {"ok": True, "calibration": doc, "captures": len(self._calib_views), "camera_to_body": None if not doc else doc.get("camera_to_body")}


def get_service():
    return _SERVICE


def start_service(config=None, env=None):
    global _SERVICE
    with _SERVICE_LOCK:
        if _SERVICE is not None:
            return _SERVICE
        try:
            cfg = config or load_config(env=env)
            svc = Cam0Service(cfg)
            svc.start()
            _SERVICE = svc
            return svc
        except Exception:
            _SERVICE = None
            return None


def service_status():
    svc = get_service()
    if svc is None:
        return {
            "ok": True,
            "camera": "cam0",
            "state": "absent",
            "camera_ok": False,
            "real": False,
            "source": "absent",
            "has_frame": False,
            "error": "service_not_started",
            "flight_commands": False,
            "observe_only": True,
        }
    return svc.status()
