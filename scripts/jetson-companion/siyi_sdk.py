#!/usr/bin/env python3
"""SIYI gimbal SDK (A8 mini) over UDP. Not a flight command.

Packet: STX 0x6655 LE, CTRL, data_len LE, SEQ LE, CMD, DATA, CRC16-CCITT
poly 0x1021 init 0, CRC stored LE. CRC covers every byte before the CRC.

The A8 mini manual labels set-angle as 0x0D (same id as attitude). Newer
SIYI docs use 0x0E. VLC_SIYI_ANGLE_CMD selects it (default 0x0E).

Control endpoints stay off unless VLC_GIMBAL_CONTROL_ENABLED=1.
Replies are paired by command id. Pending datagrams are drained before
each send. An exact SEQ echo is preferred when it arrives in the same
wait, ahead of an earlier counter fit. The A8 mini usually sends its
own counter and does not echo the request sequence. After a counter is
learned, a non-echo is accepted only when it is ahead of that counter
by 1..(sends since the counter + 16), modulo 0x10000. Equal and behind
are stale. The counter is learned from two separate sends when the
second is ahead by at least the send count and at most about 64. That
teaching reply is not returned as the answer. At most one rejection is
counted per send. Three sends that accept nothing drop the learned
counter. While no counter is learned, seq 0 after the drain is accepted
and is not stored as the counter. Angle, center, and rate confirm only
on a fresh attitude that fits this rule and matches the command. If the
move was echoed but attitude was not read, the result is sent, not
confirmed. Zoom is confirmed by a current-zoom read (command 0x18):
the first byte is the whole multiple and the second is tenths. A
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
CMD_PHOTO = 0x0C
CMD_CODEC = 0x20
# 0x20 send data is one uint8: 0 recording, 1 main, 2 sub.
# Manual example for main: 55 66 01 01 00 00 00 20 01 9E 9D
CODEC_STREAM_MAIN = 1
# Learn window. After a counter is learned, acceptance is tighter.
SEQ_AHEAD_MAX = 64
SEQ_WINDOW = SEQ_AHEAD_MAX
# Forward room past the sends since the last accepted counter.
SEQ_FORWARD_SLACK = 16
# Drop a learned counter after this many sends accept nothing, or this much silence.
SEQ_RESET_REJECTS = 3
SEQ_SILENCE_S = 3.0
# Moves are confirmed from a later attitude. Zoom is confirmed from 0x18.
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


def forward_limit(sends=1, slack=SEQ_FORWARD_SLACK):
    """How far ahead a learned counter may move: sends since it, plus slack."""
    try:
        sends = int(sends)
        slack = int(slack)
    except (TypeError, ValueError):
        return 1 + SEQ_FORWARD_SLACK
    if sends < 1:
        sends = 1
    if slack < 0:
        slack = 0
    return sends + slack


def seq_is_ahead(reply_seq, last_seq, limit=None):
    """True when reply_seq is strictly ahead of last_seq by 1..limit."""
    if limit is None:
        limit = forward_limit(1)
    try:
        delta = seq_advance(reply_seq, last_seq)
        limit = int(limit)
    except (TypeError, ValueError):
        return False
    return limit >= 1 and 1 <= delta <= limit


def seq_acceptable(reply_seq, request_seq, last_camera_seq=None, window=None, sends=1):
    """Whether this SEQ can belong to the in-flight request.

    An exact echo of the request sequence matches. The wait itself prefers
    that echo over an earlier counter fit. While no counter is learned,
    seq 0 matches as a safe default. A learned counter accepts a non-echo
    only when it is ahead by 1..(sends + 16), modulo 0x10000. Equal and
    behind are stale. A stale reply that is still inside that forward
    span can still win when no echo arrives before the wait ends.
    """
    try:
        reply = int(reply_seq) & 0xFFFF
        request = int(request_seq) & 0xFFFF
    except (TypeError, ValueError):
        return False
    if reply == request:
        return True
    if last_camera_seq is None:
        return reply == 0
    if window is None:
        window = forward_limit(sends)
    return seq_is_ahead(reply, last_camera_seq, window)


def _cmd_is(decoded, cmd):
    if not isinstance(decoded, dict):
        return False
    try:
        return (int(decoded.get("cmd")) & 0xFF) == (int(cmd) & 0xFF)
    except (TypeError, ValueError):
        return False


def reply_matches(decoded, cmd, request_seq, last_camera_seq=None):
    """Pair a datagram to the in-flight request by command id and SEQ.

    An exact echo matches. While no counter is learned, seq 0 matches.
    Otherwise only a sequence ahead of a learned counter by about
    sends+16 matches. A non-zero single reply does not match while the
    counter is unknown.
    """
    if not isinstance(decoded, dict):
        return False
    try:
        got = int(decoded.get("cmd")) & 0xFF
    except (TypeError, ValueError):
        return False
    if got != (int(cmd) & 0xFF):
        return False
    return seq_acceptable(decoded.get("seq", 0), request_seq, last_camera_seq)


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
    """Current zoom from 0x18: whole multiple, then tenths. 3.5x is 03 05."""
    raw = bytes(data or b"")
    if len(raw) < 2:
        return None
    return int(raw[0]) + (int(raw[1]) / 10.0)


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


def attitude_moved_toward(before, after, target_yaw, target_pitch, tolerance=1.0):
    """True when `after` reached the target or got closer than `before`."""
    if not isinstance(after, dict):
        return False
    try:
        yaw = float(after.get("yaw"))
        pitch = float(after.get("pitch"))
        goal_yaw = float(target_yaw)
        goal_pitch = float(target_pitch)
    except (TypeError, ValueError):
        return False
    if abs(yaw - goal_yaw) <= tolerance and abs(pitch - goal_pitch) <= tolerance:
        return True
    if not isinstance(before, dict):
        return False
    try:
        old_yaw = float(before.get("yaw"))
        old_pitch = float(before.get("pitch"))
    except (TypeError, ValueError):
        return False
    def gap(y, p):
        return abs(y - goal_yaw) + abs(p - goal_pitch)
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
        if cmd > 0:
            return observed > 0
        if cmd < 0:
            return observed < 0
        return abs(observed) <= 1.0

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
        self._camera_seq = None
        self._camera_send = None
        self._camera_candidate = None
        self._candidate_send = None
        self._consec_timeouts = 0
        self._reject_streak = 0
        self.rejected_count = 0
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
        want_echo = needs_ack and action in ACK_EXACT_ACTIONS
        before_att = dict(self.attitude) if isinstance(self.attitude, dict) else None
        before_zoom = self.zoom
        decoded = self.exchange(cmd, data, require_match=needs_ack, require_echo=want_echo)
        if decoded is False:
            entry = {"action": action, "cmd": cmd, "ok": False, "reason": "send_failed"}
            self._log(entry)
            return 504, {"ok": False, "reason": "send_failed", "sent": False, "confirmed": False}
        if want_echo:
            checked = self._confirm_motion(action, body, before_att, before_zoom)
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
            if checked:
                result = {
                    "ok": True,
                    "sent": True,
                    "confirmed": False,
                    "reason": "sent_not_confirmed",
                    "message": "sent, not confirmed",
                    "ack": checked.get("ack"),
                    "cmd": cmd,
                }
                entry = {"action": action, "cmd": cmd, "ok": True, "confirmed": False}
                self._log(entry)
                return 200, result
            if isinstance(decoded, dict) and action in MOTION_ACTIONS:
                entry = {"action": action, "cmd": cmd, "ok": True, "confirmed": False}
                self._log(entry)
                return 200, {
                    "ok": True,
                    "sent": True,
                    "confirmed": False,
                    "reason": "attitude_not_read",
                    "message": "sent, not confirmed: attitude not read",
                    "cmd": cmd,
                }
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

    def _remember_camera_seq(self, seq):
        try:
            seq = int(seq) & 0xFFFF
        except (TypeError, ValueError):
            return
        # Seq 0 is an allowed non-echo, not a new camera counter.
        if seq == 0 and self._camera_seq not in (None, 0):
            return
        self._camera_seq = seq

    def _reset_camera_seq_after_silence(self):
        with self._lock:
            last = self.last_reply_mono
        if last is None:
            return
        try:
            quiet = self.now_fn() - last
        except TypeError:
            return
        if quiet >= SEQ_SILENCE_S:
            self._clear_camera_seq()
            self._consec_timeouts = 0

    def _note_exchange_failed(self, saw_seq_reject, marks_absent):
        if marks_absent:
            with self._lock:
                if saw_seq_reject:
                    self.last_error = "seq_rejected"
                elif self.last_reply_mono is None and not self.last_error:
                    self.last_error = "no_reply"
        self._consec_timeouts += 1
        self._reject_streak += 1
        if self._reject_streak >= SEQ_RESET_REJECTS:
            self._clear_camera_seq()
            self._consec_timeouts = 0

    def _clear_camera_seq(self):
        self._camera_seq = None
        self._camera_send = None
        self._camera_candidate = None
        self._candidate_send = None
        self._reject_streak = 0

    def _commit_camera(self, seq, this_send):
        self._camera_seq = int(seq) & 0xFFFF
        self._camera_send = this_send
        self._camera_candidate = None
        self._candidate_send = None
        self._consec_timeouts = 0
        self._reject_streak = 0

    def _forward_limit(self, this_send):
        if self._camera_send is None:
            delta = 1
        else:
            delta = this_send - self._camera_send
            if delta < 1:
                delta = 1
        return forward_limit(delta)

    def _count_reject(self, marks_absent):
        self.rejected_count += 1
        if marks_absent:
            with self._lock:
                self.last_error = "seq_rejected"

    def _exchange_locked(self, cmd, data=b"", require_match=True, marks_absent=True, require_echo=False):
        self._reset_camera_seq_after_silence()
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
        this_send = self._send_index
        if not require_match:
            return True
        deadline = time.monotonic() + self.timeout
        saw_same = False
        rejected_this_send = False
        learned = False
        held = None
        held_seq = None
        held_learns = False
        request = packet_seq & 0xFFFF
        ahead_limit = self._forward_limit(this_send)
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
            if not _cmd_is(decoded, cmd):
                continue
            try:
                reply = int(decoded.get("seq", 0)) & 0xFFFF
            except (TypeError, ValueError):
                continue
            saw_same = True
            if reply == request:
                self._commit_camera(reply, this_send)
                self._note_reply()
                return decoded
            if self._camera_seq is None and reply == 0:
                # Safe default until a real counter is known. Not a learned counter.
                if held is None:
                    held = decoded
                    held_seq = 0
                    held_learns = False
                continue
            if self._camera_seq is not None and seq_is_ahead(reply, self._camera_seq, ahead_limit):
                # Keep the first fit. An exact echo later in this wait wins instead.
                if held is None:
                    held = decoded
                    held_seq = reply
                    held_learns = True
                continue
            if self._camera_seq is not None:
                rejected_this_send = True
                continue
            if self._candidate_send is not None and self._candidate_send != this_send:
                delta_sends = this_send - self._candidate_send
                advance = seq_advance(reply, self._camera_candidate)
                if delta_sends >= 1 and delta_sends <= advance <= SEQ_AHEAD_MAX:
                    # Teach the counter. This datagram is not the answer.
                    self._commit_camera(reply, this_send)
                    learned = True
                    rejected_this_send = False
                    continue
            rejected_this_send = True
            self._camera_candidate = reply
            self._candidate_send = this_send
        if held is not None and not learned:
            if held_learns:
                self._commit_camera(held_seq, this_send)
            else:
                self._camera_candidate = None
                self._candidate_send = None
                self._consec_timeouts = 0
                self._reject_streak = 0
            if require_echo and held_learns:
                return None
            self._note_reply()
            return held
        if learned:
            return None
        if rejected_this_send:
            self._count_reject(marks_absent)
            self._reject_streak += 1
            if self._reject_streak >= SEQ_RESET_REJECTS:
                self._clear_camera_seq()
            return None
        if saw_same:
            return None
        self._note_exchange_failed(False, marks_absent)
        return None

    def _confirm_motion(self, action, body, before_att, before_zoom):
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
        pkt = self.exchange(CMD_ATTITUDE, b"", require_match=True)
        att = parse_attitude(pkt["data"]) if isinstance(pkt, dict) else None
        if att is None:
            return None
        with self._lock:
            self.attitude = att
        if action == "rate":
            ok = rate_fields_match(att, clamp_rate(body.get("yaw")), clamp_rate(body.get("pitch")))
            if ok:
                return {"confirmed": True, "confirmed_by": "rate", "ack": att}
            return {"confirmed": False, "ack": att}
        if action == "center":
            goal = (0.0, 0.0)
        else:
            goal = clamp_angle(body.get("yaw"), body.get("pitch"))
        if attitude_moved_toward(before_att, att, goal[0], goal[1]):
            return {"confirmed": True, "confirmed_by": "attitude", "ack": att}
        return {"confirmed": False, "ack": att}

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
