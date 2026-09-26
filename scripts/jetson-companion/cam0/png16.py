"""16-bit grayscale PNG. Stdlib only."""

from __future__ import annotations

import struct
import zlib

import numpy as np


def _chunk(tag, data):
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)


def encode_png16(u16):
    """Return PNG bytes for a (H, W) uint16 image, big-endian samples."""
    img = np.asarray(u16, dtype=np.uint16)
    if img.ndim != 2:
        raise ValueError("png16 expects a 2D image")
    h, w = img.shape
    ihdr = struct.pack(">IIBBBBB", int(w), int(h), 16, 0, 0, 0, 0)
    be = img.astype(">u2")
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += be[y].tobytes()
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + _chunk(b"IEND", b"")
    )
