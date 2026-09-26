"""Fixed-wing auto-land shadow machine. Disabled unless AUTOLAND_ENABLED is set.

Nothing in this module turns that flag on. The default is false.
MAVLink output is only LANDING_TARGET, SET_MODE, or DO_LAND_START, and only
through GuardedSender.send. While the flag is false, while shadow mode is on,
or while no transport is injected, send does not call the transport.
Abort does not write parameters and does not invent a failsafe. It logs a hold
so ArduPlane keeps the RTL or LOITER behavior already configured on the FC.
"""

from __future__ import annotations

import math
import os
import threading
import time

from fc_telemetry import PLANE_MODES, mav_crc

STATES = (
    "IDLE",
    "ARMED_FOR_APPROACH",
    "APPROACH",
    "FINAL",
    "FLARE",
    "ROLLOUT",
    "ABORT",
)

STATE_HE = {
    "IDLE": "המתנה",
    "ARMED_FOR_APPROACH": "מוכן לגישה",
    "APPROACH": "גישה",
    "FINAL": "גמר",
    "FLARE": "הצפה",
    "ROLLOUT": "גלגול",
    "ABORT": "ביטול",
}

ABORT_HE = {
    "link_loss": "אבד הקישור",
    "target_loss": "אבד היעד",
    "cross_track": "סטייה רוחבית גדולה",
    "glideslope": "סטייה ממסלול הגלישה",
    "low_battery": "סוללה נמוכה",
    "position_invalid": "המיקום אינו תקין",
    "mode_invalid": "מצב הטיסה אינו תקין",
}

SEND_REASON_HE = {
    "disabled": "לא נשלח כי המערכת מושבתת",
    "shadow": "לא נשלח במצב צל",
    "no_transport": "לא נשלח כי אין נתיב שידור",
    "rejected": "נדחה",
    "sent": "נשלח",
}

ALLOWED_KINDS = ("LANDING_TARGET", "SET_MODE", "DO_LAND_START")
ACTIVE = ("ARMED_FOR_APPROACH", "APPROACH", "FINAL", "FLARE")
MSG_GPS_RAW_INT = 24
MSG_GLOBAL_POSITION_INT = 33
CRC_GPS_RAW_INT = 24
CRC_GLOBAL_POSITION_INT = 104
FINAL_RANGE_M = 150.0
FLARE_HEIGHT_M = 8.0
ROLLOUT_HEIGHT_M = 1.0
APPROACH_MAX_RANGE_M = 2500.0
TARGET_FRESH_S = 0.75
TARGET_LOSS_S = 1.5
LOW_BATTERY_PCT = 20.0
POSITION_FRESH_S = 2.0
PLANE_AUTO_MODE = 10
LIMITS = {
    "ARMED_FOR_APPROACH": (25.0, 15.0),
    "APPROACH": (25.0, 15.0),
    "FINAL": (8.0, 5.0),
    "FLARE": (8.0, 5.0),
}

_LOCK = threading.RLock()
_MACHINE = None


def env_flag(name, default, env=None):
    source = os.environ if env is None else env
    raw = source.get(name)
    if raw is None or str(raw).strip() == "":
        return bool(default)
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _normalize_target(raw, now_s):
    if not isinstance(raw, dict) or raw.get("valid") is not True:
        return None
    age = _finite(raw.get("age_s"))
    if age is None:
        seen = _finite(raw.get("seen_s"))
        if seen is not None:
            age = max(0.0, float(now_s) - seen)
    cross = _finite(raw.get("cross_track_m"))
    glide = _finite(raw.get("glideslope_error_m"))
    rng = _finite(raw.get("range_m"))
    height = _finite(raw.get("height_m"))
    if None in (age, cross, glide, rng, height) or age < 0:
        return None
    out = {
        "valid": True,
        "age_s": age,
        "cross_track_m": cross,
        "glideslope_error_m": glide,
        "range_m": rng,
        "height_m": height,
    }
    angle_x = _finite(raw.get("angle_x"))
    angle_y = _finite(raw.get("angle_y"))
    distance = _finite(raw.get("distance_m"))
    if distance is None:
        distance = rng
    if angle_x is not None and angle_y is not None and distance is not None:
        out["angle_x"] = angle_x
        out["angle_y"] = angle_y
        out["distance_m"] = distance
    return out


