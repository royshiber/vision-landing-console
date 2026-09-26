"""Gimbal commands over a fake SIYI socket. No live UDP."""

from __future__ import annotations

import socket
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from siyi_sdk import (  # noqa: E402
    CMD_PHOTO,
    CMD_RATE,
    CMD_ZOOM,
    DEFAULT_HOST,
    DEFAULT_PORT,
    SiyiLink,
    decode_packet,
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


if __name__ == "__main__":
    unittest.main()
