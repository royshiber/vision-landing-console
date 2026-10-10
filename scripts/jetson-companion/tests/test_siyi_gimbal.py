"""Gimbal commands over a fake SIYI socket. No live UDP."""

from __future__ import annotations

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
    CMD_FIRMWARE,
    CMD_PHOTO,
    CMD_RATE,
    CMD_ZOOM,
    CODEC_STREAM_MAIN,
    DEFAULT_HOST,
    DEFAULT_PORT,
    SiyiLink,
    decode_packet,
    encode_packet,
    parse_codec_specs,
    reply_matches,
    seq_acceptable,
    seq_distance,
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

    def sendto(self, packet, addr):
        self.sent.append((bytes(packet), addr))

    def recvfrom(self, _n):
        # timeout 0 is the pre-send drain. Nothing is queued on this fake.
        if self._timeout == 0 or not self.reply or not self.sent:
            raise socket.timeout()
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
        self.assertTrue(body["ok"])
        self.assertTrue(body["confirmed"])
        self.assertEqual(body["ack"]["sta"], 1)
        self.assertNotIn("confirmed_by", body)
        decoded, addr = last_packet(sock)
        self.assertEqual(addr, (DEFAULT_HOST, DEFAULT_PORT))
        self.assertEqual(decoded["cmd"], CMD_RATE)
        self.assertEqual(decoded["data"], struct.pack("<bb", -40, 40))

        code, _body = link.command("zoom", {"direction": "in"})
        self.assertEqual(code, 200)
        decoded, _addr = last_packet(sock)
        self.assertEqual(decoded["cmd"], CMD_ZOOM)
        self.assertEqual(decoded["data"], struct.pack("<b", 1))

        code, _body = link.command("zoom", {"zoom": 0})
        self.assertEqual(code, 200)
        decoded, _addr = last_packet(sock)
        self.assertEqual(decoded["data"], struct.pack("<b", 0))

        before = len(sock.sent)
        code, body = link.command("mode", {"mode": "lock"})
        self.assertEqual(code, 200)
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
                if self._timeout == 0 or not self.sent:
                    raise socket.timeout()
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
        # Same codec payload as the captured frame, seq 0x2C: within ±8 of
        # the attitude counter 0x2A, and not the request sequence.
        codec_near = encode_packet(
            CMD_CODEC,
            struct.pack("<BBHHHB", 1, 1, 1920, 1080, 2500, 30),
            seq=0x2C,
        )
        codec = decode_packet(codec_near)
        self.assertFalse(seq_acceptable(0x0100, 4, last_camera_seq=0x2A))
        self.assertEqual(attitude["cmd"], CMD_ATTITUDE)
        self.assertEqual(attitude["seq"], 0x2A)
        self.assertEqual(firmware["seq"], 0)
        self.assertEqual(codec["seq"], 0x2C)
        self.assertFalse(seq_acceptable(attitude["seq"], 0))
        self.assertTrue(seq_acceptable(attitude["seq"], 0, last_camera_seq=0x2A))
        self.assertTrue(seq_acceptable(0x32, 4, last_camera_seq=0x2A))
        self.assertFalse(seq_acceptable(0xBEEF, 4, last_camera_seq=0x2A))
        self.assertTrue(seq_acceptable(0, 1, last_camera_seq=0x2A))
        self.assertTrue(seq_acceptable(7, 99, last_camera_seq=65535))
        self.assertFalse(seq_acceptable(8, 99, last_camera_seq=65535))
        self.assertFalse(seq_acceptable("nope", 0))
        self.assertFalse(reply_matches(decode_packet(A8_ZOOM_NOT_ATTITUDE), CMD_ATTITUDE, 0))
        self.assertFalse(reply_matches(attitude, CMD_ATTITUDE, 0))
        self.assertFalse(reply_matches(attitude, CMD_ATTITUDE, 0, last_camera_seq=None))

        manual = encode_packet(CMD_CODEC, bytes([CODEC_STREAM_MAIN]), seq=0).hex()
        self.assertEqual(manual, "5566010100000020019e9d")

        class CaptureSock(FakeSiyiSock):
            def __init__(self):
                super().__init__(reply=True)
                self._prelude = [A8_ZOOM_NOT_ATTITUDE]

            def recvfrom(self, _n):
                if self._timeout == 0 or (not self.sent and not self._prelude):
                    raise socket.timeout()
                if self._prelude:
                    return self._prelude.pop(0), (DEFAULT_HOST, DEFAULT_PORT)
                decoded = decode_packet(self.sent[-1][0])
                table = {
                    CMD_ATTITUDE: A8_ATTITUDE_SEQ_MISMATCH,
                    CMD_FIRMWARE: A8_FIRMWARE_SEQ0,
                    CMD_CODEC: codec_near,
                }
                raw = table.get(decoded["cmd"])
                if raw is None:
                    raise socket.timeout()
                return raw, (DEFAULT_HOST, DEFAULT_PORT)

        sock = CaptureSock()
        link = SiyiLink(env={"VLC_GIMBAL_CONTROL_ENABLED": "0"}, sock=sock, now_fn=lambda: 80.0)
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
            def recvfrom(self, _n):
                if self._timeout == 0 or not self.sent:
                    raise socket.timeout()
                decoded = decode_packet(self.sent[-1][0])
                if decoded["cmd"] == CMD_ATTITUDE:
                    return A8_ATTITUDE_SEQ_MISMATCH, (DEFAULT_HOST, DEFAULT_PORT)
                raise socket.timeout()

        sock = AttitudeThenQuiet()
        link = SiyiLink(env={"VLC_GIMBAL_CONTROL_ENABLED": "0"}, sock=sock, now_fn=lambda: 90.0)
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
        self.assertIsNone(link._camera_seq)
        code, body = link.command("rate", {"yaw": 4, "pitch": -3})
        self.assertEqual(code, 504)
        self.assertEqual(body["reason"], "no_reply")
        self.assertFalse(body["confirmed"])
        self.assertEqual(queued.pending, [])
        self.assertEqual(len(queued.sent), 2)
        self.assertEqual(decode_packet(queued.sent[1][0])["cmd"], CMD_ATTITUDE)
        self.assertIsNone(link._camera_seq)

        both = QueueSock(stale=[stale], fresh=[fresh])
        followed = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=both,
            now_fn=lambda: 11.0,
        )
        followed._camera_seq = 30
        code, body = followed.command("rate", {"yaw": 4, "pitch": -3})
        self.assertEqual(code, 504)
        self.assertFalse(body["confirmed"])
        self.assertNotIn("ack", body)
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
        self.assertEqual(got["seq"], 31)
        self.assertEqual(struct.unpack_from("<h", got["data"], 0)[0], 123)
        self.assertEqual(link._camera_seq, 31)

    def test_live_a8_counter_pattern_is_accepted(self):
        class CameraCounterSock(FakeSiyiSock):
            def __init__(self):
                super().__init__(reply=True)
                self.n = 200
                self.echoed = []

            def recvfrom(self, _n):
                if self._timeout == 0 or not self.sent:
                    raise socket.timeout()
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
        self.assertEqual(link._camera_seq, 205)
        status = link.public_status()
        self.assertTrue(status["present"])
        self.assertIsNone(status["error"])

        far_seq = (link._camera_seq + 20) & 0xFFFF
        far = encode_packet(
            CMD_ATTITUDE,
            struct.pack("<hhhhhh", 900, 0, 0, 0, 0, 0),
            seq=far_seq,
        )
        link._sock = QueueSock(fresh=[far])
        missed = link.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(missed)
        self.assertEqual(link.attitude["yaw"], 10.0)
        self.assertEqual(link._camera_seq, 205)
        self.assertEqual(link._camera_candidate, far_seq)
        self.assertEqual(link.last_error, "seq_rejected")

        echo_seq = link._seq
        before = link._camera_seq
        echo = encode_packet(
            CMD_ATTITUDE,
            struct.pack("<hhhhhh", 110, -10, 0, 0, 0, 0),
            seq=echo_seq,
        )
        link._sock = QueueSock(fresh=[echo])
        matched = link.exchange(CMD_ATTITUDE, b"")
        self.assertIsInstance(matched, dict)
        self.assertEqual(matched["seq"], echo_seq)
        self.assertNotEqual(echo_seq, before)
        self.assertGreater(seq_distance(echo_seq, before), 8)
        self.assertEqual(struct.unpack_from("<h", matched["data"], 0)[0], 110)
        self.assertIsNone(link.last_error)

    def test_stale_post_drain_reply_does_not_stick(self):
        yaw = struct.pack("<hhhhhh", 10, 0, 0, 0, 0, 0)
        first = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, yaw, seq=5000),
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 410, 0, 0, 0, 0, 0), seq=41),
        ])
        link = SiyiLink(env={}, sock=first, now_fn=lambda: 40.0)
        missed = link.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(missed)
        self.assertIsNone(link._camera_seq)
        self.assertEqual(link._camera_candidate, 41)
        self.assertEqual(link.last_error, "seq_rejected")

        link._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 420, 0, 0, 0, 0, 0), seq=42),
        ])
        got = link.exchange(CMD_ATTITUDE, b"")
        self.assertEqual(got["seq"], 42)
        self.assertEqual(link._camera_seq, 42)
        self.assertIsNone(link._camera_candidate)
        self.assertIsNone(link.last_error)

        link._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 430, 0, 0, 0, 0, 0), seq=43),
        ])
        got = link.exchange(CMD_ATTITUDE, b"")
        self.assertEqual(got["seq"], 43)
        self.assertEqual(link._camera_seq, 43)

    def test_reboot_and_drift_relearn_from_two_consistent_replies(self):
        def exchange_seq(link, seq):
            link._sock = QueueSock(fresh=[
                encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 10, 0, 0, 0, 0, 0), seq=seq),
            ])
            return link.exchange(CMD_ATTITUDE, b"")

        for start, first, second in ((40, 3, 4), (40, 60, 61)):
            link = SiyiLink(env={}, sock=QueueSock(), now_fn=lambda: 50.0)
            link._camera_seq = start
            link.last_reply_mono = 50.0
            missed = exchange_seq(link, first)
            self.assertIsNone(missed)
            self.assertEqual(link._camera_seq, start)
            self.assertEqual(link._camera_candidate, first)
            self.assertEqual(link.last_error, "seq_rejected")
            got = exchange_seq(link, second)
            self.assertEqual(got["seq"], second)
            self.assertEqual(link._camera_seq, second)
            self.assertIsNone(link.last_error)

        both = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 30, 0, 0, 0, 0, 0), seq=3),
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 40, 0, 0, 0, 0, 0), seq=4),
        ])
        paired = SiyiLink(env={}, sock=both, now_fn=lambda: 50.0)
        paired._camera_seq = 40
        paired.last_reply_mono = 50.0
        got = paired.exchange(CMD_ATTITUDE, b"")
        self.assertEqual(got["seq"], 4)
        self.assertEqual(paired._camera_seq, 4)

    def test_silence_and_two_timeouts_reset_the_counter(self):
        quiet = FakeSiyiSock(reply=False)
        link = SiyiLink(env={}, sock=quiet, now_fn=lambda: 1.0)
        link._camera_seq = 40
        link._camera_candidate = 9
        link.exchange(CMD_ATTITUDE, b"")
        self.assertEqual(link._camera_seq, 40)
        self.assertEqual(link._consec_timeouts, 1)
        link.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(link._camera_seq)
        self.assertIsNone(link._camera_candidate)
        self.assertEqual(link._consec_timeouts, 0)
        self.assertEqual(link.last_error, "no_reply")

        silent = SiyiLink(env={}, sock=QueueSock(), now_fn=lambda: 10.0)
        silent._camera_seq = 40
        silent.last_reply_mono = 0.0
        silent._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 70, 0, 0, 0, 0, 0), seq=7),
        ])
        missed = silent.exchange(CMD_ATTITUDE, b"")
        self.assertIsNone(missed)
        self.assertIsNone(silent._camera_seq)
        self.assertEqual(silent._camera_candidate, 7)
        self.assertEqual(silent.last_error, "seq_rejected")

        silent._sock = QueueSock(fresh=[
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 70, 0, 0, 0, 0, 0), seq=7),
            encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 80, 0, 0, 0, 0, 0), seq=8),
        ])
        got = silent.exchange(CMD_ATTITUDE, b"")
        self.assertEqual(got["seq"], 8)
        self.assertEqual(silent._camera_seq, 8)

    def test_stale_telemetry_inside_the_window_can_still_win(self):
        stale = encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 330, 0, 0, 0, 0, 0), seq=33)
        link = SiyiLink(env={}, sock=QueueSock(fresh=[stale]), now_fn=lambda: 60.0)
        link._camera_seq = 30
        got = link.exchange(CMD_ATTITUDE, b"")
        self.assertEqual(got["seq"], 33)
        self.assertEqual(link._camera_seq, 33)

    def test_control_requires_echo_or_attitude(self):
        rate = encode_packet(CMD_RATE, bytes([1]), seq=31)
        att = encode_packet(CMD_ATTITUDE, struct.pack("<hhhhhh", 50, -20, 0, 0, 0, 0), seq=32)
        sock = BatchSock([[rate], [att]])
        link = SiyiLink(
            env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
            sock=sock,
            now_fn=lambda: 30.0,
        )
        link._camera_seq = 30
        code, body = link.command("rate", {"yaw": 4, "pitch": -3})
        self.assertEqual(code, 200)
        self.assertTrue(body["confirmed"])
        self.assertEqual(body["confirmed_by"], "attitude")
        self.assertEqual(body["ack"]["yaw"], 5.0)
        self.assertEqual(body["ack"]["pitch"], -2.0)
        self.assertNotIn("sta", body["ack"])
        self.assertEqual(link.attitude["yaw"], 5.0)
        self.assertEqual(decode_packet(sock.sent[0][0])["cmd"], CMD_RATE)
        self.assertEqual(decode_packet(sock.sent[1][0])["cmd"], CMD_ATTITUDE)

        samples = (
            ("zoom", encode_packet(CMD_ZOOM, struct.pack("<H", 25), seq=31), {"direction": "in"}),
            ("center", encode_packet(CMD_CENTER, bytes([1]), seq=31), {}),
            ("angle", encode_packet(0x0E, struct.pack("<hhh", 100, -50, 0), seq=31), {"yaw": 10, "pitch": -5}),
        )
        for action, packet, payload in samples:
            held = SiyiLink(
                env={"VLC_GIMBAL_CONTROL_ENABLED": "1"},
                sock=BatchSock([[packet], []]),
                now_fn=lambda: 31.0,
            )
            held._camera_seq = 30
            code, body = held.command(action, payload)
            self.assertEqual(code, 504, action)
            self.assertFalse(body["confirmed"], action)
            self.assertIsNone(held.zoom, action)
            self.assertIsNone(held.attitude, action)


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
