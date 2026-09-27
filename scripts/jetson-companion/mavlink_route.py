"""MAVLink routing endpoint for the companion on the FC UART it already owns.

The air radio is on a spare FC telemetry port. ArduPilot forwards frames to
the component id this module announces. This module only accepts a small
command whitelist. It does not write FC parameters and it does not send
flight commands.
"""

from __future__ import annotations

import struct
import threading

COMP_ID = 191
CMD_UPLINK = 42001
CMD_GIMBAL = 42002
CMD_TRACK = 42003

MSG_HEARTBEAT = 0
MSG_COMMAND_LONG = 76
MSG_COMMAND_ACK = 77
MSG_PARAM_SET = 23
MSG_NAMED_VALUE_FLOAT = 251
MSG_STATUSTEXT = 253

_CRC_EXTRA = {
    MSG_HEARTBEAT: 50,
    MSG_PARAM_SET: 168,
    MSG_COMMAND_LONG: 152,
    MSG_COMMAND_ACK: 143,
    MSG_NAMED_VALUE_FLOAT: 170,
    MSG_STATUSTEXT: 83,
}

MAV_RESULT_ACCEPTED = 0
MAV_RESULT_DENIED = 2
MAV_RESULT_UNSUPPORTED = 3
MAV_RESULT_FAILED = 4

_FLIGHT_COMMANDS = {21, 22, 176, 189, 192, 400}


def x25(data):
    crc = 0xFFFF
    for byte in data:
        tmp = (byte ^ (crc & 0xFF)) & 0xFF
        tmp = (tmp ^ (tmp << 4)) & 0xFF
        crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF
    return crc


def build_frame(msgid, payload, seq, sysid, compid):
    payload = bytes(payload)
    header = bytes([
        0xFE,
        len(payload) & 0xFF,
        seq & 0xFF,
        sysid & 0xFF,
        compid & 0xFF,
        msgid & 0xFF,
    ])
    extra = _CRC_EXTRA.get(msgid, 0)
    crc = x25(header[1:] + payload + bytes([extra]))
    return header + payload + bytes([crc & 0xFF, (crc >> 8) & 0xFF])


def parse_frames(buf):
    """Split a byte copy into frames. The caller still owns the original bytes."""
    frames = []
    i = 0
    raw = bytes(buf or b"")
    while i < len(raw):
        stx = raw[i]
        if stx == 0xFE and i + 8 <= len(raw):
            length = raw[i + 1]
            total = 8 + length
            if i + total > len(raw):
                break
            chunk = raw[i:i + total]
            body = chunk[1:-2]
            extra = _CRC_EXTRA.get(chunk[5], 0)
            expect = x25(body + bytes([extra]))
            got = chunk[-2] | (chunk[-1] << 8)
            if got == expect:
                frames.append({
                    "raw": chunk,
                    "msgid": chunk[5],
                    "sys": chunk[3],
                    "comp": chunk[4],
                    "payload": chunk[6:-2],
                })
                i += total
                continue
        if stx == 0xFD and i + 12 <= len(raw):
            length = raw[i + 1]
            incompat = raw[i + 2]
            total = 12 + length + (13 if incompat & 0x01 else 0)
            if i + total > len(raw):
                break
            chunk = raw[i:i + total]
            msgid = chunk[7] | (chunk[8] << 8) | (chunk[9] << 16)
            sign = 13 if incompat & 0x01 else 0
            payload = chunk[10:10 + length]
            extra = _CRC_EXTRA.get(msgid & 0xFF, 0)
            expect = x25(chunk[1:10 + length] + bytes([extra]))
            crc_at = 10 + length
            got = chunk[crc_at] | (chunk[crc_at + 1] << 8)
            if got == expect:
                frames.append({
                    "raw": chunk,
                    "msgid": msgid,
                    "sys": chunk[5],
                    "comp": chunk[6],
                    "payload": payload,
                })
                i += total
                continue
        i += 1
    return frames, raw[i:]


def command_long_fields(payload):
    padded = payload + bytes(33 - len(payload)) if len(payload) < 33 else payload
    params = list(struct.unpack_from("<7f", padded, 0))
    command = struct.unpack_from("<H", padded, 28)[0]
    target_system = padded[30]
    target_component = padded[31]
    return command, params, target_system, target_component


def _ack(command, result):
    return struct.pack("<HB", command & 0xFFFF, result & 0xFF)


def _named(name, value):
    token = str(name or "")[:10].encode("ascii", "ignore")
    token = token + bytes(10 - len(token))
    return struct.pack("<I", 0) + token + struct.pack("<f", float(value))


def _statustext(text):
    raw = str(text or "")[:50].encode("ascii", "ignore")
    return bytes([6]) + raw + bytes(50 - len(raw))


