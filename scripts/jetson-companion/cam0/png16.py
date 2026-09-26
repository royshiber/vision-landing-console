"""16-bit grayscale PNG.

cv2.imencode is used when OpenCV imports (it releases the GIL). The stdlib
encoder is the fallback. The cv2 import is the same cached result as JPEG.
"""

from __future__ import annotations

import struct
import zlib

import numpy as np

from .jpegenc import cv2_module


def _chunk(tag, data):
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)


def encode_png16(u16):
    """Return PNG bytes for a (H, W) uint16 image."""
    img = np.asarray(u16, dtype=np.uint16)
    if img.ndim != 2:
        raise ValueError("png16 expects a 2D image")
    cv2 = cv2_module()
    if cv2 is not None:
        try:
            level = int(getattr(cv2, "IMWRITE_PNG_COMPRESSION", 16))
            ok, buf = cv2.imencode(".png", np.ascontiguousarray(img), [level, 3])
            if ok and buf is not None:
                return buf.tobytes()
        except Exception:
            pass
    return _encode_png16_numpy(img)


def _encode_png16_numpy(img):
    """Stdlib PNG. Big-endian samples. Holds the GIL while it packs rows."""
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