class LandingTargetPlugin:
    """Plugin surface for a later marker detector and the camera frame bus."""

    def update_frame(self, cam_id, packet):
        return None

    def read(self, now_s):
        return None


class NullLandingTargetPlugin(LandingTargetPlugin):
    pass


class MarkerDetectorPlugin(LandingTargetPlugin):
    """Prefer the downward camera. A missing detector yields no target."""

    def __init__(self, detector=None, prefer=("cam2", "cam1", "cam3")):
        self.detector = detector
        self.prefer = tuple(prefer)
        self._frames = {}

    def update_frame(self, cam_id, packet):
        if self.detector is None or not cam_id:
            return None
        self._frames[cam_id] = packet
        return None

    def read(self, now_s):
        if self.detector is None:
            return None
        detect = getattr(self.detector, "detect", None)
        if not callable(detect):
            return None
        for cam_id in self.prefer:
            packet = self._frames.get(cam_id)
            if packet is None:
                continue
            try:
                raw = detect(packet, cam_id=cam_id, now_s=now_s)
            except TypeError:
                raw = detect(packet)
            except Exception:
                return None
            return _normalize_target(raw, now_s)
        return None


def load_marker_detector():
    """Use marker_detector.create_detector when that module exists. Else nothing."""
    try:
        import marker_detector
    except ImportError:
        return None
    factory = getattr(marker_detector, "create_detector", None)
    if not callable(factory):
        return None
    try:
        return factory()
    except Exception:
        return None


class PositionObserver:
    """Passive GLOBAL_POSITION_INT / GPS_RAW_INT reader. Never writes."""

    def __init__(self, now_fn=None):
        self._now = now_fn or time.monotonic
        self.buf = bytearray()
        self.global_pos = None
        self.global_at = None
        self.fix_type = None
        self.fix_at = None

    def set_clock(self, now_fn):
        self._now = now_fn or time.monotonic

    def feed(self, data: bytes):
        if not data:
            return
        self.buf.extend(data)
        if len(self.buf) > 8192:
            del self.buf[:-512]
        self._drain()

    def snapshot(self, now_s=None):
        now = self._now() if now_s is None else now_s
        pos = self.global_pos
        if not pos or self.global_at is None:
            return {"valid": False}
        age = now - self.global_at
        if age < 0 or age > POSITION_FRESH_S:
            return {"valid": False}
        fix_fresh = (
            self.fix_type is not None
            and self.fix_at is not None
            and 0 <= (now - self.fix_at) <= POSITION_FRESH_S
        )
        if fix_fresh and self.fix_type < 3:
            return {"valid": False}
        return {
            "valid": True,
            "lat": pos["lat"],
            "lon": pos["lon"],
            "alt_m": pos["alt_m"],
            "relative_alt_m": pos["relative_alt_m"],
            "age_s": age,
            "fix_type": self.fix_type if fix_fresh else None,
        }

    def _drain(self):
        buf = self.buf
        i = 0
        n = len(buf)
        while i < n:
            if buf[i] != 0xFD:
                i += 1
                continue
            if i + 10 > n:
                break
            ln = buf[i + 1]
            incompat = buf[i + 2]
            sig = 13 if (incompat & 0x01) else 0
            total = 12 + ln + sig
            if ln > 255 or total > 300 or i + total > n:
                if i + total > n and ln <= 255:
                    break
                i += 1
                continue
            frame = bytes(buf[i : i + total])
            if self._take(frame):
                i += total
            else:
                i += 1
        if i:
            del buf[:i]

    def _take(self, frame: bytes) -> bool:
        ln = frame[1]
        msgid = frame[7] | (frame[8] << 8) | (frame[9] << 16)
        extra = {MSG_GPS_RAW_INT: CRC_GPS_RAW_INT, MSG_GLOBAL_POSITION_INT: CRC_GLOBAL_POSITION_INT}.get(msgid)
        if extra is None:
            return False
        crc_off = 10 + ln
        rx = frame[crc_off] | (frame[crc_off + 1] << 8)
        if mav_crc(frame[1:crc_off] + bytes([extra])) != rx:
            return False
        payload = frame[10 : 10 + ln]
        if msgid == MSG_GLOBAL_POSITION_INT:
            return self._take_global(payload)
        return self._take_gps(payload)

    def _i32(self, payload, off):
        if off + 4 > len(payload):
            return None
        raw = int.from_bytes(payload[off : off + 4], "little", signed=False)
        return raw - 4294967296 if raw >= 2147483648 else raw

    def _u32(self, payload, off):
        if off + 4 > len(payload):
            return None
        return int.from_bytes(payload[off : off + 4], "little", signed=False)

    def _take_global(self, payload: bytes) -> bool:
        lat_i = self._i32(payload, 4)
        lon_i = self._i32(payload, 8)
        alt_i = self._i32(payload, 12)
        rel_i = self._i32(payload, 16)
        if None in (lat_i, lon_i, alt_i, rel_i):
            return False
        lat = lat_i / 1e7
        lon = lon_i / 1e7
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            return False
        self.global_pos = {
            "lat": lat,
            "lon": lon,
            "alt_m": alt_i / 1000.0,
            "relative_alt_m": rel_i / 1000.0,
        }
        self.global_at = self._now()
        return True

    def _take_gps(self, payload: bytes) -> bool:
        if len(payload) < 9:
            return False
        fix = payload[8]
        self.fix_type = fix
        self.fix_at = self._now()
        return True


