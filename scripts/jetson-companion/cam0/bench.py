#!/usr/bin/env python3
"""Capture-rate bench for Cam0. Run on the Jetson, not in CI.

  python3 -m cam0.bench --seconds 5 --device /dev/video0

Prints one JSON object: capture_fps, stages_ms (dqbuf, convert, stats, jpeg),
cpu_percent, and the exposure and gain applied (software and driver).
If another process holds the camera, prints a busy error and exits nonzero.
Stop airvix-companion first so this process can open /dev/video0.
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import time

from .jpegenc import JpegWorker
from .rawfmt import frame_stats
from .v4l2cap import V4l2Source, describe_capture_error, device_busy_message


def main(argv=None):
    parser = argparse.ArgumentParser(description="Cam0 capture bench")
    parser.add_argument("--device", default=os.environ.get("VLC_CAM0_DEVICE", "/dev/video0"))
    parser.add_argument("--seconds", type=float, default=3.0)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=800)
    parser.add_argument("--fps", type=int, default=60)
    parser.add_argument("--exposure-us", type=int, default=2000)
    parser.add_argument("--gain", type=int, default=16)
    args = parser.parse_args(argv)
    if not os.path.exists(args.device):
        print(json.dumps({"ok": False, "error": f"device absent: {args.device}"}))
        return 2
    src = V4l2Source(args.device, width=args.width, height=args.height, fps=args.fps)
    encoder = JpegWorker()
    encoder.start()
    usage0 = resource.getrusage(resource.RUSAGE_SELF)
    t0 = time.perf_counter()
    frames = 0
    sums = {"dqbuf": 0.0, "convert": 0.0, "stats": 0.0}
    try:
        src.open()
        src.set_exposure_gain(args.exposure_us, args.gain, fps=args.fps)
        while time.perf_counter() - t0 < args.seconds:
            frame = src.read()
            frames += 1
            ts = time.perf_counter()
            frame_stats(frame, 90)
            sums["stats"] += (time.perf_counter() - ts) * 1000.0
            stages = frame.get("stages_ms") or {}
            sums["dqbuf"] += float(stages.get("dqbuf") or 0.0)
            sums["convert"] += float(stages.get("convert") or 0.0)
            if frames == 1 or frames % 4 == 0:
                encoder.submit(frame["mono8"], quality=55, max_width=640)
    except Exception as exc:
        busy = device_busy_message(exc)
        print(json.dumps({"ok": False, "error": busy or describe_capture_error(exc)}))
        return 1
    finally:
        encoder.stop()
        try:
            src.close()
        except Exception:
            pass
    wall = max(1e-6, time.perf_counter() - t0)
    usage1 = resource.getrusage(resource.RUSAGE_SELF)
    cpu = ((usage1.ru_utime - usage0.ru_utime) + (usage1.ru_stime - usage0.ru_stime)) / wall * 100.0
    n = max(1, frames)
    print(json.dumps({
        "ok": frames > 0,
        "frames": frames,
        "capture_fps": round(frames / wall, 2),
        "stages_ms": {
            "dqbuf": round(sums["dqbuf"] / n, 3),
            "convert": round(sums["convert"] / n, 3),
            "stats": round(sums["stats"] / n, 3),
            "jpeg": encoder.stage_ms,
        },
        "cpu_percent": round(cpu, 1),
        "exposure_us": src.exposure_us,
        "gain": src.gain,
        "exposure_driver": src.exposure_driver,
        "exposure_unit": src.exposure_unit,
        "gain_driver": src.gain_driver,
        "width": args.width,
        "height": args.height,
    }))
    return 0 if frames > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
