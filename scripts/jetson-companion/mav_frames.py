# -*- coding: utf-8 -*-
"""Split MAVLink bytes into frames without building a pymavlink object per message.

The flight detector only needs a handful of message ids. Everything else stays
a raw frame for the tlog.
"""

from __future__ import print_function

import struct

# Common ids. These layouts are the MAVLink common / ardupilotmega payloads.
DETECTOR_IDS = {
    0: "HEARTBEAT",
    2: "SYSTEM_TIME",
    24: "GPS_RAW_INT",
    33: "GLOBAL_POSITION_INT",
    74: "VFR_HUD",
    245: "EXTENDED_SYS_STATE",
}


class LiteMsg(object):
    """Enough of a pymavlink message for obs_from_message."""

    def __init__(self, name, sysid, compid, fields):
        self._name = name
        self._sysid = int(sysid)
        self._compid = int(compid)
        self._fields = fields

    def get_type(self):
        return self._name

    def get_srcSystem(self):
        return self._sysid

    def get_srcComponent(self):
        return self._compid

    def get_msgbuf(self):
        return None

    def __getattr__(self, key):
        try:
            return self._fields[key]
        except KeyError:
            raise AttributeError(key)


def _pad(payload, size):
    if len(payload) >= size:
        return payload
    return payload + bytes(size - len(payload))


def _heartbeat(payload):
    custom, mav_type, autopilot, base_mode, _status, _ver = struct.unpack_from("<IBBBBB", _pad(payload, 9))
    return {
        "custom_mode": int(custom),
        "type": int(mav_type),
        "autopilot": int(autopilot),
        "base_mode": int(base_mode),
    }


def _system_time(payload):
    usec, _boot = struct.unpack_from("<QI", _pad(payload, 12))
    return {"time_unix_usec": int(usec)}


def _gps(payload):
    _t, lat, lon, _alt, eph, _epv, _vel, _cog, fix, sats = struct.unpack_from("<QiiiHHHHBB", _pad(payload, 30))
    return {
        "lat": int(lat),
        "lon": int(lon),
        "eph": int(eph),
        "fix_type": int(fix),
        "satellites_visible": int(sats),
    }


def _gpi(payload):
    _boot, lat, lon, _alt, rel, vx, vy, _vz, _hdg = struct.unpack_from("<IiiiihhhH", _pad(payload, 28))
    return {
        "lat": int(lat),
        "lon": int(lon),
        "relative_alt": int(rel),
        "vx": int(vx),
        "vy": int(vy),
    }


def _vfr(payload):
    airspeed, groundspeed, alt, climb, _heading, throttle = struct.unpack_from("<ffffhH", _pad(payload, 20))
    return {
        "airspeed": float(airspeed),
        "groundspeed": float(groundspeed),
        "alt": float(alt),
        "climb": float(climb),
        "throttle": int(throttle),
    }


def _ext(payload):
    _vtol, landed = struct.unpack_from("<BB", _pad(payload, 2))
    return {"landed_state": int(landed)}


_UNPACK = {
    "HEARTBEAT": _heartbeat,
    "SYSTEM_TIME": _system_time,
    "GPS_RAW_INT": _gps,
    "GLOBAL_POSITION_INT": _gpi,
    "VFR_HUD": _vfr,
    "EXTENDED_SYS_STATE": _ext,
}


def lite_msg(frame):
    """Return a LiteMsg for a detector frame, else None."""
    if not frame:
        return None
    magic = frame[0]
    if magic == 0xFD:
        if len(frame) < 12:
            return None
        msgid = frame[7] | (frame[8] << 8) | (frame[9] << 16)
        sysid = frame[5]
        comp = frame[6]
        payload = frame[10 : 10 + frame[1]]
    elif magic == 0xFE:
        if len(frame) < 8:
            return None
        msgid = frame[5]
        sysid = frame[3]
        comp = frame[4]
        payload = frame[6 : 6 + frame[1]]
    else:
        return None
    name = DETECTOR_IDS.get(msgid)
    if name is None:
        return None
    return LiteMsg(name, sysid, comp, _UNPACK[name](payload))


def _need(buf, i):
    """Byte length of the frame at i, or None if the header is short, or 0 to skip one byte."""
    n = len(buf)
    if i >= n:
        return None
    magic = buf[i]
    if magic not in (0xFD, 0xFE):
        return 0
    if i + 2 > n:
        return None
    if magic == 0xFE:
        return 8 + buf[i + 1]
    if i + 3 > n:
        return None
    need = 12 + buf[i + 1]
    if buf[i + 2] & 0x01:
        need += 13
    return need


class FrameSplitter(object):
    def __init__(self):
        self.buf = bytearray()
        self.skipped = 0

    def feed(self, data):
        """Yield (raw_frame, lite_or_none) for every complete frame in data."""
        if data:
            self.buf.extend(data)
        out = []
        buf = self.buf
        i = 0
        n = len(buf)
        while i < n:
            need = _need(buf, i)
            if need is None:
                break
            if need == 0:
                self.skipped += 1
                i += 1
                continue
            if i + need > n:
                break
            frame = bytes(buf[i : i + need])
            i += need
            out.append((frame, lite_msg(frame)))
        if i:
            del buf[:i]
        if len(buf) > 65536:
            self.skipped += len(buf)
            del buf[:]
        return out
