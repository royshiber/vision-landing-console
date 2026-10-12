#!/usr/bin/env python3
"""Runway awareness for the down camera or the gimbal.

Finds a paved strip, then the aircraft position against its centerline:
lateral offset, heading error, and progress along the strip. Each value
carries its own confidence. Hazard tracks from the existing detector are
kept only when their box meets the runway polygon.

Levels, default 0:
  0 OFF
  1 DISPLAY
  2 ALERTS
  3 GUIDANCE_SIM  — steering is computed; a command may leave only in SITL
  4 GUIDANCE_REAL — refused unless VLC_RUNWAY_LEVEL4_UNLOCK and the Hebrew confirm

This module does not open a MAVLink socket. emit_commands is the only
send path, and it stays at zero unless the caller passes a sink and the
gate allows SITL.
"""

from __future__ import annotations

import base64
import math
import os
import threading

RUNWAY_CAMERAS = ("cam1", "cam2", "cam3")
LEVEL_NAME = {0: "OFF", 1: "DISPLAY", 2: "ALERTS", 3: "GUIDANCE_SIM", 4: "GUIDANCE_REAL"}
LABEL_HE = {
    0: "כבוי",
    1: "תצוגה",
    2: "התראות",
    3: "הנחיית סימולטור",
    4: "הנחיה אמיתית",
}
CONFIRM_PHRASE = "מאשר"
KIND_HE = {"person": "אדם", "vehicle": "רכב", "animal": "חיה", "obstacle": "מכשול"}
VEHICLES = {"bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat"}
ANIMALS = {"bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe"}

_SERVICE = None
_SERVICE_LOCK = threading.Lock()


def _flag(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def read_level(env=None):
    env = os.environ if env is None else env
    raw = str(env.get("VLC_RUNWAY_LEVEL", "0") or "0").strip()
    try:
        level = int(float(raw))
    except (TypeError, ValueError):
        return 0
    if level < 0 or level > 4:
        return 0
    return level


def level4_unlocked(env=None):
    env = os.environ if env is None else env
    return _flag(env.get("VLC_RUNWAY_LEVEL4_UNLOCK", "0"))


def hazard_kind(name):
    key = str(name or "").strip().lower()
    if key == "person":
        return "person"
    if key in VEHICLES:
        return "vehicle"
    if key in ANIMALS:
        return "animal"
    if key:
        return "obstacle"
    return ""


def _clamp(value, lo, hi):
    return max(lo, min(hi, value))


def point_in_polygon(x, y, polygon):
    if not polygon or len(polygon) < 3:
        return False
    inside = False
    j = len(polygon) - 1
    for i, (xi, yi) in enumerate(polygon):
        xj, yj = polygon[j]
        if (yi > y) != (yj > y):
            denom = (yj - yi) or 1e-9
            if x < (xj - xi) * (y - yi) / denom + xi:
                inside = not inside
        j = i
    return inside


def _cross(p, q, r):
    return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])


def _segments_hit(a, b, c, d):
    d1 = _cross(c, d, a)
    d2 = _cross(c, d, b)
    d3 = _cross(a, b, c)
    d4 = _cross(a, b, d)
    return ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and ((d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0))


