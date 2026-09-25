"""Passive FC telemetry from a copy of UART bytes.

Never opens the serial port and never calls recv_match(). The relay keeps
the original buffer. A field is reported only when its bytes are inside the
MAVLink 2 length (trailing zeros are trimmed, not padded back to zero).

Connected only while a real autopilot HEARTBEAT is fresh:
sysid any, compid 1, autopilot != INVALID (8), age <= 3 s.
"""

from __future__ import annotations

import threading
import time

MSG_HEARTBEAT = 0
MSG_SYS_STATUS = 1
MSG_BATTERY_STATUS = 147
MSG_MEMINFO = 152
MSG_MCU_STATUS = 11039

# c_library_v2 / mavlink-mappings CRC extras.
CRC_EXTRA = {
    MSG_HEARTBEAT: 50,
    MSG_SYS_STATUS: 124,
    MSG_BATTERY_STATUS: 154,
    MSG_MEMINFO: 208,
    MSG_MCU_STATUS: 142,
}

MAV_COMP_ID_AUTOPILOT1 = 1
MAV_AUTOPILOT_INVALID = 8
MAV_TYPE_FIXED_WING = 1
HEARTBEAT_FRESH_S = 3.0
TELEM_FRESH_S = 5.0
UINT16_MAX = 65535

# ArduPlane custom_mode. Unknown numbers stay null — no guessed name.
PLANE_MODES = {
    0: "MANUAL",
    1: "CIRCLE",
    2: "STABILIZE",
    3: "TRAINING",
    4: "ACRO",
    5: "FBWA",
    6: "FBWB",
    7: "CRUISE",
    8: "AUTOTUNE",
    10: "AUTO",
    11: "RTL",
    12: "LOITER",
    13: "TAKEOFF",
    14: "AVOID_ADSB",
    15: "GUIDED",
    16: "INITIALISING",
    17: "QSTABILIZE",
    18: "QHOVER",
    19: "QLOITER",
    20: "QLAND",
    21: "QRTL",
    22: "QAUTOTUNE",
    23: "QACRO",
    24: "THERMAL",
    25: "LOITER_ALT_QLAND",
}


