#!/usr/bin/env python3
"""Hardware check for Cam0 on the Jetson. Run on the device, not in CI.

It does not arm, does not write flight-controller parameters, and does not
send a MAVLink command.

  cd ~/vlc-companion
  python3 -m cam0.verify_hardware
  python3 -m cam0.verify_hardware --print-marker 7 --marker-px 400

Checks:
  1. /dev/video0 opens after sensor_mode=0,bypass_mode=0
  2. frames arrive and the drop counter is reported
  3. auto exposure moves toward the target
  4. the companion stream answers on 127.0.0.1:8081 when the agent is up
  5. a printed marker from --print-marker is detected, with latency
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.request

from .ae import AutoExposure
from .marker import detect, render_marker
from .png16 import encode_png16
from .rawfmt import frame_stats, pack_code10


def _get(url, token):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=3) as res:
            return res.status, res.read()
    except Exception as exc:
        return None, str(exc).encode()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Cam0 hardware verify")
    parser.add_argument("--device", default=os.environ.get("VLC_CAM0_DEVICE", "/dev/video0"))
    parser.add_argument("--seconds", type=float, default=4.0)
    parser.add_argument("--base", default="http://127.0.0.1:8081")
    parser.add_argument("--print-marker", type=int, default=None)
    parser.add_argument("--marker-px", type=int, default=400)
    args = parser.parse_args(argv)
    token = os.environ.get("VLC_COMPANION_TOKEN", "")
    report = {"flight_commands": False, "steps": []}

    if args.print_marker is not None:
        mono = render_marker(args.print_marker, modules=max(8, args.marker_px // 6))
        raw = pack_code10(mono.astype("uint16") * 4)
        path = os.path.abspath(f"cam0-marker-{args.print_marker}.png")
        # 8-bit print is enough for paper. The PNG helper is 16-bit; scale into it.
        import numpy as np
        png = encode_png16(np.where(mono > 128, 65535, 0).astype(np.uint16))
        open(path, "wb").write(png)
        report["marker_png"] = path
        print(json.dumps({"printed": path, "id": args.print_marker}))

    if not os.path.exists(args.device):
        report["steps"].append({"capture": "absent", "device": args.device})
        print(json.dumps(report, indent=2))
        return 2

    from .v4l2cap import V4l2Source, describe_capture_error, device_busy_message
    src = V4l2Source(args.device, width=1280, height=800, fps=60)
    ae = AutoExposure()
    src.set_exposure_gain(ae.state.exposure_us, ae.state.gain, fps=src.fps)
    t0 = time.monotonic()
    frames = 0
    last = None
    try:
        src.open()
        while time.monotonic() - t0 < args.seconds:
            frame = src.read()
            frames += 1
            mean, pct = frame_stats(frame, 90)
            ae.update(mean, pct, fps=src.fps)
            src.set_exposure_gain(ae.state.exposure_us, ae.state.gain, fps=src.fps)
            last = frame
    except Exception as exc:
        busy = device_busy_message(exc)
        if busy:
            report["steps"].append({"capture": "busy", "error": busy})
        else:
            report["steps"].append({"capture": "error", "error": describe_capture_error(exc)})
        print(json.dumps(report, indent=2))
        return 1
    finally:
        src.close()
    elapsed = max(1e-3, time.monotonic() - t0)
    report["steps"].append({
        "capture": "ok",
        "frames": frames,
        "fps": round(frames / elapsed, 2),
        "dropped": None if last is None else last.get("dropped"),
        "exposure_us": ae.state.exposure_us,
        "gain": ae.state.gain,
        "ae_settled": ae.state.settled,
        "mean": ae.state.mean,
    })
    if last is not None:
        t_det = time.perf_counter()
        hits = detect(last["mono8"])
        report["steps"].append({
            "marker": "ok" if hits else "none",
            "detections": hits,
            "detect_ms": round((time.perf_counter() - t_det) * 1000, 2),
            "note": "hold the printed tag in view and run again" if not hits else "output only",
        })
    code, body = _get(args.base + "/api/v1/cam0/health", token)
    report["steps"].append({"stream_health_http": code, "bytes": len(body or b"")})
    code2, _ = _get(args.base + "/api/v1/cameras/cam0/frame.jpg", token)
    report["steps"].append({"frame_http": code2})
    print(json.dumps(report, indent=2))
    return 0 if frames > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