class CompanionRouter:
    """Sniff a copy of the FC UART and answer only the companion component."""

    def __init__(self, *, gimbal=None, uplink=None, status=None, comp_id=COMP_ID):
        self.comp_id = int(comp_id)
        self.sysid = 1
        self._gimbal = gimbal
        self._uplink = uplink
        self._status = status or (lambda: {})
        self._buf = b""
        self._seq = 0
        self._lock = threading.Lock()
        self.commands = 0
        self.last_command = None
        self.ignored_flight = 0

    def _next_seq(self):
        seq = self._seq & 0xFF
        self._seq = (self._seq + 1) & 0xFF
        return seq

    def _out(self, msgid, payload):
        frame = build_frame(msgid, payload, self._next_seq(), self.sysid, self.comp_id)
        return frame

    def _learn(self, frame):
        if frame["msgid"] != MSG_HEARTBEAT or len(frame["payload"]) < 6:
            return
        if frame["comp"] != 1:
            return
        mav_type = frame["payload"][4]
        autopilot = frame["payload"][5]
        if mav_type == 6 or autopilot == 8:
            return
        self.sysid = frame["sys"]

    def _handle_command(self, frame):
        command, params, target_system, target_component = command_long_fields(frame["payload"])
        if target_component != self.comp_id:
            return b""
        if target_system not in (0, self.sysid):
            return b""
        self.commands += 1
        if command in _FLIGHT_COMMANDS or command not in {CMD_UPLINK, CMD_GIMBAL, CMD_TRACK}:
            self.ignored_flight += 1
            self.last_command = "rejected"
            return self._out(MSG_COMMAND_ACK, _ack(command, MAV_RESULT_UNSUPPORTED))
        if command == CMD_TRACK:
            self.last_command = "track"
            return self._out(MSG_COMMAND_ACK, _ack(command, MAV_RESULT_UNSUPPORTED))
        if command == CMD_UPLINK:
            kind = "cellular" if int(round(params[0])) == 1 else "wifi"
            enabled = int(round(params[1])) == 1
            self.last_command = "uplink"
            code = 200
            if self._uplink is not None:
                try:
                    code, _body = self._uplink(kind, enabled)
                except Exception:
                    code = 500
            result = MAV_RESULT_ACCEPTED if int(code) < 400 else MAV_RESULT_FAILED
            if int(code) in (403, 409):
                result = MAV_RESULT_DENIED
            return self._out(MSG_COMMAND_ACK, _ack(command, result))
        action_n = int(round(params[0]))
        self.last_command = "gimbal"
        if action_n == 1:
            action, body = "rate", {"yaw": int(round(params[1])), "pitch": int(round(params[2]))}
        elif action_n == 2:
            action, body = "zoom", {"zoom": max(-1, min(1, int(round(params[1]))))}
        elif action_n == 3:
            action, body = "mode", {"mode": "lock" if int(round(params[1])) == 1 else "follow"}
        else:
            return self._out(MSG_COMMAND_ACK, _ack(command, MAV_RESULT_UNSUPPORTED))
        code = 200
        if self._gimbal is not None:
            try:
                code, _body = self._gimbal(action, body)
            except Exception:
                code = 500
        result = MAV_RESULT_ACCEPTED if int(code) < 400 else MAV_RESULT_FAILED
        if int(code) == 403:
            result = MAV_RESULT_DENIED
        return self._out(MSG_COMMAND_ACK, _ack(command, result))

    def feed(self, data):
        """Parse a copy. PARAM_SET is ignored. Nothing here writes a parameter."""
        with self._lock:
            self._buf += bytes(data or b"")
            frames, self._buf = parse_frames(self._buf)
            if len(self._buf) > 8192:
                self._buf = self._buf[-1024:]
            out = b""
            for frame in frames:
                self._learn(frame)
                if frame["msgid"] == MSG_PARAM_SET:
                    continue
                if frame["msgid"] == MSG_COMMAND_LONG:
                    out += self._handle_command(frame)
            return out

    def tick(self):
        """Heartbeat plus a compact status burst. Safe to call about once a second."""
        with self._lock:
            out = self._out(MSG_HEARTBEAT, struct.pack("<IBBBBB", 0, 18, 8, 0, 4, 3))
            try:
                snap = self._status() or {}
            except Exception:
                snap = {}
            fields = [
                ("UP_WIFI", 1.0 if snap.get("wifi") else 0.0),
                ("UP_CELL", 1.0 if snap.get("cell") else 0.0),
                ("CAM0_OK", 1.0 if snap.get("cam0") else 0.0),
                ("CAM1_OK", 1.0 if snap.get("cam1") else 0.0),
            ]
            if isinstance(snap.get("yaw"), (int, float)):
                fields.append(("GMB_YAW", float(snap["yaw"])))
            if isinstance(snap.get("pitch"), (int, float)):
                fields.append(("GMB_PIT", float(snap["pitch"])))
            if snap.get("mode") in (0, 1):
                fields.append(("GMB_MODE", float(snap["mode"])))
            for name, value in fields:
                out += self._out(MSG_NAMED_VALUE_FLOAT, _named(name, value))
            text = "VLC w=%d c=%d cam0=%d cam1=%d" % (
                1 if snap.get("wifi") else 0,
                1 if snap.get("cell") else 0,
                1 if snap.get("cam0") else 0,
                1 if snap.get("cam1") else 0,
            )
            out += self._out(MSG_STATUSTEXT, _statustext(text))
            return out