def rect_hits_polygon(bbox, polygon):
    if not bbox or len(bbox) < 4 or not polygon or len(polygon) < 3:
        return False
    x, y, w, h = (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
    if w <= 0 or h <= 0:
        return False
    corners = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    if any(point_in_polygon(px, py, polygon) for px, py in corners):
        return True
    if any(point_in_polygon(px, py, corners) for px, py in polygon):
        return True
    rect_edges = list(zip(corners, corners[1:] + corners[:1]))
    poly_edges = list(zip(polygon, polygon[1:] + polygon[:1]))
    for a, b in rect_edges:
        for c, d in poly_edges:
            if _segments_hit(a, b, c, d):
                return True
    return False


def pose_from_polygon(polygon, width, height, alt_m=None, hfov_deg=None, camera="down"):
    """Aircraft at the image center. Positive offset is right of the centerline.

    Positive heading error means the nose must turn right to match the strip.
    Progress is 0 at the far threshold and 1 at the near end.
    """
    empty = {
        "detected": False,
        "offset_px": None,
        "offset_m": None,
        "offset_norm": None,
        "heading_error_deg": None,
        "progress": None,
        "confidence": {"offset": 0.0, "heading": 0.0, "along": 0.0},
        "centerline": None,
        "aircraft": [width / 2.0, height / 2.0] if width and height else None,
        "polygon": None,
    }
    if not polygon or len(polygon) < 4 or width < 2 or height < 2:
        return empty
    pts = [(float(p[0]), float(p[1])) for p in polygon[:4]]
    far_y = min(p[1] for p in pts)
    near_y = max(p[1] for p in pts)
    if near_y - far_y < 4:
        return empty
    far_pts = [p for p in pts if abs(p[1] - far_y) <= (near_y - far_y) * 0.35]
    near_pts = [p for p in pts if abs(p[1] - near_y) <= (near_y - far_y) * 0.35]
    if len(far_pts) < 2 or len(near_pts) < 2:
        ordered = sorted(pts, key=lambda p: p[1])
        far_pts, near_pts = ordered[:2], ordered[-2:]
    far = ((far_pts[0][0] + far_pts[1][0]) / 2.0, (far_pts[0][1] + far_pts[1][1]) / 2.0)
    near = ((near_pts[0][0] + near_pts[1][0]) / 2.0, (near_pts[0][1] + near_pts[1][1]) / 2.0)
    ax, ay = width / 2.0, height / 2.0
    span_y = near[1] - far[1]
    if abs(span_y) < 1e-6:
        return empty
    t_row = _clamp((ay - far[1]) / span_y, 0.0, 1.0)
    line_x = far[0] + (near[0] - far[0]) * t_row
    left_far = min(p[0] for p in far_pts)
    right_far = max(p[0] for p in far_pts)
    left_near = min(p[0] for p in near_pts)
    right_near = max(p[0] for p in near_pts)
    half = ((right_far - left_far) * (1.0 - t_row) + (right_near - left_near) * t_row) / 2.0
    offset_px = ax - line_x
    offset_norm = offset_px / half if half > 1 else None
    offset_m = None
    try:
        alt = float(alt_m) if alt_m is not None else None
        fov = float(hfov_deg) if hfov_deg is not None else None
    except (TypeError, ValueError):
        alt, fov = None, None
    if alt and alt > 0 and fov and 1 < fov < 170:
        ground_w = 2.0 * alt * math.tan(math.radians(fov) / 2.0)
        offset_m = offset_px * (ground_w / float(width))
    heading = math.degrees(math.atan2(far[0] - near[0], near[1] - far[1]))
    along = (near[0] - far[0], near[1] - far[1])
    denom = along[0] * along[0] + along[1] * along[1]
    progress = _clamp(((ax - far[0]) * along[0] + (ay - far[1]) * along[1]) / denom, 0.0, 1.0) if denom > 1 else None
    straight = 1.0 if abs(heading) < 25 else 0.55
    width_ok = 1.0 if half > 4 else 0.4
    cam_penalty = 0.85 if str(camera) == "gimbal" else 1.0
    offset_c = _clamp(0.75 * width_ok * cam_penalty, 0.0, 1.0)
    heading_c = _clamp(0.7 * straight * cam_penalty, 0.0, 1.0)
    along_c = _clamp(0.65 * cam_penalty, 0.0, 1.0)
    return {
        "detected": True,
        "offset_px": round(offset_px, 2),
        "offset_m": None if offset_m is None else round(offset_m, 2),
        "offset_norm": None if offset_norm is None else round(offset_norm, 3),
        "heading_error_deg": round(heading, 2),
        "progress": None if progress is None else round(progress, 3),
        "confidence": {
            "offset": round(offset_c, 3),
            "heading": round(heading_c, 3),
            "along": round(along_c, 3),
        },
        "centerline": [[round(far[0], 1), round(far[1], 1)], [round(near[0], 1), round(near[1], 1)]],
        "aircraft": [round(ax, 1), round(ay, 1)],
        "polygon": [[round(p[0], 1), round(p[1], 1)] for p in pts],
    }


def _luma(r, g, b):
    return (r * 3 + g * 6 + b) / 10.0


def _sat(r, g, b):
    return max(r, g, b) - min(r, g, b)


def _longest_run(mask_row):
    best = None
    start = None
    for i, on in enumerate(mask_row):
        if on and start is None:
            start = i
        elif not on and start is not None:
            run = (start, i - 1)
            if best is None or run[1] - run[0] > best[1] - best[0]:
                best = run
            start = None
    if start is not None:
        run = (start, len(mask_row) - 1)
        if best is None or run[1] - run[0] > best[1] - best[0]:
            best = run
    return best


def detect_runway(width, height, rgb, alt_m=None, hfov_deg=None, camera="down"):
    """Gray pavement on a colored background. No model, no invented strip."""
    width = int(width)
    height = int(height)
    raw = rgb if isinstance(rgb, (bytes, bytearray)) else bytes(rgb or b"")
    if width < 8 or height < 8 or len(raw) < width * height * 3:
        return pose_from_polygon(None, width, height)
    step = 1
    while (width // step) * (height // step) > 320 * 240 and step < 8:
        step += 1
    nw = width // step
    nh = height // step
    runs = []
    for y in range(nh):
        row = []
        src_y = min(height - 1, y * step)
        base = src_y * width * 3
        for x in range(nw):
            src_x = min(width - 1, x * step)
            i = base + src_x * 3
            r, g, b = raw[i], raw[i + 1], raw[i + 2]
            row.append(_sat(r, g, b) < 36 and 45 <= _luma(r, g, b) <= 255)
        run = _longest_run(row)
        runs.append(run if run and run[1] - run[0] >= 6 else None)
    best = None
    y = 0
    while y < nh:
        if runs[y] is None:
            y += 1
            continue
        y0 = y
        score = 0
        while y < nh and runs[y] is not None:
            score += runs[y][1] - runs[y][0]
            y += 1
        if best is None or score > best[0]:
            best = (score, y0, y - 1)
    if best is None:
        return pose_from_polygon(None, width, height)
    _score, y0, y1 = best
    if y1 - y0 < 8:
        return pose_from_polygon(None, width, height)
    span = y1 - y0
    band = max(1, span // 8)

    def edge(y_a, y_b):
        lefts = []
        rights = []
        for yy in range(y_a, y_b + 1):
            run = runs[yy]
            if run is None:
                continue
            lefts.append(run[0])
            rights.append(run[1])
        if not lefts:
            return None
        lefts.sort()
        rights.sort()
        return lefts[len(lefts) // 2] * step, rights[len(rights) // 2] * step

    top = edge(y0, min(y1, y0 + band))
    bot = edge(max(y0, y1 - band), y1)
    if not top or not bot:
        return pose_from_polygon(None, width, height)
    polygon = [
        (top[0], y0 * step),
        (top[1], y0 * step),
        (bot[1], y1 * step),
        (bot[0], y1 * step),
    ]
    pose = pose_from_polygon(polygon, width, height, alt_m=alt_m, hfov_deg=hfov_deg, camera=camera)
    if not pose.get("detected"):
        return pose
    covered = sum(1 for yy in range(y0, y1 + 1) if runs[yy] is not None) / float(span + 1)
    pose["confidence"] = {
        "offset": round(_clamp(pose["confidence"]["offset"] * (0.55 + 0.45 * covered), 0.0, 1.0), 3),
        "heading": round(_clamp(pose["confidence"]["heading"] * (0.55 + 0.45 * covered), 0.0, 1.0), 3),
        "along": round(_clamp(pose["confidence"]["along"] * (0.55 + 0.45 * covered), 0.0, 1.0), 3),
    }
    return pose


def hazards_on_runway(tracks, polygon):
    found = []
    for row in tracks or []:
        if not isinstance(row, dict):
            continue
        kind = hazard_kind(row.get("class") or row.get("cls") or row.get("label"))
        bbox = row.get("bbox")
        if not kind or not rect_hits_polygon(bbox, polygon):
            continue
        try:
            confidence = float(row.get("confidence") or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        found.append({
            "kind": kind,
            "label_he": KIND_HE[kind],
            "class": str(row.get("class") or row.get("cls") or ""),
            "confidence": round(_clamp(confidence, 0.0, 1.0), 3),
            "bbox": [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
        })
    rank = {"person": 0, "vehicle": 1, "animal": 2, "obstacle": 3}
    found.sort(key=lambda item: (rank.get(item["kind"], 9), -item["confidence"]))
    return found


def advice_he(level, hazards):
    if int(level) < 2 or not hazards:
        return ""
    return f"יש {hazards[0]['label_he']} על המסלול. מומלץ ללכת סביב."


def roll_pwm(estimate):
    if not estimate or estimate.get("detected") is not True:
        return None
    heading = estimate.get("heading_error_deg")
    offset_m = estimate.get("offset_m")
    offset_norm = estimate.get("offset_norm")
    try:
        heading = float(heading)
    except (TypeError, ValueError):
        heading = 0.0
    offset_term = 0.0
    if offset_m is not None:
        try:
            offset_term = float(offset_m) * 8.0
        except (TypeError, ValueError):
            offset_term = 0.0
    elif offset_norm is not None:
        try:
            offset_term = float(offset_norm) * 40.0
        except (TypeError, ValueError):
            offset_term = 0.0
    delta = _clamp(heading * 4.0 - offset_term, -120.0, 120.0)
    return int(round(1500 + delta))


def authorize(level, sitl, unlock=False, confirmed=False, hazards=None):
    level = int(level)
    if level <= 0:
        return {"allow": False, "reason": "off"}
    if level in (1, 2):
        return {"allow": False, "reason": "observe_only"}
    if level == 4 and not (unlock and confirmed):
        return {"allow": False, "reason": "level4_locked"}
    if level not in (3, 4):
        return {"allow": False, "reason": "off"}
    if hazards:
        return {"allow": False, "reason": "hazard"}
    if sitl is not True:
        return {"allow": False, "reason": "not_sitl"}
    return {"allow": True, "reason": "sitl"}


def command_plan(level, estimate, hazards, sitl, unlock=False, confirmed=False):
    guidance = None
    pwm = roll_pwm(estimate) if int(level) >= 3 else None
    if pwm is not None:
        guidance = {"kind": "ROLL_OVERRIDE", "roll_pwm": pwm, "sitl_only": True}
    decision = authorize(level, sitl is True, unlock=unlock, confirmed=confirmed, hazards=hazards)
    commands = [guidance] if decision["allow"] and guidance else []
    return {"guidance": guidance, "allow_send": decision["allow"], "reason": decision["reason"], "commands": commands}


def emit_commands(plan, sink, sitl):
    """Call sink only when the plan is allowed and the vehicle is SITL."""
    if sitl is not True or not isinstance(plan, dict) or plan.get("allow_send") is not True:
        return 0
    sent = 0
    for cmd in plan.get("commands") or []:
        if not isinstance(cmd, dict) or cmd.get("sitl_only") is not True:
            continue
        if sink is not None:
            sink(cmd)
        sent += 1
    return sent


def synthetic_runway(width=160, height=120, shift_x=0, skew_x=0, paint_line=True):
    """Gray trapezoid on green. shift_x moves the strip. skew_x slides the far end."""
    buf = bytearray([30, 90, 40] * width * height)
    far_y, near_y = 15, 105
    far_l, far_r = 68 + shift_x + skew_x, 92 + shift_x + skew_x
    near_l, near_r = 36 + shift_x, 124 + shift_x
    span = float(near_y - far_y)
    for y in range(far_y, near_y + 1):
        t = (y - far_y) / span
        left = int(round(far_l + (near_l - far_l) * t))
        right = int(round(far_r + (near_r - far_r) * t))
        if right < left:
            left, right = right, left
        for x in range(max(0, left), min(width, right + 1)):
            i = (y * width + x) * 3
            buf[i:i + 3] = bytes((168, 168, 172))
        if paint_line:
            mid = (left + right) // 2
            for x in range(mid - 1, mid + 1):
                if 0 <= x < width:
                    i = (y * width + x) * 3
                    buf[i:i + 3] = bytes((248, 248, 248))
    return width, height, bytes(buf)


class RunwayAwareness:
    def __init__(self, env=None):
        self.env = env if env is not None else os.environ
        self.level = read_level(self.env)
        self.confirmed = False
        self.last = None
        self._lock = threading.Lock()

    @classmethod
    def from_env(cls, env=None):
        return cls(env if env is not None else os.environ)

    def set_level(self, body):
        body = body if isinstance(body, dict) else {}
        try:
            level = int(body.get("level"))
        except (TypeError, ValueError):
            return 400, self._refused("רמה לא מוכרת", "bad_level")
        if level < 0 or level > 4:
            return 400, self._refused("רמה לא מוכרת", "bad_level")
        phrase = str(body.get("phrase") or "")
        confirmed = body.get("confirm") is True and phrase == CONFIRM_PHRASE
        with self._lock:
            if level == 4:
                if not level4_unlocked(self.env) or not confirmed:
                    self.confirmed = False
                    reason = "level4_locked" if not level4_unlocked(self.env) else "confirm"
                    message = "הנחיה אמיתית נעולה. הרמה לא השתנתה." if reason == "level4_locked" else "נדרש אישור בעברית לפני הנחיה אמיתית."
                    return 403, self._refused(message, reason, need_confirm=reason == "confirm", locked=True)
                self.confirmed = True
            else:
                self.confirmed = False
            self.level = level
            payload = self._payload_locked()
        payload["ok"] = True
        payload["message_he"] = LABEL_HE[level]
        return 200, payload

    def _refused(self, message, reason, need_confirm=False, locked=False):
        body = self._payload_locked() if locked else self.snapshot()
        body.update({
            "ok": False,
            "reason": reason,
            "message_he": message,
            "need_confirm": need_confirm is True,
            "commands_sent": 0,
            "flight_commands": False,
            "allow_send": False,
            "commands": [],
        })
        return body

    def observe(self, width, height, rgb, tracks=None, camera="cam1", alt_m=None, hfov_deg=None):
        role = "gimbal" if str(camera) == "cam3" else "down"
        pose = detect_runway(width, height, rgb, alt_m=alt_m, hfov_deg=hfov_deg, camera=role)
        hazards = hazards_on_runway(tracks, pose.get("polygon")) if pose.get("detected") else []
        pose = dict(pose)
        pose["camera"] = camera if camera in RUNWAY_CAMERAS else None
        pose["hazards"] = hazards
        with self._lock:
            self.last = pose
        return pose

    def snapshot(self, camera=""):
        with self._lock:
            return self._payload_locked(camera)

    def _payload_locked(self, camera=""):
        level = self.level
        estimate = self.last if level >= 1 else None
        if camera and estimate and estimate.get("camera") not in (None, "", camera):
            estimate = None
        hazards = ((estimate or {}).get("hazards") or []) if level >= 1 else []
        plan = command_plan(
            level,
            estimate if (estimate or {}).get("detected") else None,
            hazards,
            sitl=False,
            unlock=level4_unlocked(self.env),
            confirmed=self.confirmed,
        )
        detected = None if level <= 0 or not estimate else estimate.get("detected") is True
        published = None
        if level >= 1 and estimate:
            published = dict(estimate)
            published["detected"] = detected is True
            published["hazards"] = hazards
        return {
            "ok": True,
            "level": level,
            "level_name": LEVEL_NAME[level],
            "label_he": LABEL_HE[level],
            "level4_unlocked": level4_unlocked(self.env) is True,
            "level4_confirmed": self.confirmed is True,
            "runway_detector": level >= 1,
            "detected": detected,
            "estimate": published,
            "hazards": hazards,
            "advice_he": advice_he(level, hazards),
            "guidance": plan["guidance"] if level >= 3 else None,
            "allow_send": False,
            "send_reason": "companion_does_not_transmit",
            "commands": [],
            "commands_sent": 0,
            "flight_commands": False,
            "cameras": list(RUNWAY_CAMERAS),
        }


def service():
    global _SERVICE
    with _SERVICE_LOCK:
        if _SERVICE is None:
            _SERVICE = RunwayAwareness.from_env()
        return _SERVICE


def reset_service():
    global _SERVICE
    with _SERVICE_LOCK:
        _SERVICE = None


def _query_camera(handler):
    raw = getattr(handler, "path", "") or ""
    query = raw.split("?", 1)[1] if "?" in raw else ""
    camera = ""
    for part in query.split("&"):
        if part.startswith("camera="):
            camera = part.split("=", 1)[1]
    return camera


def _live_rgb(camera):
    try:
        from camera_ingest import ingest_frame_jpeg, ingest_frame_packet
    except ImportError:
        return None
    packet = ingest_frame_packet(camera) if ingest_frame_packet else None
    jpeg = packet.get("jpeg") if isinstance(packet, dict) else None
    if not jpeg and ingest_frame_jpeg:
        jpeg = ingest_frame_jpeg(camera)
    if not jpeg:
        return None
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None
    arr = np.frombuffer(jpeg, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        return None
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    height, width = rgb.shape[:2]
    return width, height, rgb.tobytes()


def _live_tracks(camera):
    try:
        import vision_tracks
    except ImportError:
        return []
    with vision_tracks._SERVICE_LOCK:
        svc = vision_tracks._SERVICE
    if svc is None:
        return []
    try:
        body = svc.snapshot(camera)
    except Exception:
        return []
    rows = body.get("tracks") if isinstance(body, dict) else None
    return rows if isinstance(rows, list) else []


def try_handle(handler, body=None):
    path = handler._path() if hasattr(handler, "_path") else str(getattr(handler, "path", "")).split("?", 1)[0]
    if path not in {"/api/v1/runway/awareness", "/api/v1/runway/level", "/api/v1/runway/frame"}:
        return False
    svc = service()
    command = getattr(handler, "command", "GET")
    if path == "/api/v1/runway/awareness" and command == "GET":
        camera = _query_camera(handler)
        if svc.level >= 1:
            order = [camera] if camera in RUNWAY_CAMERAS else list(RUNWAY_CAMERAS)
            for cam in order:
                live = _live_rgb(cam)
                if not live:
                    continue
                width, height, rgb = live
                svc.observe(width, height, rgb, tracks=_live_tracks(cam), camera=cam)
                break
        handler._json(200, svc.snapshot(camera))
        return True
    if path == "/api/v1/runway/level" and command == "POST":
        code, payload = svc.set_level(body if isinstance(body, dict) else {})
        handler._json(code, payload)
        return True
    if path == "/api/v1/runway/frame" and command == "POST":
        asked = body if isinstance(body, dict) else {}
        camera = str(asked.get("camera") or "cam1")
        if camera not in RUNWAY_CAMERAS:
            handler._json(400, {"ok": False, "reason": "bad_camera", "flight_commands": False, "commands_sent": 0})
            return True
        try:
            width = int(asked.get("width"))
            height = int(asked.get("height"))
            rgb = base64.b64decode(asked.get("rgb_b64") or "")
        except Exception:
            handler._json(400, {"ok": False, "reason": "bad_frame", "flight_commands": False, "commands_sent": 0})
            return True
        if svc.level <= 0:
            handler._json(200, svc.snapshot(camera))
            return True
        svc.observe(
            width,
            height,
            rgb,
            tracks=asked.get("tracks") or [],
            camera=camera,
            alt_m=asked.get("alt_m"),
            hfov_deg=asked.get("hfov_deg"),
        )
        handler._json(200, svc.snapshot(camera))
        return True
    handler._json(405, {"ok": False, "reason": "method_not_allowed", "flight_commands": False, "commands_sent": 0})
    return True
