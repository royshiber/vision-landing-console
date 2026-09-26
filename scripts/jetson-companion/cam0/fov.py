"""Field of view in degrees. Nominal intrinsics come from this, not a fixed focal length."""

from __future__ import annotations

import math

FOV_MIN = 20.0
FOV_MAX = 180.0
FOV_DEFAULTS = {"cam0": 120.0, "cam1": 79.0}


def parse_fov(value):
    try:
        fov = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(fov) or fov < FOV_MIN or fov > FOV_MAX:
        return None
    return fov


def intrinsics_from_fov(width, height, fov_deg):
    """Horizontal FOV, square pixels. 180 degrees stays a finite focal length."""
    fov = parse_fov(fov_deg)
    try:
        w = float(width)
        h = float(height)
    except (TypeError, ValueError):
        return None
    if fov is None or w <= 0 or h <= 0:
        return None
    limited = min(fov, 179.999)
    half = math.radians(limited) / 2.0
    fx = (w / 2.0) / math.tan(half)
    if not math.isfinite(fx) or fx <= 0:
        return None
    return {
        "fx": fx,
        "fy": fx,
        "cx": (w - 1.0) / 2.0,
        "cy": (h - 1.0) / 2.0,
        "fov_deg": fov,
    }
