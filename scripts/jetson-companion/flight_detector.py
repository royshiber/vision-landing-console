# -*- coding: utf-8 -*-
"""Pure ArduPlane flight detector (design §3). No I/O. No pymavlink."""

from __future__ import print_function

import hashlib
import json

from flightlog_common import DETECTOR_VERSION, env_float, haversine_m

AUTOPILOT_TYPES = (1, 19, 20, 21, 22)
FRESH_S = 1.5
TICK_S = 0.5
IN_AIR = 2
ON_GROUND = 1


class DetectorParams(object):
    def __init__(
        self,
        aspd_min=9.0,
        gspd_min=8.0,
        alt_min=8.0,
        aspd_fast=13.0,
        gspd_fast=11.0,
        alt_strong=15.0,
        confirm_s=5.0,
        confirm_ratio=0.8,
        disp_min=30.0,
        land_still_s=20.0,
        link_lost_close_s=120.0,
    ):
        self.aspd_min = float(aspd_min)
        self.gspd_min = float(gspd_min)
        self.alt_min = float(alt_min)
        self.aspd_fast = float(aspd_fast)
        self.gspd_fast = float(gspd_fast)
        self.alt_strong = float(alt_strong)
        self.confirm_s = float(confirm_s)
        self.confirm_ratio = float(confirm_ratio)
        self.disp_min = float(disp_min)
        self.land_still_s = float(land_still_s)
        self.link_lost_close_s = float(link_lost_close_s)

    @classmethod
    def from_env(cls):
        return cls(
            aspd_min=env_float("AIRVIX_FD_ASPD_MIN", 9),
            gspd_min=env_float("AIRVIX_FD_GSPD_MIN", 8),
            alt_min=env_float("AIRVIX_FD_ALT_MIN", 8),
            aspd_fast=env_float("AIRVIX_FD_ASPD_FAST", 13),
            gspd_fast=env_float("AIRVIX_FD_GSPD_FAST", 11),
            alt_strong=env_float("AIRVIX_FD_ALT_STRONG", 15),
            confirm_s=env_float("AIRVIX_FD_CONFIRM_S", 5),
            confirm_ratio=env_float("AIRVIX_FD_CONFIRM_RATIO", 0.8),
            disp_min=env_float("AIRVIX_FD_DISP_MIN", 30),
            land_still_s=env_float("AIRVIX_FD_LAND_STILL_S", 20),
            link_lost_close_s=env_float("AIRVIX_FD_LINK_LOST_CLOSE_S", 120),
        )

    def as_dict(self):
        return {
            "ASPD_MIN": self.aspd_min,
            "GSPD_MIN": self.gspd_min,
            "ALT_MIN": self.alt_min,
            "ASPD_FAST": self.aspd_fast,
            "GSPD_FAST": self.gspd_fast,
            "ALT_STRONG": self.alt_strong,
            "CONFIRM_S": self.confirm_s,
            "CONFIRM_RATIO": self.confirm_ratio,
            "DISP_MIN": self.disp_min,
            "LAND_STILL_S": self.land_still_s,
            "LINK_LOST_CLOSE_S": self.link_lost_close_s,
        }


