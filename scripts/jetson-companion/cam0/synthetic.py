"""Synthetic OV9281 source.

Pixels are 16-bit little-endian, left-justified 10-bit codes (value << 6,
which is the same as a 12-bit container stored as value12 << 4 when the
10-bit code sits in the top of that container).

The scene is a fixed radiance. Applied exposure and gain scale it, so the
auto-exposure loop has something real to converge on. A marker is drawn
after the scale so detection does not depend on exposure.
"""

from __future__ import annotations

import time

import numpy as np

from .marker import render_marker
from .rawfmt import pack_code10, to_code10, to_mono8

DEFAULT_W = 160
DEFAULT_H = 100


class SyntheticSource:
    def __init__(self, width=DEFAULT_W, height=DEFAULT_H, fps=20, marker_id=7, marker_px=48):
        self.width = int(width)
        self.height = int(height)
        self.fps = float(fps)
        self.marker_id = int(marker_id)
        self.marker_px = int(marker_px)
        self.exposure_us = 200
        self.gain = 16
        self.index = 0
        self.dropped = 0
        self._period = 1.0 / max(1.0, self.fps)
        self._next = time.monotonic()
        yy, xx = np.mgrid[0:self.height, 0:self.width]
        # Reference code at 2000 us and gain 32 is a mid tone (~430/1023).
        shade = 280 + (xx.astype(np.float64) / max(1, self.width - 1)) * 220
        self._radiance = shade.astype(np.float64)
        self.real = False
        self.source = "synthetic"

    def set_exposure_gain(self, exposure_us, gain):
        self.exposure_us = int(exposure_us)
        self.gain = int(gain)

    def _compose(self):
        scale = (float(self.exposure_us) / 2000.0) * (float(self.gain) / 32.0)
        code = np.clip(self._radiance * scale, 0, 1023).astype(np.uint16)
        mark = render_marker(self.marker_id, modules=max(2, self.marker_px // 6))
        mh, mw = mark.shape
        pad = 4
        plate = np.full((mh + pad * 2, mw + pad * 2), 255, dtype=np.uint8)
        plate[pad:pad + mh, pad:pad + mw] = mark
        ph, pw = plate.shape
        y0 = max(0, (self.height - ph) // 2)
        x0 = max(0, (self.width - pw) // 2)
        y1 = min(self.height, y0 + ph)
        x1 = min(self.width, x0 + pw)
        patch = plate[:y1 - y0, :x1 - x0]
        # A white margin keeps the black border off a dark exposure.
        region = np.where(patch > 128, np.uint16(900), np.uint16(20)).astype(np.uint16)
        code[y0:y1, x0:x1] = region
        raw = pack_code10(code)
        self.marker_origin = (x0, y0, x1, y1)
        return raw, code

    def read(self):
        now = time.monotonic()
        if now < self._next:
            time.sleep(self._next - now)
        self._next = time.monotonic() + self._period
        raw, code = self._compose()
        self.index += 1
        mono_ns = time.monotonic_ns()
        utc_ns = time.time_ns()
        return {
            "index": self.index,
            "t_monotonic_ns": mono_ns,
            "t_utc_ns": utc_ns,
            "width": self.width,
            "height": self.height,
            "raw_u16": raw,
            "code10": code,
            "mono8": to_mono8(raw),
            "exposure_us": self.exposure_us,
            "gain": self.gain,
            "dropped": self.dropped,
            "source": self.source,
            "real": False,
            "temperature_c": None,
        }


def roundtrip_sample():
    """One 1280x800 frame in the device sample layout, without keeping it live."""
    code = np.full((800, 1280), 512, dtype=np.uint16)
    raw = pack_code10(code)
    back = to_code10(raw)
    return raw, back
