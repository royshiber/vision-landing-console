"""On-demand recording into the flight-log layout.

  <root>/v1/<vehicle>/flights/<flight_id>/cam0/video.mjpg
  <root>/v1/<vehicle>/flights/<flight_id>/cam0/frames.jsonl

Auto-on-arm is off unless the config says otherwise. Stopping the record
never touches the vehicle.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path


def flight_id_now():
    return "cam0-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


class Recorder:
    def __init__(self, root, vehicle_id="airvix"):
        self.root = Path(root)
        self.vehicle_id = str(vehicle_id or "airvix")
        self._lock = threading.Lock()
        self._fh = None
        self._meta = None
        self._offset = 0
        self._count = 0
        self._t0_ns = None
        self.flight_id = None
        self.active = False
        self.path = None

    def _dir(self, flight_id):
        return self.root / "v1" / self.vehicle_id / "flights" / flight_id / "cam0"

    def start(self, flight_id=None):
        with self._lock:
            if self.active:
                return self.status()
            fid = flight_id or flight_id_now()
            dest = self._dir(fid)
            dest.mkdir(parents=True, exist_ok=True)
            self._fh = open(dest / "video.mjpg", "wb")
            self._meta = open(dest / "frames.jsonl", "w", encoding="utf-8")
            self._offset = 0
            self._count = 0
            self._t0_ns = time.time_ns()
            self.flight_id = fid
            self.path = str(dest)
            self.active = True
            return self.status()

    def stop(self):
        with self._lock:
            self._close()
            return self.status()

    def _close(self):
        for fh in (self._fh, self._meta):
            if fh is not None:
                try:
                    fh.close()
                except Exception:
                    pass
        self._fh = None
        self._meta = None
        self.active = False

    def write(self, jpeg, meta):
        if not jpeg:
            return False
        with self._lock:
            if not self.active or self._fh is None:
                return False
            blob = jpeg if isinstance(jpeg, (bytes, bytearray)) else bytes(jpeg)
            self._fh.write(blob)
            self._fh.flush()
            t_utc = meta.get("t_utc_ns")
            rel = None
            if t_utc is not None and self._t0_ns is not None:
                rel = (int(t_utc) - int(self._t0_ns)) / 1e9
            row = {
                "i": self._count,
                "t_mono_ns": meta.get("t_monotonic_ns"),
                "t_utc_ns": t_utc,
                "t_rel_s": rel,
                "exposure_us": meta.get("exposure_us"),
                "gain": meta.get("gain"),
                "attitude": meta.get("attitude"),
                "position": meta.get("position"),
                "rangefinder_m": meta.get("rangefinder_m"),
                "detections": meta.get("detections") or [],
                "jpeg_offset": self._offset,
                "jpeg_length": len(blob),
            }
            self._meta.write(json.dumps(row, separators=(",", ":")) + "\n")
            self._meta.flush()
            self._offset += len(blob)
            self._count += 1
            return True

    def status(self):
        return {
            "recording": self.active,
            "flight_id": self.flight_id,
            "path": self.path,
            "frames": self._count,
            "vehicle_id": self.vehicle_id,
        }

    def list_recordings(self):
        base = self.root / "v1" / self.vehicle_id / "flights"
        out = []
        if not base.is_dir():
            return out
        for flight in sorted(p for p in base.iterdir() if p.is_dir()):
            cam = flight / "cam0" / "frames.jsonl"
            if cam.is_file():
                out.append({
                    "flight_id": flight.name,
                    "frames": str(cam),
                    "video": str(flight / "cam0" / "video.mjpg"),
                })
        return out

    def read_frames(self, flight_id):
        path = self._dir(flight_id) / "frames.jsonl"
        if not path.is_file():
            return None
        rows = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
        return rows

    def read_jpeg(self, flight_id, index):
        rows = self.read_frames(flight_id)
        if not rows:
            return None
        chosen = None
        for row in rows:
            if int(row.get("i", -1)) == int(index):
                chosen = row
                break
        if chosen is None:
            return None
        video = self._dir(flight_id) / "video.mjpg"
        if not video.is_file():
            return None
        with open(video, "rb") as fh:
            fh.seek(int(chosen["jpeg_offset"]))
            return fh.read(int(chosen["jpeg_length"]))
