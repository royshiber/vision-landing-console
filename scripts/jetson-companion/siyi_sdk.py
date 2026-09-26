#!/usr/bin/env python3
"""SIYI gimbal SDK (A8 mini) over UDP. Not a flight command.

Packet: STX 0x6655 LE, CTRL, data_len LE, SEQ LE, CMD, DATA, CRC16-CCITT
poly 0x1021 init 0, CRC stored LE. CRC covers every byte before the CRC.

The A8 mini manual labels set-angle as 0x0D (same id as attitude). Newer
SIYI docs use 0x0E. VLC_SIYI_ANGLE_CMD selects it (default 0x0E).

Control endpoints stay off unless VLC_GIMBAL_CONTROL_ENABLED=1.
"""

from __future__ import annotations

import json
import os
import socket
import struct
import threading
import time

STX = 0x6655
CTRL_SEND = 0x01
CMD_FIRMWARE = 0x01
CMD_HARDWARE = 0x02
CMD_AUTOFOCUS = 0x04
CMD_ZOOM = 0x05
CMD_FOCUS = 0x06
CMD_RATE = 0x07
CMD_CENTER = 0x08
CMD_CONFIG = 0x0A
CMD_ATTITUDE = 0x0D
CMD_PHOTO = 0x0C
DEFAULT_HOST = "192.168.144.25"
DEFAULT_PORT = 37260
YAW_MIN = -135.0
YAW_MAX = 135.0
PITCH_MIN = -90.0
PITCH_MAX = 25.0
RATE_MIN = -100
RATE_MAX = 100
CONTROL_DISABLED_HE = "שליטת גימבל כבויה. לא נשלחה פקודה."
MODE_TO_FUNC = {"lock": 3, "follow": 4, "fpv": 5}
FUNC_TO_MODE = {0: "lock", 1: "follow", 2: "fpv"}
MODE_ALIASES = {
    "lock": "lock",
    "follow": "follow",
    "fpv": "fpv",
    "נעילה": "lock",
    "עקיבה": "follow",
}

_CRC_TAB = []
for _i in range(256):
    _crc = _i << 8
    for _ in range(8):
        if _crc & 0x8000:
            _crc = ((_crc << 1) ^ 0x1021) & 0xFFFF
        else:
            _crc = (_crc << 1) & 0xFFFF
    _CRC_TAB.append(_crc)


def crc16(data, init=0):
    crc = init & 0xFFFF
    for byte in data:
        crc = ((crc << 8) & 0xFFFF) ^ _CRC_TAB[((crc >> 8) ^ byte) & 0xFF]
    return crc & 0xFFFF


def encode_packet(cmd, data=b"", seq=0, ctrl=CTRL_SEND):
    payload = bytes(data or b"")
    if len(payload) > 0xFFFF:
        raise ValueError("data_too_long")
    body = struct.pack(
        "<HBHHB",
        STX,
        ctrl & 0xFF,
        len(payload) & 0xFFFF,
        seq & 0xFFFF,
        cmd & 0xFF,
    ) + payload
    return body + struct.pack("<H", crc16(body))


def decode_packet(raw):
    buf = bytes(raw or b"")
    if len(buf) < 10:
        return None
    stx, ctrl, length, seq, cmd = struct.unpack_from("<HBHHB", buf, 0)
    if stx != STX:
        return None
    total = 8 + length + 2
    if len(buf) < total:
        return None
    body = buf[: 8 + length]
    got = struct.unpack_from("<H", buf, 8 + length)[0]
    if crc16(body) != got:
        return None
    data = buf[8:8 + length]
    return {"ctrl": ctrl, "len": length, "seq": seq, "cmd": cmd, "data": data}


def format_firmware(value):
    if value is None:
        return None
    word = int(value) & 0xFFFFFFFF
    major = (word >> 16) & 0xFF
    minor = (word >> 8) & 0xFF
    patch = word & 0xFF
    return f"v{major}.{minor}.{patch}"


def parse_firmware(data):
    if len(data) < 12:
        return None
    camera, gimbal, zoom = struct.unpack_from("<III", data, 0)
    return {
        "camera": format_firmware(camera),
        "gimbal": format_firmware(gimbal),
        "zoom": format_firmware(zoom),
        "camera_raw": camera,
        "gimbal_raw": gimbal,
        "zoom_raw": zoom,
    }


def parse_hardware_id(data):
    if not data:
        return None
    text = bytes(data[:12]).split(b"\x00", 1)[0].decode("ascii", errors="ignore").strip()
    return text or None