def params_digest(params):
    raw = json.dumps(params.as_dict(), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def accept_autopilot_heartbeat(comp, autopilot, mav_type, sysid, locked_sysid):
    if comp != 1 or autopilot != 3:
        return False
    if mav_type not in AUTOPILOT_TYPES:
        return False
    if locked_sysid is not None and sysid != locked_sysid:
        return False
    return True


def apply_obs(latest, obs, locked_sysid):
    """Fold one observation into latest{signal: {t, v}}. Returns locked sysid."""
    name = obs.get("name")
    t = obs.get("t")
    sysid = obs.get("sysid")
    if name == "HEARTBEAT":
        if not accept_autopilot_heartbeat(
            obs.get("comp"), obs.get("autopilot"), obs.get("mav_type"), sysid, locked_sysid
        ):
            return locked_sysid
        if locked_sysid is None:
            locked_sysid = sysid
        latest["hb"] = {
            "t": t,
            "v": {
                "armed": bool(obs.get("armed")),
                "mode": obs.get("custom_mode"),
                "sysid": sysid,
            },
        }
        latest.setdefault("hb_events", []).append({"t": t, "armed": bool(obs.get("armed"))})
        return locked_sysid
    if locked_sysid is not None and sysid is not None and sysid != locked_sysid:
        return locked_sysid
    if name == "VFR_HUD":
        latest["vfr"] = {
            "t": t,
            "v": {
                "airspeed": obs.get("airspeed"),
                "groundspeed": obs.get("groundspeed"),
                "climb": obs.get("climb"),
                "throttle": obs.get("throttle"),
            },
        }
    elif name == "GPS_RAW_INT":
        latest["gps"] = {
            "t": t,
            "v": {
                "fix": obs.get("fix_type"),
                "sats": obs.get("sats"),
                "eph": obs.get("eph"),
                "lat": obs.get("lat"),
                "lon": obs.get("lon"),
            },
        }
    elif name == "GLOBAL_POSITION_INT":
        latest["gpi"] = {
            "t": t,
            "v": {
                "rel_alt": obs.get("rel_alt"),
                "lat": obs.get("lat"),
                "lon": obs.get("lon"),
                "vx": obs.get("vx"),
                "vy": obs.get("vy"),
            },
        }
    elif name == "EXTENDED_SYS_STATE":
        latest["ext"] = {"t": t, "v": {"landed_state": obs.get("landed_state")}}
    elif name == "SYSTEM_TIME":
        latest["systime"] = {"t": t, "v": {"time_unix_usec": obs.get("time_unix_usec")}}
    return locked_sysid


def _fresh(latest, key, t, fresh_s):
    rec = latest.get(key)
    if not rec:
        return None
    if t - rec["t"] > fresh_s:
        return None
    return rec["v"]


def sample_from_latest(latest, t, fresh_s=FRESH_S):
    hb = _fresh(latest, "hb", t, fresh_s)
    vfr = _fresh(latest, "vfr", t, fresh_s)
    gps = _fresh(latest, "gps", t, fresh_s)
    gpi = _fresh(latest, "gpi", t, fresh_s)
    ext = _fresh(latest, "ext", t, fresh_s)
    gps_valid = False
    if gps is not None:
        fix = gps.get("fix") or 0
        sats = gps.get("sats") or 0
        eph = gps.get("eph")
        gps_valid = fix >= 3 and sats >= 6 and eph is not None and eph <= 300
    airspeed = None if vfr is None else vfr.get("airspeed")
    climb = None if vfr is None else vfr.get("climb")
    g_meas = None
    if vfr is not None and vfr.get("groundspeed") is not None:
        g_meas = vfr.get("groundspeed")
    elif gpi is not None and gpi.get("vx") is not None and gpi.get("vy") is not None:
        g_meas = (gpi["vx"] ** 2 + gpi["vy"] ** 2) ** 0.5
    g_use = g_meas if gps_valid else None
    rel_alt = None if gpi is None else gpi.get("rel_alt")
    lat = None
    lon = None
    if gps_valid and gps is not None and gps.get("lat") is not None:
        lat, lon = gps.get("lat"), gps.get("lon")
    elif gpi is not None and gps_valid:
        lat, lon = gpi.get("lat"), gpi.get("lon")
    hb_rec = latest.get("hb")
    return {
        "t": t,
        "hb_fresh": hb is not None,
        "hb_t": None if hb_rec is None or hb is None else hb_rec["t"],
        "armed": None if hb is None else bool(hb.get("armed")),
        "mode": None if hb is None else hb.get("mode"),
        "airspeed": airspeed,
        "groundspeed": g_use,
        "groundspeed_meas": g_meas,
        "gps_valid": gps_valid,
        "rel_alt": rel_alt,
        "climb": climb,
        "lat": lat,
        "lon": lon,
        "landed_state": None if ext is None else ext.get("landed_state"),
        "has_telemetry": vfr is not None or gpi is not None or gps is not None,
        "systime": _fresh(latest, "systime", t, fresh_s),
    }


def observations_to_samples(observations, dt=TICK_S, fresh_s=FRESH_S):
    if not observations:
        return []
    ordered = sorted(observations, key=lambda item: item["t"])
    start = ordered[0]["t"]
    end = ordered[-1]["t"]
    latest = {}
    locked = None
    idx = 0
    out = []
    i = 0
    while True:
        t = start + i * dt
        if t > end + 1e-6:
            break
        while idx < len(ordered) and ordered[idx]["t"] <= t + 1e-9:
            locked = apply_obs(latest, ordered[idx], locked)
            idx += 1
        out.append(sample_from_latest(latest, t, fresh_s))
        i += 1
    return out


class FlightDetector(object):
    def __init__(self, params=None):
        self.params = params or DetectorParams()
        self.state = "idle"
        self.closed = False
        self.arm_t = None
        self.disarm_t = None
        self.end_reason = None
        self.classification = None
        self.segments = []
        self.evidence = {}
        self.saw_telemetry = False
        self.max_g = 0.0
        self.max_disp = 0.0
        self.arm_lat = None
        self.arm_lon = None
        self._armed_streak = 0
        self._disarmed_streak = 0
        self._first_armed_t = None
        self._first_disarmed_t = None
        self._seen_hb_t = None
        self._last_hb_t = None
        self._hb_lost = False
        self._ev_hist = []
        self._run_start = None
        self._alt_strong_start = None
        self._still_start = None
        self._ground_start = None
        self._last_evidence_t = None
        self._open = None
        self._glitch_until = None
        self._prev_g = None
        self._prev_g_t = None
        self._prev_a = None
        self._sample_cache = []

    def tick(self, sample):
        if self.closed:
            return []
        events = []
        t = float(sample["t"])
        self._sample_cache.append(sample)
        if len(self._sample_cache) > 80:
            self._sample_cache = self._sample_cache[-80:]
        self._note_heartbeat(sample, events)
        if self.state == "idle" and self._armed_streak >= 2:
            self.state = "armed_ground"
            self.arm_t = self._first_armed_t
            self._capture_arm_pos(sample)
        if self.state != "idle" and self._disarmed_streak >= 2:
            reason = "disarmed_in_air" if self._airborne_evidence(sample)[0] else "disarmed"
            if reason == "disarmed_in_air":
                events.append(self._ev(t, "flight.disarmed_in_air", "critical"))
            self._close(reason, events)
            return events
        if sample.get("has_telemetry"):
            self.saw_telemetry = True
        self._note_glitch(sample, events)
        self._note_motion(sample)
        if self.state in ("armed_ground", "landed_armed", "airborne"):
            ev, rule_hint = self._airborne_evidence(sample)
            if ev:
                self._last_evidence_t = t
            self._maybe_takeoff(sample, ev, rule_hint, events)
            self._maybe_land(sample, events)
        self._maybe_link_lost(sample, events)
        return events

    def force_close(self, reason, t=None):
        events = []
        if self.closed:
            return events
        if t is None:
            t = self._last_hb_t if self._last_hb_t is not None else self.arm_t
        if t is not None:
            self._last_evidence_t = self._last_evidence_t if self._last_evidence_t is not None else t
        self._close(reason, events)
        return events

    def snapshot(self):
        takeoff = self.segments[0]["takeoff_t"] if self.segments else None
        landed = None
        if self.segments:
            landed = self.segments[-1].get("landed_t")
        return {
            "state": "closed" if self.closed else self.state,
            "open": not self.closed and self.state != "idle",
            "classification": self.classification,
            "end_reason": self.end_reason,
            "arm_t": self.arm_t,
            "disarm_t": self.disarm_t,
            "takeoff_t": takeoff,
            "landed_t": landed,
            "segments": [dict(seg) for seg in self.segments],
            "segment_count": len(self.segments),
            "evidence": self.evidence,
            "saw_telemetry": self.saw_telemetry,
            "max_g": self.max_g,
            "max_disp": self.max_disp,
            "params": self.params.as_dict(),
            "detector_version": DETECTOR_VERSION,
        }

    def _note_heartbeat(self, sample, events):
        queued = sample.get("hb_events") or []
        if queued:
            for item in queued:
                self._apply_hb(item.get("t"), bool(item.get("armed")), sample, events)
            return
        if not sample.get("hb_fresh"):
            return
        hb_t = sample.get("hb_t")
        if hb_t is None or hb_t == self._seen_hb_t:
            return
        self._apply_hb(hb_t, bool(sample.get("armed")), sample, events)

    def _apply_hb(self, hb_t, armed, sample, events):
        if hb_t is None or hb_t == self._seen_hb_t:
            return
        self._seen_hb_t = hb_t
        self._last_hb_t = hb_t
        if self._hb_lost and self.state not in ("idle", "closed"):
            self._hb_lost = False
            events.append(self._ev(sample["t"], "fc.heartbeat_restored", "info"))
        if armed:
            if self._armed_streak == 0:
                self._first_armed_t = hb_t
            self._armed_streak += 1
            self._disarmed_streak = 0
        else:
            if self._disarmed_streak == 0:
                self._first_disarmed_t = hb_t
            self._disarmed_streak += 1
            self._armed_streak = 0

    def _note_glitch(self, sample, events):
        g = sample.get("groundspeed_meas")
        a = sample.get("airspeed")
        t = sample["t"]
        if (
            g is not None
            and self._prev_g is not None
            and self._prev_g_t is not None
            and a is not None
            and self._prev_a is not None
        ):
            dt = t - self._prev_g_t
            if 0 < dt <= 1.0 and (g - self._prev_g) > 15.0 and abs(a - self._prev_a) < 3.0:
                self._glitch_until = t + 3.0
                events.append(self._ev(t, "fc.gps_glitch_suspected", "warning"))
        if g is not None:
            self._prev_g = g
            self._prev_g_t = t
        if a is not None:
            self._prev_a = a

    def _glitch(self, t):
        return self._glitch_until is not None and t < self._glitch_until

    def _note_motion(self, sample):
        if self.state == "idle":
            return
        t = sample["t"]
        if self._glitch(t):
            return
        g = sample.get("groundspeed")
        if g is not None and g > self.max_g:
            self.max_g = g
        if not sample.get("gps_valid"):
            return
        lat, lon = sample.get("lat"), sample.get("lon")
        if lat is None or lon is None:
            return
        if self.arm_lat is None:
            self.arm_lat, self.arm_lon = lat, lon
            return
        dist = haversine_m(self.arm_lat, self.arm_lon, lat, lon)
        if dist > self.max_disp:
            self.max_disp = dist

    def _capture_arm_pos(self, sample):
        if sample.get("gps_valid") and sample.get("lat") is not None and not self._glitch(sample["t"]):
            self.arm_lat = sample.get("lat")
            self.arm_lon = sample.get("lon")

    def _usable_g(self, sample):
        if self._glitch(sample["t"]):
            return None
        return sample.get("groundspeed")

    def _airborne_evidence(self, sample):
        p = self.params
        h = sample.get("rel_alt")
        a = sample.get("airspeed")
        g = self._usable_g(sample)
        cond_alt = h is not None and h >= p.alt_min and (
            (a is not None and a >= p.aspd_min) or (g is not None and g >= p.gspd_min)
        )
        cond_fast = a is not None and g is not None and a >= p.aspd_fast and g >= p.gspd_fast
        cond_ext = sample.get("landed_state") == IN_AIR and (
            (a is not None and a >= p.aspd_min)
            or (g is not None and g >= p.gspd_min)
            or (h is not None and h >= p.alt_min)
        )
        if cond_alt:
            return True, "alt_and_speed"
        if cond_fast:
            return True, "fast_path"
        if cond_ext:
            return True, "extended_in_air"
        return False, None

    def _disp_now(self):
        return self.max_disp

    def _maybe_takeoff(self, sample, ev, rule_hint, events):
        if self.state not in ("armed_ground", "landed_armed"):
            self._ev_hist = []
            self._run_start = None
            self._alt_strong_start = None
            return
        p = self.params
        t = sample["t"]
        self._ev_hist.append((t, bool(ev)))
        self._ev_hist = [(tt, flag) for tt, flag in self._ev_hist if t - tt <= p.confirm_s + 1e-6]
        if ev:
            if self._run_start is None:
                self._run_start = t
        else:
            self._run_start = None
        h = sample.get("rel_alt")
        if h is not None and h >= p.alt_strong:
            if self._alt_strong_start is None:
                self._alt_strong_start = t
        else:
            self._alt_strong_start = None
        rule = None
        back = None
        if ev and self._ev_hist:
            span = self._ev_hist[-1][0] - self._ev_hist[0][0]
            ratio = sum(1 for _, flag in self._ev_hist if flag) / float(len(self._ev_hist))
            guard = self._disp_now() >= p.disp_min or (h is not None and h >= p.alt_min)
            if ratio + 1e-9 >= p.confirm_ratio and span + TICK_S + 1e-6 >= p.confirm_s and guard:
                rule = rule_hint or "alt_and_speed"
                back = self._run_start if self._run_start is not None else t
        if rule is None and self._alt_strong_start is not None and t - self._alt_strong_start >= 10.0 - 1e-6:
            rule = "alt_strong"
            back = self._alt_strong_start
        if rule is None:
            return
        self._open_segment(back, rule, sample, events)

    def _open_segment(self, takeoff_t, rule, sample, events):
        self.state = "airborne"
        n = len(self.segments) + 1
        self._open = {"n": n, "takeoff_t": takeoff_t, "landed_t": None}
        self.segments.append(self._open)
        values = self._values_near(takeoff_t, sample)
        self.evidence["takeoff" if n == 1 else "takeoff_%d" % n] = {
            "rule": rule,
            "t": takeoff_t,
            "values": values,
        }
        events.append(self._ev(takeoff_t, "flight.takeoff", "notice", {"segment": n, "rule": rule}))
        events.append(self._ev(takeoff_t, "flight.segment", "info", {"n": n}))
        self._ev_hist = []
        self._run_start = None
        self._alt_strong_start = None
        self._still_start = None
        self._ground_start = None

    def _values_near(self, t, fallback):
        chosen = fallback
        for item in self._sample_cache:
            if abs(item["t"] - t) <= TICK_S + 1e-6:
                chosen = item
                break
        g = chosen.get("groundspeed")
        return {
            "rel_alt_m": chosen.get("rel_alt"),
            "airspeed_mps": chosen.get("airspeed"),
            "groundspeed_mps": g,
            "disp_m": round(self.max_disp, 3),
        }

    def _is_still(self, sample):
        if self._glitch(sample["t"]):
            return False
        h = sample.get("rel_alt")
        climb = sample.get("climb")
        if h is None or climb is None:
            return False
        if h >= 5 or abs(climb) >= 0.7:
            return False
        if sample.get("gps_valid"):
            g = self._usable_g(sample)
            return g is not None and g < 2.0
        a = sample.get("airspeed")
        return a is not None and a < 5.0

    def _maybe_land(self, sample, events):
        if self.state != "airborne":
            return
        t = sample["t"]
        if self._is_still(sample):
            if self._still_start is None:
                self._still_start = t
            elif t - self._still_start >= self.params.land_still_s - 1e-6:
                self._close_segment(self._still_start, events)
                return
        else:
            self._still_start = None
        if sample.get("landed_state") == ON_GROUND:
            if self._ground_start is None:
                self._ground_start = t
            elif t - self._ground_start >= 10.0 - 1e-6:
                self._close_segment(self._ground_start, events)
        else:
            self._ground_start = None

    def _close_segment(self, landed_t, events):
        if self._open is not None:
            self._open["landed_t"] = landed_t
            self._open["air_time_s"] = max(0.0, landed_t - self._open["takeoff_t"])
        self._open = None
        self.state = "landed_armed"
        self._still_start = None
        self._ground_start = None
        self._run_start = None
        self._ev_hist = []
        events.append(self._ev(landed_t, "flight.landed", "notice"))

    def _maybe_link_lost(self, sample, events):
        if self.state in ("idle", "closed") or self._last_hb_t is None:
            return
        if sample.get("hb_fresh"):
            return
        gap = sample["t"] - self._last_hb_t
        if gap > 2.0 and not self._hb_lost:
            self._hb_lost = True
            events.append(self._ev(sample["t"], "fc.heartbeat_lost", "warning", {"gap_s": round(gap, 3)}))
        if gap >= self.params.link_lost_close_s - 1e-6:
            self._close("fc_link_lost", events)

    def _close(self, reason, events):
        if self._open is not None:
            if self._open.get("landed_t") is None:
                self._open["landed_t"] = self._last_evidence_t
            if self._open.get("landed_t") is not None:
                self._open["air_time_s"] = max(0.0, self._open["landed_t"] - self._open["takeoff_t"])
            else:
                self._open["air_time_s"] = 0.0
            self._open = None
        self.end_reason = reason
        if reason.startswith("disarmed"):
            self.disarm_t = self._first_disarmed_t
        self.classification = self._classify()
        self.state = "closed"
        self.closed = True
        events.append(self._ev(self.disarm_t or self._last_hb_t or 0, "flight.session_end", "info", {"end_reason": reason}))

    def _classify(self):
        if self.segments:
            return "flight"
        if not self.saw_telemetry:
            return "unknown_no_telemetry"
        if self.max_g >= 3.0 or self.max_disp >= 8.0:
            return "ground_run"
        return "bench"

    def _ev(self, t, etype, sev, data=None):
        return {"t": t, "type": etype, "sev": sev, "src": "flight" if etype.startswith("flight.") else "fc", "data": data or {}}
