"""Auto exposure / gain. Prefers a short exposure so a moving aircraft blurs less.

Anti-flicker: once the exposure is at least one mains quantum, it snaps to a
multiple of that quantum. Below one quantum the exposure stays short.
A deadband stops the loop from chattering around the target.
"""

from __future__ import annotations

from dataclasses import dataclass, field


def _clamp(value, lo, hi):
    return max(lo, min(hi, value))


@dataclass
class AeLimits:
    exposure_us_min: int = 10
    exposure_us_max: int = 100001
    prefer_exposure_us_max: int = 4000
    gain_min: int = 16
    gain_max: int = 256
    flicker_quantum_us: int = 10000


@dataclass
class AeConfig:
    enabled: bool = True
    target_mean: float = 0.42
    target_percentile: float = 0.78
    percentile: float = 90.0
    hysteresis: float = 0.035
    limits: AeLimits = field(default_factory=AeLimits)


@dataclass
class AeState:
    enabled: bool = True
    exposure_us: int = 2000
    gain: int = 16
    mean: float | None = None
    percentile: float | None = None
    last_error: float | None = None
    settled: bool = False
    manual: bool = False


class AutoExposure:
    """Short exposure first. Gain absorbs brightness before the shutter opens.

    Exposure never passes prefer_exposure_us_max, and never passes the frame
    time 1e6/fps. A 100 ms shutter would cap the sensor below 30 fps.
    """

    def __init__(self, config=None, exposure_us=2000, gain=16):
        self.config = config or AeConfig()
        lim = self.config.limits
        self.state = AeState(
            enabled=bool(self.config.enabled),
            exposure_us=int(_clamp(exposure_us, lim.exposure_us_min, lim.exposure_us_max)),
            gain=int(_clamp(gain, lim.gain_min, lim.gain_max)),
        )

    def set_manual(self, exposure_us=None, gain=None):
        lim = self.config.limits
        self.state.enabled = False
        self.state.manual = True
        if exposure_us is not None:
            self.state.exposure_us = int(_clamp(int(exposure_us), lim.exposure_us_min, lim.exposure_us_max))
        if gain is not None:
            self.state.gain = int(_clamp(int(gain), lim.gain_min, lim.gain_max))
        self.state.settled = True
        return self.snapshot()

    def set_enabled(self, enabled):
        self.state.enabled = bool(enabled)
        self.state.manual = not bool(enabled)
        self.config.enabled = bool(enabled)
        return self.snapshot()

    def _snap_exposure(self, exposure):
        lim = self.config.limits
        exposure = int(_clamp(int(round(exposure)), lim.exposure_us_min, lim.exposure_us_max))
        quantum = int(lim.flicker_quantum_us or 0)
        if quantum > 0 and exposure >= quantum:
            steps = max(1, int(round(exposure / quantum)))
            exposure = int(_clamp(steps * quantum, lim.exposure_us_min, lim.exposure_us_max))
        return exposure

    def exposure_cap_us(self, fps=None):
        lim = self.config.limits
        cap = int(lim.prefer_exposure_us_max)
        if fps:
            cap = min(cap, int(1_000_000 / max(1, int(fps))))
        cap = min(cap, int(lim.exposure_us_max))
        return max(int(lim.exposure_us_min), cap)

    def update(self, mean, percentile, fps=None):
        """mean and percentile are 0..1 of the 10-bit full scale."""
        self.state.mean = None if mean is None else float(mean)
        self.state.percentile = None if percentile is None else float(percentile)
        if not self.state.enabled or mean is None:
            return self.snapshot()
        target = float(self.config.target_mean)
        err = target - float(mean)
        pct = float(percentile) if percentile is not None else float(mean)
        if pct > float(self.config.target_percentile):
            err = min(err, float(self.config.target_percentile) - pct)
        self.state.last_error = err
        if abs(err) <= float(self.config.hysteresis):
            self.state.settled = True
            return self.snapshot()
        self.state.settled = False
        lim = self.config.limits
        cap = self.exposure_cap_us(fps)
        # Percentile only widens the deadband above. The step follows the mean,
        # so a bright marker does not pin the shutter shut.
        hold = float(min(max(int(self.state.exposure_us), int(lim.exposure_us_min)), cap))
        ratio = _clamp(target / max(0.02, float(mean)), 0.5, 1.8)
        desired = max(1.0, hold * float(self.state.gain) * ratio)
        gain = desired / hold
        if gain > lim.gain_max:
            gain = float(lim.gain_max)
            exposure = desired / gain
        elif gain < lim.gain_min:
            gain = float(lim.gain_min)
            exposure = desired / gain
        else:
            exposure = hold
        exposure = _clamp(exposure, lim.exposure_us_min, cap)
        snapped = min(self._snap_exposure(exposure), cap)
        self.state.exposure_us = int(snapped)
        self.state.gain = int(_clamp(int(round(gain)), lim.gain_min, lim.gain_max))
        return self.snapshot()

    def snapshot(self):
        s = self.state
        return {
            "enabled": s.enabled,
            "manual": s.manual,
            "exposure_us": s.exposure_us,
            "gain": s.gain,
            "gain_x": round(s.gain / 16.0, 3),
            "mean": None if s.mean is None else round(s.mean, 4),
            "percentile": None if s.percentile is None else round(s.percentile, 4),
            "error": None if s.last_error is None else round(s.last_error, 4),
            "settled": s.settled,
            "target_mean": self.config.target_mean,
            "prefer_exposure_us_max": self.config.limits.prefer_exposure_us_max,
            "exposure_cap_us": self.exposure_cap_us(),
        }
