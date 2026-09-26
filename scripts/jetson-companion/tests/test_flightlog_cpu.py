# -*- coding: utf-8 -*-
"""Flight-log idle cost. 10k frames must stay under 1 ms each (10% of a core at 100 msg/s)."""

from __future__ import print_function

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from flight_events import obs_from_message  # noqa: E402
from flight_logger import FlightLogger  # noqa: E402
from flightlog_service import FlightLogService  # noqa: E402
from mav_frames import FrameSplitter  # noqa: E402
from tlog_writer import TlogWriter, iter_records, pack_record  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures" / "hand.tlog"


def _mav2(msgid, payload, seq=0):
    return bytes(
        [
            0xFD,
            len(payload),
            0,
            0,
            seq & 0xFF,
            1,
            1,
            msgid & 0xFF,
            (msgid >> 8) & 0xFF,
            (msgid >> 16) & 0xFF,
        ]
    ) + payload + b"\x00\x00"


class FlightlogCpuTests(unittest.TestCase):
    def test_ten_thousand_frames_stay_under_a_millisecond(self):
        attitude = _mav2(30, b"\x00" * 28)
        heartbeat = _mav2(0, b"\x00\x00\x00\x00\x01\x03\x80\x04\x03")
        frames = []
        for i in range(10000):
            frames.append(heartbeat if i % 50 == 0 else attitude)
        blob = b"".join(frames)
        splitter = FrameSplitter()
        parsed = []
        import tlog_writer

        fsyncs = []
        original = tlog_writer.os.fsync
        tlog_writer.os.fsync = lambda fd: fsyncs.append(1)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                writer = TlogWriter(tmp)
                t0 = time.perf_counter()
                step = 1400
                for off in range(0, len(blob), step):
                    for frame, msg in splitter.feed(blob[off : off + step]):
                        writer.append(1_700_000_000.0, frame)
                        parsed.append(msg)
                if splitter.buf:
                    for frame, msg in splitter.feed(b""):
                        writer.append(1_700_000_000.0, frame)
                        parsed.append(msg)
                elapsed = time.perf_counter() - t0
                writer.flush()
                writer.close()
        finally:
            tlog_writer.os.fsync = original
        self.assertLess(len(fsyncs), 40)
        self.assertEqual(len(parsed), 10000)
        self.assertFalse(splitter.buf)
        hearts = [msg for msg in parsed if msg is not None]
        self.assertEqual(len(hearts), 200)
        self.assertEqual(hearts[0].get_type(), "HEARTBEAT")
        self.assertTrue(obs_from_message(0, hearts[0])["armed"])
        self.assertLess(elapsed / 10000.0, 0.001)

    def test_tlog_flushes_about_once_a_second(self):
        import tlog_writer

        calls = []
        original = tlog_writer.os.fsync
        tlog_writer.os.fsync = lambda fd: calls.append(fd)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                writer = TlogWriter(tmp)
                clock = [1000.0]
                writer._now = lambda: clock[0]
                writer._last_flush = clock[0]
                frame = _mav2(30, b"\x11" * 28)
                for i in range(30):
                    writer.append(1_700_000_000.0 + i * 0.01, frame)
                self.assertEqual(calls, [])
                clock[0] = 1001.05
                writer.append(1_700_000_001.0, frame)
                self.assertEqual(len(calls), 1)
                writer.flush()
                records = list(iter_records(writer.segment))
                self.assertEqual(len(records), 31)
                writer.close()
        finally:
            tlog_writer.os.fsync = original

    def test_status_writes_at_most_once_per_second(self):
        service = FlightLogService()
        with tempfile.TemporaryDirectory() as tmp:
            service.status_file = Path(tmp) / "status.json"
            self.assertTrue(service.write_status(service.disabled_status("disabled"), force=True))
            self.assertFalse(service.write_status(service.disabled_status("disabled")))

    def test_hand_fixture_keeps_detector_fields(self):
        blob = b"".join(frame for _ts, frame in iter_records(FIX))
        rows = FrameSplitter().feed(blob)
        self.assertGreater(len(rows), 100)
        vfr = next(msg for _frame, msg in rows if msg is not None and msg.get_type() == "VFR_HUD")
        obs = obs_from_message(0, vfr)
        self.assertAlmostEqual(obs["airspeed"], 4.0, places=3)
        self.assertEqual(obs["sysid"], 1)

    def test_tick_cost_does_not_grow_with_tlog_size(self):
        import flight_logger
        import tlog_writer

        frame = _mav2(30, b"\x00" * 28)
        rec = pack_record(1_700_000_000.0, frame)
        blob = rec * ((50 * 1024 * 1024) // len(rec))
        self.assertGreaterEqual(len(blob), 50 * 1024 * 1024 - len(rec))
        calls = []
        original = tlog_writer.iter_records

        def wrapped(path):
            calls.append(str(path))
            return original(path)

        tlog_writer.iter_records = wrapped
        previous_disk = flight_logger.disk_free_mb
        flight_logger.disk_free_mb = lambda path: 100000
        try:
            with tempfile.TemporaryDirectory() as tmp:
                day = Path(tmp) / "tlog" / "20260926"
                day.mkdir(parents=True)
                (day / "120000Z.tlog").write_bytes(blob)
                writer = TlogWriter(tmp, quota_mb=4096, retention_days=30)
                logger = FlightLogger(tmp, "airvix-test", writer)
                costs = []
                base = 1_800_000_000.0
                for i in range(4):
                    t0 = time.perf_counter()
                    logger.tick(now=base + i)
                    costs.append((time.perf_counter() - t0) * 1000.0)
                writer.close()
        finally:
            tlog_writer.iter_records = original
            flight_logger.disk_free_mb = previous_disk
        self.assertEqual(calls, [])
        self.assertLess(max(costs), 5.0)

    def test_split_frame_survives_a_short_read(self):
        frame = _mav2(74, struct_vfr())
        splitter = FrameSplitter()
        self.assertEqual(splitter.feed(frame[:7]), [])
        got = splitter.feed(frame[7:])
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0][0], frame)
        self.assertEqual(got[0][1].get_type(), "VFR_HUD")
        self.assertIsNone(FrameSplitter().feed(_mav2(30, b"\x00" * 28))[0][1])


def struct_vfr():
    import struct

    return struct.pack("<ffffhH", 4.0, 1.0, 1.0, 0.0, 90, 0)


if __name__ == "__main__":
    unittest.main()
