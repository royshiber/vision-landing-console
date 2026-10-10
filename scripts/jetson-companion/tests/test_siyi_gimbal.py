"""Gimbal commands over a fake SIYI socket. No live UDP."""

from __future__ import annotations

import re
import socket
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from siyi_sdk import (  # noqa: E402
    CMD_ATTITUDE,
    CMD_CENTER,
    CMD_CODEC,
    CMD_CONFIG,
    CMD_FIRMWARE,
    CMD_PHOTO,
    CMD_RATE,
    CMD_ZOOM,
    CMD_ZOOM_READ,
    CODEC_STREAM_MAIN,
    DEFAULT_HOST,
    DEFAULT_PORT,
    SiyiLink,
    decode_packet,
    encode_packet,
    parse_codec_specs,
    parse_firmware,
    parse_zoom,
    parse_zoom_ack,
    reply_matches,
)

# Captured A8-mini reply frames (CRC included). SEQ is the camera's counter,
# not an echo of the request that was on the wire.
# Attitude: seq 0x002A, yaw 12.3, pitch -4.5, roll 0.2, pitch rate 1.0.
A8_ATTITUDE_SEQ_MISMATCH = bytes.fromhex("5566010c002a000d7b00d3ff020000000a000000faba")
# Firmware: seq 0, camera v3.2.3, gimbal v1.4.2. Request seq on the poll is 1.
A8_FIRMWARE_SEQ0 = bytes.fromhex("5566010c000000010302036e02040100000000003495")
# Codec ACK: seq 0x0100, main-stream byte 1, H264 1920x1080, 2500 kbps, 30 fps.
A8_CODEC_SEQ_MISMATCH = bytes.fromhex("5566010900000120010180073804c4091e7058")
# Manual zoom-in request, used as a datagram that must not satisfy attitude.
A8_ZOOM_NOT_ATTITUDE = bytes.fromhex("5566010100000005018d64")


class FakeSiyiSock:
    def __init__(self, reply=True):
        self.sent = []
        self.reply = reply
        self._timeout = None
        self._open = False

    def sendto(self, packet, addr):
        self.sent.append((bytes(packet), addr))
        self._open = True

    def recvfrom(self, _n):
        # timeout 0 is the pre-send drain. One reply per send; a second
        # recv must time out so a teach can finish the wait.
        if self._timeout == 0 or not self.reply or not self.sent or not self._open:
            raise socket.timeout()
        self._open = False
        raw, _addr = self.sent[-1]
        decoded = decode_packet(raw)
        ack = struct.pack("<b", 1) if decoded["cmd"] == CMD_ZOOM else bytes([1])
        from siyi_sdk import encode_packet
        return encode_packet(decoded["cmd"], ack, seq=decoded["seq"]), (DEFAULT_HOST, DEFAULT_PORT)

    def settimeout(self, timeout):
        self._timeout = timeout

    def close(self):
        return None


class QueueSock:
    """Datagrams already in `pending` are stale. `fresh` is appended on send."""

    def __init__(self, stale=(), fresh=()):
        self.pending = [bytes(item) for item in stale]
        self.fresh = [bytes(item) for item in fresh]
        self.sent = []
        self._timeout = None

    def sendto(self, packet, addr):
        self.sent.append((bytes(packet), addr))
        self.pending.extend(self.fresh)
        self.fresh = []

    def recvfrom(self, _n):
        if not self.pending:
            raise socket.timeout()
        return self.pending.pop(0), (DEFAULT_HOST, DEFAULT_PORT)

    def settimeout(self, timeout):
        self._timeout = timeout

    def close(self):
        return None


def last_packet(sock):
    raw, addr = sock.sent[-1]
    return decode_packet(raw), addr


_CAPTURE_LINE = re.compile(
    r"req_seq=(\d+)\s+->\s+\[\('((?:0x)?[0-9a-fA-F]+)',\s*(\d+),\s*(\d+)"
    r"(?:,\s*'raw=([0-9a-fA-F]+)')?\)\]"
)


def _load_a8_seq_capture():
    path = Path(__file__).resolve().parent / "fixtures" / "a8-seq-capture.txt"
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        match = _CAPTURE_LINE.search(line)
        if match is None:
            raise AssertionError(f"unparsed capture line: {line}")
        req_seq = int(match.group(1))
        cmd = int(match.group(2), 16) & 0xFF
        reply_seq = int(match.group(3)) & 0xFFFF
        length = int(match.group(4))
        raw_hex = match.group(5)
        if raw_hex:
            packet = bytes.fromhex(raw_hex)
        elif cmd == CMD_ATTITUDE:
            packet = encode_packet(cmd, struct.pack("<hhhhhh", 0, 0, 0, 0, 0, 0), seq=reply_seq)
        elif cmd == CMD_CONFIG:
            packet = encode_packet(cmd, bytes(length), seq=reply_seq)
        else:
            packet = encode_packet(cmd, bytes(length), seq=reply_seq)
        decoded = decode_packet(packet)
        if decoded is None or decoded["seq"] != reply_seq or decoded["cmd"] != cmd:
            raise AssertionError(f"capture packet does not decode: {line}")
        if len(decoded["data"]) != length:
            raise AssertionError(f"capture length mismatch: {line}")
        rows.append({
            "cmd": cmd,
            "req_seq": req_seq,
            "reply_seq": reply_seq,
            "packet": packet,
        })
    return rows


class CaptureReplaySock:
    """One captured reply per send. A drain (timeout 0) sees nothing."""

    def __init__(self, rows):
        self.rows = list(rows)
        self.sent = []
        self._timeout = None
        self._open = False
        self.i = 0

    def sendto(self, packet, addr):
        self.sent.append((bytes(packet), addr))
        self._open = True

    def recvfrom(self, _n):
        if self._timeout == 0 or not self._open:
            raise socket.timeout()
        self._open = False
        row = self.rows[self.i]
        self.i += 1
        return row["packet"], (DEFAULT_HOST, DEFAULT_PORT)

    def settimeout(self, timeout):
        self._timeout = timeout

    def close(self):
        return None


