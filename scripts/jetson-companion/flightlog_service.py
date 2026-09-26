#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AIRVIX flight logger entry point. Disabled unless AIRVIX_FLIGHTLOG_ENABLED=1."""

from __future__ import print_function

import json
import os
import signal
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from flight_logger import FlightLogger  # noqa: E402
from flightlog_common import (  # noqa: E402
    FLIGHTLOG_VERSION,
    atomic_write_json,
    choose_spool_dir,
    disk_free_mb,
    env_flag,
    env_str,
    hostname_vehicle,
    public_status,
    status_path,
    utc_iso,
)
from log_uploader import LogUploader, load_upload_config  # noqa: E402
from mav_tap import MavTap, parse_relay  # noqa: E402
from system_events import SystemEvents  # noqa: E402
from tlog_writer import TlogWriter  # noqa: E402


class FlightLogService(object):
    def __init__(self):
        self.stop = threading.Event()
        self.spool = choose_spool_dir()
        self.status_file = status_path(self.spool)
        self.vehicle_id = hostname_vehicle()
        self.writer = None
        self.uploader = None
        self.logger = None
        self.tap = None
        self.tap_error = None
        self._threads = []
        self._status_mono = 0.0

    def disabled_status(self, reason):
        return {
            "ok": True,
            "present": True,
            "enabled": False,
            "reason": reason,
            "state": "idle",
            "current_flight_id": None,
            "detector": {"last_evidence": None, "params_digest": None},
            "tap": {"connected": False, "bytes": 0, "frames": 0, "drops": 0, "bad_data": 0, "last_msg_age_s": None},
            "tlog": {"segment": None, "disk_free_mb": disk_free_mb(self.spool), "quota_used_mb": 0},
            "uploader": {
                "enabled": False,
                "credential": "absent",
                "reason": reason,
                "network": "none",
                "queue_jobs": 0,
                "queue_bytes": 0,
                "last_success_utc": None,
                "last_error": None,
                "auth_failed": False,
                "cell_used_today_mb": 0,
            },
            "fc_log": {"enabled": False, "state": "not_implemented"},
            "flights_local": [],
            "updated_utc": utc_iso(time.time()),
            "version": FLIGHTLOG_VERSION,
        }

    def write_status(self, doc, force=False):
        now = time.monotonic()
        if not force and self._status_mono and (now - self._status_mono) < 1.0:
            return False
        self._status_mono = now
        atomic_write_json(self.status_file, public_status(doc))
        return True

    def build_status(self):
        view = self.logger.status_view() if self.logger else {"state": "idle", "current_flight_id": None, "detector": {}, "flights_local": []}
        up = self.uploader.status() if self.uploader else self.disabled_status("disabled")["uploader"]
        tap = {
            "connected": bool(self.tap and self.tap.connected),
            "bytes": 0 if not self.tap else self.tap.bytes,
            "frames": 0 if not self.tap else self.tap.frames,
            "drops": 0 if not self.tap else self.tap.drops,
            "bad_data": 0 if not self.tap else self.tap.bad_data,
            "last_msg_age_s": None if not self.tap else self.tap.last_msg_age_s(),
            "reconnects": 0 if not self.tap else self.tap.reconnects,
        }
        return {
            "ok": True,
            "present": True,
            "enabled": True,
            "reason": None if not self.tap_error else self.tap_error,
            "state": view.get("state") or "idle",
            "current_flight_id": view.get("current_flight_id"),
            "detector": view.get("detector") or {},
            "tap": tap,
            "tlog": {
                "segment": None if not self.writer else self.writer.segment,
                "disk_free_mb": disk_free_mb(self.spool),
                "quota_used_mb": None if not self.writer else round(self.writer.quota_used_mb(), 3),
            },
            "uploader": up,
            "fc_log": {"enabled": False, "state": "not_implemented"},
            "flights_local": view.get("flights_local") or [],
            "updated_utc": utc_iso(time.time()),
            "version": FLIGHTLOG_VERSION,
        }

    def start(self):
        self.writer = TlogWriter(self.spool)
        cfg = load_upload_config()
        self.uploader = LogUploader(self.spool, cfg=cfg)
        port = env_str("VLC_HTTP_PORT", "8081")
        token = env_str("VLC_COMPANION_TOKEN", "")
        system = SystemEvents("http://127.0.0.1:%s" % port, token=token)
        self.logger = FlightLogger(
            self.spool,
            self.vehicle_id,
            self.writer,
            uploader=self.uploader,
            system_events=system,
            prefix=cfg.get("prefix") or "v1",
        )
        host, relay_port = parse_relay(env_str("AIRVIX_FLIGHTLOG_RELAY", "127.0.0.1:5770"))
        try:
            self.tap = MavTap(host, relay_port, self.logger.on_frame)
            self.tap.start()
        except Exception as exc:
            self.tap = None
            self.tap_error = str(exc)[:160]

        def _supervise(name, fn):
            delay = 1.0
            while not self.stop.is_set():
                try:
                    fn()
                except Exception:
                    time.sleep(delay)
                    delay = min(10.0, delay * 2)
                    continue
                delay = 1.0

        def _tick_loop():
            while not self.stop.is_set():
                try:
                    self.logger.tick()
                except Exception:
                    pass
                self.stop.wait(0.2)

        def _upload_loop():
            while not self.stop.is_set():
                try:
                    if self.uploader is not None:
                        self.uploader.step()
                except Exception:
                    pass
                self.stop.wait(0.5)

        def _status_loop():
            while not self.stop.is_set():
                try:
                    self.write_status(self.build_status())
                except Exception:
                    pass
                self.stop.wait(1.0)

        for name, fn in (("tick", _tick_loop), ("upload", _upload_loop), ("status", _status_loop)):
            thread = threading.Thread(target=_supervise, args=(name, fn), name="flightlog-" + name, daemon=True)
            thread.start()
            self._threads.append(thread)
        # _supervise calls fn() which loops until stop, so a crash restarts. The inner loops
        # already catch exceptions. Supervision still restarts if they return.

    def shutdown(self):
        self.stop.set()
        if self.tap is not None:
            self.tap.close()
        if self.writer is not None:
            self.writer.flush()
            self.writer.close()
        if self.logger is not None:
            try:
                self.logger._persist()
            except Exception:
                pass
        try:
            self.write_status(self.build_status() if self.logger else self.disabled_status("stopped"), force=True)
        except Exception:
            pass
        if self.uploader is not None:
            self.uploader.close()


def pymavlink_ok():
    try:
        import pymavlink.dialects.v20.ardupilotmega  # noqa: F401

        return True
    except Exception:
        return False


def main(argv):
    service = FlightLogService()
    self_test = "--self-test" in argv
    if not env_flag("AIRVIX_FLIGHTLOG_ENABLED", "0"):
        doc = service.disabled_status("disabled")
        service.write_status(doc, force=True)
        if self_test:
            print(json.dumps(doc, sort_keys=True))
        return 0
    if not pymavlink_ok():
        doc = service.disabled_status("pymavlink_missing")
        service.write_status(doc, force=True)
        if self_test:
            print(json.dumps(doc, sort_keys=True))
        return 0
    if self_test:
        service.writer = TlogWriter(service.spool)
        service.uploader = LogUploader(service.spool, cfg=load_upload_config())
        doc = service.build_status()
        doc["enabled"] = True
        service.write_status(doc, force=True)
        print(json.dumps(public_status(doc), sort_keys=True))
        service.uploader.close()
        service.writer.close()
        return 0

    def _stop(_signum, _frame):
        service.shutdown()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    service.start()
    while not service.stop.is_set():
        time.sleep(0.5)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
