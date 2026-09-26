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
    src = np.asarray(raw_u16)
    if src.dtype != np.uint16:
        src = src.astype(np.uint16, copy=False)
    return src >> np.uint16(6)


def to_mono8(raw_u16):
    """Top byte of each left-justified little-endian sample. No debayer."""
    src = np.asarray(raw_u16)
    if src.dtype != np.uint16:
        src = np.asarray(src, dtype=np.uint16)
    src = np.ascontiguousarray(src)
    if sys_le():
        paired = src.view(np.uint8).reshape(src.shape + (2,))
        return np.ascontiguousarray(paired[..., 1])
    return (src >> np.uint16(8)).astype(np.uint8)


def sys_le():
    return np.little_endian


def pack_code10(code10):
    """Left-justify a 10-bit code into the 16-bit container (code << 6)."""
    c = np.asarray(code10, dtype=np.uint16)
    return (np.clip(c, 0, CODE10_MAX).astype(np.uint16) << np.uint16(6)).astype(np.uint16)


def mean_and_percentile(code10, percentile=90.0, step=None):
    """Return (mean, percentile) in 0..1 of the 10-bit full scale.

    Large frames are subsampled. AE only needs the level, not every pixel.
    """
    c = np.asarray(code10)
    if c.size == 0:
        return 0.0, 0.0
    if step is None:
        step = 16 if c.size > 20000 else 1
    if step > 1 and getattr(c, "ndim", 1) == 2 and c.shape[0] > step and c.shape[1] > step:
        c = c[::int(step), ::int(step)]
    values = c.astype(np.float64, copy=False)
    mean = float(values.mean() / CODE10_MAX)
    pct = float(np.percentile(values, percentile) / CODE10_MAX)
    return mean, pct


def stats_raw(raw_u16, percentile=90.0, step=16):
    """10-bit stats from a strided raw frame. Does not convert the full image."""
    arr = np.asarray(raw_u16)
    if arr.ndim == 2 and step > 1 and arr.shape[0] > step and arr.shape[1] > step:
        arr = arr[::int(step), ::int(step)]
    return mean_and_percentile(to_code10(arr), percentile, step=1)


def frame_stats(frame, percentile=90.0):
    raw = None if not isinstance(frame, dict) else frame.get("raw_u16")
    if raw is not None:
        return stats_raw(raw, percentile)
    return mean_and_percentile(None if not isinstance(frame, dict) else frame.get("code10"), percentile)
