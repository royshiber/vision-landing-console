# -*- coding: utf-8 -*-
"""Standard tlog big-endian timestamps and retention."""

from __future__ import print_function

import struct
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tlog_writer import TlogWriter, iter_records, pack_record  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures"


class TlogTests(unittest.TestCase):
    def test_big_endian_round_trip(self):
        from pymavlink import mavutil

        raw = (FIX / "hand.tlog").read_bytes()
        usec = struct.unpack(">Q", raw[:8])[0]
        _ts, frame = next(iter_records(FIX / "hand.tlog"))
        blob = pack_record(usec / 1e6, frame)
        self.assertEqual(blob[:8], struct.pack(">Q", usec))
        # A little-endian header is not the standard tlog timestamp.
        self.assertNotEqual(struct.unpack("<Q", blob[:8])[0], usec)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "one.tlog"
            path.write_bytes(blob)
            mlog = mavutil.mavlink_connection(str(path))
            msg = mlog.recv_match(blocking=False)
            self.assertIsNotNone(msg)
            self.assertAlmostEqual(msg._timestamp, usec / 1e6, places=3)

    def test_retention_keeps_protected_flight_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            writer = TlogWriter(tmp, quota_mb=1, retention_days=1)
            old = 1_000_000.0
            writer.append(old, b"\xfd\x00" + b"\x00" * 20)
            writer.flush()
            writer.close()
            files = list(Path(tmp).glob("tlog/*/*.tlog"))
            self.assertEqual(len(files), 1)
            writer.protected_ranges = [(old - 10, old + 10)]
            writer.prune(now=old + 40 * 86400)
            self.assertTrue(files[0].is_file())
            writer.protected_ranges = []
            writer.prune(now=old + 40 * 86400)
            self.assertFalse(files[0].is_file())


if __name__ == "__main__":
    unittest.main()
