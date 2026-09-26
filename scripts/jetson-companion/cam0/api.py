"""HTTP routes for Cam0. The companion handler stays the authenticator."""

from __future__ import annotations

import json
from urllib.parse import parse_qs, urlparse

from .service import get_service, service_status


def _qs(path):
    return parse_qs(urlparse(path).query)


def _json_body(handler, code, obj):
    handler._json(code, obj)


def try_handle(handler, body=None):
    """Return True when the request belonged to Cam0."""
    full = handler.path
    path = full.split("?", 1)[0]
    if not (path.startswith("/api/v1/cam0") or path.startswith("/api/cameras/cam0") or path.startswith("/api/v1/cameras/cam0")):
        return False
    method = handler.command
    svc = get_service()
    if path in ("/api/v1/cameras/cam0/frame", "/api/v1/cameras/cam0/frame.jpg", "/api/cameras/cam0/frame", "/api/cameras/cam0/frame.jpg"):
        jpeg = svc.frame_jpeg() if svc else None
        if not jpeg:
            _json_body(handler, 404, {"ok": False, "camera_ok": False, "reason": "no_frame", "note": "אין אות"})
            return True
        handler._send_bytes(200, jpeg, "image/jpeg", extra=(("Cache-Control", "no-store"),))
        return True
    if path in ("/api/v1/cam0/status", "/api/v1/cam0/health") and method == "GET":
        if path.endswith("/health"):
            payload = svc.health() if svc else service_status()
        else:
            payload = service_status()
        _json_body(handler, 200, payload)
        return True
    if path == "/api/v1/cam0/settings" and method == "GET":
        if svc is None:
            _json_body(handler, 200, {"ok": True, "source": "absent", "flight_commands": False})
            return True
        _json_body(handler, 200, svc.settings())
        return True
    if path == "/api/v1/cam0/settings" and method == "POST":
        if svc is None:
            _json_body(handler, 503, {"ok": False, "reason": "service_absent"})
            return True
        _json_body(handler, 200, svc.apply_settings(body or {}))
        return True
    if path == "/api/v1/cam0/stream.mjpg" and method == "GET":
        _write_mjpeg(handler, svc)
        return True
    if path in ("/api/v1/cam0/snapshot.png", "/api/v1/cam0/snapshot") and method == "GET":
        png = svc.snapshot_bytes() if svc else None
        if not png:
            _json_body(handler, 404, {"ok": False, "reason": "no_frame", "note": "אין אות"})
            return True
        handler._send_bytes(200, png, "image/png", extra=(("Cache-Control", "no-store"),))
        return True
    if path == "/api/v1/cam0/record/start" and method == "POST":
        if svc is None:
            _json_body(handler, 503, {"ok": False, "reason": "service_absent"})
            return True
        flight = (body or {}).get("flight_id")
        _json_body(handler, 200, {"ok": True, **svc.recorder.start(flight)})
        return True
    if path == "/api/v1/cam0/record/stop" and method == "POST":
        if svc is None:
            _json_body(handler, 503, {"ok": False, "reason": "service_absent"})
            return True
        _json_body(handler, 200, {"ok": True, **svc.recorder.stop()})
        return True
    if path == "/api/v1/cam0/recordings" and method == "GET":
        rows = svc.recorder.list_recordings() if svc else []
        _json_body(handler, 200, {"ok": True, "recordings": rows})
        return True
    if path.startswith("/api/v1/cam0/recordings/") and method == "GET":
        return _recording(handler, svc, path)
    if path == "/api/v1/cam0/modules" and method == "GET":
        _json_body(handler, 200, {"ok": True, "modules": [] if svc is None or svc.host is None else svc.host.list()})
        return True
    if path.startswith("/api/v1/cam0/modules/") and method in {"GET", "POST"}:
        return _module(handler, svc, path, method, body)
    if path == "/api/v1/cam0/detections" and method == "GET":
        _json_body(handler, 200, svc.detections() if svc else {"ok": True, "detections": [], "flight_commands": False})
        return True
    if path == "/api/v1/cam0/calibration" and method == "GET":
        _json_body(handler, 200, svc.calibration() if svc else {"ok": True, "calibration": None})
        return True
    if path == "/api/v1/cam0/calibration/capture" and method == "POST":
        if svc is None:
            _json_body(handler, 503, {"ok": False, "reason": "service_absent"})
            return True
        _json_body(handler, 200, svc.capture_calibration(body or {}))
        return True
    if path == "/api/v1/cam0/calibration/solve" and method == "POST":
        if svc is None:
            _json_body(handler, 503, {"ok": False, "reason": "service_absent"})
            return True
        _json_body(handler, 200, svc.solve_calibration())
        return True
    _json_body(handler, 404, {"ok": False, "reason": "not_found"})
    return True


