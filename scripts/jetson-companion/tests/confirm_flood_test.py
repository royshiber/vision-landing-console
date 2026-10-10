"""Confirm reads stay rate-limited. A gimbal that never settles must not be flooded.

Pass bar: 32 or fewer 0x0D reads per command over the 1.5 s window
(at most about 20 reads/s, including margin). A later rate or stop
cancels the confirm already in progress.
"""

from __future__ import annotations

import socket
import struct
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from siyi_sdk import (  # noqa: E402
    CMD_ATTITUDE,
    CMD_CENTER,
    CMD_RATE,
    CONFIRM_READ_GAP_S,
    SiyiLink,
    decode_packet,
    encode_packet,
)

READ_BAR = 32
HOST = ("192.168.144.25", 37260)


class FastGimbalSock:
    """One reply per send, after a short RTT. Attitude never changes."""

    def __init__(self, yaw_rate=0.2, pitch=174.9, rtt=0.002):
        self.yaw_rate = yaw_rate
        self.pitch = pitch
        self.rtt = rtt
        self.sent = []
        self._queue = []
        self._timeout = None
        self._lock = threading.Lock()
        self.shared = 23800
        self.config = 6307

    def sendto(self, packet, addr):
        raw = bytes(packet)
        with self._lock:
            self.sent.append((threading.get_ident(), raw, time.monotonic()))
            self._queue.append(raw)

    def recvfrom(self, _n):
        if self._timeout == 0:
            raise socket.timeout()
        with self._lock:
            if not self._queue:
                raise socket.timeout()
            raw = self._queue.pop(0)
        if self.rtt:
            time.sleep(self.rtt)
        decoded = decode_packet(raw)
        cmd = decoded["cmd"]
        with self._lock:
            if cmd == CMD_ATTITUDE:
                self.shared = (self.shared + 1) & 0xFFFF
                seq = self.shared
                data = struct.pack(
                    "<hhhhhh",
                    0,
                    int(round(self.pitch * 10)),
                    0,
                    int(round(self.yaw_rate * 10)),
                    0,
                    0,
                )
            elif cmd in (CMD_RATE, CMD_CENTER):
                self.config = (self.config + 1) & 0xFFFF
                seq = self.config
                data = bytes([1])
            else:
                seq = 1
                data = bytes([1])
        return encode_packet(cmd, data, seq=seq), HOST

    def settimeout(self, timeout):
        self._timeout = timeout

    def close(self):
        return None

    def attitude_reads(self, ident=None, start=None, end=None):
        total = 0
        for tid, raw, when in self.sent:
            if ident is not None and tid != ident:
                continue
            if start is not None and when < start:
                continue
            if end is not None and when >= end:
                continue
            decoded = decode_packet(raw)
            if decoded and decoded["cmd"] == CMD_ATTITUDE:
                total += 1
        return total


def _live_link(sock):
    link = SiyiLink(env={"VLC_GIMBAL_CONTROL_ENABLED": "1"}, sock=sock)
    link._device_seq["shared"] = sock.shared
    link._device_seq["config"] = sock.config
    link.last_reply_mono = time.monotonic()
    return link


class ConfirmFloodTests(unittest.TestCase):
    def test_gap_is_inside_the_75_to_100_ms_band(self):
        self.assertGreaterEqual(CONFIRM_READ_GAP_S, 0.075)
        self.assertLessEqual(CONFIRM_READ_GAP_S, 0.100)

    def test_center_rate_and_stop_stay_under_the_read_bar(self):
        cases = (
            ("center", "center", {}, 0.2, 174.9),
            ("rate", "rate", {"yaw": 20, "pitch": 0}, 0.2, 174.9),
            ("stop", "rate", {"yaw": 0, "pitch": 0}, 22.0, 174.9),
        )
        for name, action, body, yaw_rate, pitch in cases:
            with self.subTest(name=name):
                sock = FastGimbalSock(yaw_rate=yaw_rate, pitch=pitch, rtt=0.002)
                link = _live_link(sock)
                started = time.monotonic()
                code, result = link.command(action, body)
                elapsed = time.monotonic() - started
                reads = sock.attitude_reads()
                self.assertEqual(code, 200, result)
                self.assertFalse(result["confirmed"], result)
                self.assertLessEqual(reads, READ_BAR, f"{name} sent {reads} attitude reads")
                self.assertGreaterEqual(elapsed, 1.2)
                self.assertLess(elapsed, 2.2)
                if name == "stop":
                    self.assertEqual(result["reason"], "rate_not_decayed")
                    self.assertEqual(result["yaw_rate"], 22.0)
                    self.assertEqual(result["pitch_rate"], 0.0)
                else:
                    self.assertNotEqual(result.get("reason"), "rate_not_decayed")

    def test_a_new_rate_cancels_the_previous_confirm_loop(self):
        sock = FastGimbalSock(yaw_rate=0.2, pitch=174.9, rtt=0.002)
        link = _live_link(sock)
        done = {}

        def run(name, body):
            ident = threading.get_ident()
            started = time.monotonic()
            code, result = link.command("rate", body)
            done[name] = {
                "ident": ident,
                "code": code,
                "result": result,
                "secs": time.monotonic() - started,
            }

        first = threading.Thread(target=run, args=("first", {"yaw": 20, "pitch": 0}))
        first.start()
        time.sleep(0.25)
        second = threading.Thread(target=run, args=("second", {"yaw": 40, "pitch": 0}))
        second.start()
        first.join(timeout=2.0)
        self.assertFalse(first.is_alive(), "the first confirm kept running")
        self.assertLess(done["first"]["secs"], 0.8)
        self.assertLessEqual(sock.attitude_reads(done["first"]["ident"]), 8)
        self.assertFalse(done["first"]["result"]["confirmed"])
        self.assertNotEqual(done["first"]["result"].get("reason"), "rate_not_decayed")
        second.join(timeout=3.0)
        self.assertFalse(second.is_alive())
        self.assertLessEqual(sock.attitude_reads(done["second"]["ident"]), READ_BAR)
        self.assertLess(done["second"]["secs"], 2.2)

    def test_a_20_hz_stick_stays_at_or_under_15_reads_per_second(self):
        # Each update used to read once before the previous loop could cancel,
        # so 20 Hz became about 20 attitude reads per second. The shared gap
        # has to hold the link at 15/s or fewer.
        sock = FastGimbalSock(yaw_rate=0.2, pitch=174.9, rtt=0.002)
        link = _live_link(sock)
        window = 1.0
        interval = 0.05
        started = time.monotonic()
        threads = []
        next_at = started
        while True:
            now = time.monotonic()
            if now - started >= window:
                break
            if now < next_at:
                time.sleep(next_at - now)
            yaw = 10 + (len(threads) % 5)
            thread = threading.Thread(
                target=link.command,
                args=("rate", {"yaw": yaw, "pitch": 0}),
                daemon=True,
            )
            thread.start()
            threads.append(thread)
            next_at += interval
        end = started + window
        reads = sock.attitude_reads(start=started, end=end)
        self.assertGreaterEqual(len(threads), 18)
        self.assertGreaterEqual(reads, 8, f"only {reads} attitude reads; the stick never sampled")
        self.assertLessEqual(
            reads / window,
            15.0,
            f"{reads} attitude reads in {window:.2f}s ({reads / window:.1f}/s)",
        )
        for thread in threads:
            thread.join(timeout=3.0)
        self.assertFalse(any(thread.is_alive() for thread in threads))


if __name__ == "__main__":
    unittest.main()