class SiyiGimbalCommandTests(unittest.TestCase):
    def test_rate_zoom_and_lock_use_the_siyi_socket(self):
        sock = FakeSiyiSock()
        link = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=sock,
            now_fn=lambda: 1000.0,
        )
        self.assertEqual(link.host, DEFAULT_HOST)
        self.assertEqual(link.port, DEFAULT_PORT)

        code, body = link.command("rate", {"yaw": -40, "pitch": 40})
        self.assertEqual(code, 200)
        self.assertFalse(body["confirmed"])
        self.assertEqual(body["message"], "sent, not confirmed")
        self.assertNotIn("confirmed_by", body)
        self.assertTrue(link.present)
        rate_pkt = next(decode_packet(pkt) for pkt, _addr in sock.sent if decode_packet(pkt)["cmd"] == CMD_RATE)
        rate_addr = next(addr for pkt, addr in sock.sent if decode_packet(pkt)["cmd"] == CMD_RATE)
        self.assertEqual(rate_addr, (DEFAULT_HOST, DEFAULT_PORT))
        self.assertEqual(rate_pkt["data"], struct.pack("<bb", -40, 40))

        code, body = link.command("zoom", {"direction": "in"})
        self.assertEqual(code, 200)
        self.assertFalse(body["confirmed"])
        self.assertEqual(body["message"], "sent, not confirmed")
        zoom_in = [decode_packet(pkt) for pkt, _addr in sock.sent if decode_packet(pkt)["cmd"] == CMD_ZOOM]
        self.assertEqual([pkt["data"] for pkt in zoom_in], [struct.pack("<b", 1)])
        zoom_reads = [decode_packet(pkt) for pkt, _addr in sock.sent if decode_packet(pkt)["cmd"] == CMD_ZOOM_READ]
        self.assertEqual(zoom_reads[-1]["data"], b"")
        self.assertTrue(link.present)

        before_zoom = len([pkt for pkt, _addr in sock.sent if decode_packet(pkt)["cmd"] == CMD_ZOOM])
        code, body = link.command("zoom", {"zoom": 0})
        self.assertFalse(body["confirmed"])
        zoom_pkts = [decode_packet(pkt) for pkt, _addr in sock.sent if decode_packet(pkt)["cmd"] == CMD_ZOOM]
        self.assertGreater(len(zoom_pkts), before_zoom)
        self.assertEqual(zoom_pkts[before_zoom]["data"], struct.pack("<b", 0))

        before = len(sock.sent)
        code, body = link.command("mode", {"mode": "lock"})
        self.assertEqual(code, 200)
        self.assertFalse(body["confirmed"])
        decoded, _addr = last_packet(sock)
        self.assertEqual(decoded["cmd"], CMD_PHOTO)
        self.assertEqual(decoded["data"], bytes([3]))
        code, _body = link.command("mode", {"mode": "follow"})
        decoded, _addr = last_packet(sock)
        self.assertEqual(decoded["data"], bytes([4]))
        self.assertGreater(len(sock.sent), before)

        link.command("mode", {"mode": "lock"})
        status = link.public_status()
        self.assertTrue(status["present"])
        self.assertIsNone(status["error"])
        self.assertEqual(status["mode"], "lock")
        link.command("mode", {"mode": "follow"})
        self.assertEqual(link.public_status()["mode"], "follow")

    def test_no_reply_stays_absent_and_disabled_sends_nothing(self):
        quiet = FakeSiyiSock(reply=False)
        link = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=quiet,
            now_fn=lambda: 1000.0,
        )
        code, body = link.command("rate", {"yaw": 0, "pitch": 0})
        self.assertEqual(code, 504)
        self.assertEqual(body["reason"], "no_reply")
        status = link.public_status()
        self.assertFalse(status["present"])
        self.assertEqual(status["error"], "no_reply")

        blocked = FakeSiyiSock()
        off = SiyiLink(env={"VLC_GIMBAL_CONTROL_ENABLED": "0"}, sock=blocked, now_fn=lambda: 1.0)
        code, body = off.command("rate", {"yaw": 10, "pitch": 0})
        self.assertEqual(code, 403)
        self.assertEqual(blocked.sent, [])
        self.assertIn("גימבל", body["message"])

    def test_codec_poll_reads_and_never_sets(self):
        main = struct.pack("<BBHHHB", 1, 1, 1920, 1080, 4000, 30)
        sub = struct.pack("<BBHHHB", 2, 1, 640, 360, 512, 25)
        parsed = parse_codec_specs(main + sub)
        self.assertEqual(parsed[0]["stream"], "main")
        self.assertEqual(parsed[0]["codec"], "h264")
        self.assertEqual(parsed[0]["width"], 1920)
        self.assertEqual(parsed[1]["stream"], "sub")
        self.assertEqual(parsed[1]["bitrate_kbps"], 512)

        class CodecSock(FakeSiyiSock):
            def recvfrom(self, _n):
                if self._timeout == 0 or not self.sent or not self._open:
                    raise socket.timeout()
                self._open = False
                raw, _addr = self.sent[-1]
                decoded = decode_packet(raw)
                payload = main + sub if decoded["cmd"] == CMD_CODEC else bytes([1])
                return encode_packet(decoded["cmd"], payload, seq=decoded["seq"]), (DEFAULT_HOST, DEFAULT_PORT)

        sock = CodecSock()
        link = SiyiLink(env={"VLC_GIMBAL_CONTROL_ENABLED": "0"}, sock=sock, now_fn=lambda: 50.0)
        link.poll_once()
        cmds = [decode_packet(pkt)["cmd"] for pkt, _addr in sock.sent]
        self.assertIn(CMD_CODEC, cmds)
        self.assertNotIn(0x21, cmds)
        codec_req = next(decode_packet(pkt) for pkt, _addr in sock.sent if decode_packet(pkt)["cmd"] == CMD_CODEC)
        self.assertEqual(codec_req["data"], bytes([CODEC_STREAM_MAIN]))
        self.assertEqual(link.codec[0]["height"], 1080)
        status = link.public_status()
        self.assertFalse(status["codec_writable"])
        self.assertEqual(status["codec"][0]["stream"], "main")
        self.assertEqual(status["codec"][0]["stream_type"], 1)
        self.assertEqual(status["codec"][1]["stream"], "sub")
        self.assertEqual(status["codec"][1]["stream_type"], 2)
        code, body = link.command("rate", {"yaw": 1, "pitch": 0})
        self.assertEqual(code, 403)
        self.assertFalse(body["sent"])

    def test_codec_stream_numbers_are_record_main_sub(self):
        record = struct.pack("<BBHHHB", 0, 1, 1920, 1080, 6000, 30)
        main = struct.pack("<BBHHHB", 1, 2, 1280, 720, 2500, 25)
        sub = struct.pack("<BBHHHB", 2, 1, 640, 360, 512, 15)
        parsed = parse_codec_specs(record + main + sub)
        self.assertEqual([row["stream_type"] for row in parsed], [0, 1, 2])
        self.assertEqual([row["stream"] for row in parsed], ["record", "main", "sub"])
        self.assertEqual(parsed[1]["codec"], "h265")
        self.assertEqual(parsed[2]["fps"], 15)

    def test_captured_a8_frames_accept_a_seq_that_does_not_match(self):
        attitude = decode_packet(A8_ATTITUDE_SEQ_MISMATCH)
        firmware = decode_packet(A8_FIRMWARE_SEQ0)
        # Same codec payload as the captured frame, seq 0x2E. Codec is not
        # on a tracked counter. Firmware is 0x2C: the poll reads attitude
        # twice (0x2A teaches, 0x2B is the reading) before firmware.
        codec_near = encode_packet(
            CMD_CODEC,
            struct.pack("<BBHHHB", 1, 1, 1920, 1080, 2500, 30),
            seq=0x2E,
        )
        firmware_ahead = encode_packet(CMD_FIRMWARE, firmware["data"], seq=0x2C)
        attitude_data = attitude["data"]
        codec = decode_packet(codec_near)
        self.assertEqual(attitude["cmd"], CMD_ATTITUDE)
        self.assertEqual(attitude["seq"], 0x2A)
        self.assertEqual(firmware["seq"], 0)
        self.assertEqual(codec["seq"], 0x2E)
        self.assertNotEqual(attitude["seq"], 0)
        self.assertTrue(reply_matches(attitude, CMD_ATTITUDE, 0))
        self.assertTrue(reply_matches(attitude, CMD_ATTITUDE, 99, last_camera_seq=None))
        self.assertTrue(reply_matches(firmware, CMD_FIRMWARE, 1, last_camera_seq=0x2A))
        self.assertFalse(reply_matches(decode_packet(A8_ZOOM_NOT_ATTITUDE), CMD_ATTITUDE, 0))
        self.assertFalse(reply_matches(None, CMD_ATTITUDE))

        manual = encode_packet(CMD_CODEC, bytes([CODEC_STREAM_MAIN]), seq=0).hex()
        self.assertEqual(manual, "5566010100000020019e9d")

        class CaptureSock(FakeSiyiSock):
            def __init__(self):
                super().__init__()
                self._fallback_seq = 0x40
                self._att_seq = 0x2A

            def sendto(self, packet, addr):
                super().sendto(packet, addr)
                self._open = True

            def recvfrom(self, _n):
                if self._timeout == 0 or not getattr(self, "_open", False):
                    raise socket.timeout()
                self._open = False
                decoded = decode_packet(self.sent[-1][0])
                if decoded["cmd"] == CMD_ATTITUDE:
                    seq = self._att_seq
                    self._att_seq = (self._att_seq + 1) & 0xFFFF
                    return encode_packet(CMD_ATTITUDE, attitude_data, seq=seq), (DEFAULT_HOST, DEFAULT_PORT)
                if decoded["cmd"] == CMD_FIRMWARE:
                    return firmware_ahead, (DEFAULT_HOST, DEFAULT_PORT)
                if decoded["cmd"] == CMD_CODEC:
                    return codec_near, (DEFAULT_HOST, DEFAULT_PORT)
                seq = self._fallback_seq
                self._fallback_seq += 1
                raw = encode_packet(decoded["cmd"], bytes([1, 0, 0, 0, 0]), seq=seq)
                return raw, (DEFAULT_HOST, DEFAULT_PORT)

        cold = SiyiLink(env={}, sock=QueueSock(fresh=[A8_ATTITUDE_SEQ_MISMATCH]), now_fn=lambda: 80.0)
        taught = cold.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(taught)
        self.assertIsNone(cold.attitude)
        self.assertEqual(cold._device_seq.get("shared"), 0x2A)
        self.assertEqual(cold.rejected_count, 0)
        cold._sock = QueueSock(fresh=[encode_packet(CMD_ATTITUDE, attitude_data, seq=0x2B)])
        got = cold.exchange(CMD_ATTITUDE, b"")
        self.assertEqual(got["seq"], 0x2B)
        self.assertNotEqual(got["seq"], decode_packet(cold._sock.sent[-1][0])["seq"])
        self.assertEqual(cold._device_seq.get("shared"), 0x2B)

        sock = CaptureSock()
        link = SiyiLink(env={"VLC_GIMBAL_CONTROL_ENABLED": "0"}, sock=sock, now_fn=lambda: 80.0)
        link._camera_seq = 0x29
        link.poll_once()
        att_req = next(decode_packet(pkt) for pkt, _addr in sock.sent if decode_packet(pkt)["cmd"] == CMD_ATTITUDE)
        fw_req = next(decode_packet(pkt) for pkt, _addr in sock.sent if decode_packet(pkt)["cmd"] == CMD_FIRMWARE)
        self.assertNotEqual(attitude["seq"], att_req["seq"])
        self.assertNotEqual(firmware["seq"], fw_req["seq"])
        self.assertEqual(link.attitude["yaw"], 12.3)
        self.assertEqual(link.attitude["pitch"], -4.5)
        self.assertEqual(link.firmware["camera"], "v3.2.3")
        self.assertEqual(link.firmware["gimbal"], "v1.4.2")
        codec_req = next(decode_packet(pkt) for pkt, _addr in sock.sent if decode_packet(pkt)["cmd"] == CMD_CODEC)
        self.assertEqual(codec_req["data"], bytes([CODEC_STREAM_MAIN]))
        self.assertNotEqual(codec["seq"], codec_req["seq"])
        self.assertEqual(link.codec[0]["stream"], "main")
        self.assertEqual(link.codec[0]["stream_type"], 1)
        self.assertEqual(link.codec[0]["width"], 1920)
        self.assertEqual(link.codec[0]["height"], 1080)
        self.assertEqual(link.codec[0]["bitrate_kbps"], 2500)
        status = link.public_status()
        self.assertTrue(status["present"])
        self.assertIsNone(status["error"])
        self.assertEqual(status["attitude"]["roll"], 0.2)

    def test_codec_miss_never_marks_the_gimbal_absent(self):
        class AttitudeThenQuiet(FakeSiyiSock):
            def __init__(self):
                super().__init__()
                self._att_seq = 0x2A

            def sendto(self, packet, addr):
                super().sendto(packet, addr)
                self._open = True

            def recvfrom(self, _n):
                if self._timeout == 0 or not self.sent or not getattr(self, "_open", False):
                    raise socket.timeout()
                self._open = False
                decoded = decode_packet(self.sent[-1][0])
                if decoded["cmd"] == CMD_ATTITUDE:
                    seq = self._att_seq
                    self._att_seq = (self._att_seq + 1) & 0xFFFF
                    data = decode_packet(A8_ATTITUDE_SEQ_MISMATCH)["data"]
                    return encode_packet(CMD_ATTITUDE, data, seq=seq), (DEFAULT_HOST, DEFAULT_PORT)
                raise socket.timeout()

        sock = AttitudeThenQuiet()
        link = SiyiLink(env={"VLC_GIMBAL_CONTROL_ENABLED": "0"}, sock=sock, now_fn=lambda: 90.0)
        link._camera_seq = 0x29
        link.poll_once()
        codec_req = next(decode_packet(pkt) for pkt, _addr in sock.sent if decode_packet(pkt)["cmd"] == CMD_CODEC)
        self.assertEqual(codec_req["data"], bytes([CODEC_STREAM_MAIN]))
        self.assertIsNone(link.codec)
        self.assertTrue(link.present)
        self.assertIsNone(link.last_error)
        self.assertEqual(link.attitude["yaw"], 12.3)
        status = link.public_status()
        self.assertTrue(status["present"])
        self.assertIsNone(status["error"])
        self.assertEqual(status["attitude"]["pitch"], -4.5)

        quiet = FakeSiyiSock(reply=False)
        cold = SiyiLink(env={}, sock=quiet, now_fn=lambda: 1.0)
        missed = cold.exchange(CMD_CODEC, bytes([CODEC_STREAM_MAIN]), require_match=True, marks_absent=False)
        self.assertIsNone(missed)
        self.assertIsNone(cold.last_error)
        self.assertFalse(cold.present)
        self.assertEqual(decode_packet(quiet.sent[-1][0])["data"], bytes([CODEC_STREAM_MAIN]))

    def test_stale_same_command_reply_does_not_confirm(self):
        stale = encode_packet(CMD_RATE, bytes([1]), seq=1234)
        fresh = encode_packet(CMD_RATE, bytes([1]), seq=31)
        queued = QueueSock(stale=[stale], fresh=[])
        link = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=queued,
            now_fn=lambda: 10.0,
        )
        code, body = link.command("rate", {"yaw": 4, "pitch": -3})
        self.assertEqual(code, 504)
        self.assertEqual(body["reason"], "no_reply")
        self.assertFalse(body["confirmed"])
        self.assertEqual(queued.pending, [])
        self.assertEqual(len(queued.sent), 2)
        self.assertEqual(decode_packet(queued.sent[1][0])["cmd"], CMD_ATTITUDE)

        both = QueueSock(stale=[stale], fresh=[fresh])
        followed = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=both,
            now_fn=lambda: 11.0,
        )
        code, body = followed.command("rate", {"yaw": 4, "pitch": -3})
        self.assertEqual(code, 200)
        self.assertFalse(body["confirmed"])
        self.assertEqual(body["message"], "sent, not confirmed")
        self.assertNotIn("confirmed_by", body)
        self.assertIsNone(followed.zoom)

    def test_out_of_order_replies_keep_the_matching_telemetry(self):
        wrong = encode_packet(CMD_ZOOM, struct.pack("<H", 10), seq=31)
        stale = encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 900, 0, 0, 0, 0, 0), seq=1234)
        fresh = encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 123, -45, 2, 0, 0, 0), seq=31)
        sock = QueueSock(fresh=[wrong, stale, fresh])
        link = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "0"},
            sock=sock,
            now_fn=lambda: 12.0,
        )
        link._camera_seq = 30
        got = link.exchange(CMD_ATTITUDE, b"")
        # 1234 teaches. 31 is behind that baseline, so it is not the reading.
        self.assertIsNone(got)
        self.assertEqual(link._device_seq.get("shared"), 1234)
        self.assertTrue(link._device_seq_regressed.get("shared"))
        self.assertIsNone(link.attitude)

    def test_live_a8_counter_pattern_is_accepted(self):
        class CameraCounterSock(FakeSiyiSock):
            def __init__(self):
                super().__init__(reply=True)
                self.n = 200
                self.echoed = []

            def sendto(self, packet, addr):
                super().sendto(packet, addr)
                self._open = True

            def recvfrom(self, _n):
                if self._timeout == 0 or not self.sent or not getattr(self, "_open", False):
                    raise socket.timeout()
                self._open = False
                decoded = decode_packet(self.sent[-1][0])
                seq = self.n
                self.n = (self.n + 1) & 0xFFFF
                self.echoed.append(seq == decoded["seq"])
                if decoded["cmd"] == CMD_ATTITUDE:
                    payload = struct.pack("<hhhhhh", 100, -45, 2, 0, 0, 0)
                elif decoded["cmd"] == CMD_CODEC:
                    payload = struct.pack("<BBHHHB", 1, 1, 1920, 1080, 2500, 30)
                elif decoded["cmd"] == CMD_FIRMWARE:
                    payload = struct.pack("<III", 0x6E030203, 0x00010402, 0)
                else:
                    payload = bytes([1])
                return encode_packet(decoded["cmd"], payload, seq=seq), (DEFAULT_HOST, DEFAULT_PORT)

        sock = CameraCounterSock()
        link = SiyiLink(env={"VLC_GIMBAL_CONTROL_ENABLED": "0"}, sock=sock, now_fn=lambda: 20.0)
        link.poll_once()
        self.assertTrue(sock.echoed)
        self.assertFalse(any(sock.echoed))
        self.assertEqual(link.attitude["yaw"], 10.0)
        self.assertEqual(link.firmware["camera"], "v3.2.3")
        self.assertEqual(link.codec[0]["stream"], "main")
        # The first attitude teaches 200. The next attitude (201) is the
        # reading, then firmware takes 202. Config is its own counter.
        self.assertEqual(link._device_seq.get("shared"), 202)
        self.assertEqual(link._device_seq.get("config"), 204)
        self.assertEqual(link.rejected_count, 0)
        self.assertIsNone(link.last_error)
        status = link.public_status()
        self.assertTrue(status["present"])
        self.assertIsNone(status["error"])
        self.assertEqual(status["rejected"], 0)

        behind = encode_packet(
            CMD_ATTITUDE,
            struct.pack("<hhhhhh", 110, -10, 0, 0, 0, 0),
            seq=(link._device_seq["shared"] - 64) & 0xFFFF,
        )
        link._sock = QueueSock(fresh=[behind])
        missed = link.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(missed)
        self.assertEqual(link.attitude["yaw"], 10.0)
        self.assertEqual(link._device_seq.get("shared"), 202)
        self.assertTrue(link._device_seq_regressed.get("shared"))
        self.assertGreaterEqual(link.rejected_count, 1)
        self.assertEqual(link.last_error, "seq_rejected")
        self.assertTrue(link.present)

    def test_first_post_send_datagram_is_the_reply(self):
        stale_angle = struct.pack("<hhhhhh", 500, 0, 0, 0, 0, 0)
        queued = encode_packet(CMD_ATTITUDE, stale_angle, seq=5000)
        drained = SiyiLink(env={}, sock=QueueSock(stale=[queued], fresh=[]), now_fn=lambda: 40.0)
        missed = drained.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(missed)
        self.assertEqual(drained.last_error, "no_reply")
        self.assertEqual(drained._device_seq, {})
        self.assertEqual(drained.rejected_count, 0)

        first = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, stale_angle, seq=5000),
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 510, 0, 0, 0, 0, 0), seq=5001),
        ])
        link = SiyiLink(env={}, sock=first, now_fn=lambda: 40.0)
        got = link.exchange(CMD_ATTITUDE, b"")
        # 5000 only teaches. 5001 is one ahead, so it is the attitude.
        self.assertEqual(got["seq"], 5001)
        self.assertEqual(struct.unpack_from("<h", got["data"], 0)[0], 510)
        self.assertEqual(link._device_seq.get("shared"), 5001)
        self.assertEqual(first.pending, [])

        link._sock = QueueSock(fresh=[
            encode_packet(CMD_CONFIG, bytes([0, 0, 0, 0, 1, 0, 0]), seq=42),
        ])
        cfg = link.exchange(CMD_CONFIG, b"")
        self.assertEqual(cfg["seq"], 42)
        self.assertEqual(link._device_seq.get("shared"), 5001)
        self.assertEqual(link._device_seq.get("config"), 42)
        self.assertEqual(link.rejected_count, 0)

    def test_backwards_seq_is_rejected_and_the_flag_is_set(self):
        link = SiyiLink(env={}, sock=QueueSock(), now_fn=lambda: 50.0)
        link._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 100, 0, 0, 0, 0, 0), seq=100),
        ])
        first = link.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(first)
        self.assertEqual(link._device_seq.get("shared"), 100)
        self.assertTrue(link.present)
        link._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 90, 0, 0, 0, 0, 0), seq=90),
        ])
        back = link.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(back)
        self.assertEqual(link._device_seq.get("shared"), 100)
        self.assertTrue(link._device_seq_regressed.get("shared"))
        self.assertGreaterEqual(link.rejected_count, 1)
        self.assertEqual(link.last_error, "seq_rejected")
        self.assertTrue(link.present)

    def test_timeouts_do_not_block_a_later_command_id_reply(self):
        quiet = FakeSiyiSock(reply=False)
        link = SiyiLink(env={}, sock=quiet, now_fn=lambda: 1.0)
        link.exchange(CMD_ATTITUDE, b"")
        link.exchange(CMD_ATTITUDE, b"")
        self.assertEqual(link.last_error, "no_reply")
        self.assertFalse(link.present)
        self.assertEqual(link._device_seq, {})
        link._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 70, 0, 0, 0, 0, 0), seq=7),
        ])
        taught = link.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(taught)
        self.assertEqual(link._device_seq.get("shared"), 7)
        self.assertTrue(link.present)
        self.assertIsNone(link.last_error)
        link._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 80, 0, 0, 0, 0, 0), seq=8),
        ])
        got = link.exchange(CMD_ATTITUDE, b"")
        self.assertEqual(got["seq"], 8)
        self.assertIsNone(link.last_error)
        self.assertTrue(link.present)
        self.assertEqual(link._device_seq.get("shared"), 8)
        self.assertEqual(link.rejected_count, 0)

    def test_stale_telemetry_inside_the_window_can_still_win(self):
        stale = encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 330, 0, 0, 0, 0, 0), seq=33)
        link = SiyiLink(env={}, sock=QueueSock(fresh=[stale]), now_fn=lambda: 60.0)
        link._camera_seq = 30
        got = link.exchange(CMD_ATTITUDE, b"")
        # A lone attitude on a fresh link teaches the counter. It is not returned.
        self.assertIsNone(got)
        self.assertEqual(link._device_seq.get("shared"), 33)
        self.assertEqual(link.rejected_count, 0)
        self.assertIsNone(link.attitude)

    def test_control_confirms_only_a_fresh_matching_read(self):
        def att_pkt(seq, yaw, pitch, yaw_rate=0, pitch_rate=0):
            return encode_packet(
                CMD_ATTITUDE,
                struct.pack("<hhhhhh", int(yaw * 10), int(pitch * 10), 0, int(yaw_rate * 10), int(pitch_rate * 10), 0),
                seq=seq,
            )

        stale = att_pkt(31, 9, -4, yaw_rate=8, pitch_rate=-8)
        fresh = att_pkt(32, 1, 1, yaw_rate=4, pitch_rate=-3)
        # 31 teaches. 32 is one ahead, so the rate fields on 32 can confirm.
        sock = BatchSock([[], [att_pkt(31, 0, 0), fresh]])
        sock.pending = [stale]
        link = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=sock,
            now_fn=lambda: 30.0,
        )
        link._camera_seq = 30
        code, body = link.command("rate", {"yaw": 4, "pitch": -3})
        self.assertEqual(code, 200)
        self.assertTrue(body["confirmed"])
        self.assertEqual(body["confirmed_by"], "rate")
        self.assertEqual(body["ack"]["yaw_rate"], 4)
        self.assertEqual(body["ack"]["pitch_rate"], -3)
        self.assertNotIn("sta", body["ack"])

        wrong = att_pkt(32, 9, -4, yaw_rate=0, pitch_rate=0)
        held = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[], [att_pkt(31, 0, 0), wrong]]),
            now_fn=lambda: 30.0,
        )
        held._camera_seq = 30
        code, body = held.command("rate", {"yaw": 4, "pitch": -3})
        self.assertEqual(code, 200)
        self.assertFalse(body["confirmed"])
        self.assertEqual(body["message"], "sent, not confirmed")

        angled = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[], [att_pkt(31, 0, 0), att_pkt(32, 6, -3)]]),
            now_fn=lambda: 31.0,
        )
        angled._camera_seq = 30
        angled.attitude = {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}
        code, body = angled.command("angle", {"yaw": 10, "pitch": -5})
        self.assertEqual(code, 200)
        self.assertTrue(body["confirmed"])
        self.assertEqual(body["confirmed_by"], "attitude")
        self.assertEqual(body["ack"]["yaw"], 6)

        unmoved = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[], [att_pkt(31, 1, 1), att_pkt(32, 0, 0)]]),
            now_fn=lambda: 31.0,
        )
        unmoved._camera_seq = 30
        unmoved.attitude = {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}
        code, body = unmoved.command("angle", {"yaw": 10, "pitch": -5})
        self.assertEqual(code, 200)
        self.assertFalse(body["confirmed"])
        self.assertEqual(body["message"], "sent, not confirmed")

        centered = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[], [att_pkt(31, 20, 10), att_pkt(32, 4, 2)]]),
            now_fn=lambda: 32.0,
        )
        centered._camera_seq = 30
        centered.attitude = {"yaw": 20.0, "pitch": 10.0, "roll": 0.0}
        code, body = centered.command("center", {})
        self.assertTrue(body["confirmed"])
        self.assertEqual(body["confirmed_by"], "attitude")

        stuck = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[], [att_pkt(31, 20, 10), att_pkt(32, 20, 10)]]),
            now_fn=lambda: 32.0,
        )
        stuck._camera_seq = 30
        stuck.attitude = {"yaw": 20.0, "pitch": 10.0, "roll": 0.0}
        code, body = stuck.command("center", {})
        self.assertFalse(body["confirmed"])
        self.assertEqual(body["message"], "sent, not confirmed")

        zoom_link = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[], [encode_packet(CMD_ZOOM_READ, bytes([3, 5]), seq=32)]]),
            now_fn=lambda: 33.0,
        )
        zoom_link._camera_seq = 30
        zoom_link.zoom = 2.0
        code, body = zoom_link.command("zoom", {"direction": "in"})
        self.assertTrue(body["confirmed"])
        self.assertEqual(body["confirmed_by"], "zoom")
        self.assertEqual(body["ack"]["zoom"], 3.5)
        sent_cmds = [decode_packet(pkt) for pkt, _addr in zoom_link._sock.sent]
        self.assertEqual(sent_cmds[0]["cmd"], CMD_ZOOM)
        self.assertEqual(sent_cmds[0]["data"], struct.pack("<b", 1))
        self.assertEqual(sent_cmds[-1]["cmd"], CMD_ZOOM_READ)
        self.assertEqual(sent_cmds[-1]["data"], b"")
        self.assertFalse(any(pkt["cmd"] == CMD_ZOOM and pkt["data"] == struct.pack("<b", 0) for pkt in sent_cmds))

        flat = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[], [encode_packet(CMD_ZOOM_READ, bytes([2, 0]), seq=32)]]),
            now_fn=lambda: 33.0,
        )
        flat._camera_seq = 30
        flat.zoom = 2.0
        code, body = flat.command("zoom", {"direction": "in"})
        self.assertEqual(code, 200)
        self.assertFalse(body["confirmed"])
        self.assertEqual(body["message"], "sent, not confirmed")
        self.assertEqual(flat.zoom, 2.0)

        silent = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[], []]),
            now_fn=lambda: 34.0,
        )
        silent._camera_seq = 30
        silent.zoom = 2.0
        code, body = silent.command("zoom", {"direction": "in"})
        self.assertEqual(code, 504)
        self.assertFalse(body["confirmed"])
        self.assertEqual(body["message"], "sent, not confirmed")
        self.assertEqual(silent.zoom, 2.0)

    def test_a_far_seq_is_rejected_while_present(self):
        link = SiyiLink(env={}, sock=QueueSock(), now_fn=lambda: 70.0)
        link.last_reply_mono = 70.0
        link.present = True
        link.attitude = {"yaw": 1.0, "pitch": 0.0, "roll": 0.0}
        link._device_seq["shared"] = 40
        link._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 900, 0, 0, 0, 0, 0), seq=200),
        ])
        got = link.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(got)
        self.assertEqual(link._device_seq.get("shared"), 40)
        self.assertFalse(link._device_seq_regressed.get("shared"))
        self.assertEqual(link.last_error, "seq_rejected")
        self.assertGreaterEqual(link.rejected_count, 1)
        status = link.public_status()
        self.assertTrue(status["present"])
        self.assertEqual(status["error"], "seq_rejected")
        self.assertEqual(status["rejected"], link.rejected_count)
        self.assertEqual(status["attitude"]["yaw"], 1.0)

    def test_a8_skip_pattern_is_accepted_without_lockout(self):
        class SkipSock(FakeSiyiSock):
            def __init__(self):
                super().__init__()
                self.n = 65520
                self.i = 0

            def sendto(self, packet, addr):
                super().sendto(packet, addr)
                self._open = True

            def recvfrom(self, _n):
                if self._timeout == 0 or not getattr(self, "_open", False):
                    raise socket.timeout()
                self._open = False
                self.n = (self.n + (self.i % 12) + 1) & 0xFFFF
                self.i += 1
                payload = struct.pack("<hhhhhh", 10, 0, 0, 0, 0, 0)
                return encode_packet(CMD_ATTITUDE, payload, seq=self.n), (DEFAULT_HOST, DEFAULT_PORT)

        sock = SkipSock()
        link = SiyiLink(env={}, sock=sock, now_fn=lambda: 80.0)
        total = 100
        accepted = 0
        for _ in range(total):
            got = link.exchange(CMD_ATTITUDE, b"")
            if isinstance(got, dict):
                accepted += 1
        self.assertEqual(accepted, total - 1)
        again = link.exchange(CMD_ATTITUDE, b"")
        self.assertEqual(again["seq"], sock.n)
        self.assertEqual(link._device_seq.get("shared"), sock.n)
        self.assertTrue(link.present)
        self.assertEqual(link.rejected_count, 0)
        self.assertIsNone(link.last_error)

    def test_drained_attitude_does_not_confirm_a_move(self):
        stale = encode_packet(
            CMD_ATTITUDE,
            struct.pack("<hhhhhh", 100, -50, 0, 0, 0, 0),
            seq=0,
        )
        held = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[], []]),
            now_fn=lambda: 90.0,
        )
        held._sock.pending = [stale]
        held.attitude = {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}
        code, body = held.command("angle", {"yaw": 10, "pitch": -5})
        self.assertEqual(code, 504)
        self.assertFalse(body["confirmed"])
        self.assertNotIn("confirmed_by", body)
        self.assertEqual(held.attitude["yaw"], 0.0)
        self.assertEqual(held.attitude["pitch"], 0.0)
        self.assertEqual(held._sock.pending, [])

        fresh = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[], [stale]]),
            now_fn=lambda: 91.0,
        )
        fresh.attitude = {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}
        code, body = fresh.command("angle", {"yaw": 10, "pitch": -5})
        self.assertFalse(body["confirmed"])
        self.assertNotIn("confirmed_by", body)
        self.assertEqual(fresh.attitude["yaw"], 0.0)
        self.assertEqual(fresh.attitude["pitch"], 0.0)
        self.assertEqual(fresh._device_seq.get("shared"), 0)

        moved = encode_packet(
            CMD_ATTITUDE,
            struct.pack("<hhhhhh", 100, -50, 0, 0, 0, 0),
            seq=1,
        )
        advanced = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[], [stale, moved]]),
            now_fn=lambda: 92.0,
        )
        advanced.attitude = {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}
        code, body = advanced.command("angle", {"yaw": 10, "pitch": -5})
        self.assertEqual(code, 200)
        self.assertTrue(body["confirmed"])
        self.assertEqual(body["confirmed_by"], "attitude")
        self.assertEqual(advanced.attitude["yaw"], 10.0)
        self.assertEqual(advanced.attitude["pitch"], -5.0)
        self.assertEqual(advanced._device_seq.get("shared"), 1)

    def test_non_motion_ack_stays_confirmed(self):
        sock = FakeSiyiSock()
        link = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=sock,
            now_fn=lambda: 1000.0,
        )
        link._build = lambda action, body: (0x04, bytes([1]), True)
        code, body = link.command("focus", {})
        self.assertEqual(code, 200)
        self.assertTrue(body["confirmed"])
        self.assertEqual(body["ack"]["sta"], 1)

        plain = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=FakeSiyiSock(),
            now_fn=lambda: 1000.0,
        )
        code, body = plain.command("photo", {})
        self.assertEqual(code, 200)
        self.assertFalse(body["confirmed"])

    def test_zoom_read_is_whole_plus_tenths(self):
        self.assertEqual(parse_zoom(bytes.fromhex("0305")), 3.5)
        self.assertNotEqual(parse_zoom(bytes.fromhex("0305")), 128.3)
        self.assertEqual(parse_zoom(bytes([2, 0])), 2.0)
        self.assertIsNone(parse_zoom(bytes([1])))

    def test_zoom_ack_is_uint16_times_ten(self):
        packed = struct.pack("<H", 35)
        self.assertEqual(parse_zoom_ack(packed), 3.5)
        self.assertEqual(parse_zoom(packed), 35.0)
        self.assertNotEqual(parse_zoom(packed), 3.5)
        link = SiyiLink(env={}, sock=QueueSock(), now_fn=lambda: 1.0)
        ack = link._apply_ack(CMD_ZOOM, packed)
        self.assertEqual(ack["zoom"], 3.5)
        self.assertEqual(link.zoom, 3.5)

    def test_first_same_command_datagram_wins_over_a_later_echo(self):
        fit = encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 900, 0, 0, 0, 0, 0), seq=33)
        echo = encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 110, -10, 0, 0, 0, 0), seq=0)
        link = SiyiLink(env={}, sock=QueueSock(fresh=[fit, echo]), now_fn=lambda: 70.0)
        got = link.exchange(CMD_ATTITUDE, b"")
        # 33 teaches. Seq 0 is behind it, so the later datagram is not the reading.
        self.assertIsNone(got)
        self.assertEqual(link._device_seq.get("shared"), 33)
        self.assertTrue(link._device_seq_regressed.get("shared"))
        self.assertGreaterEqual(link.rejected_count, 1)

    def test_seq0_matches_by_command_id(self):
        link = SiyiLink(env={}, sock=QueueSock(fresh=[A8_FIRMWARE_SEQ0]), now_fn=lambda: 70.0)
        link._seq = 4
        got = link.exchange(CMD_FIRMWARE, b"")
        self.assertEqual(got["seq"], 0)
        self.assertNotEqual(got["seq"], decode_packet(link._sock.sent[-1][0])["seq"])
        self.assertEqual(parse_firmware(got["data"])["camera"], "v3.2.3")
        self.assertEqual(link._device_seq.get("shared"), 0)
        self.assertTrue(link.present)
        self.assertEqual(link.rejected_count, 0)

        echoed = encode_packet(CMD_FIRMWARE, decode_packet(A8_FIRMWARE_SEQ0)["data"], seq=4)
        both = SiyiLink(
            env={},
            sock=QueueSock(fresh=[A8_FIRMWARE_SEQ0, echoed]),
            now_fn=lambda: 71.0,
        )
        both._seq = 4
        got = both.exchange(CMD_FIRMWARE, b"")
        self.assertEqual(got["seq"], 0)
        self.assertEqual(both._device_seq.get("shared"), 0)

    def test_captured_a8_sequence_replays_by_command_id(self):
        rows = _load_a8_seq_capture()
        self.assertEqual(len(rows), 60)
        sock = CaptureReplaySock(rows)
        link = SiyiLink(env={}, sock=sock, now_fn=lambda: 100.0)
        link._seq = rows[0]["req_seq"]
        shared = []
        config = []
        taught = None
        for index, row in enumerate(rows):
            got = link.exchange(row["cmd"], b"")
            sent = decode_packet(sock.sent[-1][0])
            self.assertEqual(sent["seq"], row["req_seq"])
            self.assertEqual(sent["cmd"], row["cmd"])
            if index == 0:
                self.assertEqual(row["cmd"], CMD_ATTITUDE)
                self.assertIsNone(got)
                self.assertEqual(link._device_seq.get("shared"), row["reply_seq"])
                taught = row["reply_seq"]
                continue
            self.assertIsInstance(got, dict)
            self.assertEqual(got["cmd"], row["cmd"])
            self.assertEqual(got["seq"], row["reply_seq"])
            self.assertNotEqual(got["seq"], row["req_seq"])
            self.assertNotEqual(got["seq"], 0)
            if row["cmd"] == CMD_ZOOM_READ:
                self.assertEqual(parse_zoom(got["data"]), 1.0)
            if row["cmd"] in {CMD_ATTITUDE, CMD_ZOOM_READ, CMD_FIRMWARE}:
                shared.append(got["seq"])
            if row["cmd"] == CMD_CONFIG:
                config.append(got["seq"])
        self.assertEqual(taught, 23739)
        self.assertEqual(shared[0], 23740)
        self.assertEqual(shared[-1], 23783)
        self.assertTrue(all(b - a == 1 for a, b in zip(shared, shared[1:])))
        self.assertEqual(config[0], 6307)
        self.assertEqual(config[-1], 6321)
        self.assertTrue(all(b - a == 1 for a, b in zip(config, config[1:])))
        self.assertEqual(link._device_seq.get("shared"), 23783)
        self.assertEqual(link._device_seq.get("config"), 6321)
        self.assertEqual(link._device_seq_regressed, {})
        self.assertEqual(link.rejected_count, 0)
        self.assertIsNone(link.last_error)
        self.assertTrue(link.present)

    def test_r3_regressed_seq_is_not_returned(self):
        now = {"t": 50.0}
        link = SiyiLink(env={}, sock=QueueSock(), now_fn=lambda: now["t"])
        link._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 10, 0, 0, 0, 0, 0), seq=23800),
        ])
        learned = link.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(learned)
        self.assertEqual(link._device_seq.get("shared"), 23800)
        self.assertFalse(link._device_seq_regressed.get("shared", False))
        link._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 9990, 0, 0, 0, 0, 0), seq=23000),
        ])
        missed = link.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(missed)
        self.assertEqual(link._device_seq.get("shared"), 23800)
        self.assertTrue(link._device_seq_regressed.get("shared"))
        self.assertGreaterEqual(link.rejected_count, 1)
        self.assertEqual(link.last_error, "seq_rejected")
        link._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 20, 0, 0, 0, 0, 0), seq=23001),
        ])
        resumed = link.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(resumed)
        self.assertEqual(link._device_seq.get("shared"), 23001)
        self.assertFalse(link._device_seq_regressed.get("shared", False))
        link._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 21, 0, 0, 0, 0, 0), seq=23002),
        ])
        followed = link.exchange(CMD_ATTITUDE, b"")
        self.assertEqual(followed["seq"], 23002)
        self.assertEqual(link._device_seq.get("shared"), 23002)
        self.assertIsNone(link.last_error)

        silent = SiyiLink(env={}, sock=QueueSock(), now_fn=lambda: now["t"])
        silent._device_seq["shared"] = 23800
        silent.last_reply_mono = now["t"] - 5
        silent._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 30, 0, 0, 0, 0, 0), seq=23000),
        ])
        again = silent.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(again)
        self.assertEqual(silent._device_seq.get("shared"), 23000)
        self.assertFalse(silent._device_seq_regressed.get("shared", False))
        silent._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 31, 0, 0, 0, 0, 0), seq=23001),
        ])
        followed = silent.exchange(CMD_ATTITUDE, b"")
        self.assertEqual(followed["seq"], 23001)
        self.assertEqual(silent._device_seq.get("shared"), 23001)

    def test_r2_stale_then_live_keeps_the_advancing_reply(self):
        link = SiyiLink(env={}, sock=QueueSock(), now_fn=lambda: 60.0)
        link._device_seq["shared"] = 23790
        link.last_reply_mono = 60.0
        stale = encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 9990, 0, 0, 0, 0, 0), seq=23700)
        live = encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 100, 0, 0, 0, 0, 0), seq=23801)
        link._sock = QueueSock(fresh=[stale, live])
        got = link.exchange(CMD_ATTITUDE, b"")
        self.assertEqual(got["seq"], 23801)
        self.assertEqual(struct.unpack_from("<h", got["data"], 0)[0], 100)
        self.assertEqual(link._device_seq.get("shared"), 23801)
        self.assertFalse(link._device_seq_regressed.get("shared", False))
        self.assertGreaterEqual(link.rejected_count, 1)

    def test_c2_regressed_attitude_nearer_the_target_does_not_confirm(self):
        closer = encode_packet(
            CMD_ATTITUDE,
            struct.pack("<hhhhhh", 100, 100, 0, 0, 0, 0),
            seq=23000,
        )
        link = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[], [closer]]),
            now_fn=lambda: 80.0,
        )
        link._device_seq["shared"] = 23800
        link.last_reply_mono = 80.0
        link.attitude = {"yaw": 30.0, "pitch": 30.0, "roll": 0.0}
        code, body = link.command("center", {})
        self.assertIn(code, (200, 504))
        self.assertFalse(body["confirmed"])
        self.assertNotIn("confirmed_by", body)
        self.assertEqual(link.attitude["yaw"], 30.0)
        self.assertEqual(link.attitude["pitch"], 30.0)
        self.assertEqual(link._device_seq.get("shared"), 23800)
        self.assertTrue(link._device_seq_regressed.get("shared"))
        sent = [decode_packet(pkt)["cmd"] for pkt, _addr in link._sock.sent]
        self.assertEqual(sent[0], CMD_CENTER)
        self.assertIn(CMD_ATTITUDE, sent)

    def test_r2_post_drain_stale_attitude_on_a_fresh_link_is_not_live(self):
        # Harness R2: no seeded counter. Stale 0x0D seq 23700 arrives after
        # the drain, then a later 0x0D seq 23801. 23700 only teaches.
        # 23801 is 101 ahead, so neither datagram is the reading.
        stale = encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 9990, 9990, 0, 0, 0, 0), seq=23700)
        live = encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 100, 0, 0, 0, 0, 0), seq=23801)
        link = SiyiLink(env={}, sock=QueueSock(fresh=[stale, live]), now_fn=lambda: 61.0)
        got = link.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(got)
        self.assertIsNone(link.attitude)
        self.assertEqual(link._device_seq.get("shared"), 23700)
        self.assertFalse(link._device_seq_regressed.get("shared", False))
        self.assertGreaterEqual(link.rejected_count, 1)
        self.assertEqual(link.last_error, "seq_rejected")

    def test_c2_fresh_link_closer_attitude_does_not_confirm(self):
        # Harness C2: no seeded counter. Stored attitude is 30/30. The only
        # post-send attitude is seq 23000 at 10/10, closer to center, but it
        # has not advanced a known counter, so it must not confirm.
        closer = encode_packet(
            CMD_ATTITUDE,
            struct.pack("<hhhhhh", 100, 100, 0, 0, 0, 0),
            seq=23000,
        )
        link = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[], [closer]]),
            now_fn=lambda: 82.0,
        )
        link.attitude = {"yaw": 30.0, "pitch": 30.0, "roll": 0.0}
        _code, body = link.command("center", {})
        self.assertFalse(body["confirmed"])
        self.assertNotIn("confirmed_by", body)
        self.assertEqual(link.attitude["yaw"], 30.0)
        self.assertEqual(link.attitude["pitch"], 30.0)
        self.assertEqual(link._device_seq.get("shared"), 23000)
        self.assertFalse(link._device_seq_regressed.get("shared", False))

    def test_c3_stale_ack_does_not_confirm_an_unchanged_attitude(self):
        ack = encode_packet(CMD_CENTER, bytes([1]), seq=23000)
        held = encode_packet(
            CMD_ATTITUDE,
            struct.pack("<hhhhhh", 300, 300, 0, 0, 0, 0),
            seq=23802,
        )
        link = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=BatchSock([[ack], [held]]),
            now_fn=lambda: 81.0,
        )
        link._device_seq["shared"] = 23800
        link.last_reply_mono = 81.0
        link.attitude = {"yaw": 30.0, "pitch": 30.0, "roll": 0.0}
        code, body = link.command("center", {})
        self.assertEqual(code, 200)
        self.assertFalse(body["confirmed"])
        self.assertNotIn("confirmed_by", body)
        self.assertEqual(body["message"], "sent, not confirmed")
        self.assertEqual(link.attitude["yaw"], 30.0)
        self.assertEqual(link.attitude["pitch"], 30.0)
        self.assertEqual(link._device_seq.get("shared"), 23802)


class BatchSock:
    """Each sendto arms the next reply batch. Earlier leftovers drain first."""

    def __init__(self, batches):
        self.batches = [list(batch) for batch in batches]
        self.pending = []
        self.sent = []
        self._timeout = None

    def sendto(self, packet, addr):
        self.sent.append((bytes(packet), addr))
        if self.batches:
            self.pending.extend(self.batches.pop(0))

    def recvfrom(self, _n):
        if not self.pending:
            raise socket.timeout()
        return self.pending.pop(0), (DEFAULT_HOST, DEFAULT_PORT)

    def settimeout(self, timeout):
        self._timeout = timeout

    def close(self):
        return None


if __name__ == "__main__":
    unittest.main()