class GuardedSender:
    """Single send path. A no-op unless enabled, not in shadow, and a transport exists."""

    def __init__(self, *, enabled, shadow, transport=None):
        self.enabled = bool(enabled)
        self.shadow = bool(shadow)
        self.transport = transport
        self.log = []
        self.sent_count = 0

    def send(self, kind, fields=None):
        entry = {
            "kind": kind,
            "fields": dict(fields or {}),
            "sent": False,
            "reason": None,
        }
        if kind not in ALLOWED_KINDS:
            entry["reason"] = "rejected"
        elif self.shadow:
            entry["reason"] = "shadow"
        elif not self.enabled:
            entry["reason"] = "disabled"
        elif self.transport is None:
            entry["reason"] = "no_transport"
        else:
            self.transport(kind, entry["fields"])
            entry["sent"] = True
            entry["reason"] = "sent"
            self.sent_count += 1
        entry["reasonHe"] = SEND_REASON_HE.get(entry["reason"], "")
        self.log.append(entry)
        if len(self.log) > 200:
            del self.log[:-200]
        return entry


class AutoLandMachine:
    def __init__(
        self,
        *,
        enabled=False,
        shadow=True,
        expected_token="",
        presented_token="",
        transport=None,
        plugin=None,
        now_fn=None,
    ):
        self.enabled = bool(enabled)
        self.shadow = bool(shadow)
        self.expected_token = expected_token if isinstance(expected_token, str) else ""
        self.presented_token = presented_token if isinstance(presented_token, str) else ""
        self.sender = GuardedSender(enabled=self.enabled, shadow=self.shadow, transport=transport)
        self.plugin = plugin if plugin is not None else MarkerDetectorPlugin(None)
        self.position = PositionObserver(now_fn=now_fn)
        self._now = now_fn or time.monotonic
        self.state = "IDLE"
        self.abort_reason = None
        self.holds = []
        self._gates_snap = []
        self._last_target = None
        self.bus_bound = False
        self._unsub = None

    def bind_bus(self, bus):
        if bus is None or self._unsub is not None or not hasattr(bus, "subscribe"):
            return None
        self._unsub = bus.subscribe(self.plugin.update_frame)
        self.bus_bound = True
        return self._unsub

    def observe_bytes(self, data: bytes):
        self.position.feed(data)

    def reset(self):
        self.state = "IDLE"
        self.abort_reason = None
        self.holds.clear()
        self.sender.log.clear()
        self.sender.sent_count = 0
        self._last_target = None

    def tick(self, telem, target=None, now=None):
        now_s = self._now() if now is None else now
        telem = telem if isinstance(telem, dict) else {}
        if target is None and self.plugin is not None:
            try:
                target = self.plugin.read(now_s)
            except Exception:
                target = None
        target = _normalize_target(target, now_s)
        self._last_target = target
        gates = self._gates(telem)
        self._gates_snap = gates

        if self.state in ("ROLLOUT", "ABORT"):
            return self.snapshot()

        if self.state in ACTIVE:
            reason = self._abort_reason(telem, target)
            if reason:
                self._enter_abort(reason)
                return self.snapshot()

        if self.state == "IDLE":
            if self._may_progress(gates):
                self.state = "ARMED_FOR_APPROACH"
            return self.snapshot()

        if self.state == "ARMED_FOR_APPROACH":
            if self._target_ready(target):
                if not self._errors_ok(target, "APPROACH"):
                    self._enter_abort(self._error_reason(target, "APPROACH"))
                else:
                    self._command_approach_start(telem)
                    self.state = "APPROACH"
            return self.snapshot()

        if self.state == "APPROACH":
            self._command_target(target)
            if self._target_ready(target) and target["range_m"] <= FINAL_RANGE_M:
                self.state = "FINAL"
            return self.snapshot()

        if self.state == "FINAL":
            self._command_target(target)
            if self._target_ready(target) and target["height_m"] <= FLARE_HEIGHT_M:
                self.state = "FLARE"
            return self.snapshot()

        if self.state == "FLARE":
            self._command_target(target)
            if self._target_ready(target) and target["height_m"] <= ROLLOUT_HEIGHT_M:
                self.state = "ROLLOUT"
            return self.snapshot()

        return self.snapshot()

    def status_from_fc(self, fc):
        pos = self.position.snapshot(self._now())
        telem = telem_from_fc(fc, pos, self.presented_token)
        return self.tick(telem)

    def snapshot(self):
        commands = [dict(item) for item in self.sender.log]
        return {
            "ok": True,
            "reported": True,
            "enabled": self.enabled is True,
            "shadow": self.shadow is True,
            "disabled": self.enabled is not True,
            "labelHe": "מושבת" if self.enabled is not True else "פעיל",
            "state": self.state,
            "stateHe": STATE_HE.get(self.state),
            "gates": [dict(gate) for gate in self._gates_snap],
            "abortReason": self.abort_reason,
            "abortReasonHe": ABORT_HE.get(self.abort_reason) if self.abort_reason else None,
            "fallbackHe": self.holds[-1]["fallbackHe"] if self.holds else None,
            "commands": commands,
            "commandsSent": self.sender.sent_count,
            "target": dict(self._last_target) if self._last_target else None,
            "transport": self.sender.transport is not None,
            "paramWrites": False,
            "flightCommandsSent": self.sender.sent_count > 0,
        }

    def _gates(self, telem):
        position_ok = telem.get("position_valid") is True
        mode_ok = telem.get("mode_valid") is True
        link_ok = telem.get("link_healthy") is True
        token = telem.get("arm_token")
        token_ok = (
            isinstance(token, str)
            and token != ""
            and self.expected_token != ""
            and token == self.expected_token
        )
        return [
            {
                "id": "config_enabled",
                "ok": self.enabled is True,
                "reasonHe": "מושבת" if self.enabled is not True else "פעיל",
            },
            {
                "id": "position",
                "ok": position_ok,
                "reasonHe": "יש מיקום תקין" if position_ok else "אין מיקום תקין",
            },
            {
                "id": "mode",
                "ok": mode_ok,
                "reasonHe": "מצב הטיסה תקין" if mode_ok else "אין מצב טיסה תקין",
            },
            {
                "id": "link",
                "ok": link_ok,
                "reasonHe": "הקישור תקין" if link_ok else "הקישור אינו תקין",
            },
            {
                "id": "arm_token",
                "ok": token_ok,
                "reasonHe": "אסימון המפעיל קיים" if token_ok else "אין אסימון מפעיל",
            },
        ]

    def _may_progress(self, gates):
        needed = {"position", "mode", "link", "arm_token"}
        if not self.shadow:
            needed.add("config_enabled")
        by_id = {gate["id"]: gate["ok"] is True for gate in gates}
        return all(by_id.get(key) is True for key in needed)

    def _target_alive(self, target):
        return bool(target) and target.get("valid") is True and target["age_s"] <= TARGET_LOSS_S

    def _target_ready(self, target):
        return (
            self._target_alive(target)
            and target["age_s"] <= TARGET_FRESH_S
            and 0 <= target["range_m"] <= APPROACH_MAX_RANGE_M
        )

    def _errors_ok(self, target, phase):
        cross_max, glide_max = LIMITS[phase]
        return abs(target["cross_track_m"]) <= cross_max and abs(target["glideslope_error_m"]) <= glide_max

    def _error_reason(self, target, phase):
        cross_max, glide_max = LIMITS[phase]
        if abs(target["cross_track_m"]) > cross_max:
            return "cross_track"
        if abs(target["glideslope_error_m"]) > glide_max:
            return "glideslope"
        return "cross_track"

    def _abort_reason(self, telem, target):
        if telem.get("link_healthy") is not True:
            return "link_loss"
        battery = _finite(telem.get("battery_pct"))
        if battery is not None and battery < LOW_BATTERY_PCT:
            return "low_battery"
        if telem.get("position_valid") is not True:
            return "position_invalid"
        if telem.get("mode_valid") is not True:
            return "mode_invalid"
        phase = self.state
        if phase == "ARMED_FOR_APPROACH":
            if self._target_ready(target) and not self._errors_ok(target, "APPROACH"):
                return self._error_reason(target, "APPROACH")
            return None
        if not self._target_alive(target):
            return "target_loss"
        if self._target_ready(target) and not self._errors_ok(target, phase if phase in LIMITS else "APPROACH"):
            return self._error_reason(target, phase if phase in LIMITS else "APPROACH")
        return None

    def _enter_abort(self, reason):
        self.state = "ABORT"
        self.abort_reason = reason
        self.holds.append(
            {
                "kind": "NATIVE_FAILSAFE_HOLD",
                "sent": False,
                "abort": reason,
                "fallback": "existing_rtl_or_loiter",
                "fallbackHe": "נשארת ההתנהגות שכבר מוגדרת בבקר",
            }
        )

    def _command_approach_start(self, telem):
        if telem.get("mode") != "AUTO":
            self.sender.send("SET_MODE", {"custom_mode": PLANE_AUTO_MODE, "mode_name": "AUTO"})
        self.sender.send("DO_LAND_START", {"command": 189})

    def _command_target(self, target):
        if not self._target_ready(target):
            return
        if "angle_x" not in target or "angle_y" not in target or "distance_m" not in target:
            return
        self.sender.send(
            "LANDING_TARGET",
            {
                "angle_x": target["angle_x"],
                "angle_y": target["angle_y"],
                "distance_m": target["distance_m"],
            },
        )


