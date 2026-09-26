#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate small standard tlogs plus truth sidecars for the flight detector."""

from __future__ import print_function

import json
import struct
import sys
from pathlib import Path

from pymavlink.dialects.v20 import ardupilotmega as dialect

T0 = 1700000000.0
ROOT = Path(__file__).resolve().parent / "fixtures"


class Builder(object):
    def __init__(self):
        self.fc = dialect.MAVLink(None, srcSystem=1, srcComponent=1)
        self.gcs = dialect.MAVLink(None, srcSystem=255, srcComponent=190)
        self.rows = []

    def _pack(self, ml, msg, t):
        self.rows.append((T0 + t, bytes(msg.pack(ml))))

    def hb(self, t, armed, mode, gcs=False, mav_type=1):
        ml = self.gcs if gcs else self.fc
        base = 217 if armed else 89
        msg = ml.heartbeat_encode(6 if gcs else mav_type, 0 if gcs else 3, 0 if gcs else base, 0 if gcs else mode, 4)
        self._pack(ml, msg, t)

    def vfr(self, t, airspeed, groundspeed, alt, climb=0.0, throttle=0):
        msg = self.fc.vfr_hud_encode(float(airspeed), float(groundspeed), 90, int(throttle), float(alt), float(climb))
        self._pack(self.fc, msg, t)

    def gps(self, t, lat, lon, fix=3, sats=12, eph=120, alt=100):
        msg = self.fc.gps_raw_int_encode(
            int((T0 + t) * 1e6),
            int(fix),
            int(lat * 1e7),
            int(lon * 1e7),
            int(alt * 1000),
            int(eph),
            100,
            0,
            0,
            int(sats),
        )
        self._pack(self.fc, msg, t)

    def gpi(self, t, lat, lon, rel_alt, vx=0.0, vy=0.0):
        msg = self.fc.global_position_int_encode(
            int(t * 1000),
            int(lat * 1e7),
            int(lon * 1e7),
            int((rel_alt + 100) * 1000),
            int(rel_alt * 1000),
            int(vx * 100),
            int(vy * 100),
            0,
            9000,
        )
        self._pack(self.fc, msg, t)

    def systime(self, t):
        msg = self.fc.system_time_encode(int((T0 + t) * 1e6), int(t * 1000))
        self._pack(self.fc, msg, t)

    def text(self, t, text, severity=6):
        msg = self.fc.statustext_encode(int(severity), text.encode("ascii", "replace"))
        self._pack(self.fc, msg, t)

    def stream(self, t, armed, mode, air, gnd, alt, lat, lon, climb=0.0, fix=3, sats=12, eph=120, gcs=False):
        self.hb(t, armed, mode, gcs=False)
        if gcs:
            self.hb(t + 0.01, False, 0, gcs=True)
        self.vfr(t, air, gnd, alt, climb=climb, throttle=40 if air > 10 else 0)
        self.gps(t, lat, lon, fix=fix, sats=sats, eph=eph, alt=alt + 100)
        self.gpi(t, lat, lon, alt, vx=gnd, vy=0.0)
        if int(round(t)) == int(t):
            self.systime(t)


def _lat(base, meters):
    return base + meters / 111320.0


