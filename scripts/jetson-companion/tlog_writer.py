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
FLUSH_S = 1.0
FLUSH_BYTES = 64 * 1024
FSYNC_S = FLUSH_S
PRUNE_INTERVAL_S = 60.0
# Same floor as companion.disk_low. Prune is not an idle-path scan.
DISK_FREE_MIN_MB = 500.0


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
        self._seg_first = None
        self._seg_last = None
        self._span_cache = {}
        self._last_prune = 0.0
        self._pending = bytearray()
        self._last_flush = time.monotonic()
        self._now = time.monotonic
        self.segment = None
        self._lock = threading.Lock()

    def append(self, unix_s, frame):
        if not frame:
            return
        with self._lock:
            ts = float(unix_s)
            self._rotate(ts)
            if self._seg_first is None or ts < self._seg_first:
                self._seg_first = ts
            if self._seg_last is None or ts > self._seg_last:
                self._seg_last = ts
            self._pending.extend(pack_record(unix_s, frame))
            if (self._now() - self._last_flush) >= FLUSH_S or len(self._pending) >= FLUSH_BYTES:
                self._flush_locked()

    def flush(self):
        with self._lock:
            self._flush_locked()

    def _flush_locked(self):
        if self._fh is not None and self._pending:
            self._fh.write(self._pending)
            self._pending.clear()
        if self._fh is None:
            self._last_flush = self._now()
            return
        self._fh.flush()
        try:
            os.fsync(self._fh.fileno())
        except OSError:
            pass
        self._last_flush = self._now()

    def close(self):
        with self._lock:
            self._flush_locked()
            self._seal_span_locked()
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

    def prune_if_needed(self, now=None, disk_free_mb=None):
        """Prune at most every 60s, and only when the quota or disk floor requires it.

        Idle ticks must not read tlog bytes. Span checks stay on the cached
        first and last timestamps.
        """
        mono = self._now()
        if self._last_prune and (mono - self._last_prune) < PRUNE_INTERVAL_S:
            return False
        if not self._prune_required(disk_free_mb):
            return False
        self._last_prune = mono
        self.prune(now=now)
        return True

    def _prune_required(self, disk_free_mb):
        if disk_free_mb is not None and float(disk_free_mb) < DISK_FREE_MIN_MB:
            return True
        return self.quota_used_mb() + 1e-6 >= self.quota_mb

    def prune(self, now=None):
        """Drop old unprotected segments. Never delete a segment overlapping an open upload."""
        now = time.time() if now is None else now
        cutoff = now - self.retention_days * 86400.0
        files = self._segments()
        for path in files:
            span = self._span_of(path)
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
            span = self._span_of(path)
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
        self._seal_span_locked()
        if self._fh is not None:
            self._fh.close()
            self._fh = None
        self._seg_first = None
        self._seg_last = None
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
        self._last_flush = self._now()
        if path.stat().st_size > 0:
            span = self._span_of(path)
            if span is not None:
                self._seg_first, self._seg_last = span
                self._seg_start = span[0]

    def _seal_span_locked(self):
        if self._path is None or self._seg_first is None:
            return
        last = self._seg_last if self._seg_last is not None else self._seg_first
        span = (float(self._seg_first), float(last))
        path = Path(self._path)
        try:
            size = path.stat().st_size
        except OSError:
            size = None
        if size is not None:
            try:
                Path(str(path) + ".span").write_text("%s %s %s\n" % (span[0], span[1], int(size)))
            except OSError:
                pass
            try:
                st = path.stat()
                self._span_cache[str(path)] = (st.st_size, _mtime_ns(st), span)
            except OSError:
                pass

    def _span_of(self, path):
        """First and last record time. The open segment is tracked in memory."""
        path = Path(path)
        if (
            self._path is not None
            and self._seg_first is not None
            and path.resolve() == Path(self._path).resolve()
        ):
            last = self._seg_last if self._seg_last is not None else self._seg_first
            return (self._seg_first, last)
        try:
            st = path.stat()
        except OSError:
            return None
        key = str(path)
        mtime = _mtime_ns(st)
        cached = self._span_cache.get(key)
        if cached and cached[0] == st.st_size and cached[1] == mtime:
            return cached[2]
        span = _span_from_sidecar(path, st.st_size)
        if span is None:
            span = _segment_span(path)
        if span is None:
            return None
        self._span_cache[key] = (st.st_size, mtime, span)
        return span

    def _segments(self):
        return sorted(self.root.glob("*/*.tlog"))


def _mtime_ns(st):
    return getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))


def _span_from_sidecar(path, size):
    side = Path(str(path) + ".span")
    if not side.is_file():
        return None
    try:
        parts = side.read_text(encoding="utf-8").split()
        first = float(parts[0])
        last = float(parts[1])
        recorded = int(parts[2]) if len(parts) > 2 else None
    except Exception:
        return None
    if recorded is not None and recorded != int(size):
        return None
    return (first, last)


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