def parse_attitude(data):
    if len(data) < 12:
        return None
    yaw, pitch, roll, yaw_rate, pitch_rate, roll_rate = struct.unpack_from("<hhhhhh", data, 0)
    return {
        "yaw": yaw / 10.0,
        "pitch": pitch / 10.0,
        "roll": roll / 10.0,
        "yaw_rate": yaw_rate / 10.0,
        "pitch_rate": pitch_rate / 10.0,
        "roll_rate": roll_rate / 10.0,
    }


def parse_zoom(data):
    if len(data) < 2:
        return None
    raw = struct.unpack_from("<H", data, 0)[0]
    return raw / 10.0


def parse_config(data):
    if len(data) < 5:
        return None
    record = data[3] if len(data) > 3 else None
    mode_byte = data[4] if len(data) > 4 else None
    return {
        "hdr": bool(data[1]) if len(data) > 1 else None,
        "recording": None if record is None else record == 1,
        "record_sta": record,
        "mode": FUNC_TO_MODE.get(mode_byte),
        "mount": data[5] if len(data) > 5 else None,
    }


def clamp_rate(value):
    return max(RATE_MIN, min(RATE_MAX, int(value)))


def clamp_angle(yaw, pitch):
    yaw_c = max(YAW_MIN, min(YAW_MAX, float(yaw)))
    pitch_c = max(PITCH_MIN, min(PITCH_MAX, float(pitch)))
    return yaw_c, pitch_c


def angle_to_raw(degrees):
    return int(round(float(degrees) * 10.0))


def gimbal_control_enabled(env=None):
    src = env if env is not None else os.environ
    raw = src.get("VLC_GIMBAL_CONTROL_ENABLED", "0")
    return str(raw or "0").strip().lower() in {"1", "true", "yes", "on"}


def angle_cmd_from_env(env=None):
    src = env if env is not None else os.environ
    raw = str(src.get("VLC_SIYI_ANGLE_CMD", "0x0E") or "0x0E").strip()
    try:
        return int(raw, 0) & 0xFF
    except ValueError:
        return 0x0E


def _env_float(name, default, env=None):
    src = env if env is not None else os.environ
    raw = str(src.get(name, "") or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name, default, env=None):
    src = env if env is not None else os.environ
    raw = str(src.get(name, "") or "").strip()
    if not raw:
        return default
    try:
        return int(raw, 0)
    except ValueError:
        return default


