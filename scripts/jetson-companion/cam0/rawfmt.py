"""OV9281 / tegra mono sample layout.

The sensor is mono. nv_ov9281 labels the pixels RG10 (a Bayer fourcc). Y10
is the same 10-bit sample when a driver accepts it. Neither path is debayered.
Each sample is a 16-bit little-endian word, left-justified:

  container12 = uint16 >> 4     # 0..4095
  code10      = uint16 >> 6     # 0..1023, the significant 10 bits
  mono8       = uint16 >> 8     # preview byte, top of the left-justified word

A stored word of ``value << 4`` round-trips through ``>> 4``.
"""

from __future__ import annotations

import numpy as np

WIDTH = 1280
HEIGHT = 800
CODE10_MAX = 1023
CONTAINER12_MAX = 4095


def as_u16(buf, width, height):
    """View or copy a 16-bit little-endian buffer as (height, width) uint16."""
    arr = np.asarray(buf)
    if arr.dtype == np.uint16 and arr.shape == (height, width):
        return arr
    flat = np.frombuffer(np.ascontiguousarray(arr).view(np.uint8) if arr.dtype != np.uint8 else np.ascontiguousarray(arr), dtype="<u2")
    need = int(width) * int(height)
    if flat.size < need:
        raise ValueError(f"short raw buffer {flat.size} < {need}")
    return flat[:need].reshape((int(height), int(width)))


def to_container12(raw_u16):
    return (np.asarray(raw_u16, dtype=np.uint16) >> np.uint16(4)).astype(np.uint16)


def to_code10(raw_u16):
    return (np.asarray(raw_u16, dtype=np.uint16) >> np.uint16(6)).astype(np.uint16)


def to_mono8(raw_u16):
    return (np.asarray(raw_u16, dtype=np.uint16) >> np.uint16(8)).astype(np.uint8)


def pack_code10(code10):
    """Left-justify a 10-bit code into the 16-bit container (code << 6)."""
    c = np.asarray(code10, dtype=np.uint16)
    return (np.clip(c, 0, CODE10_MAX).astype(np.uint16) << np.uint16(6)).astype(np.uint16)


def mean_and_percentile(code10, percentile=90.0):
    """Return (mean, percentile) in 0..1 of the 10-bit full scale."""
    c = np.asarray(code10, dtype=np.float64)
    if c.size == 0:
        return 0.0, 0.0
    mean = float(c.mean() / CODE10_MAX)
    pct = float(np.percentile(c, percentile) / CODE10_MAX)
    return mean, pct