def write_tlog(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    ordered = sorted(rows, key=lambda item: item[0])
    with open(path, "wb") as handle:
        for ts, frame in ordered:
            handle.write(struct.pack(">Q", int(round(ts * 1e6))))
            handle.write(frame)


def scenario_bench():
    b = Builder()
    lat, lon = 32.1000, 34.8000
    for t in range(0, 61):
        armed = 5 <= t < 55
        b.stream(t, armed, 5, 3.0, 0.3, 1.0, lat, lon)
    return b, {
        "classification": "bench",
        "takeoff_offset": None,
        "landing_offset": None,
        "segments": 0,
        "end_reason": "disarmed",
        "tail_s": 2,
    }


def scenario_taxi():
    b = Builder()
    lat, lon = 32.1000, 34.8000
    for t in range(0, 51):
        armed = 5 <= t < 45
        if t < 10:
            g = 0.4
        elif t < 20:
            g = 0.4 + (7.0 - 0.4) * ((t - 10) / 10.0)
        elif t < 30:
            g = 7.0
        elif t < 40:
            g = 7.0 * (1 - (t - 30) / 10.0)
        else:
            g = 0.3
        b.stream(t, armed, 5, g, g, 1.0, _lat(lat, g), lon)
    return b, {
        "classification": "ground_run",
        "takeoff_offset": None,
        "landing_offset": None,
        "segments": 0,
        "end_reason": "disarmed",
        "tail_s": 2,
    }


def scenario_normal():
    """Six minutes armed: FBWA → AUTO → RTL, then a full stop."""
    b = Builder()
    lat, lon = 32.1000, 34.8000
    b.text(279.2, "Failsafe: short", severity=2)
    for t in range(0, 376):
        armed = 10 <= t < 370
        if t < 120:
            mode = 5
        elif t < 280:
            mode = 10
        else:
            mode = 11
        if t < 40 or t >= 330:
            air, gnd, alt = 4.0, 1.0, 1.0
        else:
            air, gnd, alt = 18.0, 20.0, 40.0
            lat = _lat(32.1000, (t - 40) * 15.0)
        b.stream(t, armed, mode, air, gnd, alt, lat, lon, climb=0.0)
    return b, {
        "classification": "flight",
        "takeoff_offset": 40.0,
        "landing_offset": 330.0,
        "segments": 1,
        "end_reason": "disarmed",
        "tail_s": 2,
        "modes": ["FBWA", "AUTO", "RTL"],
    }


def scenario_hand():
    b = Builder()
    lat, lon = 32.1000, 34.8000
    for t in range(0, 116):
        armed = 5 <= t < 110
        mode = 5 if t < 40 else 10
        if t < 15:
            air, gnd, alt = 4.0, 1.0, 1.0
        elif t < 80:
            alt = 3.0 if t < 18 else 25.0
            air, gnd = 16.0, 14.0
            lat = _lat(32.1000, (t - 15) * 12.0)
        else:
            air, gnd, alt = 2.0, 0.4, 1.0
        b.stream(t, armed, mode, air, gnd, alt, lat, lon)
    return b, {
        "classification": "flight",
        "takeoff_offset": 15.0,
        "landing_offset": 80.0,
        "segments": 1,
        "end_reason": "disarmed",
        "tail_s": 2,
        "modes": ["FBWA", "AUTO"],
    }


def scenario_glitch():
    b = Builder()
    lat, lon = 32.1000, 34.8000
    for t in range(0, 126):
        armed = 5 <= t < 120
        mode = 5
        fix, sats = 3, 12
        if t < 40 or t >= 90:
            air, gnd, alt = 4.0, 1.0, 1.0
            here = lat
        else:
            air, gnd, alt = 18.0, 16.0, 30.0
            here = _lat(lat, (t - 40) * 12.0)
        if t == 22:
            gnd = 40.0
            here = _lat(lat, 800.0)
        if t == 60:
            gnd = 55.0
            fix, sats = 1, 3
            here = _lat(lat, 1500.0)
        b.stream(t, armed, mode, air, gnd, alt, here, lon, fix=fix, sats=sats)
    return b, {
        "classification": "flight",
        "takeoff_offset": 40.0,
        "landing_offset": 90.0,
        "segments": 1,
        "end_reason": "disarmed",
        "tail_s": 2,
    }


def scenario_touch():
    b = Builder()
    lat, lon = 32.1000, 34.8000
    for t in range(0, 236):
        armed = 5 <= t < 230
        mode = 5
        if 20 <= t < 70 or 78 <= t < 120 or 150 <= t < 200:
            air, gnd, alt = 16.0, 18.0, 30.0
            lat = _lat(32.1000, max(0, t - 20) * 8.0)
        elif 70 <= t < 78:
            air, gnd, alt = 8.0, 4.0, 1.0
        else:
            air, gnd, alt = 2.0, 0.3, 1.0
        b.stream(t, armed, mode, air, gnd, alt, lat, lon)
    return b, {
        "classification": "flight",
        "takeoff_offset": 20.0,
        "landing_offset": 200.0,
        "segments": 2,
        "segment_takeoffs": [20.0, 150.0],
        "segment_landings": [120.0, 200.0],
        "end_reason": "disarmed",
        "tail_s": 2,
    }


def scenario_link():
    b = Builder()
    lat, lon = 32.1000, 34.8000
    for t in list(range(0, 60)) + list(range(90, 140)):
        armed = t >= 5
        if t < 20:
            air, gnd, alt = 4.0, 1.0, 1.0
        else:
            air, gnd, alt = 18.0, 16.0, 35.0
            lat = _lat(32.1000, (t - 20) * 10.0)
        b.stream(t, armed, 5, air, gnd, alt, lat, lon)
    return b, {
        "classification": "flight",
        "takeoff_offset": 20.0,
        "landing_offset": 139.0,
        "segments": 1,
        "end_reason": "fc_link_lost",
        "tail_s": 130,
        "expect_restored": True,
    }


def scenario_disarm_air():
    b = Builder()
    lat, lon = 32.1000, 34.8000
    for t in range(0, 86):
        armed = 5 <= t < 80
        if t < 20:
            air, gnd, alt = 4.0, 1.0, 1.0
        else:
            air, gnd, alt = 18.0, 16.0, 30.0
            lat = _lat(32.1000, (t - 20) * 12.0)
        b.stream(t, armed, 5, air, gnd, alt, lat, lon)
    return b, {
        "classification": "flight",
        "takeoff_offset": 20.0,
        "landing_offset": 80.5,
        "segments": 1,
        "end_reason": "disarmed_in_air",
        "tail_s": 2,
    }


def scenario_hb_only():
    b = Builder()
    for t in range(0, 46):
        armed = 5 <= t < 40
        b.hb(t, armed, 5)
    return b, {
        "classification": "unknown_no_telemetry",
        "takeoff_offset": None,
        "landing_offset": None,
        "segments": 0,
        "end_reason": "disarmed",
        "tail_s": 2,
    }


def scenario_gcs():
    b = Builder()
    lat, lon = 32.1000, 34.8000
    for t in range(0, 80):
        armed = 5 <= t < 70
        if t < 20 or t >= 60:
            air, gnd, alt = 4.0, 0.4, 1.0
        else:
            air, gnd, alt = 16.0, 14.0, 20.0
        b.stream(t, armed, 5, air, gnd, alt, lat, lon, gcs=True)
    return b, {
        "classification": "flight",
        "takeoff_offset": 20.0,
        "landing_offset": 60.0,
        "segments": 1,
        "end_reason": "disarmed",
        "tail_s": 2,
    }


SCENARIOS = (
    ("bench", scenario_bench),
    ("taxi", scenario_taxi),
    ("normal", scenario_normal),
    ("hand", scenario_hand),
    ("glitch", scenario_glitch),
    ("touch", scenario_touch),
    ("linkloss", scenario_link),
    ("disarm_air", scenario_disarm_air),
    ("heartbeat_only", scenario_hb_only),
    ("gcs_ignored", scenario_gcs),
)


def build_all(dest=None):
    dest = Path(dest) if dest else ROOT
    dest.mkdir(parents=True, exist_ok=True)
    written = []
    for name, fn in SCENARIOS:
        builder, truth = fn()
        truth = dict(truth)
        truth["name"] = name
        truth["t0"] = T0
        tlog = dest / ("%s.tlog" % name)
        write_tlog(tlog, builder.rows)
        (dest / ("%s.json" % name)).write_text(json.dumps(truth, sort_keys=True, indent=2), encoding="utf-8")
        written.append(tlog)
    return written


def main():
    paths = build_all(ROOT)
    total = sum(path.stat().st_size for path in paths)
    print(json.dumps({"ok": True, "files": len(paths), "bytes": total}))
    if total > 2 * 1024 * 1024:
        print("fixtures exceed 2 MB", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