class SiyiLink:
    def __init__(self, host=None, port=None, timeout=None, env=None, sock=None, now_fn=None):
        src = env if env is not None else os.environ
        self.host = host or str(src.get("VLC_SIYI_HOST", DEFAULT_HOST) or DEFAULT_HOST).strip()
        self.port = int(port if port is not None else _env_int("VLC_SIYI_PORT", DEFAULT_PORT, src))
        self.timeout = float(timeout if timeout is not None else _env_float("VLC_SIYI_TIMEOUT_S", 0.4, src))
        self.poll_s = max(0.05, _env_float("VLC_SIYI_POLL_S", 0.5, src))
        self.stale_s = max(0.2, _env_float("VLC_SIYI_STALE_S", 2.0, src))
        self.angle_cmd = angle_cmd_from_env(src)
        self.env = src
        self.now_fn = now_fn or time.monotonic
        self._sock = sock
        self._external_sock = sock is not None
        self._seq = 0
        self._lock = threading.Lock()
        self._io = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self.firmware = None
        self.hardware_id = None
        self.attitude = None
        self.zoom = None
        self.mode = None
        self.recording = None
        self.last_reply_mono = None
        self.present = False
        self.last_error = None
        self.command_log = []
        self._ticks = 0

    def start(self):
        if self._thread is not None:
            return self
        self._thread = threading.Thread(target=self._loop, name="siyi-poll", daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)
        self._close_sock()

    def public_status(self):
        now = self.now_fn()
        with self._lock:
            age = None
            if self.last_reply_mono is not None:
                age = max(0, int(round((now - self.last_reply_mono) * 1000)))
            fresh = self.present and age is not None and age <= int(self.stale_s * 1000)
            if self.last_reply_mono is not None and not fresh:
                self.present = False
            present = bool(self.present and fresh)
            error = None if present else (self.last_error or "no_reply")
            return {
                "ok": True,
                "present": present,
                "firmware": self.firmware if present else None,
                "hardware_id": self.hardware_id if present else None,
                "attitude": self.attitude if present else None,
                "zoom": self.zoom if present else None,
                "mode": self.mode if present else None,
                "recording": self.recording if present else None,
                "age_ms": age,
                "control_enabled": gimbal_control_enabled(self.env),
                "polling": self._thread is not None,
                "host": self.host,
                "port": self.port,
                "angle_cmd": self.angle_cmd,
                "error": error,
                "note": "gimbal reply live" if present else "no gimbal reply; not invented",
            }

    def command(self, action, body=None):
        action = str(action or "").strip().lower()
        body = body if isinstance(body, dict) else {}
        if not gimbal_control_enabled(self.env):
            entry = {"action": action, "ok": False, "reason": "gimbal_control_disabled"}
            self._log(entry)
            return 403, {
                "ok": False,
                "reason": "gimbal_control_disabled",
                "message": CONTROL_DISABLED_HE,
                "sent": False,
            }
        try:
            cmd, data, needs_ack = self._build(action, body)
        except ValueError as exc:
            entry = {"action": action, "ok": False, "reason": str(exc)}
            self._log(entry)
            return 400, {"ok": False, "reason": str(exc), "message": "בקשה לא תקינה", "sent": False}
        decoded = self.exchange(cmd, data, require_match=needs_ack)
        if decoded is False:
            entry = {"action": action, "cmd": cmd, "ok": False, "reason": "send_failed"}
            self._log(entry)
            return 504, {"ok": False, "reason": "send_failed", "sent": False, "confirmed": False}
        if needs_ack and not isinstance(decoded, dict):
            entry = {"action": action, "cmd": cmd, "ok": False, "reason": "no_reply"}
            self._log(entry)
            return 504, {"ok": False, "reason": "no_reply", "sent": True, "confirmed": False, "present": False}
        result = {"ok": True, "sent": True, "confirmed": bool(needs_ack and isinstance(decoded, dict)), "cmd": cmd}
        if isinstance(decoded, dict):
            result["ack"] = self._apply_ack(cmd, decoded["data"])
        entry = {"action": action, "cmd": cmd, "ok": True, "confirmed": result["confirmed"]}
        self._log(entry)
        return 200, result

    def exchange(self, cmd, data=b"", require_match=True):
        with self._io:
            return self._exchange_locked(cmd, data, require_match)

    def _exchange_locked(self, cmd, data=b"", require_match=True):
        packet_seq = self._seq & 0xFFFF
        self._seq = (self._seq + 1) & 0xFFFF
        packet = encode_packet(cmd, data, seq=packet_seq)
        try:
            sock = self._ensure_sock()
            sock.sendto(packet, (self.host, self.port))
        except OSError as exc:
            with self._lock:
                self.last_error = "send_failed"
            print(f"[gimbal] send_failed cmd={cmd:#04x} {exc}", flush=True)
            return False
        if not require_match:
            return True
        deadline = time.monotonic() + self.timeout
        while True:
            remain = deadline - time.monotonic()
            if remain <= 0:
                with self._lock:
                    if self.last_reply_mono is None:
                        self.last_error = "no_reply"
                return None
            try:
                sock.settimeout(remain)
                raw, _addr = sock.recvfrom(2048)
            except socket.timeout:
                with self._lock:
                    if self.last_reply_mono is None:
                        self.last_error = "no_reply"
                return None
            except OSError:
                return None
            decoded = decode_packet(raw)
            if not decoded:
                continue
            if decoded["cmd"] != (cmd & 0xFF) or decoded["seq"] != packet_seq:
                continue
            self._note_reply()
            return decoded

    def poll_once(self):
        self._ticks += 1
        decoded = self.exchange(CMD_ATTITUDE, b"", require_match=True)
        if isinstance(decoded, dict):
            att = parse_attitude(decoded["data"])
            if att:
                with self._lock:
                    self.attitude = att
                    self.present = True
                    self.last_error = None
        else:
            self._expire()
        if self._ticks % 5 == 1:
            fw = self.exchange(CMD_FIRMWARE, b"", require_match=True)
            if isinstance(fw, dict):
                parsed = parse_firmware(fw["data"])
                if parsed:
                    with self._lock:
                        self.firmware = {
                            "camera": parsed["camera"],
                            "gimbal": parsed["gimbal"],
                            "zoom": parsed["zoom"],
                        }
            hw = self.exchange(CMD_HARDWARE, b"", require_match=True)
            if isinstance(hw, dict):
                text = parse_hardware_id(hw["data"])
                if text:
                    with self._lock:
                        self.hardware_id = text
            cfg = self.exchange(CMD_CONFIG, b"", require_match=True)
            if isinstance(cfg, dict):
                parsed = parse_config(cfg["data"])
                if parsed:
                    with self._lock:
                        if parsed.get("mode"):
                            self.mode = parsed["mode"]
                        if parsed.get("recording") is not None:
                            self.recording = parsed["recording"]

    def _loop(self):
        while not self._stop.wait(self.poll_s):
            try:
                self.poll_once()
            except Exception as exc:
                print(f"[gimbal] poll {exc}", flush=True)

    def _build(self, action, body):
        if action == "rate":
            if "yaw" not in body or "pitch" not in body:
                raise ValueError("missing_rate")
            yaw = clamp_rate(body.get("yaw"))
            pitch = clamp_rate(body.get("pitch"))
            return CMD_RATE, struct.pack("<bb", yaw, pitch), True
        if action == "angle":
            if "yaw" not in body or "pitch" not in body:
                raise ValueError("missing_angle")
            yaw, pitch = clamp_angle(body.get("yaw"), body.get("pitch"))
            return self.angle_cmd, struct.pack("<hh", angle_to_raw(yaw), angle_to_raw(pitch)), True
        if action == "center":
            return CMD_CENTER, bytes([1]), True
        if action == "zoom":
            zoom = _zoom_byte(body)
            return CMD_ZOOM, struct.pack("<b", zoom), True
        if action == "mode":
            mode = MODE_ALIASES.get(str(body.get("mode") or "").strip().lower())
            if not mode:
                raise ValueError("bad_mode")
            return CMD_PHOTO, bytes([MODE_TO_FUNC[mode]]), False
        if action == "photo":
            return CMD_PHOTO, bytes([0]), False
        if action == "record":
            return CMD_PHOTO, bytes([2]), False
        raise ValueError("unknown_action")

    def _apply_ack(self, cmd, data):
        if cmd == CMD_ZOOM:
            zoom = parse_zoom(data)
            if zoom is not None:
                with self._lock:
                    self.zoom = zoom
            return {"zoom": zoom}
        if cmd in {CMD_RATE, CMD_CENTER, CMD_AUTOFOCUS, CMD_FOCUS}:
            sta = data[0] if data else None
            return {"sta": sta}
        if cmd == self.angle_cmd:
            att = parse_attitude(data + b"\x00\x00") if len(data) >= 4 else None
            if len(data) >= 6:
                yaw, pitch, roll = struct.unpack_from("<hhh", data, 0)
                att = {"yaw": yaw / 10.0, "pitch": pitch / 10.0, "roll": roll / 10.0}
                with self._lock:
                    prev = dict(self.attitude or {})
                    prev.update(att)
                    self.attitude = prev
            return att
        return {"len": len(data)}

    def _note_reply(self):
        with self._lock:
            self.last_reply_mono = self.now_fn()
            self.present = True
            self.last_error = None

    def _expire(self):
        now = self.now_fn()
        with self._lock:
            if self.last_reply_mono is None or (now - self.last_reply_mono) > self.stale_s:
                self.present = False
                if self.last_error is None:
                    self.last_error = "no_reply"

    def _ensure_sock(self):
        if self._sock is not None:
            return self._sock
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(self.timeout)
        self._sock = sock
        return sock

    def _close_sock(self):
        if self._external_sock:
            return
        sock = self._sock
        self._sock = None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    def _log(self, entry):
        entry = {"t": time.time(), **entry}
        line = json.dumps(entry, ensure_ascii=False)
        print(f"[gimbal] {line}", flush=True)
        with self._lock:
            self.command_log.append(entry)
            self.command_log = self.command_log[-32:]


def _zoom_byte(body):
    if "zoom" in body and body.get("zoom") is not None:
        return max(-1, min(1, int(body.get("zoom"))))
    direction = str(body.get("direction") or body.get("dir") or "").strip().lower()
    if direction in {"in", "zoom_in", "+"}:
        return 1
    if direction in {"out", "zoom_out", "-"}:
        return -1
    if direction in {"stop", "0"}:
        return 0
    raise ValueError("bad_zoom")


_LINK = None
_LINK_LOCK = threading.Lock()


def get_link(start=False):
    global _LINK
    with _LINK_LOCK:
        if _LINK is None:
            _LINK = SiyiLink()
        link = _LINK
    if start:
        link.start()
    return link


def gimbal_status(start=False):
    return get_link(start=start).public_status()


def gimbal_command(action, body=None):
    return get_link(start=False).command(action, body)


def reset_link_for_tests():
    global _LINK
    with _LINK_LOCK:
        if _LINK is not None:
            _LINK.stop()
        _LINK = None
