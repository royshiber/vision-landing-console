"""Apply camera controls, then report the device read-back.

Field of view is stored for distance. It is not a v4l2 or libcamera control.
A missing camera never counts as applied.
"""

from __future__ import annotations


def _int_or_none(value):
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _row(requested, actual, applied, **extra):
    out = {"requested": requested, "actual": actual, "applied": bool(applied)}
    for key, value in extra.items():
        if value is not None:
            out[key] = value
    return out


def _match(requested, actual):
    if requested is None or actual is None:
        return False
    return int(requested) == int(actual)


def commit_controls(source, spec):
    """Write spec onto source, then compare read_controls().

    spec keys: ae_enabled, exposure_us, gain, width, height, fps, fov_deg.
    While auto exposure is on, exposure and gain are not written.
    """
    spec = spec or {}
    ae = spec.get("ae_enabled")
    if ae is None and isinstance(spec.get("ae"), dict):
        ae = spec["ae"].get("enabled")
    exposure = _int_or_none(spec.get("exposure_us"))
    gain = _int_or_none(spec.get("gain"))
    width = _int_or_none(spec.get("width"))
    height = _int_or_none(spec.get("height"))
    fps = _int_or_none(spec.get("fps"))
    fov = spec.get("fov_deg")

    wrote_ae = None
    if ae is not None and source is not None and hasattr(source, "set_auto_exposure"):
        try:
            wrote = source.set_auto_exposure(bool(ae))
            wrote_ae = None if wrote is None else bool(wrote)
        except Exception:
            wrote_ae = False

    wrote_exp = None
    if (
        ae is not True
        and source is not None
        and hasattr(source, "set_exposure_gain")
        and (exposure is not None or gain is not None)
    ):
        try:
            wrote_exp = bool(source.set_exposure_gain(
                int(exposure if exposure is not None else getattr(source, "exposure_us", 2000)),
                int(gain if gain is not None else getattr(source, "gain", 16)),
                fps=fps or getattr(source, "fps", None),
            ))
        except Exception:
            wrote_exp = False

    wrote_fmt = None
    if source is not None and hasattr(source, "configure") and any(v is not None for v in (width, height, fps)):
        try:
            wrote_fmt = bool(source.configure(
                int(width if width is not None else getattr(source, "width", 1280)),
                int(height if height is not None else getattr(source, "height", 800)),
                int(fps if fps is not None else getattr(source, "fps", 30)),
            ))
        except Exception:
            wrote_fmt = False

    actual = {}
    if source is not None and hasattr(source, "read_controls"):
        try:
            got = source.read_controls() or {}
            if isinstance(got, dict):
                actual = got
        except Exception:
            actual = {}

    def hardware(key, requested, wrote):
        act = actual.get(key)
        if source is None:
            return _row(requested, None, False)
        if wrote is False and act is None:
            return _row(requested, None, False)
        return _row(requested, act, _match(requested, act))

    controls = {}
    if ae is not None:
        act_ae = actual.get("ae_enabled")
        if source is None:
            controls["ae"] = _row(bool(ae), None, False)
        elif wrote_ae is None and act_ae is None:
            controls["ae"] = _row(bool(ae), bool(ae), True, software=True)
        else:
            if act_ae is None and wrote_ae is True:
                act_ae = bool(ae)
            applied = act_ae is not None and bool(act_ae) is bool(ae)
            controls["ae"] = _row(bool(ae), None if act_ae is None else bool(act_ae), applied)

    if ae is True:
        controls["exposure_us"] = _row(exposure, actual.get("exposure_us"), False, skipped=True)
        controls["gain"] = _row(gain, actual.get("gain"), False, skipped=True)
    else:
        if exposure is not None:
            controls["exposure_us"] = hardware("exposure_us", exposure, wrote_exp)
        if gain is not None:
            controls["gain"] = hardware("gain", gain, wrote_exp)

    if width is not None:
        controls["width"] = hardware("width", width, wrote_fmt)
    if height is not None:
        controls["height"] = hardware("height", height, wrote_fmt)
    if fps is not None:
        controls["fps"] = hardware("fps", fps, wrote_fmt)

    if fov is not None:
        try:
            fov_n = float(fov)
        except (TypeError, ValueError):
            fov_n = None
        controls["fov_deg"] = _row(fov_n, fov_n, fov_n is not None, metadata_only=True)
    return controls