def mav_crc(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        tmp = (b ^ (crc & 0xFF)) & 0xFF
        tmp = (tmp ^ ((tmp << 4) & 0xFF)) & 0xFF
        crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF
    return crc


def _u16(payload: bytes, off: int):
    if off + 2 > len(payload):
        return None
    return payload[off] | (payload[off + 1] << 8)


def _i16(payload: bytes, off: int):
    raw = _u16(payload, off)
    if raw is None:
        return None
    return raw - 65536 if raw >= 32768 else raw


def _u32(payload: bytes, off: int):
    if off + 4 > len(payload):
        return None
    return (
        payload[off]
        | (payload[off + 1] << 8)
        | (payload[off + 2] << 16)
        | (payload[off + 3] << 24)
    )


def _i8(payload: bytes, off: int):
    if off >= len(payload):
        return None
    v = payload[off]
    return v - 256 if v >= 128 else v


def _pct_byte(payload: bytes, off: int):
    raw = _i8(payload, off)
    if raw is None or raw < 0:
        return None
    if raw > 100:
        return None
    return raw


class FcObserver:
    def __init__(self, now_fn=None):
        self._now = now_fn or time.monotonic
        self.buf = bytearray()
        self.hb = None
        self.sys = None
        self.bat = None
        self.mem = None
        self.mcu = None
        self.heartbeat_wall = None

    def set_clock(self, now_fn):
        self._now = now_fn or time.monotonic

    def reset(self):
        self.buf.clear()
        self.hb = None
        self.sys = None
        self.bat = None
        self.mem = None
        self.mcu = None
        self.heartbeat_wall = None

    def feed(self, data: bytes):
        if not data:
            return
        self.buf.extend(data)
        if len(self.buf) > 8192:
            del self.buf[:-512]
        self._drain()

    def _drain(self):
        buf = self.buf
        i = 0
        n = len(buf)
        while i < n:
            stx = buf[i]
            if stx == 0xFD:
                if i + 10 > n:
                    break
                ln = buf[i + 1]
                incompat = buf[i + 2]
                sig = 13 if (incompat & 0x01) else 0
                total = 12 + ln + sig
                if ln > 255 or total > 300:
                    i += 1
                    continue
                if i + total > n:
                    break
                frame = bytes(buf[i : i + total])
                if self._take_v2(frame):
                    i += total
                    continue
                i += 1
                continue
            if stx == 0xFE:
                if i + 8 > n:
                    break
                ln = buf[i + 1]
                total = 8 + ln
                if ln > 255:
                    i += 1
                    continue
                if i + total > n:
                    break
                frame = bytes(buf[i : i + total])
                if self._take_v1(frame):
                    i += total
                    continue
                i += 1
                continue
            i += 1
        if i:
            del buf[:i]

    def _take_v2(self, frame: bytes) -> bool:
        ln = frame[1]
        msgid = frame[7] | (frame[8] << 8) | (frame[9] << 16)
        extra = CRC_EXTRA.get(msgid)
        if extra is None:
            return False
        crc_off = 10 + ln
        rx = frame[crc_off] | (frame[crc_off + 1] << 8)
        if mav_crc(frame[1 : crc_off] + bytes([extra])) != rx:
            return False
        self._on(frame[5], frame[6], msgid, frame[10 : 10 + ln])
        return True

    def _take_v1(self, frame: bytes) -> bool:
        ln = frame[1]
        msgid = frame[5]
        extra = CRC_EXTRA.get(msgid)
        if extra is None:
            return False
        crc_off = 6 + ln
        rx = frame[crc_off] | (frame[crc_off + 1] << 8)
        if mav_crc(frame[1 : crc_off] + bytes([extra])) != rx:
            return False
        self._on(frame[3], frame[4], msgid, frame[6 : 6 + ln])
        return True

    def _on(self, sysid: int, compid: int, msgid: int, payload: bytes):
        now = self._now()
        if msgid == MSG_HEARTBEAT:
            autopilot = payload[5] if len(payload) > 5 else None
            if compid != MAV_COMP_ID_AUTOPILOT1 or autopilot is None or autopilot == MAV_AUTOPILOT_INVALID:
                return
            self.hb = {
                "t": now,
                "sysid": sysid,
                "compid": compid,
                "payload": payload,
            }
            self.heartbeat_wall = time.time()
            return
        slot = {
            MSG_SYS_STATUS: "sys",
            MSG_BATTERY_STATUS: "bat",
            MSG_MEMINFO: "mem",
            MSG_MCU_STATUS: "mcu",
        }.get(msgid)
        if slot is None:
            return
        setattr(self, slot, {"t": now, "sysid": sysid, "compid": compid, "payload": payload})

    def _fresh(self, slot, now, limit):
        if not slot:
            return False
        return (now - slot["t"]) <= limit

    def snapshot(self):
        now = self._now()
        age_ms = None
        connected = False
        if self.hb is not None:
            age = now - self.hb["t"]
            age_ms = int(round(age * 1000))
            if age <= HEARTBEAT_FRESH_S:
                connected = True
        if not connected:
            return _disconnected(age_ms)

        hb_payload = self.hb["payload"]
        custom = _u32(hb_payload, 0)
        vehicle_type = hb_payload[4] if len(hb_payload) > 4 else None
        autopilot = hb_payload[5] if len(hb_payload) > 5 else None
        base_mode = hb_payload[6] if len(hb_payload) > 6 else None
        system_status = hb_payload[7] if len(hb_payload) > 7 else None
        armed = None if base_mode is None else bool(base_mode & 0x80)
        mode = None
        if vehicle_type == MAV_TYPE_FIXED_WING and custom is not None:
            mode = PLANE_MODES.get(custom)

        load_pct = None
        battery_v = None
        battery_pct = None
        battery_source = None
        sys_fields = {
            "load": None,
            "load_pct": None,
            "voltage_battery": None,
            "battery_remaining": None,
        }
        sys_valid = False
        if self._fresh(self.sys, now, TELEM_FRESH_S):
            sys_valid = True
            sp = self.sys["payload"]
            load_raw = _u16(sp, 12)
            if load_raw is not None and load_raw <= 1000:
                sys_fields["load"] = load_raw
                sys_fields["load_pct"] = load_raw / 10.0
                load_pct = sys_fields["load_pct"]
            volts = _u16(sp, 14)
            if volts is not None and volts != UINT16_MAX:
                sys_fields["voltage_battery"] = volts
            # Official wire offset is 30. Offset 18 is drop_rate_comm.
            remaining = _pct_byte(sp, 30)
            sys_fields["battery_remaining"] = remaining

        bat_v = None
        bat_pct = None
        if self._fresh(self.bat, now, TELEM_FRESH_S):
            bp = self.bat["payload"]
            bat_v = _pack_mv(bp)
            bat_pct = _pct_byte(bp, 35)

        if bat_v is not None or bat_pct is not None:
            battery_source = "battery_status"
            battery_v = None if bat_v is None else bat_v / 1000.0
            battery_pct = bat_pct
        elif sys_fields["voltage_battery"] is not None or sys_fields["battery_remaining"] is not None:
            battery_source = "sys_status"
            if sys_fields["voltage_battery"] is not None:
                battery_v = sys_fields["voltage_battery"] / 1000.0
            battery_pct = sys_fields["battery_remaining"]

        mem_kb = None
        if self._fresh(self.mem, now, TELEM_FRESH_S):
            mp = self.mem["payload"]
            free32 = _u32(mp, 4)
            free16 = _u16(mp, 2)
            if free32 is not None:
                mem_kb = free32 / 1024.0
            elif free16 is not None:
                mem_kb = free16 / 1024.0

        mcu_c = None
        if self._fresh(self.mcu, now, TELEM_FRESH_S):
            cdeg = _i16(self.mcu["payload"], 0)
            if cdeg is not None:
                mcu_c = cdeg / 100.0

        return {
            "ok": True,
            "status": "connected",
            "connected": True,
            "heartbeat_validity": "valid",
            "system_id": self.hb["sysid"],
            "component_id": self.hb["compid"],
            "autopilot": autopilot,
            "mode": mode,
            "custom_mode": custom,
            "armed": armed,
            "load_pct": load_pct,
            "loadPct": load_pct,
            "battery_v": battery_v,
            "battery_pct": battery_pct,
            "battery_source": battery_source,
            "meminfo_free_kb": mem_kb,
            "mcu_temp_c": mcu_c,
            "temperature_c": mcu_c,
            "last_heartbeat_age_ms": age_ms,
            "heartbeat": {
                "validity": "valid",
                "system_id": self.hb["sysid"],
                "component_id": self.hb["compid"],
                "fields": {
                    "custom_mode": custom,
                    "type": vehicle_type,
                    "autopilot": autopilot,
                    "base_mode": base_mode,
                    "system_status": system_status,
                },
            },
            "sys_status": {
                "validity": "valid" if sys_valid else "invalid",
                "system_id": self.sys["sysid"] if sys_valid else None,
                "component_id": self.sys["compid"] if sys_valid else None,
                "fields": sys_fields if sys_valid else _empty_sys_fields(),
            },
        }


def _empty_sys_fields():
    return {
        "load": None,
        "load_pct": None,
        "voltage_battery": None,
        "battery_remaining": None,
    }


def _disconnected(age_ms):
    return {
        "ok": True,
        "status": "disconnected",
        "connected": False,
        "heartbeat_validity": "invalid",
        "system_id": None,
        "component_id": None,
        "autopilot": None,
        "mode": None,
        "custom_mode": None,
        "armed": None,
        "load_pct": None,
        "loadPct": None,
        "battery_v": None,
        "battery_pct": None,
        "battery_source": None,
        "meminfo_free_kb": None,
        "mcu_temp_c": None,
        "temperature_c": None,
        "last_heartbeat_age_ms": age_ms,
        "heartbeat": {
            "validity": "invalid",
            "system_id": None,
            "component_id": None,
            "fields": {
                "custom_mode": None,
                "type": None,
                "autopilot": None,
                "base_mode": None,
                "system_status": None,
            },
        },
        "sys_status": {
            "validity": "invalid",
            "system_id": None,
            "component_id": None,
            "fields": _empty_sys_fields(),
        },
    }


def _pack_mv(payload: bytes):
    if len(payload) < 12:
        return None
    count = min(10, (len(payload) - 10) // 2)
    total = 0
    seen = 0
    for i in range(count):
        cell = _u16(payload, 10 + (2 * i))
        if cell is None or cell == UINT16_MAX:
            continue
        total += cell
        seen += 1
    if seen == 0:
        return None
    return total


_LOCK = threading.Lock()
_OBS = FcObserver()


def set_fc_clock(now_fn):
    with _LOCK:
        _OBS.set_clock(now_fn)


def reset_fc_observer():
    with _LOCK:
        _OBS.reset()
        _OBS.set_clock(time.monotonic)


def observe_uart_bytes(data: bytes):
    """Parse a copy. Caller still forwards the original bytes."""
    if not data:
        return
    with _LOCK:
        _OBS.feed(bytes(data))


def fc_link_flags():
    with _LOCK:
        snap = _OBS.snapshot()
        return {
            "connected": snap["connected"] is True,
            "heartbeat_wall": _OBS.heartbeat_wall,
        }


def fc_status_payload():
    with _LOCK:
        body = _OBS.snapshot()
    return body
