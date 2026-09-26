# -*- coding: utf-8 -*-
"""Deterministic derive: tlog → summary, series, track. Child process, derive_rev 1."""

from __future__ import print_function

import json
import sys
from pathlib import Path

from flight_events import mode_name, obs_from_message
from flightlog_common import DERIVE_REV, haversine_m, utc_iso

SERIES_SPEC = (
    ("alt_rel_m", "m", "tlog.GLOBAL_POSITION_INT"),
    ("airspeed_mps", "m/s", "tlog.VFR_HUD"),
    ("groundspeed_mps", "m/s", "tlog.VFR_HUD"),
    ("climb_mps", "m/s", "tlog.VFR_HUD"),
    ("throttle_pct", "pct", "tlog.VFR_HUD"),
    ("roll_deg", "deg", "tlog.ATTITUDE"),
    ("pitch_deg", "deg", "tlog.ATTITUDE"),
    ("batt_v", "V", "tlog.SYS_STATUS"),
    ("batt_a", "A", "tlog.SYS_STATUS"),
    ("gps_sats", "count", "tlog.GPS_RAW_INT"),
    ("gps_hdop", "hdop", "tlog.GPS_RAW_INT"),
)


def decimate_minmax(points, max_hz=2.0, limit=6000):
    """Keep min and max inside each bucket so peaks survive. Output rate ≤ max_hz."""
    if len(points) <= 2:
        return list(points)
    span = points[-1][0] - points[0][0]
    if span <= 0:
        return [points[0], points[-1]]
    bucket = 2.0 / float(max_hz)
    out = _bucket(points, bucket)
    while len(out) > limit and bucket < span * 2:
        bucket *= 2.0
        out = _bucket(points, bucket)
    if len(out) > limit:
        step = max(1, len(out) // limit)
        out = out[::step][:limit]
    return out


def _bucket(points, bucket):
    out = []
    i = 0
    n = len(points)
    while i < n:
        end = points[i][0] + bucket
        group = []
        while i < n and points[i][0] < end - 1e-9:
            group.append(points[i])
            i += 1
        if not group:
            break
        if len(group) == 1:
            out.append(group[0])
            continue
        lo = min(group, key=lambda item: (item[1], item[0]))
        hi = max(group, key=lambda item: (item[1], item[0]))
        for item in sorted((lo, hi), key=lambda it: it[0]):
            if not out or out[-1][0] != item[0] or out[-1][1] != item[1]:
                out.append(item)
    return out


def _glitch_mask(samples):
    """Indexes whose groundspeed spike should be dropped from the track."""
    bad = set()
    prev_g = None
    prev_a = None
    prev_t = None
    for i, sample in enumerate(samples):
        g = sample.get("g")
        a = sample.get("a")
        t = sample.get("t")
        if g is not None and prev_g is not None and a is not None and prev_a is not None and prev_t is not None:
            if 0 < (t - prev_t) <= 1.0 and (g - prev_g) > 15.0 and abs(a - prev_a) < 3.0:
                bad.add(i)
        if g is not None:
            prev_g = g
            prev_t = t
        if a is not None:
            prev_a = a
    return bad


def derive_tlog(path, arm_unix, end_unix=None):
    from pymavlink import mavutil

    mlog = mavutil.mavlink_connection(str(path))
    obs = []
    raw_series = {name: [] for name, _unit, _src in SERIES_SPEC}
    coverage_hits = {"VFR_HUD": 0, "GLOBAL_POSITION_INT": 0, "GPS_RAW_INT": 0, "SYSTEM_TIME": 0}
    hb_times = []
    modes = []
    positions = []
    fc_text = []
    while True:
        msg = mlog.recv_match(blocking=False)
        if msg is None:
            break
        if msg.get_type() == "BAD_DATA":
            continue
        ts = getattr(msg, "_timestamp", None)
        if ts is None:
            continue
        if end_unix is not None and ts > end_unix + 1e-6:
            continue
        item = obs_from_message(ts, msg)
        obs.append(item)
        rel = None if arm_unix is None else ts - arm_unix
        name = item["name"]
        if name in coverage_hits:
            coverage_hits[name] += 1
        if name == "HEARTBEAT" and item.get("comp") == 1 and item.get("autopilot") == 3 and item.get("mav_type") in (1, 19, 20, 21, 22):
            hb_times.append(ts)
            label = mode_name(item.get("custom_mode"))
            if label:
                if not modes or modes[-1]["mode"] != label:
                    modes.append({"mode": label, "t": ts})
        elif name == "VFR_HUD" and rel is not None:
            raw_series["airspeed_mps"].append((rel, item.get("airspeed")))
            raw_series["groundspeed_mps"].append((rel, item.get("groundspeed")))
            raw_series["climb_mps"].append((rel, item.get("climb")))
            raw_series["throttle_pct"].append((rel, item.get("throttle")))
            positions.append({"t": ts, "rel": rel, "a": item.get("airspeed"), "g": item.get("groundspeed")})
        elif name == "GLOBAL_POSITION_INT" and rel is not None:
            raw_series["alt_rel_m"].append((rel, item.get("rel_alt")))
            if positions:
                positions[-1]["lat"] = item.get("lat")
                positions[-1]["lon"] = item.get("lon")
                positions[-1]["alt"] = item.get("rel_alt")
            else:
                positions.append({"t": ts, "rel": rel, "lat": item.get("lat"), "lon": item.get("lon"), "alt": item.get("rel_alt"), "a": None, "g": None})
        elif name == "GPS_RAW_INT" and rel is not None:
            raw_series["gps_sats"].append((rel, item.get("sats")))
            eph = item.get("eph")
            raw_series["gps_hdop"].append((rel, None if eph is None else eph / 100.0))
        elif name == "SYS_STATUS" and rel is not None:
            if item.get("voltage_v") is not None:
                raw_series["batt_v"].append((rel, item.get("voltage_v")))
            if item.get("current_a") is not None:
                raw_series["batt_a"].append((rel, item.get("current_a")))
        elif name == "ATTITUDE" and rel is not None:
            raw_series["roll_deg"].append((rel, float(msg.roll) * 57.2957795))
            raw_series["pitch_deg"].append((rel, float(msg.pitch) * 57.2957795))
        elif name == "STATUSTEXT":
            fc_text.append(item.get("text") or "")
        elif name == "SYSTEM_TIME" and item.get("time_unix_usec"):
            fc_text.append("SYSTEM_TIME")

    duration = 0.0
    if arm_unix is not None and obs:
        duration = max(0.0, obs[-1]["t"] - arm_unix)
    window_s = duration if duration > 0 else 1.0
    # rough expected counts at the rates we record; coverage is hits / seconds, capped at 1
    coverage = {}
    for key, hits in coverage_hits.items():
        coverage[key] = round(min(1.0, hits / window_s), 3)

    def _max(points):
        best = None
        best_t = None
        for rel, value in points:
            if value is None:
                continue
            if best is None or value > best:
                best = value
                best_t = rel
        return best, best_t

    max_alt, t_alt = _max(raw_series["alt_rel_m"])
    max_as, t_as = _max(raw_series["airspeed_mps"])
    max_gs, t_gs = _max(raw_series["groundspeed_mps"])
    bad = _glitch_mask(positions)
    distance = 0.0
    max_home = 0.0
    home = None
    clean_track = []
    for i, pos in enumerate(positions):
        if i in bad or pos.get("lat") is None or pos.get("lon") is None:
            continue
        if home is None:
            home = (pos["lat"], pos["lon"])
        else:
            step = haversine_m(clean_track[-1]["lat"], clean_track[-1]["lon"], pos["lat"], pos["lon"]) if clean_track else 0.0
            if step < 2000:
                distance += step
            dist_home = haversine_m(home[0], home[1], pos["lat"], pos["lon"])
            if dist_home > max_home:
                max_home = dist_home
        clean_track.append(pos)
    hb_gap = 0.0
    for i in range(1, len(hb_times)):
        hb_gap = max(hb_gap, hb_times[i] - hb_times[i - 1])
    batt_min = None
    for _rel, value in raw_series["batt_v"]:
        if value is None:
            continue
        batt_min = value if batt_min is None else min(batt_min, value)
    sats_min = None
    for _rel, value in raw_series["gps_sats"]:
        if value is None:
            continue
        sats_min = value if sats_min is None else min(sats_min, value)
    hdop_max = None
    for _rel, value in raw_series["gps_hdop"]:
        if value is None:
            continue
        hdop_max = value if hdop_max is None else max(hdop_max, value)
    mode_rows = []
    for i, row in enumerate(modes):
        end = modes[i + 1]["t"] if i + 1 < len(modes) else (obs[-1]["t"] if obs else row["t"])
        start_rel = 0 if arm_unix is None else row["t"] - arm_unix
        end_rel = 0 if arm_unix is None else end - arm_unix
        mode_rows.append(
            {
                "mode": row["mode"],
                "from_rel_s": round(start_rel, 3),
                "to_rel_s": round(end_rel, 3),
                "dur_s": round(max(0.0, end_rel - start_rel), 3),
            }
        )
    facts = []
    n = 1

    def add_fact(key, value, unit, t_rel, src):
        nonlocal n
        if value is None:
            return
        facts.append({"id": "F%d" % n, "key": key, "value": round(value, 3) if isinstance(value, float) else value, "unit": unit, "t_rel_s": None if t_rel is None else round(t_rel, 3), "src": src})
        n += 1

    add_fact("max_rel_alt_m", max_alt, "m", t_alt, "tlog.GLOBAL_POSITION_INT")
    add_fact("max_airspeed_mps", max_as, "m/s", t_as, "tlog.VFR_HUD")
    add_fact("max_groundspeed_mps", max_gs, "m/s", t_gs, "tlog.VFR_HUD")
    add_fact("distance_m", distance, "m", None, "tlog.GLOBAL_POSITION_INT")
    insights = _insights(raw_series, hb_gap, fc_text, mode_rows)
    series = {"t0_utc": utc_iso(arm_unix) if arm_unix is not None else None, "series": {}}
    for key, unit, src in SERIES_SPEC:
        points = [(rel, value) for rel, value in raw_series[key] if value is not None]
        kept = decimate_minmax(points, 2.0, 6000)
        if not kept:
            continue
        series["series"][key] = {
            "t": [round(rel, 3) for rel, _value in kept],
            "v": [round(value, 3) if isinstance(value, float) else value for _rel, value in kept],
            "unit": unit,
            "src": src,
        }
    summary = {
        "schema": "airvix.flight.summary/1",
        "derive_rev": DERIVE_REV,
        "sources": ["tlog"],
        "stats": {
            "duration_s": round(duration, 3),
            "air_time_s": None,
            "max_rel_alt_m": None if max_alt is None else round(max_alt, 3),
            "max_airspeed_mps": None if max_as is None else round(max_as, 3),
            "max_groundspeed_mps": None if max_gs is None else round(max_gs, 3),
            "distance_m": round(distance, 3),
            "max_dist_home_m": round(max_home, 3),
            "batt_min_v": batt_min,
            "batt_used_mah": None,
            "gps_min_sats": sats_min,
            "gps_max_hdop": hdop_max,
            "hb_max_gap_s": round(hb_gap, 3),
        },
        "modes": mode_rows,
        "takeoff": None,
        "landing": None,
        "facts": facts,
        "insights": insights,
        "coverage": coverage,
    }
    track = _track(clean_track, mode_rows, arm_unix)
    fc_firmware = None
    sysid = None
    for item in obs:
        if item["name"] == "STATUSTEXT" and item.get("text") and "ArduPlane" in item["text"] and fc_firmware is None:
            fc_firmware = item["text"]
        if item["name"] == "HEARTBEAT" and sysid is None and item.get("comp") == 1:
            sysid = item.get("sysid")
    return {
        "summary": summary,
        "series": series,
        "track": track,
        "modes": [row["mode"] for row in mode_rows],
        "fc_firmware": fc_firmware,
        "fc_sysid": sysid,
        "jetson_minus_fc_s": _clock_offset(obs),
        "saw_system_time": coverage_hits["SYSTEM_TIME"] > 0,
    }


def _clock_offset(obs):
    for item in obs:
        if item["name"] == "SYSTEM_TIME" and item.get("time_unix_usec"):
            fc = item["time_unix_usec"] / 1000000.0
            return round(item["t"] - fc, 3)
    return None


def _insights(raw_series, hb_gap, texts, mode_rows):
    found = []
    low = [(rel, value) for rel, value in raw_series["gps_sats"] if value is not None and value < 6]
    if low:
        found.append(_insight(len(found) + 1, "gps_low_sats", "warning", "קליטת לוויינים נמוכה", low[0][0], low[-1][0], []))
    hdop = [(rel, value) for rel, value in raw_series["gps_hdop"] if value is not None and value > 2.5]
    if hdop:
        found.append(_insight(len(found) + 1, "gps_high_hdop", "warning", "דיוק מיקום אופקי חלש", hdop[0][0], hdop[-1][0], []))
    if hb_gap > 2.0:
        found.append(_insight(len(found) + 1, "heartbeat_gap", "warning", "פער דופק ארוך", None, None, []))
    for text in texts:
        low_text = (text or "").lower()
        if "failsafe" in low_text:
            found.append(_insight(len(found) + 1, "failsafe_text", "warning", "הבקר דיווח כשל בטיחות", None, None, []))
            break
    if any(row["mode"] in ("RTL", "LOITER") for row in mode_rows) and any("failsafe" in (text or "").lower() for text in texts):
        found.append(_insight(len(found) + 1, "mode_after_failsafe", "warning", "החלפת מצב אחרי כשל בטיחות", None, None, []))
    return found


def _insight(n, rule, sev, text_he, start, end, evidence):
    return {
        "id": "I%d" % n,
        "rule": rule,
        "sev": sev,
        "text_he": text_he,
        "from_rel_s": None if start is None else round(start, 3),
        "to_rel_s": None if end is None else round(end, 3),
        "evidence": evidence,
    }


def _track(points, mode_rows, arm_unix):
    features = []
    if not points:
        return {"type": "FeatureCollection", "features": features}
    # ≤ 1 Hz
    kept = []
    last_t = None
    for pos in points:
        if last_t is None or pos["t"] - last_t >= 1.0 - 1e-6:
            kept.append(pos)
            last_t = pos["t"]
    if len(kept) > 6000:
        kept = kept[:6000]

    def mode_at(rel):
        current = None
        for row in mode_rows:
            if row["from_rel_s"] <= rel <= row["to_rel_s"] + 1e-6:
                current = row
        return current

    run = []
    run_mode = None
    for pos in kept:
        row = mode_at(pos["rel"])
        label = row["mode"] if row else None
        if run and label != run_mode:
            features.append(_line(run, run_mode))
            run = []
        run_mode = label
        run.append(pos)
    if run:
        features.append(_line(run, run_mode))
    features.append(_point(kept[0], "home"))
    return {"type": "FeatureCollection", "features": features}


def _line(points, mode):
    return {
        "type": "Feature",
        "geometry": {
            "type": "LineString",
            "coordinates": [[round(p["lon"], 7), round(p["lat"], 7), None if p.get("alt") is None else round(p["alt"], 2)] for p in points],
        },
        "properties": {
            "mode": mode,
            "from_rel_s": round(points[0]["rel"], 3),
            "to_rel_s": round(points[-1]["rel"], 3),
        },
    }


def _point(pos, role):
    return {
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": [round(pos["lon"], 7), round(pos["lat"], 7), None if pos.get("alt") is None else round(pos["alt"], 2)],
        },
        "properties": {"role": role, "t_rel_s": round(pos["rel"], 3)},
    }


def write_outputs(result, out_dir, air_time_s=None, takeoff=None, landing=None):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    summary = result["summary"]
    summary["stats"]["air_time_s"] = air_time_s
    summary["takeoff"] = takeoff
    summary["landing"] = landing
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    (out / "series.json").write_text(json.dumps(result["series"], ensure_ascii=False, sort_keys=True), encoding="utf-8")
    (out / "track.geojson").write_text(json.dumps(result["track"], ensure_ascii=False, sort_keys=True), encoding="utf-8")
    return summary


def main(argv):
    import argparse

    parser = argparse.ArgumentParser(description="Derive flight summary from a tlog")
    parser.add_argument("--tlog", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--arm-unix", type=float, required=True)
    parser.add_argument("--end-unix", type=float, default=None)
    parser.add_argument("--air-time", type=float, default=None)
    args = parser.parse_args(argv)
    result = derive_tlog(args.tlog, args.arm_unix, args.end_unix)
    write_outputs(result, args.out, air_time_s=args.air_time)
    print(json.dumps({"ok": True, "derive_rev": DERIVE_REV}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
