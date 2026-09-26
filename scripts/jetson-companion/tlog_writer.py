# -*- coding: utf-8 -*-
"""Continuous standard tlog: 8-byte big-endian wall µs + raw MAVLink frame."""

from __future__ import print_function

import os
import struct
import threading
import time
from pathlib import Path

from flightlog_common import env_float, env_int

SEGMENT_S = 600.0
FSYNC_S = 5.0


def pack_record(unix_s, frame):
    usec = int(round(float(unix_s) * 1000000.0))
    if usec < 0:
        usec = 0
    return struct.pack(">Q", usec) + bytes(frame)


def iter_records(path):
    data = Path(path).read_bytes()
    i = 0
    n = len(data)
    while i + 8 <= n:
        usec = struct.unpack(">Q", data[i : i + 8])[0]
        i += 8
        if i >= n:
            break
        # MAVLink v2 frame length: 12 + payload + 2 crc, stx 0xFD, byte 1 is payload len.
        # v2: 10-byte header + payload + 2 crc, plus 13 when the signature bit is set.
        # v1: 6-byte header + payload + 2 crc.
        if data[i] == 0xFD and i + 1 < n:
            length = 12 + data[i + 1]
            if i + 2 < n and data[i + 2] & 0x01:
                length += 13
        elif data[i] == 0xFE and i + 1 < n:
            length = 8 + data[i + 1]
        else:
            break
        if i + length > n:
            break
        frame = data[i : i + length]
        i += length
        yield usec / 1000000.0, frame


class TlogWriter(object):
    def __init__(self, spool_dir, quota_mb=None, retention_days=None, protected_ranges=None):
        self.root = Path(spool_dir) / "tlog"
        self.root.mkdir(parents=True, exist_ok=True)
        self.quota_mb = float(quota_mb if quota_mb is not None else env_int("AIRVIX_FLIGHTLOG_TLOG_QUOTA_MB", 2048))
        self.retention_days = float(
            retention_days if retention_days is not None else env_float("AIRVIX_FLIGHTLOG_RETENTION_DAYS", 14)
        )
        self.protected_ranges = list(protected_ranges or [])
        self._fh = None
        self._path = None
        self._seg_start = None
        self._last_fsync = 0.0
        self.segment = None
        self._lock = threading.Lock()

    def append(self, unix_s, frame):
        if not frame:
            return
        with self._lock:
            self._rotate(float(unix_s))
            self._fh.write(pack_record(unix_s, frame))
            now = time.time()
            if now - self._last_fsync >= FSYNC_S:
                self._flush_locked()
                self._last_fsync = now

    def flush(self):
        with self._lock:
            self._flush_locked()

    def _flush_locked(self):
        if self._fh is None:
            return
        self._fh.flush()
        try:
            os.fsync(self._fh.fileno())
        except OSError:
            pass

    def close(self):
        with self._lock:
            self._flush_locked()
            if self._fh is not None:
                self._fh.close()
                self._fh = None

    def set_protected(self, ranges):
        self.protected_ranges = list(ranges or [])

    def slice(self, start_unix, end_unix, dest_path):
        dest = Path(dest_path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._flush_locked()
        with open(dest, "wb") as out:
            for path in self._segments():
                try:
                    for ts, frame in iter_records(path):
                        if ts + 1e-6 < start_unix:
                            continue
                        if ts - 1e-6 > end_unix:
                            continue
                        out.write(pack_record(ts, frame))
                except Exception:
                    continue
        return dest

    def quota_used_mb(self):
        total = 0
        for path in self._segments():
            try:
                total += path.stat().st_size
            except OSError:
                pass
        return total / (1024.0 * 1024.0)

    def prune(self, now=None):
        """Drop old unprotected segments. Never delete a segment overlapping an open upload."""
        now = time.time() if now is None else now
        cutoff = now - self.retention_days * 86400.0
        files = self._segments()
        for path in files:
            span = _segment_span(path)
            if span is None:
                continue
            if _overlaps(span, self.protected_ranges):
                continue
            if span[1] < cutoff:
                try:
                    path.unlink()
                except OSError:
                    pass
        files = self._segments()
        used = sum(path.stat().st_size for path in files)
        limit = self.quota_mb * 1024.0 * 1024.0
        if used <= limit:
            return
        for path in files:
            if used <= limit:
                break
            span = _segment_span(path)
            if span is not None and _overlaps(span, self.protected_ranges):
                continue
            if self._path is not None and path.resolve() == Path(self._path).resolve():
                continue
            try:
                size = path.stat().st_size
                path.unlink()
                used -= size
            except OSError:
                pass

    def _rotate(self, unix_s):
        if self._fh is not None and self._seg_start is not None and (unix_s - self._seg_start) < SEGMENT_S:
            return
        self._flush_locked()
        if self._fh is not None:
            self._fh.close()
            self._fh = None
        import datetime

        dt = datetime.datetime.fromtimestamp(unix_s, datetime.timezone.utc)
        folder = self.root / dt.strftime("%Y%m%d")
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / (dt.strftime("%H%M%SZ") + ".tlog")
        # Same-second restart appends instead of truncating a live segment.
        self._fh = open(path, "ab")
        self._path = path
        self._seg_start = unix_s
        self.segment = str(path)
        self._last_fsync = time.time()

    def _segments(self):
        return sorted(self.root.glob("*/*.tlog"))


def _segment_span(path):
    try:
        first = None
        last = None
        for ts, _frame in iter_records(path):
            if first is None:
                first = ts
            last = ts
        if first is None:
            st = path.stat()
            return (st.st_mtime - SEGMENT_S, st.st_mtime)
        return (first, last)
    except Exception:
        return None


def _overlaps(span, ranges):
    for start, end in ranges:
        if start is None or end is None:
            continue
        if span[0] <= end and span[1] >= start:
            return True
    return False
