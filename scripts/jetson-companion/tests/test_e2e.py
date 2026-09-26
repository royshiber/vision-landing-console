# -*- coding: utf-8 -*-
"""Fake relay at 10x: package, redaction, reconnect, RSS."""

from __future__ import print_function

import gzip
import json
import os
import resource
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from flight_logger import FlightLogger  # noqa: E402
from log_uploader import LogUploader, load_upload_config  # noqa: E402
from mav_tap import MavTap  # noqa: E402
from system_events import SystemEvents  # noqa: E402
from tlog_writer import TlogWriter, iter_records  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures" / "hand.tlog"
MANIFEST_KEYS = [
    "schema",
    "manifest_rev",
    "flight_id",
    "vehicle_id",
    "classification",
    "state",
    "end_reason",
    "times",
    "segments",
    "detector",
    "versions",
    "artifacts",
    "counts",
    "upload",
    "created_utc",
    "updated_utc",
]


class _Health(BaseHTTPRequestHandler):
    state = "idle"

    def do_GET(self):
        body = json.dumps(
            {
                "ok": True,
                "relay_clients": 1,
                "uart_bytes_rx": 10,
                "fc": {"connected": True},
                "modem": {"present": True, "state": _Health.state},
                "system": {"tempC": 40},
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        return


def _replay(frames, speed, ready):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    srv.settimeout(0.5)
    ready.append(srv.getsockname()[1])
    idx = 0
    dropped = False
    t0 = frames[0][0]
    try:
        while idx < len(frames):
            try:
                conn, _addr = srv.accept()
            except socket.timeout:
                continue
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            base = time.monotonic() - ((frames[idx][0] - t0) / speed)
            while idx < len(frames):
                ts, frame = frames[idx]
                delay = (base + ((ts - t0) / speed)) - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                try:
                    conn.sendall(frame)
                except OSError:
                    break
                idx += 1
                if not dropped and ts - t0 >= 3.0:
                    dropped = True
                    conn.close()
                    break
            else:
                try:
                    conn.close()
                except OSError:
                    pass
    finally:
        srv.close()


class E2ETests(unittest.TestCase):
    def test_hand_replay_packages_and_redacts(self):
        os.environ["AIRVIX_FD_CONFIRM_S"] = "0.6"
        os.environ["AIRVIX_FD_LAND_STILL_S"] = "1.0"
        os.environ["AIRVIX_FLIGHTLOG_POSTROLL_S"] = "0.4"
        os.environ["AIRVIX_FLIGHTLOG_PREROLL_S"] = "2"
        os.environ["AIRVIX_FLIGHTLOG_DERIVE_INLINE"] = "1"
        os.environ["AIRVIX_UPLOAD_ENABLED"] = "0"
        os.environ["AIRVIX_UPLOAD_ENDPOINT"] = ""
        os.environ["AIRVIX_UPLOAD_SECRET"] = ""
        os.environ["AIRVIX_UPLOAD_APP_KEY"] = ""
        frames = list(iter_records(FIX))
        self.assertGreater(len(frames), 10)
        rss_peak = {"kb": 0}
        cpu0 = resource.getrusage(resource.RUSAGE_SELF)
        wall0 = time.perf_counter()
        with tempfile.TemporaryDirectory() as tmp:
            journal = Path(tmp) / "journal.jsonl"
            journal.write_text(
                '{"MESSAGE":"Bearer abc123"}\nAIRVIX_UPLOAD_APP_KEY=supersecretvalue\nAIRVIX_UPLOAD_SECRET=othersecretvalue\n',
                encoding="utf-8",
            )
            os.environ["AIRVIX_FLIGHTLOG_JOURNAL_OVERRIDE"] = str(journal)
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Health)
            http_port = httpd.server_address[1]
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            ready = []
            threading.Thread(target=_replay, args=(frames, 10.0, ready), daemon=True).start()
            while not ready:
                time.sleep(0.01)
            spool = Path(tmp) / "spool"
            writer = TlogWriter(spool, quota_mb=64, retention_days=14)
            up = LogUploader(spool, cfg=load_upload_config(), sleep_fn=lambda _s: None)
            system = SystemEvents("http://127.0.0.1:%s" % http_port, timeout=0.3)
            logger = FlightLogger(spool, "airvix-test", writer, uploader=up, system_events=system, prefix="v1")
            tap = MavTap("127.0.0.1", ready[0], logger.on_frame)
            tap.start()
            stop = threading.Event()

            def _tick():
                _Health.state = "idle"
                flipped = False
                while not stop.is_set():
                    logger.tick()
                    if not flipped and tap.frames > 20:
                        _Health.state = "up Bearer abc123"
                        flipped = True
                    try:
                        with open("/proc/self/status", encoding="utf-8") as handle:
                            rss = int(handle.read().split("VmRSS:")[1].split()[0])
                        rss_peak["kb"] = max(rss_peak["kb"], rss)
                    except Exception:
                        pass
                    if logger.last_pack is not None:
                        break
                    time.sleep(0.15)

            worker = threading.Thread(target=_tick)
            worker.start()
            worker.join(40)
            stop.set()
            status = up.status()
            tap.close()
            writer.close()
            up.close()
            httpd.shutdown()
            self.assertIsNotNone(logger.last_pack, "package was not built")
            self.assertGreaterEqual(tap.reconnects, 1)
            folder = Path(logger.last_pack["dir"])
            for name in (
                "manifest.json",
                "summary.json",
                "events.jsonl.gz",
                "series.json.gz",
                "track.geojson.gz",
                "telemetry.tlog.gz",
                "jetson/journal.jsonl.gz",
                "jetson/system.jsonl.gz",
            ):
                self.assertTrue((folder / name).is_file(), name)
            manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
            for key in MANIFEST_KEYS:
                self.assertIn(key, manifest)
            self.assertEqual(manifest["schema"], "airvix.flight.manifest/1")
            events = gzip.open(folder / "events.jsonl.gz", "rt", encoding="utf-8").read()
            self.assertIn("fc.mode_change", events)
            self.assertIn("מצב טיסה", events)
            journal_txt = gzip.open(folder / "jetson" / "journal.jsonl.gz", "rt", encoding="utf-8").read()
            system_txt = gzip.open(folder / "jetson" / "system.jsonl.gz", "rt", encoding="utf-8").read()
            blob = journal_txt + "\n" + system_txt + "\n" + json.dumps(manifest)
            self.assertNotIn("abc123", blob)
            self.assertNotIn("supersecretvalue", blob)
            self.assertNotIn("othersecretvalue", blob)
            self.assertIn("[redacted]", journal_txt)
            from pymavlink import mavutil

            tlog = folder / "telemetry.tlog"
            self.assertGreater(tlog.stat().st_size, 8)
            _ts, frame = next(iter_records(tlog))
            self.assertEqual(frame[0], 0xFD)
            mlog = mavutil.mavlink_connection(str(tlog))
            msg = mlog.recv_match(blocking=False)
            self.assertIsNotNone(msg)
            self.assertEqual(status["credential"], "absent")
            self.assertFalse(status["enabled"])
            print("FLIGHTLOG_E2E_RSS_KB %s" % rss_peak["kb"])
            print("FLIGHTLOG_E2E_STATUS %s" % json.dumps(logger.status_view(), sort_keys=True, default=str)[:800])
            print("FLIGHTLOG_E2E_MANIFEST %s" % json.dumps(manifest, sort_keys=True)[:1200])
        cpu1 = resource.getrusage(resource.RUSAGE_SELF)
        wall = max(0.001, time.perf_counter() - wall0)
        cpu = (cpu1.ru_utime + cpu1.ru_stime) - (cpu0.ru_utime + cpu0.ru_stime)
        print("FLIGHTLOG_E2E_CPU %.3f wall %.3f ratio %.3f" % (cpu, wall, cpu / wall))
        self.assertLess(rss_peak["kb"], 80 * 1024)
        self.assertLess(cpu / wall, 1.0)


if __name__ == "__main__":
    unittest.main()