def telem_from_fc(fc, pos, token):
    fc = fc if isinstance(fc, dict) else {}
    mode = fc.get("mode")
    known = isinstance(mode, str) and mode in PLANE_MODES.values() and mode != "INITIALISING"
    heartbeat = fc.get("heartbeat") if isinstance(fc.get("heartbeat"), dict) else {}
    link = fc.get("connected") is True and heartbeat.get("validity") == "valid"
    battery = _finite(fc.get("battery_pct"))
    return {
        "position_valid": bool(pos and pos.get("valid") is True),
        "mode_valid": bool(known and link),
        "mode": mode if known else None,
        "link_healthy": link,
        "battery_pct": battery,
        "arm_token": token if isinstance(token, str) else "",
    }


def build_machine_from_env(env=None):
    source = os.environ if env is None else env
    token = source.get("AUTOLAND_ARM_TOKEN", "")
    if not isinstance(token, str):
        token = ""
    token = token.strip()
    return AutoLandMachine(
        enabled=env_flag("AUTOLAND_ENABLED", False, source),
        shadow=env_flag("AUTOLAND_SHADOW", True, source),
        expected_token=token,
        presented_token=token,
        transport=None,
        plugin=MarkerDetectorPlugin(load_marker_detector()),
    )


def get_machine():
    global _MACHINE
    with _LOCK:
        if _MACHINE is None:
            _MACHINE = build_machine_from_env()
        return _MACHINE


def feed_downlink_bytes(data: bytes):
    with _LOCK:
        get_machine().observe_bytes(data)


def _bind_existing_bus(machine):
    if machine.bus_bound:
        return
    try:
        import camera_ingest
    except ImportError:
        return
    ingest = getattr(camera_ingest, "_INGEST", None)
    bus = getattr(ingest, "bus", None) if ingest is not None else None
    machine.bind_bus(bus)


def autoland_status_payload(fc=None):
    with _LOCK:
        if fc is None:
            from fc_telemetry import fc_status_payload

            fc = fc_status_payload()
        machine = get_machine()
        _bind_existing_bus(machine)
        return machine.status_from_fc(fc)
