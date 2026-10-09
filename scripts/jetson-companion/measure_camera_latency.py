#!/usr/bin/env python3
"""Measure one camera's JPEG delay on the Jetson.

  python3 measure_camera_latency.py --camera cam0 --seconds 5
  python3 measure_camera_latency.py --camera cam3 --seconds 5 --base http://127.0.0.1:8081

Prints one JSON object: fps, end-to-end delay from the capture timestamp on
the JPEG to the moment the bytes were received, and decode/encode time from
the response headers. A camera that does not answer is `measured: false`.
This host does not open the gimbal. Run it on the Jetson, next to the companion.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request


def _num(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def percentile(values, pct):
    if not values:
        return None
    ordered = sorted(float(v) for v in values)
    if len(ordered) == 1:
        return round(ordered[0], 3)
    rank = (float(pct) / 100.0) * (len(ordered) - 1)
    lo = int(rank)
    hi = min(lo + 1, len(ordered) - 1)
    frac = rank - lo
    return round(ordered[lo] * (1.0 - frac) + ordered[hi] * frac, 3)


def _stats(values):
    if not values:
        return None
    return {
        "min": percentile(values, 0),
        "median": percentile(values, 50),
        "p95": percentile(values, 95),
        "max": percentile(values, 100),
    }


def summarize_samples(samples, wall_s, camera):
    """Pure summary. `samples` are pull results that included a JPEG."""
    rows = [row for row in (samples or []) if row.get("ok") and row.get("bytes")]
    wall = max(1e-6, float(wall_s or 0.0))
    if not rows:
        return {
            "ok": False,
            "measured": False,
            "reason": "not_measured",
            "camera": camera,
            "frames": 0,
            "fps": None,
            "e2e_delay_ms": None,
            "decode_ms": None,
            "encode_ms": None,
        }
    delays = [row["e2e_ms"] for row in rows if row.get("e2e_ms") is not None]
    decodes = [row["decode_ms"] for row in rows if row.get("decode_ms") is not None]
    encodes = [row["encode_ms"] for row in rows if row.get("encode_ms") is not None]
    return {
        "ok": True,
        "measured": True,
        "reason": None,
        "camera": camera,
        "frames": len(rows),
        "fps": round(len(rows) / wall, 2),
        "e2e_delay_ms": _stats(delays),
        "decode_ms": _stats(decodes),
        "encode_ms": _stats(encodes),
        "jpeg_bytes": rows[-1].get("bytes"),
        "capture_stamp": "companion arrival after decode",
    }


def pull_once(base, camera, timeout):
    url = base.rstrip("/") + f"/api/v1/cameras/{camera}/frame.jpg"
    req = urllib.request.Request(url, headers={"Accept": "image/jpeg"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = res.read()
            headers = {str(k).lower(): v for k, v in res.headers.items()}
            code = int(res.status)
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": f"http_{exc.code}", "bytes": 0}
    except Exception as exc:
        return {"ok": False, "error": type(exc).__name__, "bytes": 0}
    served_ms = time.time() * 1000.0
    capture_ms = _num(headers.get("x-airvix-capture-at"))
    e2e = None if capture_ms is None else round(served_ms - capture_ms, 3)
    return {
        "ok": code == 200 and len(body) > 0,
        "bytes": len(body),
        "e2e_ms": e2e,
        "encode_ms": _num(headers.get("x-encode-ms")),
        "decode_ms": _num(headers.get("x-airvix-decode-ms")),
    }


def pull_status_stages(base, camera, timeout):
    paths = ["/api/v1/status/cameras", f"/api/v1/cam{camera[-1]}/status" if camera[:3] == "cam" else ""]
    if camera == "cam0":
        paths.insert(0, "/api/v1/cam0/status")
    elif camera == "cam1":
        paths.insert(0, "/api/v1/cam1/status")
    for path in paths:
        if not path:
            continue
        req = urllib.request.Request(base.rstrip("/") + path, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                body = json.loads(res.read().decode("utf-8"))
        except Exception:
            continue
        if not isinstance(body, dict):
            continue
        if body.get("camera") == camera and isinstance(body.get("stages_ms"), dict):
            return body.get("stages_ms")
        cameras = body.get("cameras") if isinstance(body.get("cameras"), dict) else None
        slot = cameras.get(camera) if isinstance(cameras, dict) else None
        if isinstance(slot, dict) and isinstance(slot.get("stages_ms"), dict):
            return slot.get("stages_ms")
    return None


def measure(base, camera, seconds, timeout):
    deadline = time.monotonic() + max(0.2, float(seconds))
    samples = []
    t0 = time.monotonic()
    while time.monotonic() < deadline:
        samples.append(pull_once(base, camera, timeout))
        time.sleep(0.05)
    wall = max(1e-6, time.monotonic() - t0)
    report = summarize_samples(samples, wall, camera)
    report["seconds"] = round(wall, 3)
    report["base"] = base
    stages = pull_status_stages(base, camera, timeout)
    if stages:
        report["status_stages_ms"] = stages
    if not report.get("measured"):
        report["note"] = "no JPEG from this camera on this host; not measured"
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Measure camera JPEG delay")
    parser.add_argument("--camera", required=True, help="cam0, cam1, or cam3")
    parser.add_argument("--seconds", type=float, default=5.0)
    parser.add_argument("--base", default="http://127.0.0.1:8081")
    parser.add_argument("--timeout", type=float, default=2.0)
    args = parser.parse_args(argv)
    camera = str(args.camera).strip().lower()
    report = measure(args.base, camera, args.seconds, args.timeout)
    print(json.dumps(report, indent=2))
    return 0 if report.get("measured") else 2


if __name__ == "__main__":
    raise SystemExit(main())