def _recording(handler, svc, path):
    rest = path[len("/api/v1/cam0/recordings/"):]
    parts = rest.split("/")
    flight = parts[0]
    if svc is None:
        _json_body(handler, 404, {"ok": False, "reason": "no_recording"})
        return True
    if len(parts) == 1 or parts[1] in {"meta", "frames.jsonl"}:
        rows = svc.recorder.read_frames(flight)
        if rows is None:
            _json_body(handler, 404, {"ok": False, "reason": "no_recording"})
            return True
        _json_body(handler, 200, {"ok": True, "flight_id": flight, "frames": rows})
        return True
    if parts[1] in {"frame", "frame.jpg"}:
        qs = _qs(handler.path)
        index = 0
        if "i" in qs:
            index = int(qs["i"][0])
        elif "t_rel_s" in qs:
            rows = svc.recorder.read_frames(flight) or []
            target = float(qs["t_rel_s"][0])
            chosen = None
            for row in rows:
                rel = row.get("t_rel_s")
                if rel is None:
                    continue
                if chosen is None or abs(float(rel) - target) < abs(float(chosen.get("t_rel_s")) - target):
                    chosen = row
            if chosen is None:
                _json_body(handler, 404, {"ok": False, "reason": "no_frame", "note": "אין אות"})
                return True
            index = int(chosen["i"])
        jpeg = svc.recorder.read_jpeg(flight, index)
        if not jpeg:
            _json_body(handler, 404, {"ok": False, "reason": "no_frame", "note": "אין אות"})
            return True
        handler._send_bytes(200, jpeg, "image/jpeg", extra=(("Cache-Control", "no-store"),))
        return True
    _json_body(handler, 404, {"ok": False})
    return True


def _module(handler, svc, path, method, body):
    rest = path[len("/api/v1/cam0/modules/"):]
    parts = rest.split("/")
    name = parts[0]
    if svc is None or svc.host is None:
        _json_body(handler, 404, {"ok": False, "reason": "no_module"})
        return True
    if len(parts) > 1 and parts[1] == "results" and method == "GET":
        rows = svc.host.results(name)
        if rows is None:
            _json_body(handler, 404, {"ok": False, "reason": "no_module"})
            return True
        _json_body(handler, 200, {"ok": True, "name": name, "results": rows, "flight_commands": False})
        return True
    if method == "POST":
        enabled = bool((body or {}).get("enabled", True))
        ok = svc.host.set_enabled(name, enabled)
        _json_body(handler, 200 if ok else 404, {"ok": ok, "name": name, "enabled": enabled})
        return True
    rows = svc.host.list()
    hit = next((row for row in rows if row["name"] == name), None)
    if hit is None:
        _json_body(handler, 404, {"ok": False, "reason": "no_module"})
        return True
    _json_body(handler, 200, {"ok": True, "module": hit})
    return True


def _write_mjpeg(handler, svc):
    handler.close_connection = True
    if svc is None:
        _json_body(handler, 404, {"ok": False, "reason": "no_frame", "note": "אין אות"})
        return
    handler.send_response(200)
    handler.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Connection", "close")
    handler.end_headers()
    boundary = b"--frame\r\n"
    blank = 0
    try:
        while blank < 50:
            jpeg = svc.frame_jpeg()
            if not jpeg:
                blank += 1
                time_sleep = __import__("time").sleep
                time_sleep(0.1)
                continue
            blank = 0
            header = boundary + b"Content-Type: image/jpeg\r\nContent-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
            handler.wfile.write(header)
            handler.wfile.write(jpeg)
            handler.wfile.write(b"\r\n")
            handler.wfile.flush()
            __import__("time").sleep(1.0 / max(1.0, float((svc.config.get("stream") or {}).get("fps", 8))))
    except Exception:
        handler.close_connection = True
