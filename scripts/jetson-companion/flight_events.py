# -*- coding: utf-8 -*-
"""MAVLink message → timeline events (design §5.4). Python 3.8."""

from __future__ import print_function

MODES = {
    0: "MANUAL",
    1: "CIRCLE",
    2: "STABILIZE",
    3: "TRAINING",
    4: "ACRO",
    5: "FBWA",
    6: "FBWB",
    7: "CRUISE",
    8: "AUTOTUNE",
    10: "AUTO",
    11: "RTL",
    12: "LOITER",
    13: "TAKEOFF",
    14: "AVOID_ADSB",
    15: "GUIDED",
    16: "INITIALISING",
    17: "QSTABILIZE",
    18: "QHOVER",
    19: "QLOITER",
    20: "QLAND",
    21: "QRTL",
    22: "QAUTOTUNE",
    23: "QACRO",
    24: "THERMAL",
    25: "LOITER_ALT_QLAND",
    26: "AUTOLAND",
}

SEV_MAP = {
    0: "critical",
    1: "critical",
    2: "critical",
    3: "error",
    4: "warning",
    5: "notice",
    6: "info",
    7: "info",
}

FAILSAFE_HINTS = ("failsafe", "fence breach", "battery failsafe", "gps failsafe", "rc failsafe")
CAUSE_MODES = ("RTL", "LOITER", "QLAND", "QRTL")


def obs_from_message(t, msg):
    """Normalize a pymavlink message into a plain dict. Timestamps stay with the caller."""
    name = msg.get_type()
    obs = {
        "t": t,
        "name": name,
        "sysid": msg.get_srcSystem(),
        "comp": msg.get_srcComponent(),
    }
    if name == "HEARTBEAT":
        obs["mav_type"] = int(msg.type)
        obs["autopilot"] = int(msg.autopilot)
        obs["base_mode"] = int(msg.base_mode)
        obs["custom_mode"] = int(msg.custom_mode)
        obs["armed"] = bool(int(msg.base_mode) & 128)
    elif name == "VFR_HUD":
        obs["airspeed"] = float(msg.airspeed)
        obs["groundspeed"] = float(msg.groundspeed)
        obs["climb"] = float(msg.climb)
        obs["throttle"] = int(msg.throttle)
        obs["alt"] = float(msg.alt)
    elif name == "GPS_RAW_INT":
        obs["fix_type"] = int(msg.fix_type)
        obs["sats"] = int(msg.satellites_visible)
        obs["eph"] = int(msg.eph)
        obs["lat"] = float(msg.lat) / 1e7
        obs["lon"] = float(msg.lon) / 1e7
    elif name == "GLOBAL_POSITION_INT":
        obs["rel_alt"] = float(msg.relative_alt) / 1000.0
        obs["lat"] = float(msg.lat) / 1e7
        obs["lon"] = float(msg.lon) / 1e7
        obs["vx"] = float(msg.vx) / 100.0
        obs["vy"] = float(msg.vy) / 100.0
    elif name == "STATUSTEXT":
        text = msg.text
        if isinstance(text, bytes):
            text = text.decode("utf-8", "replace")
        obs["text"] = str(text).replace("\x00", "").strip()
        obs["severity"] = int(msg.severity)
    elif name == "SYSTEM_TIME":
        obs["time_unix_usec"] = int(msg.time_unix_usec)
    elif name == "EXTENDED_SYS_STATE":
        obs["landed_state"] = int(msg.landed_state)
    elif name == "SYS_STATUS":
        volts = int(msg.voltage_battery)
        amps = int(msg.current_battery)
        rem = int(msg.battery_remaining)
        obs["voltage_v"] = None if volts == 65535 else volts / 1000.0
        obs["current_a"] = None if amps < 0 else amps / 100.0
        obs["remaining_pct"] = None if rem < 0 else rem
    elif name == "EKF_STATUS_REPORT":
        obs["flags"] = int(getattr(msg, "flags", 0))
    elif name == "MISSION_ITEM_REACHED":
        obs["seq"] = int(msg.seq)
    elif name == "HOME_POSITION":
        obs["lat"] = float(msg.latitude) / 1e7
        obs["lon"] = float(msg.longitude) / 1e7
    return obs


