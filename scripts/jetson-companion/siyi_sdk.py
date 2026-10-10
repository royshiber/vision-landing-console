#!/usr/bin/env python3
"""SIYI gimbal SDK (A8 mini) over UDP. Not a flight command.

Packet: STX 0x6655 LE, CTRL, data_len LE, SEQ LE, CMD, DATA, CRC16-CCITT
poly 0x1021 init 0, CRC stored LE. CRC covers every byte before the CRC.

The A8 mini manual labels set-angle as 0x0D (same id as attitude). Newer
SIYI docs use 0x0E. VLC_SIYI_ANGLE_CMD selects it (default 0x0E).

Control endpoints stay off unless VLC_GIMBAL_CONTROL_ENABLED=1.
Replies are paired by command id. The A8 mini does not echo the
request sequence. Attitude, current-zoom, firmware, and the angle
ack (0x0E) share one device counter. Config (0x0A), center (0x08), and
rate (0x07) share the other. Once a counter is known, a reply in
that group is kept only when its sequence moves forward by 1..64.
Anything else is dropped, and a backwards step is recorded. A long
silence, or a wait that produced no acceptable reply, lets the next
reply teach the counter again. An attitude (0x0D) that teaches the
counter is not the reading: it is kept only when a later attitude in
the same group is ahead of that baseline by 1..64. Datagrams already
queued are drained before each send so they are not this reply. Angle,
center, and rate confirm only on that counter-advanced attitude. Center
and rate wait for their ack, then re-read attitude for about 1.5 s,
with a short pause between reads so the link is not flooded. A newer
rate or stop cancels the confirm already in progress. This mount's
level pitch is ±180, so center is the shortest wrap-around distance to
yaw 0 and pitch 180, not to pitch 0. A rate confirms only when that
later reading shows the commanded change; a stop confirms only after
the rate has decayed. If it never decays, the result says so and
includes the last rate. A command ack alone does not confirm a move,
and neither does the attitude that only taught the counter.
Zoom is confirmed only by a current-zoom read (command
0x18): the first byte is the whole multiple and the second is tenths.
The status poll reads 0x18 as well. Firmware replies of 8 bytes (camera
and gimbal versions) are accepted.
The zoom-command ack (0x05) is a separate uint16 in tenths. A
confirmation never sends zoom stop. Codec specs (command 0x20) are
read with the status poll.
The request carries one stream-type byte (1 = main stream). A miss on
that read does not mark the gimbal absent. The set command (0x21) is
never sent. Nothing in this module moves the gimbal unless a control
POST is enabled and asked for.
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
# 0x18 is a read of the current zoom. 0x05 with 0 is zoom stop, a write.
CMD_ZOOM_READ = 0x18
CMD_RATE = 0x07
CMD_CENTER = 0x08
CMD_CONFIG = 0x0A
CMD_ATTITUDE = 0x0D
CMD_ANGLE = 0x0E
CMD_PHOTO = 0x0C
CMD_CODEC = 0x20
# 0x20 send data is one uint8: 0 recording, 1 main, 2 sub.
# Manual example for main: 55 66 01 01 00 00 00 20 01 9E 9D
CODEC_STREAM_MAIN = 1
# Live A8: 0x0D, 0x18, 0x01, and the 0x0E angle ack share one counter.
# 0x0A, the 0x08 center ack, and the 0x07 rate ack share the other.
SHARED_SEQ_CMDS = frozenset({CMD_ATTITUDE, CMD_ZOOM_READ, CMD_FIRMWARE, CMD_ANGLE})
CONFIG_SEQ_CMDS = frozenset({CMD_CONFIG, CMD_RATE, CMD_CENTER})
# A move confirms only from a fresh attitude whose counter advanced.
# Zoom confirms only from a 0x18 read. A command ack does not confirm.
SEQ_AHEAD_MAX = 64
SEQ_SILENCE_S = 3.0
# Center and rate take about this long to show up in attitude.
CONFIRM_MOTION_S = 1.5
# Pause between confirm reads. 75–100 ms keeps the loop at 10–15 Hz.
CONFIRM_READ_GAP_S = 0.09
# This mount reads pitch ±180 when the camera is level.
CENTER_YAW = 0.0
CENTER_PITCH = 180.0
# Rates inside this band are noise, not a commanded move.
RATE_NOISE_DPS = 1.0
MOTION_ACTIONS = frozenset({"rate", "angle", "center"})
ACK_EXACT_ACTIONS = MOTION_ACTIONS | frozenset({"zoom"})
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


def seq_distance(left, right):
    delta = (int(left) - int(right)) & 0xFFFF
    if delta & 0x8000:
        delta = (0x10000 - delta) & 0xFFFF
    return delta


def seq_advance(reply_seq, last_seq):
    """Forward distance from last_seq to reply_seq, modulo 0x10000."""
    return (int(reply_seq) - int(last_seq)) & 0xFFFF


def _cmd_is(decoded, cmd):
    if not isinstance(decoded, dict):
        return False
    try:
        return (int(decoded.get("cmd")) & 0xFF) == (int(cmd) & 0xFF)
    except (TypeError, ValueError):
        return False


def reply_matches(decoded, cmd, request_seq=None, last_camera_seq=None):
    """True when the datagram is for this command.

    Sequence is not checked here. The link drops a grouped reply whose
    own counter did not move forward by 1..64. ``request_seq`` and
    ``last_camera_seq`` are ignored so older callers still import.
    """
    return _cmd_is(decoded, cmd)


def seq_in_window(reply_seq, last_seq, limit=SEQ_AHEAD_MAX):
    """True when reply_seq is ahead of last_seq by 1..limit, mod 0x10000."""
    advance = seq_advance(reply_seq, last_seq)
    return 1 <= advance <= int(limit)


def format_firmware(value):
    if value is None:
        return None
    word = int(value) & 0xFFFFFFFF
    major = (word >> 16) & 0xFF
    minor = (word >> 8) & 0xFF
    patch = word & 0xFF
    return f"v{major}.{minor}.{patch}"


def parse_firmware(data):
    """Camera and gimbal versions, then zoom when the gimbal sends it.

    The A8 mini replies to 0x01 with 8 bytes (two uint32 versions). A
    12-byte reply also carries the zoom version.
    """
    raw = bytes(data or b"")
    if len(raw) < 8:
        return None
    camera, gimbal = struct.unpack_from("<II", raw, 0)
    zoom_raw = None
    zoom = None
    if len(raw) >= 12:
        zoom_raw = struct.unpack_from("<I", raw, 8)[0]
        zoom = format_firmware(zoom_raw)
    return {
        "camera": format_firmware(camera),
        "gimbal": format_firmware(gimbal),
        "zoom": zoom,
        "camera_raw": camera,
        "gimbal_raw": gimbal,
        "zoom_raw": zoom_raw,
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
    """Current zoom from 0x18: whole multiple, then tenths. 3.5x is 03 05."""
    raw = bytes(data or b"")
    if len(raw) < 2:
        return None
    return int(raw[0]) + (int(raw[1]) / 10.0)


def parse_zoom_ack(data):
    """Manual-zoom ack from 0x05: uint16 little-endian, multiple times 10.

    3.5x is 35 (23 00). This is not the 0x18 whole-plus-tenths layout.
    """
    raw = bytes(data or b"")
    if len(raw) < 2:
        return None
    return struct.unpack_from("<H", raw, 0)[0] / 10.0


# SIYI 0x20 stream_type: 0 recording, 1 main, 2 sub.
CODEC_STREAM_NAME = {0: "record", 1: "main", 2: "sub"}


def parse_codec_specs(data):
    """Read-only SIYI codec block. 0x20, nine bytes per stream. Never a set."""
    raw = bytes(data or b"")
    rows = []
    off = 0
    while off + 9 <= len(raw):
        stream_type, enc, width, height, bitrate, fps = struct.unpack_from("<BBHHHB", raw, off)
        if width <= 0 or height <= 0 or width > 8192 or height > 8192:
            break
        kind = int(stream_type)
        rows.append({
            "stream": CODEC_STREAM_NAME.get(kind, str(kind)),
            "stream_type": kind,
            "codec": {1: "h264", 2: "h265"}.get(int(enc), str(int(enc))),
            "width": int(width),
            "height": int(height),
            "bitrate_kbps": int(bitrate),
            "fps": int(fps),
        })
        off += 9
    return rows or None


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


def angle_separation(left, right):
    """Shortest distance between two headings, in degrees, on a 360 circle."""
    delta = (float(left) - float(right) + 180.0) % 360.0 - 180.0
    return abs(delta)


def attitude_moved_toward(before, after, target_yaw, target_pitch, tolerance=1.0):
    """True when `after` reached the target or got closer than `before`.

    Distance wraps at ±180, so pitch 179.9 and pitch -179.9 are the same
    place. On this mount that place is level, which is center.
    """
    if not isinstance(after, dict):
        return False
    try:
        yaw = float(after.get("yaw"))
        pitch = float(after.get("pitch"))
        goal_yaw = float(target_yaw)
        goal_pitch = float(target_pitch)
    except (TypeError, ValueError):
        return False
    if angle_separation(yaw, goal_yaw) <= tolerance and angle_separation(pitch, goal_pitch) <= tolerance:
        return True
    if not isinstance(before, dict):
        return False
    try:
        old_yaw = float(before.get("yaw"))
        old_pitch = float(before.get("pitch"))
    except (TypeError, ValueError):
        return False
    def gap(y, p):
        return angle_separation(y, goal_yaw) + angle_separation(p, goal_pitch)
    return gap(yaw, pitch) + 0.05 < gap(old_yaw, old_pitch)


def rate_fields_match(attitude, yaw_cmd, pitch_cmd):
    """True when the attitude rate signs follow the commanded rate."""
    if not isinstance(attitude, dict):
        return False
    try:
        yaw_rate = float(attitude.get("yaw_rate"))
        pitch_rate = float(attitude.get("pitch_rate"))
        yaw_cmd = int(yaw_cmd)
        pitch_cmd = int(pitch_cmd)
    except (TypeError, ValueError):
        return False

    def axis(cmd, observed):
        # 0.2 deg/s is resting noise. A start has to leave that band.
        if cmd > 0:
            return observed > RATE_NOISE_DPS
        if cmd < 0:
            return observed < -RATE_NOISE_DPS
        return abs(observed) <= RATE_NOISE_DPS

    return axis(yaw_cmd, yaw_rate) and axis(pitch_cmd, pitch_rate)


def zoom_moved(before, after, direction):
    """True when a fresh zoom read moved in the commanded direction."""
    try:
        after = float(after)
        direction = int(direction)
    except (TypeError, ValueError):
        return False
    if direction == 0:
        return True
    if before is None:
        return False
    try:
        before = float(before)
    except (TypeError, ValueError):
        return False
    if direction > 0:
        return after > before
    return after < before


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
        self._send_index = 0
        # Per-group device counters. A known counter rejects a reply that
        # did not advance by 1..64. _device_seq_regressed records a backwards step.
        self._device_seq = {}
        self._device_seq_regressed = {}
        self._resync_groups = set()
        self.rejected_count = 0
        self._lock = threading.Lock()
        self._io = threading.Lock()
        # One confirm window at a time. A new rate or stop bumps the
        # generation and wakes the sleeper so the old loop stops reading.
        self._confirm_gen = 0
        self._confirm_cv = threading.Condition()
        self._stop = threading.Event()
        self._thread = None
        self.firmware = None
        self.hardware_id = None
        self.attitude = None
        self.zoom = None
        self.mode = None
        self.recording = None
        self.codec = None
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
            if self.last_error:
                error = self.last_error
            elif present:
                error = None
            else:
                error = "no_reply"
            return {
                "ok": True,
                "present": present,
                "firmware": self.firmware if present else None,
                "hardware_id": self.hardware_id if present else None,
                "attitude": self.attitude if present else None,
                "zoom": self.zoom if present else None,
                "mode": self.mode if present else None,
                "recording": self.recording if present else None,
                "codec": list(self.codec) if present and self.codec else None,
                "codec_writable": False,
                "age_ms": age,
                "control_enabled": gimbal_control_enabled(self.env),
                "polling": self._thread is not None,
                "host": self.host,
                "port": self.port,
                "angle_cmd": self.angle_cmd,
                "error": error,
                "rejected": self.rejected_count,
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
        # A held stick sends rate again before the last confirm finishes.
        # That new command owns the window; the previous loop must stop.
        confirm_token = None
        if action in {"rate", "center", "angle"}:
            confirm_token = self._open_confirm()
        want_fresh = needs_ack and action in ACK_EXACT_ACTIONS
        before_att = dict(self.attitude) if isinstance(self.attitude, dict) else None
        before_zoom = self.zoom
        decoded = self.exchange(cmd, data, require_match=needs_ack)
        if decoded is False:
            entry = {"action": action, "cmd": cmd, "ok": False, "reason": "send_failed"}
            self._log(entry)
            return 504, {"ok": False, "reason": "send_failed", "sent": False, "confirmed": False}
        if want_fresh:
            # Center and rate are confirmed only from an attitude read after
            # the ack. Without that ack there is nothing to wait on.
            if action in {"rate", "center"} and not isinstance(decoded, dict):
                checked = None
            else:
                checked = self._confirm_motion(
                    action, body, before_att, before_zoom, token=confirm_token,
                )
            if checked and checked.get("confirmed"):
                result = {
                    "ok": True,
                    "sent": True,
                    "confirmed": True,
                    "confirmed_by": checked["confirmed_by"],
                    "ack": checked["ack"],
                    "cmd": cmd,
                }
                entry = {
                    "action": action,
                    "cmd": cmd,
                    "ok": True,
                    "confirmed": True,
                    "confirmed_by": checked["confirmed_by"],
                }
                self._log(entry)
                return 200, result
            # A command ack is not confirmation. The fresh read is.
            if checked:
                reason = checked.get("reason") or "sent_not_confirmed"
                result = {
                    "ok": True,
                    "sent": True,
                    "confirmed": False,
                    "reason": reason,
                    "message": "rate not decayed" if reason == "rate_not_decayed" else "sent, not confirmed",
                    "ack": checked.get("ack"),
                    "cmd": cmd,
                }
                if reason == "rate_not_decayed" and isinstance(checked.get("ack"), dict):
                    result["yaw_rate"] = checked["ack"].get("yaw_rate")
                    result["pitch_rate"] = checked["ack"].get("pitch_rate")
                entry = {
                    "action": action,
                    "cmd": cmd,
                    "ok": True,
                    "confirmed": False,
                    "reason": reason,
                }
                self._log(entry)
                return 200, result
            if isinstance(decoded, dict):
                entry = {"action": action, "cmd": cmd, "ok": True, "confirmed": False}
                self._log(entry)
                return 200, {
                    "ok": True,
                    "sent": True,
                    "confirmed": False,
                    "reason": "sent_not_confirmed",
                    "message": "sent, not confirmed",
                    "cmd": cmd,
                }
            reason = self.last_error or "no_reply"
            entry = {"action": action, "cmd": cmd, "ok": False, "reason": reason}
            self._log(entry)
            return 504, {
                "ok": False,
                "reason": reason,
                "message": "sent, not confirmed",
                "sent": True,
                "confirmed": False,
            }
        result = {
            "ok": True,
            "sent": True,
            "confirmed": bool(needs_ack and isinstance(decoded, dict)),
            "cmd": cmd,
        }
        if isinstance(decoded, dict):
            result["ack"] = self._apply_ack(cmd, decoded["data"])
        if action == "mode":
            mode = MODE_ALIASES.get(str(body.get("mode") or "").strip().lower())
            if mode:
                with self._lock:
                    self.mode = mode
                result["mode"] = mode
        entry = {"action": action, "cmd": cmd, "ok": True, "confirmed": result["confirmed"]}
        self._log(entry)
        return 200, result

    def exchange(self, cmd, data=b"", require_match=True, marks_absent=True, require_echo=False):
        with self._io:
            return self._exchange_locked(
                cmd,
                data,
                require_match,
                marks_absent=marks_absent,
                require_echo=require_echo,
            )

    def _drain_pending(self, sock):
        """Drop datagrams queued before this send. They are not this reply."""
        try:
            sock.settimeout(0)
        except OSError:
            return
        while True:
            try:
                sock.recvfrom(2048)
            except (socket.timeout, BlockingIOError, InterruptedError):
                return
            except OSError:
                return

    def _seq_group(self, cmd):
        try:
            cmd = int(cmd) & 0xFF
        except (TypeError, ValueError):
            return None
        if cmd in CONFIG_SEQ_CMDS:
            return "config"
        if cmd in SHARED_SEQ_CMDS:
            return "shared"
        return None

    def _group_needs_resync(self, group):
        """True when this reply may teach the counter instead of matching it."""
        if group is None or group not in self._device_seq:
            return True
        if group in self._resync_groups:
            return True
        last = self.last_reply_mono
        # A counter stored earlier in this wait is already known. The silence
        # clock starts when the exchange notes the reply, so a missing clock
        # must not turn the next datagram into another baseline.
        if last is None:
            return False
        try:
            silent = (self.now_fn() - last) >= SEQ_SILENCE_S
        except TypeError:
            return False
        return bool(silent)

    def _seq_ok(self, cmd, seq):
        """Accept a grouped reply only when its counter advanced by 1..64.

        The first reply, a reply after a timeout, and a reply after a long
        silence teach the counter. An attitude that teaches is not
        returned (``"teach"``). Zoom-read and firmware still return the
        sample that taught their counter. A backwards or repeated
        sequence is rejected and recorded on ``_device_seq_regressed``.
        Zoom write and codec are not gated.
        """
        group = self._seq_group(cmd)
        if group is None:
            return True
        try:
            seq = int(seq) & 0xFFFF
            cmd_id = int(cmd) & 0xFF
        except (TypeError, ValueError):
            return False
        teaching = self._group_needs_resync(group)
        if not teaching:
            prev = self._device_seq[group]
            advance = seq_advance(seq, prev)
            if not (1 <= advance <= SEQ_AHEAD_MAX):
                if advance == 0 or advance > 0x8000:
                    self._device_seq_regressed[group] = True
                self.rejected_count += 1
                self.last_error = "seq_rejected"
                return False
        self._device_seq[group] = seq
        self._device_seq_regressed.pop(group, None)
        self._resync_groups.discard(group)
        if teaching and cmd_id == CMD_ATTITUDE:
            return "teach"
        return True

    def _note_exchange_failed(self, marks_absent):
        if marks_absent:
            with self._lock:
                if self.last_reply_mono is None and not self.last_error:
                    self.last_error = "no_reply"

    def _exchange_locked(self, cmd, data=b"", require_match=True, marks_absent=True, require_echo=False):
        # require_echo is unused. The A8 does not echo SEQ; command id is the pair.
        del require_echo
        packet_seq = self._seq & 0xFFFF
        self._seq = (self._seq + 1) & 0xFFFF
        packet = encode_packet(cmd, data, seq=packet_seq)
        try:
            sock = self._ensure_sock()
            self._drain_pending(sock)
            sock.sendto(packet, (self.host, self.port))
        except OSError as exc:
            if marks_absent:
                with self._lock:
                    self.last_error = "send_failed"
            print(f"[gimbal] send_failed cmd={cmd:#04x} {exc}", flush=True)
            return False
        self._send_index += 1
        if not require_match:
            return True
        deadline = time.monotonic() + self.timeout
        taught = False
        rejected_before = self.rejected_count
        while True:
            remain = deadline - time.monotonic()
            if remain <= 0:
                break
            try:
                sock.settimeout(remain)
                raw, _addr = sock.recvfrom(2048)
            except (socket.timeout, OSError):
                break
            decoded = decode_packet(raw)
            if not reply_matches(decoded, cmd):
                continue
            verdict = self._seq_ok(cmd, decoded.get("seq", 0))
            if verdict == "teach":
                # Baseline only. A later 0x0D in this wait may still advance.
                taught = True
                continue
            if not verdict:
                continue
            self._note_reply()
            return decoded
        if taught:
            # The teacher proved the gimbal is there. Do not arm a resync,
            # or the next single attitude would teach again and never land.
            self._note_reply()
            if self.rejected_count > rejected_before:
                self.last_error = "seq_rejected"
            return None
        group = self._seq_group(cmd)
        # An optional read (zoom poll, codec) must not forget a live counter.
        if group is not None and marks_absent:
            self._resync_groups.add(group)
        self._note_exchange_failed(marks_absent)
        return None

    def _exchange_fresh_attitude(self):
        """Return an attitude only when its counter advanced by 1..64.

        The sample that teaches a cold or resynced counter is not a
        reading. One more exchange can pick up the next step (the A8
        and an echoing test double both move by a small forward gap).
        A rejection against a counter that was already known is not retried.
        """
        before = self._device_seq.get("shared")
        pkt = self.exchange(CMD_ATTITUDE, b"", require_match=True)
        after = self._device_seq.get("shared")
        if pkt is None and after is not None and after != before:
            pkt = self.exchange(CMD_ATTITUDE, b"", require_match=True)
        return pkt

    def _open_confirm(self):
        """Hand the confirm window to this command and stop the previous one."""
        with self._confirm_cv:
            self._confirm_gen += 1
            token = self._confirm_gen
            self._confirm_cv.notify_all()
        return token

    def _wait_confirm_gap(self, token, deadline):
        """Pause before the next confirm read. False when a newer command owns the window."""
        limit = min(time.monotonic() + CONFIRM_READ_GAP_S, deadline)
        with self._confirm_cv:
            while token == self._confirm_gen:
                remain = limit - time.monotonic()
                if remain <= 0:
                    return token == self._confirm_gen
                self._confirm_cv.wait(timeout=remain)
            return False

    def _confirm_motion(self, action, body, before_att, before_zoom, token=None):
        """Fresh post-send read. None when nothing new arrived."""
        if action == "zoom":
            # 0x18 reads the current zoom. 0x05 byte 0 would stop the zoom.
            pkt = self.exchange(CMD_ZOOM_READ, b"", require_match=True)
            zoom = parse_zoom(pkt["data"]) if isinstance(pkt, dict) else None
            if zoom is None:
                return None
            with self._lock:
                self.zoom = zoom
            direction = _zoom_byte(body)
            if zoom_moved(before_zoom, zoom, direction):
                return {"confirmed": True, "confirmed_by": "zoom", "ack": {"zoom": zoom}}
            return {"confirmed": False, "ack": {"zoom": zoom}}
        if token is None:
            token = self._open_confirm()
        if action == "rate":
            yaw_cmd = clamp_rate(body.get("yaw"))
            pitch_cmd = clamp_rate(body.get("pitch"))
            att, ok, how = self._poll_attitude_until(
                lambda sample: rate_fields_match(sample, yaw_cmd, pitch_cmd),
                token,
            )
            if att is None:
                return None
            if ok:
                return {"confirmed": True, "confirmed_by": "rate", "ack": att}
            # A stop that is still moving is not a generic miss.
            if yaw_cmd == 0 and pitch_cmd == 0 and how != "superseded":
                return {"confirmed": False, "reason": "rate_not_decayed", "ack": att}
            return {"confirmed": False, "ack": att}
        if action == "center":
            goal = (CENTER_YAW, CENTER_PITCH)
        else:
            goal = clamp_angle(body.get("yaw"), body.get("pitch"))
        att, ok, _how = self._poll_attitude_until(
            lambda sample: attitude_moved_toward(before_att, sample, goal[0], goal[1]),
            token,
        )
        if att is None:
            return None
        if ok:
            return {"confirmed": True, "confirmed_by": "attitude", "ack": att}
        return {"confirmed": False, "ack": att}

    def _poll_attitude_until(self, ready, token):
        """Re-read attitude until `ready`, about 1.5 s, or a newer command.

        Each sample has to be a counter-advanced 0x0D. Reads are spaced by
        CONFIRM_READ_GAP_S. A silent socket ends the wait immediately. The
        caller already holds the command ack, so these reads are after that ack.
        """
        deadline = time.monotonic() + CONFIRM_MOTION_S
        latest = None
        while time.monotonic() < deadline:
            if token != self._confirm_gen:
                return latest, False, "superseded"
            pkt = self._exchange_fresh_attitude()
            att = parse_attitude(pkt["data"]) if isinstance(pkt, dict) else None
            if att is None:
                return latest, False, "silent"
            with self._lock:
                self.attitude = att
            latest = att
            try:
                done = bool(ready(att))
            except (TypeError, ValueError):
                done = False
            if done:
                return att, True, "matched"
            if not self._wait_confirm_gap(token, deadline):
                return latest, False, "superseded"
        return latest, False, "timeout"

    def poll_once(self):
        self._ticks += 1
        decoded = self._exchange_fresh_attitude()
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
            # 0x20 needs the stream-type byte. A miss must not clear presence:
            # attitude already proved the gimbal is there.
            codec = self.exchange(
                CMD_CODEC,
                bytes([CODEC_STREAM_MAIN]),
                require_match=True,
                marks_absent=False,
            )
            if isinstance(codec, dict):
                parsed = parse_codec_specs(codec["data"])
                if parsed:
                    with self._lock:
                        self.codec = parsed
            # 0x18 so status zoom is filled. A miss must not clear presence
            # or forget the shared counter. 01 00 is 1.0x.
            zoom_pkt = self.exchange(
                CMD_ZOOM_READ,
                b"",
                require_match=True,
                marks_absent=False,
            )
            if isinstance(zoom_pkt, dict):
                zoom = parse_zoom(zoom_pkt["data"])
                if zoom is not None:
                    with self._lock:
                        self.zoom = zoom

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
            zoom = parse_zoom_ack(data)
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
