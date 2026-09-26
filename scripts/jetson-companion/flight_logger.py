# -*- coding: utf-8 -*-
"""Orchestrator: tap bytes → tlog, detector, events, packager."""

from __future__ import print_function

import json
import threading
import time
from pathlib import Path

from flight_detector import DetectorParams, FlightDetector, TICK_S, apply_obs, params_digest, sample_from_latest
from flight_events import obs_from_message
from flight_packager import package_flight
from flightlog_common import atomic_write_json, env_float, flight_id_for, index_key, utc_iso
from system_events import SystemEvents

PREROLL_DEFAULT = 60.0
POSTROLL_DEFAULT = 30.0


class FlightLogger(object):
    def __init__(self, spool_dir, vehicle_id, writer, uploader=None, params=None, system_events=None, prefix="v1"):
        self.spool = Path(spool_dir)
        self.spool.mkdir(parents=True, exist_ok=True)
        self.vehicle_id = vehicle_id
        self.writer = writer
        self.uploader = uploader
        self.prefix = prefix
        self.params = params or DetectorParams.from_env()
        self.detector = FlightDetector(self.params)
        self.system = system_events
        self.preroll = env_float("AIRVIX_FLIGHTLOG_PREROLL_S", PREROLL_DEFAULT)
        self.postroll = env_float("AIRVIX_FLIGHTLOG_POSTROLL_S", POSTROLL_DEFAULT)
        self.latest = {}
        self.locked = None
        self.extra_events = []
        self.system_lines = []
        self.flight_id = None
        self.pending_close_at = None
        self.last_pack = None
        self.time_source = "jetson_unsynced"
        self._last_tick = 0.0
        self._last_system = 0.0
        self._packaged_ids = []
        self._lock = threading.Lock()
        self.recover_open_session(time.time())

    def on_frame(self, t_wall, frame, msg):
        if frame:
            try:
                self.writer.append(t_wall, frame)
            except Exception:
                pass
        if msg is None:
            return
        try:
            obs = obs_from_message(t_wall, msg)
        except Exception:
            return
        with self._lock:
            self.locked = apply_obs(self.latest, obs, self.locked)
            if obs.get("name") == "SYSTEM_TIME" and obs.get("time_unix_usec"):
                self.time_source = "fc_system_time"

    def tick(self, now=None):
        now = time.time() if now is None else now
        if now - self._last_tick < TICK_S - 0.05 and self._last_tick:
            self._maybe_package(now)
            return None
        self._last_tick = now
        with self._lock:
            sample = sample_from_latest(self.latest, now)
            sample["hb_events"] = list(self.latest.get("hb_events") or [])
            self.latest["hb_events"] = []
        before = self.detector.state
        events = self.detector.tick(sample)
        for event in events:
            self.extra_events.append(event)
        if self.detector.state != before or any(ev.get("type") in ("flight.takeoff", "flight.landed", "flight.session_end", "fc.heartbeat_lost") for ev in events):
            self._persist()
        if before != "airborne" and self.detector.state == "airborne":
            self._publish_index("in_flight")
        if self.detector.closed and self.pending_close_at is None and self.flight_id:
            self.pending_close_at = now + self.postroll
            self._publish_index("processing")
            self._persist()
        if self.detector.state == "armed_ground" and self.flight_id is None and self.detector.arm_t:
            self.flight_id = flight_id_for(self.detector.arm_t, self.vehicle_id)
            self._persist()
        self._poll_system(now)
        self._maybe_package(now)
        if self.uploader is not None:
            self.uploader.armed = self.detector.state in ("armed_ground", "airborne", "landed_armed")
        self._protect_writer()
        return self.detector.snapshot()

    def recover_open_session(self, now):
        path = self.spool / "state.json"
        if not path.is_file():
            return
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return
        if not isinstance(saved, dict) or not saved.get("open"):
            return
        saved["end_reason"] = "companion_restart"
        saved["open"] = False
        saved["closed_t"] = now
        saved["classification"] = saved.get("classification") or _classify_saved(saved)
        saved["postroll_s"] = 0
        saved["preroll_s"] = self.preroll
        saved["extra_events"] = saved.get("extra_events") or []
        saved["system_lines"] = saved.get("system_lines") or []
        try:
            self.last_pack = package_flight(
                saved,
                self.spool,
                self.writer,
                self.uploader,
                saved.get("vehicle_id") or self.vehicle_id,
                self.prefix,
                self.time_source,
            )
            self._packaged_ids.append(saved.get("flight_id"))
        except Exception:
            self.last_pack = None
        saved["open"] = False
        atomic_write_json(path, saved)

    def status_view(self):
        snap = self.detector.snapshot()
        state = snap["state"] if snap["state"] != "closed" else "idle"
        if self.pending_close_at is not None and not self.detector.closed:
            state = snap["state"]
        if self.pending_close_at is not None and self.detector.closed:
            state = "packaging"
        flights = []
        root = self.spool / "flights"
        if root.is_dir():
            dirs = sorted(root.iterdir(), reverse=True)
            for folder in dirs[:20]:
                man = folder / "manifest.json"
                if not man.is_file():
                    continue
                try:
                    doc = json.loads(man.read_text(encoding="utf-8"))
                except Exception:
                    continue
                flights.append(
                    {
                        "flight_id": doc.get("flight_id"),
                        "classification": doc.get("classification"),
                        "state": doc.get("state"),
                    }
                )
        return {
            "state": state if state in ("idle", "armed_ground", "airborne", "landed_armed", "packaging") else "idle",
            "current_flight_id": None if self.detector.closed else self.flight_id,
            "detector": {"last_evidence": snap.get("evidence"), "params_digest": params_digest(self.params)},
            "flights_local": flights,
        }

    def _maybe_package(self, now):
        if self.pending_close_at is None or now < self.pending_close_at:
            return
        if self.flight_id is None:
            self.pending_close_at = None
            return
        snap = self.detector.snapshot()
        session = dict(snap)
        session["flight_id"] = self.flight_id
        session["vehicle_id"] = self.vehicle_id
        session["closed_t"] = now
        session["preroll_s"] = self.preroll
        session["postroll_s"] = self.postroll
        session["extra_events"] = list(self.extra_events)
        session["system_lines"] = list(self.system_lines)
        session["manifest_rev"] = 1
        try:
            self.last_pack = package_flight(session, self.spool, self.writer, self.uploader, self.vehicle_id, self.prefix, self._resolved_time_source())
            self._packaged_ids.append(self.flight_id)
        except Exception:
            self.last_pack = None
        self.pending_close_at = None
        self._reset_after_package()

    def _reset_after_package(self):
        self.detector = FlightDetector(self.params)
        self.flight_id = None
        self.extra_events = []
        self.system_lines = []
        self.latest = {}
        self.locked = None
        self._persist()

    def _persist(self):
        snap = self.detector.snapshot()
        doc = dict(snap)
        doc["flight_id"] = self.flight_id
        doc["vehicle_id"] = self.vehicle_id
        doc["open"] = bool(snap.get("open"))
        doc["updated_utc"] = utc_iso(time.time())
        doc["extra_events"] = self.extra_events[-400:]
        doc["system_lines"] = self.system_lines[-400:]
        atomic_write_json(self.spool / "state.json", doc)

    def _publish_index(self, state_name):
        if not self.flight_id or self.detector.arm_t is None:
            return
        snap = self.detector.snapshot()
        doc = {
            "schema": "airvix.flight.index/1",
            "flight_id": self.flight_id,
            "vehicle_id": self.vehicle_id,
            "classification": snap.get("classification") or "flight",
            "state": state_name,
            "manifest_rev": 1,
            "arm_utc": utc_iso(self.detector.arm_t),
            "takeoff_utc": utc_iso(snap.get("takeoff_t")),
            "landed_utc": utc_iso(snap.get("landed_t")),
            "disarm_utc": utc_iso(snap.get("disarm_t")),
            "time_source": self._resolved_time_source(),
            "modes": [],
            "warnings": 0,
            "errors": 0,
            "critical": 0,
            "end_reason": snap.get("end_reason") or "",
            "has_fc_log": False,
            "updated_utc": utc_iso(time.time()),
        }
        folder = self.spool / "staging" / self.flight_id
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / ("index-%s.json" % state_name)
        atomic_write_json(path, doc)
        if self.uploader is not None:
            try:
                self.uploader.enqueue_file(
                    self.flight_id,
                    "index-%s.json" % state_name,
                    str(path),
                    index_key(self.prefix, self.vehicle_id, self.flight_id, state_name),
                    "index",
                    10,
                )
            except Exception:
                pass

    def _poll_system(self, now):
        if self.system is None or now - self._last_system < 1.0:
            return
        self._last_system = now
        try:
            events = self.system.poll(now)
        except Exception:
            return
        for event in events:
            self.extra_events.append(event)
            try:
                self.system_lines.append(json.dumps(event, ensure_ascii=False, sort_keys=True, default=str))
            except Exception:
                continue

    def _protect_writer(self):
        ranges = []
        if self.flight_id and self.detector.arm_t:
            ranges.append((self.detector.arm_t - self.preroll, time.time() + self.postroll))
        # Un-uploaded flight windows stay protected.
        root = self.spool / "flights"
        if root.is_dir():
            for folder in root.iterdir():
                man = folder / "manifest.json"
                if not man.is_file():
                    continue
                try:
                    doc = json.loads(man.read_text(encoding="utf-8"))
                except Exception:
                    continue
                pending = any(art.get("state") in ("pending", "uploading") for art in doc.get("artifacts") or [])
                if not pending:
                    continue
                times = doc.get("times") or {}
                ranges.append((_parse_iso(times.get("window_start_utc")), _parse_iso(times.get("window_end_utc"))))
        try:
            self.writer.set_protected(ranges)
            self.writer.prune()
        except Exception:
            pass

    def _resolved_time_source(self):
        if self.time_source == "fc_system_time":
            return "fc_system_time"
        if _ntp_synced():
            return "ntp"
        return "jetson_unsynced"


def _classify_saved(saved):
    if saved.get("segments"):
        return "flight"
    if not saved.get("saw_telemetry"):
        return "unknown_no_telemetry"
    if float(saved.get("max_g") or 0) >= 3 or float(saved.get("max_disp") or 0) >= 8:
        return "ground_run"
    return "bench"


def _parse_iso(text):
    if not text:
        return None
    import datetime

    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.datetime.fromisoformat(text).timestamp()
    except Exception:
        return None


_NTP = None


def _ntp_synced():
    global _NTP
    if _NTP is not None:
        return _NTP
    import subprocess

    try:
        proc = subprocess.run(
            ["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=1.0,
            check=False,
        )
        _NTP = proc.stdout.decode("utf-8", "replace").strip().lower() == "yes"
    except Exception:
        _NTP = False
    return _NTP