def mode_name(custom_mode):
    if custom_mode is None:
        return None
    try:
        return MODES.get(int(custom_mode))
    except (TypeError, ValueError):
        return None


def severity_name(mav_severity):
    try:
        return SEV_MAP.get(int(mav_severity), "info")
    except (TypeError, ValueError):
        return "info"


def _mode_texts(frm, to):
    left = frm or "?"
    right = to or "?"
    return ("Mode %s → %s" % (left, right), "מצב טיסה %s ← %s" % (left, right))


class EventNormalizer(object):
    """Incremental normalizer. Call finalize() for stable ids and cause links."""

    def __init__(self):
        self.rows = []
        self._mode = None
        self._armed = None
        self._fix = None
        self._ekf = None
        self._locked = None
        self._batt_low = False

    def feed_obs(self, obs):
        name = obs.get("name")
        t = obs.get("t")
        if name == "HEARTBEAT":
            self._feed_heartbeat(t, obs)
        elif name == "STATUSTEXT":
            self._feed_statustext(t, obs)
        elif name == "GPS_RAW_INT":
            self._feed_gps(t, obs)
        elif name == "EKF_STATUS_REPORT":
            flags = obs.get("flags")
            if flags is not None and flags != self._ekf:
                prev = self._ekf
                self._ekf = flags
                if prev is not None:
                    self._add(t, "fc", "fc.ekf_flags", "warning", "EKF flags %s → %s" % (prev, flags), "דגלי הערכה השתנו", {"from": prev, "to": flags})
        elif name == "SYS_STATUS":
            remaining = obs.get("remaining_pct")
            voltage = obs.get("voltage_v")
            low = (remaining is not None and remaining < 25) or (voltage is not None and voltage < 6.0)
            if low and not self._batt_low:
                self._batt_low = True
                self._add(
                    t,
                    "fc",
                    "fc.battery",
                    "warning",
                    "Battery low",
                    "מצבר נמוך",
                    {"voltage_v": voltage, "current_a": obs.get("current_a"), "remaining_pct": remaining},
                )
            elif not low:
                self._batt_low = False
        elif name == "MISSION_ITEM_REACHED":
            self._add(t, "fc", "fc.mission_item_reached", "info", "Mission item %s" % obs.get("seq"), "נקודת משימה", {"seq": obs.get("seq")})
        elif name == "HOME_POSITION":
            self._add(t, "fc", "fc.home_set", "info", "Home set", "נקודת הבית נקבעה", {"lat": obs.get("lat"), "lon": obs.get("lon")})

    def add_external(self, event):
        """Detector / system events already shaped with t, type, sev, src."""
        self._add(
            event.get("t"),
            event.get("src") or "system",
            event.get("type"),
            event.get("sev") or "info",
            event.get("msg") or event.get("type") or "",
            event.get("msg_he"),
            event.get("data") or {},
            origin=event.get("origin") or "tlog",
        )

    def finalize(self, arm_t):
        rows = sorted(self.rows, key=lambda row: (row["t"] if row["t"] is not None else 0, row["type"], row["msg"]))
        collapsed = []
        for row in rows:
            if collapsed and row["type"] in ("fc.statustext", "fc.failsafe") and collapsed[-1]["type"] == row["type"]:
                prev = collapsed[-1]
                if prev["msg"] == row["msg"] and row["t"] is not None and prev["t"] is not None and (row["t"] - prev["t"]) <= 10.0:
                    prev["count"] = int(prev.get("count") or 1) + int(row.get("count") or 1)
                    prev["last_t"] = row["t"]
                    continue
            row["count"] = int(row.get("count") or 1)
            collapsed.append(row)
        for i, row in enumerate(collapsed):
            row["id"] = "E%04d" % (i + 1)
            row["t_rel_s"] = None if arm_t is None or row["t"] is None else round(row["t"] - arm_t, 3)
            if row.get("last_t") is not None and arm_t is not None:
                row["last_t_rel_s"] = round(row["last_t"] - arm_t, 3)
            else:
                row["last_t_rel_s"] = None
        self._link_causes(collapsed)
        return collapsed

    def _link_causes(self, rows):
        interesting = ("fc.failsafe", "fc.battery", "fc.gps_fix_change", "fc.gps_glitch_suspected", "fc.ekf_flags")
        for row in rows:
            row["cause_id"] = None
            if row["type"] != "fc.mode_change":
                continue
            to_mode = (row.get("data") or {}).get("to")
            if to_mode not in CAUSE_MODES:
                continue
            cause = None
            for prev in rows:
                if prev["id"] == row["id"]:
                    break
                if prev["type"] not in interesting:
                    continue
                if row["t"] is None or prev["t"] is None:
                    continue
                if 0 <= (row["t"] - prev["t"]) <= 3.0:
                    cause = prev["id"]
            row["cause_id"] = cause

    def _feed_heartbeat(self, t, obs):
        from flight_detector import accept_autopilot_heartbeat

        if not accept_autopilot_heartbeat(obs.get("comp"), obs.get("autopilot"), obs.get("mav_type"), obs.get("sysid"), self._locked):
            return
        if self._locked is None:
            self._locked = obs.get("sysid")
        armed = bool(obs.get("armed"))
        if self._armed is None:
            self._armed = armed
        elif armed != self._armed:
            self._armed = armed
            if armed:
                self._add(t, "fc", "fc.arm", "notice", "Autopilot armed", "הבקר חמוש", {})
            else:
                self._add(t, "fc", "fc.disarm", "notice", "Autopilot disarmed", "הבקר שוחרר", {})
        mode = mode_name(obs.get("custom_mode"))
        if mode is None:
            return
        if self._mode is None:
            self._mode = mode
            return
        if mode != self._mode:
            msg, msg_he = _mode_texts(self._mode, mode)
            self._add(t, "fc", "fc.mode_change", "info", msg, msg_he, {"from": self._mode, "to": mode})
            self._mode = mode

    def _feed_statustext(self, t, obs):
        text = obs.get("text") or ""
        sev = severity_name(obs.get("severity"))
        low = text.lower()
        etype = "fc.statustext"
        if any(hint in low for hint in FAILSAFE_HINTS):
            etype = "fc.failsafe"
            if sev == "info":
                sev = "warning"
        self._add(t, "fc", etype, sev, text, None, {"severity": obs.get("severity")})

    def _feed_gps(self, t, obs):
        fix = obs.get("fix_type")
        if fix is None:
            return
        if self._fix is None:
            self._fix = fix
            return
        if fix != self._fix:
            prev = self._fix
            self._fix = fix
            sev = "warning" if fix < 3 else "info"
            self._add(t, "fc", "fc.gps_fix_change", sev, "GPS fix %s → %s" % (prev, fix), "מצב לוויינים השתנה", {"from": prev, "to": fix, "sats": obs.get("sats")})

    def _add(self, t, src, etype, sev, msg, msg_he, data, origin="tlog"):
        self.rows.append(
            {
                "t": t,
                "src": src,
                "type": etype,
                "sev": sev,
                "msg": msg or "",
                "msg_he": msg_he,
                "data": data or {},
                "origin": origin,
                "count": 1,
            }
        )


def rows_to_jsonl_events(rows, arm_t):
    """Map finalized rows to the public event objects."""
    from flightlog_common import utc_iso

    out = []
    for row in rows:
        out.append(
            {
                "id": row["id"],
                "t_utc": utc_iso(row["t"]) if row.get("t") is not None else None,
                "t_rel_s": row.get("t_rel_s") if row.get("t_rel_s") is not None else 0,
                "src": row["src"],
                "type": row["type"],
                "sev": row["sev"],
                "msg": row["msg"],
                "msg_he": row.get("msg_he"),
                "data": row.get("data") or {},
                "origin": row.get("origin") or "tlog",
                "cause_id": row.get("cause_id"),
                "count": int(row.get("count") or 1),
                "last_t_rel_s": row.get("last_t_rel_s"),
            }
        )
    return out
