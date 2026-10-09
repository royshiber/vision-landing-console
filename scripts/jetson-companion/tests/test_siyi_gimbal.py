"""Gimbal commands over a fake SIYI socket. No live UDP."""

from __future__ import annotations

import socket
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from siyi_sdk import (  # noqa: E402
    CMD_CODEC,
    CMD_PHOTO,
    CMD_RATE,
    CMD_ZOOM,
    DEFAULT_HOST,
    DEFAULT_PORT,
    SiyiLink,
    decode_packet,
    encode_packet,
    parse_codec_specs,
)


class FakeSiyiSock:
    def __init__(self, reply=True):
        self.sent = []
        self.reply = reply

    def sendto(self, packet, addr):
        self.sent.append((bytes(packet), addr))

    def recvfrom(self, _n):
        if not self.reply or not self.sent:
            raise socket.timeout()
        raw, _addr = self.sent[-1]
        decoded = decode_packet(raw)
        ack = struct.pack("<b", 1) if decoded["cmd"] == CMD_ZOOM else bytes([1])
        from siyi_sdk import encode_packet
        return encode_packet(decoded["cmd"], ack, seq=decoded["seq"]), (DEFAULT_HOST, DEFAULT_PORT)

    def settimeout(self, _timeout):
        return None

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
        main = struct.pack("<BBHHHB", 0, 1, 1920, 1080, 4000, 30)
        sub = struct.pack("<BBHHHB", 1, 1, 640, 360, 512, 25)
        parsed = parse_codec_specs(main + sub)
        self.assertEqual(parsed[0]["stream"], "main")
        self.assertEqual(parsed[0]["codec"], "h264")
        self.assertEqual(parsed[0]["width"], 1920)
        self.assertEqual(parsed[1]["stream"], "sub")
        self.assertEqual(parsed[1]["bitrate_kbps"], 512)

        class CodecSock(FakeSiyiSock):
            def recvfrom(self, _n):
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
        self.assertEqual(link.codec[0]["height"], 1080)
        status = link.public_status()
        self.assertFalse(status["codec_writable"])
        self.assertEqual(status["codec"][1]["stream"], "sub")
        code, body = link.command("rate", {"yaw": 1, "pitch": 0})
        self.assertEqual(code, 403)
        self.assertFalse(body["sent"])


if __name__ == "__main__":
    unittest.main()
