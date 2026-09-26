"""Read-only MAVLink clock and attitude tagger.

Observes ATTITUDE, GLOBAL_POSITION_INT, DISTANCE_SENSOR / RANGEFINDER,
SYSTEM_TIME, TIMESYNC, and HEARTBEAT. Never writes a byte to the flight
controller. Missing fields stay null.
"""

from __future__ import annotations

import threading
import time
from collections import deque

MSG_HEARTBEAT = 0
MSG_SYSTEM_TIME = 2
MSG_ATTITUDE = 30
MSG_GLOBAL_POSITION_INT = 33
MSG_TIMESYNC = 111
MSG_DISTANCE_SENSOR = 132
MSG_RANGEFINDER = 173

MAV_MODE_FLAG_SAFETY_ARMED = 128


def x25(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        tmp = (b ^ (crc & 0xFF)) & 0xFF
        tmp = (tmp ^ ((tmp << 4) & 0xFF)) & 0xFF
        crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF
    return crc


_TYPE_SIZE = {
    "uint64_t": 8, "int64_t": 8, "double": 8,
    "uint32_t": 4, "int32_t": 4, "float": 4,
    "uint16_t": 2, "int16_t": 2,
    "uint8_t": 1, "int8_t": 1, "char": 1,
}


def crc_extra(name, fields):
    """CRC-EXTRA. Fields are XML order; the checksum walks wire order."""
    ordered = []
    for index, (typ, fname, alen) in enumerate(fields):
        size = _TYPE_SIZE[typ] * (int(alen) or 1)
        ordered.append((-size, index, typ, fname, int(alen)))
    ordered.sort()
    buf = bytearray((name + " ").encode("ascii"))
    for _size, _index, typ, fname, alen in ordered:
        buf.extend((typ + " ").encode("ascii"))
        buf.extend((fname + " ").encode("ascii"))
        if alen:
            buf.append(alen & 0xFF)
    crc = x25(bytes(buf))
    return (crc & 0xFF) ^ (crc >> 8)


_HEARTBEAT_FIELDS = (
    ("uint8_t", "type", 0),
    ("uint8_t", "autopilot", 0),
    ("uint8_t", "base_mode", 0),
    ("uint32_t", "custom_mode", 0),
    ("uint8_t", "system_status", 0),
    ("uint8_t", "mavlink_version", 0),
)
_SYSTEM_TIME_FIELDS = (
    ("uint64_t", "time_unix_usec", 0),
    ("uint32_t", "time_boot_ms", 0),
)
_ATTITUDE_FIELDS = (
    ("uint32_t", "time_boot_ms", 0),
    ("float", "roll", 0),
    ("float", "pitch", 0),
    ("float", "yaw", 0),
    ("float", "rollspeed", 0),
    ("float", "pitchspeed", 0),
    ("float", "yawspeed", 0),
)
_GPI_FIELDS = (
    ("uint32_t", "time_boot_ms", 0),
    ("int32_t", "lat", 0),
    ("int32_t", "lon", 0),
    ("int32_t", "alt", 0),
    ("int32_t", "relative_alt", 0),
    ("int16_t", "vx", 0),
    ("int16_t", "vy", 0),
    ("int16_t", "vz", 0),
    ("uint16_t", "hdg", 0),
)
_TIMESYNC_FIELDS = (
    ("int64_t", "tc1", 0),
    ("int64_t", "ts1", 0),
)
_DISTANCE_FIELDS = (
    ("uint32_t", "time_boot_ms", 0),
    ("uint16_t", "min_distance", 0),
    ("uint16_t", "max_distance", 0),
    ("uint16_t", "current_distance", 0),
    ("uint8_t", "type", 0),
    ("uint8_t", "id", 0),
    ("uint8_t", "orientation", 0),
    ("uint8_t", "covariance", 0),
)
_RANGEFINDER_FIELDS = (
    ("float", "distance", 0),
    ("float", "voltage", 0),
)

CRC_EXTRA = {
    MSG_HEARTBEAT: crc_extra("HEARTBEAT", _HEARTBEAT_FIELDS),
    MSG_SYSTEM_TIME: crc_extra("SYSTEM_TIME", _SYSTEM_TIME_FIELDS),
    MSG_ATTITUDE: crc_extra("ATTITUDE", _ATTITUDE_FIELDS),
    MSG_GLOBAL_POSITION_INT: crc_extra("GLOBAL_POSITION_INT", _GPI_FIELDS),
    MSG_TIMESYNC: crc_extra("TIMESYNC", _TIMESYNC_FIELDS),
    MSG_DISTANCE_SENSOR: crc_extra("DISTANCE_SENSOR", _DISTANCE_FIELDS),
    MSG_RANGEFINDER: crc_extra("RANGEFINDER", _RANGEFINDER_FIELDS),
}


def _u8(p, i):
    return p[i] if i < len(p) else None


def _u16(p, i):
    if i + 2 > len(p):
        return None
    return p[i] | (p[i + 1] << 8)


def _u32(p, i):
    if i + 4 > len(p):
        return None
    return p[i] | (p[i + 1] << 8) | (p[i + 2] << 16) | (p[i + 3] << 24)


def _i16(p, i):
    v = _u16(p, i)
    if v is None:
        return None
    return v - 65536 if v >= 32768 else v


def _i32(p, i):
    v = _u32(p, i)
    if v is None:
        return None
    return v - 4294967296 if v >= 2147483648 else v


def _u64(p, i):
    if i + 8 > len(p):
        return None
    return int.from_bytes(p[i:i + 8], "little", signed=False)


def _i64(p, i):
    if i + 8 > len(p):
        return None
    return int.from_bytes(p[i:i + 8], "little", signed=True)


def _f32(p, i):
    import struct
    if i + 4 > len(p):
        return None
    return struct.unpack_from("<f", p, i)[0]


def iter_mavlink2(buf):
    """Yield (msgid, payload) for CRC-valid frames. Leaves the remainder."""
    data = buf if isinstance(buf, (bytes, bytearray)) else bytes(buf)
    i = 0
    n = len(data)
    while i + 12 <= n:
        if data[i] != 0xFD:
            i += 1
            continue
        length = data[i + 1]
        frame_len = 10 + length + 2
        if i + frame_len > n:
            break
        incompat = data[i + 2]
        if incompat & 0x01:
            i += 1
            continue
        msgid = data[i + 7] | (data[i + 8] << 8) | (data[i + 9] << 16)
        extra = CRC_EXTRA.get(msgid)
        if extra is None:
            i += frame_len
            continue
        body = data[i + 1:i + 10 + length]
        crc = _u16(data, i + 10 + length)
        expect = x25(body + bytes([extra]))
        if crc != expect:
            i += 1
            continue
        payload = data[i + 10:i + 10 + length]
        yield msgid, payload
        i += frame_len


def _lerp(a, b, t):
    if a is None or b is None:
        return a if a is not None else b
    return a + (b - a) * t


def _ang_lerp(a, b, t):
    if a is None or b is None:
        return a if a is not None else b
    import math
    d = (b - a + math.pi) % (2 * math.pi) - math.pi
    return a + d * t


class AttitudeTagger:
    def __init__(self, history=240):
        self._lock = threading.Lock()
        self._att = deque(maxlen=history)
        self._pos = deque(maxlen=history)
        self._range = deque(maxlen=history)
        self.clock = {
            "fc_unix_us": None,
            "fc_boot_ms": None,
            "jetson_utc_ns": None,
            "offset_ns": None,
            "timesync_tc1_ns": None,
            "timesync_ts1_ns": None,
            "source": None,
        }
        self.armed = None
        self._last_mono_ns = None

    def observe(self, data, mono_ns=None, utc_ns=None):
        now_mono = int(mono_ns if mono_ns is not None else time.monotonic_ns())
        now_utc = int(utc_ns if utc_ns is not None else time.time_ns())
        for msgid, payload in iter_mavlink2(data):
            self._on(msgid, payload, now_mono, now_utc)

    def _on(self, msgid, p, mono_ns, utc_ns):
        with self._lock:
            if msgid == MSG_HEARTBEAT and len(p) >= 7:
                # Wire order is size-sorted: custom_mode uint32, then type,
                # autopilot, base_mode, system_status, mavlink_version.
                base_mode = p[6]
                if base_mode is not None:
                    self.armed = bool(base_mode & MAV_MODE_FLAG_SAFETY_ARMED)
            elif msgid == MSG_SYSTEM_TIME and len(p) >= 12:
                unix_us = _u64(p, 0)
                boot = _u32(p, 8)
                self.clock["fc_unix_us"] = unix_us
                self.clock["fc_boot_ms"] = boot
                self.clock["jetson_utc_ns"] = utc_ns
                if unix_us:
                    self.clock["offset_ns"] = int(utc_ns - unix_us * 1000)
                    self.clock["source"] = "system_time"
            elif msgid == MSG_TIMESYNC and len(p) >= 16:
                self.clock["timesync_tc1_ns"] = _i64(p, 0)
                self.clock["timesync_ts1_ns"] = _i64(p, 8)
                if self.clock["source"] is None:
                    self.clock["source"] = "timesync"
            elif msgid == MSG_ATTITUDE and len(p) >= 28:
                self._att.append({
                    "mono_ns": mono_ns,
                    "boot_ms": _u32(p, 0),
                    "roll": _f32(p, 4),
                    "pitch": _f32(p, 8),
                    "yaw": _f32(p, 12),
                })
            elif msgid == MSG_GLOBAL_POSITION_INT and len(p) >= 28:
                self._pos.append({
                    "mono_ns": mono_ns,
                    "boot_ms": _u32(p, 0),
                    "lat_deg": None if _i32(p, 4) is None else _i32(p, 4) / 1e7,
                    "lon_deg": None if _i32(p, 8) is None else _i32(p, 8) / 1e7,
                    "alt_mm": _i32(p, 12),
                    "relative_alt_mm": _i32(p, 16),
                })
            elif msgid == MSG_DISTANCE_SENSOR and len(p) >= 14:
                cm = _u16(p, 8)
                self._range.append({
                    "mono_ns": mono_ns,
                    "boot_ms": _u32(p, 0),
                    "distance_m": None if cm is None else cm / 100.0,
                })
            elif msgid == MSG_RANGEFINDER and len(p) >= 4:
                dist = _f32(p, 0)
                self._range.append({
                    "mono_ns": mono_ns,
                    "boot_ms": None,
                    "distance_m": dist,
                })
            self._last_mono_ns = mono_ns

    def _interp(self, samples, mono_ns, angle_keys=()):
        if not samples:
            return None, None
        if len(samples) == 1 or mono_ns <= samples[0]["mono_ns"]:
            return dict(samples[0]), abs(mono_ns - samples[0]["mono_ns"]) / 1e6
        if mono_ns >= samples[-1]["mono_ns"]:
            return dict(samples[-1]), abs(mono_ns - samples[-1]["mono_ns"]) / 1e6
        prev = samples[0]
        nxt = samples[-1]
        for s in samples:
            if s["mono_ns"] <= mono_ns:
                prev = s
            elif s["mono_ns"] > mono_ns:
                nxt = s
                break
        span = max(1, nxt["mono_ns"] - prev["mono_ns"])
        t = (mono_ns - prev["mono_ns"]) / span
        out = {"mono_ns": mono_ns, "boot_ms": prev.get("boot_ms")}
        for key, value in prev.items():
            if key in {"mono_ns", "boot_ms"}:
                continue
            other = nxt.get(key)
            if key in angle_keys:
                out[key] = _ang_lerp(value, other, t)
            elif isinstance(value, (int, float)) and isinstance(other, (int, float)):
                out[key] = _lerp(value, other, t)
            else:
                out[key] = value
        age = 0.0
        return out, age

    def tag(self, mono_ns, utc_ns=None):
        now_mono = time.monotonic_ns()
        with self._lock:
            att, _ = self._interp(list(self._att), mono_ns, angle_keys=("roll", "pitch", "yaw"))
            pos, _ = self._interp(list(self._pos), mono_ns)
            rng, _ = self._interp(list(self._range), mono_ns)
            clock = dict(self.clock)
            armed = self.armed
        att_age = None
        if att is not None:
            att_age = abs(now_mono - mono_ns) / 1e6
        capture_age = (now_mono - int(mono_ns)) / 1e6
        latency = capture_age if att is None else capture_age
        if att is not None and att.get("mono_ns") is not None:
            sample_age = abs(int(mono_ns) - int(att["mono_ns"])) / 1e6
            latency = capture_age + sample_age
            att_age = sample_age
        attitude = None
        if att:
            attitude = {
                "roll": att.get("roll"),
                "pitch": att.get("pitch"),
                "yaw": att.get("yaw"),
                "age_ms": None if att_age is None else round(att_age, 3),
            }
        position = None
        if pos:
            position = {
                "lat_deg": pos.get("lat_deg"),
                "lon_deg": pos.get("lon_deg"),
                "alt_m": None if pos.get("alt_mm") is None else pos["alt_mm"] / 1000.0,
                "relative_alt_m": None if pos.get("relative_alt_mm") is None else pos["relative_alt_mm"] / 1000.0,
            }
        return {
            "t_monotonic_ns": int(mono_ns),
            "t_utc_ns": None if utc_ns is None else int(utc_ns),
            "attitude": attitude,
            "position": position,
            "rangefinder_m": None if not rng else rng.get("distance_m"),
            "armed": armed,
            "latency_ms": round(latency, 3),
            "clock_offset_ns": clock.get("offset_ns"),
            "clock_source": clock.get("source"),
        }
