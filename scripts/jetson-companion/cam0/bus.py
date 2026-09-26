"""Shared-memory frame bus.

A publisher writes the newest frame into a ring. Subscribers only ever read
the latest slot, so a slow module skips frames and cannot stall capture.
The header layout is plain integers so a C++ mapper can attach without
copying pixels.

Magic ``CAM0BUS1`` at offset 0.
"""

from __future__ import annotations

import json
import struct
import threading
import time
from multiprocessing import shared_memory

MAGIC = b"CAM0BUS1"
HEADER_FMT = "<8sIIIIIIIIIQQ"
HEADER_SIZE = 4096
META_CAP = 2048


def _slot_size(width, height, keep_u16):
    mono = int(width) * int(height)
    proc = mono * 2 if keep_u16 else 0
    return 8 + 4 + 4 + 4 + META_CAP + mono + proc


class FrameView:
    """A view of one published slot. Arrays alias shared memory."""

    def __init__(self, seq, meta, mono8, code10):
        self.seq = int(seq)
        self.meta = meta
        self.mono8 = mono8
        self.code10 = code10

    @property
    def index(self):
        return self.meta.get("index")

    @property
    def width(self):
        return int(self.meta.get("width") or (0 if self.mono8 is None else self.mono8.shape[1]))

    @property
    def height(self):
        return int(self.meta.get("height") or (0 if self.mono8 is None else self.mono8.shape[0]))


class FrameBus:
    def __init__(self, name="cam0-bus", width=64, height=64, slots=3, keep_u16=True, create=True):
        self.name = name
        self.width = int(width)
        self.height = int(height)
        self.slots = int(slots)
        self.keep_u16 = bool(keep_u16)
        self._slot_bytes = _slot_size(self.width, self.height, self.keep_u16)
        self._nbytes = HEADER_SIZE + self.slots * self._slot_bytes
        self._shm = None
        self._buf = None
        self._lock = threading.Lock()
        self._local_seq = 0
        if create:
            self._create()

    def _create(self):
        try:
            stale = shared_memory.SharedMemory(name=self.name)
            stale.close()
            stale.unlink()
        except FileNotFoundError:
            pass
        except Exception:
            pass
        self._shm = shared_memory.SharedMemory(name=self.name, create=True, size=self._nbytes)
        self._buf = self._shm.buf
        self._write_header(0)

    def _write_header(self, seq):
        flags = 1 if self.keep_u16 else 0
        blob = struct.pack(
            HEADER_FMT,
            MAGIC,
            1,
            self.width,
            self.height,
            self.width,
            self.width * 2 if self.keep_u16 else 0,
            self.slots,
            self._slot_bytes,
            flags,
            META_CAP,
            int(seq),
            0,
        )
        self._buf[:len(blob)] = blob

    def attach(self):
        self._shm = shared_memory.SharedMemory(name=self.name, create=False)
        self._buf = self._shm.buf
        return self

    def close(self):
        shm = self._shm
        self._shm = None
        self._buf = None
        if shm is not None:
            try:
                shm.close()
            except Exception:
                pass

    def unlink(self):
        name = self.name
        self.close()
        try:
            shm = shared_memory.SharedMemory(name=name)
            shm.close()
            shm.unlink()
        except FileNotFoundError:
            pass
        except Exception:
            pass

    def _slot_off(self, index):
        return HEADER_SIZE + (int(index) % self.slots) * self._slot_bytes

    def publish(self, mono8, meta, code10=None):
        import numpy as np
        mono = np.ascontiguousarray(mono8, dtype=np.uint8)
        if mono.shape != (self.height, self.width):
            raise ValueError(f"mono shape {mono.shape} != {(self.height, self.width)}")
        with self._lock:
            self._local_seq += 1
            seq = self._local_seq
            slot = (seq - 1) % self.slots
            off = self._slot_off(slot)
            body = dict(meta or {})
            body["seq"] = seq
            body["width"] = self.width
            body["height"] = self.height
            raw = json.dumps(body, separators=(",", ":")).encode("utf-8")[:META_CAP]
            struct.pack_into("<QIII", self._buf, off, seq, len(raw), mono.nbytes, 0 if code10 is None else int(code10.nbytes))
            meta_off = off + 20
            self._buf[meta_off:meta_off + META_CAP] = b"\x00" * META_CAP
            self._buf[meta_off:meta_off + len(raw)] = raw
            pix_off = meta_off + META_CAP
            self._buf[pix_off:pix_off + mono.nbytes] = mono.tobytes()
            if self.keep_u16 and code10 is not None:
                proc = np.ascontiguousarray(code10, dtype=np.uint16)
                self._buf[pix_off + mono.nbytes:pix_off + mono.nbytes + proc.nbytes] = proc.tobytes()
            struct.pack_into("<Q", self._buf, struct.calcsize(HEADER_FMT) - 16, seq)
            return seq

    def latest_seq(self):
        if self._buf is None:
            return 0
        return struct.unpack_from("<Q", self._buf, struct.calcsize(HEADER_FMT) - 16)[0]

    def read_seq(self, seq):
        import numpy as np
        if seq <= 0 or self._buf is None:
            return None
        slot = (int(seq) - 1) % self.slots
        off = self._slot_off(slot)
        got, meta_len, mono_len, proc_len = struct.unpack_from("<QIII", self._buf, off)
        if int(got) != int(seq) or meta_len <= 0 or meta_len > META_CAP:
            return None
        meta_off = off + 20
        meta = json.loads(bytes(self._buf[meta_off:meta_off + meta_len]).decode("utf-8"))
        pix_off = meta_off + META_CAP
        mono = np.frombuffer(self._buf[pix_off:pix_off + mono_len], dtype=np.uint8).reshape(self.height, self.width)
        code = None
        if proc_len:
            code = np.frombuffer(self._buf[pix_off + mono_len:pix_off + mono_len + proc_len], dtype=np.uint16).reshape(self.height, self.width)
        return FrameView(seq, meta, mono, code)

    def latest(self):
        return self.read_seq(self.latest_seq())

    def subscribe(self):
        return Subscription(self)


class Subscription:
    def __init__(self, bus):
        self.bus = bus
        self.last = 0
        self.dropped = 0

    def poll(self):
        seq = self.bus.latest_seq()
        if seq <= self.last:
            return None
        skipped = seq - self.last - 1
        if skipped > 0:
            self.dropped += skipped
        self.last = seq
        return self.bus.read_seq(seq)

    def wait(self, timeout=0.5):
        end = time.monotonic() + float(timeout)
        while True:
            view = self.poll()
            if view is not None:
                return view
            if time.monotonic() >= end:
                return None
            time.sleep(0.002)
