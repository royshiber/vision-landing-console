# -*- coding: utf-8 -*-
"""Non-blocking tap, disabled service, companion status hook."""

from __future__ import print_function

import json
import os
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
sys.path.insert(0, str(ROOT))

from mav_tap import MavTap  # noqa: E402


class TapTests(unittest.TestCase):
    def test_stalled_decoder_does_not_block_the_relay(self):
        stall = threading.Event()
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        tap = MavTap("127.0.0.1", port, lambda *_a: None, stall=stall)
        tap.queue = queue.Queue(maxsize=2)
        tap.start()
        conn, _addr = server.accept()
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        deadline = time.time() + 2
        while not tap.connected and time.time() < deadline:
            time.sleep(0.01)
        slow = 0.0
        for _ in range(40):
            blob = b"\xfd" + os.urandom(64)
            t0 = time.perf_counter()
            conn.sendall(blob)
            slow = max(slow, time.perf_counter() - t0)
            time.sleep(0.02)
        time.sleep(0.2)
        self.assertLess(slow, 0.05)
        self.assertGreater(tap.drops, 0)
        stall.set()
        tap.close()
        conn.close()
        server.close()


class ServiceTests(unittest.TestCase):
    def test_disabled_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            status = Path(tmp) / "status.json"
            env = os.environ.copy()
            env.pop("AIRVIX_FLIGHTLOG_ENABLED", None)
            env["AIRVIX_FLIGHTLOG_DIR"] = tmp
            env["AIRVIX_FLIGHTLOG_STATUS_FILE"] = str(status)
            env["AIRVIX_UPLOAD_ENABLED"] = "0"
            env["AIRVIX_UPLOAD_APP_KEY"] = ""
            proc = subprocess.run(
                [sys.executable, str(ROOT / "flightlog_service.py")],
                cwd=str(ROOT),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=20,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))
            doc = json.loads(status.read_text(encoding="utf-8"))
            self.assertFalse(doc["enabled"])
            self.assertEqual(doc["fc_log"]["state"], "not_implemented")
            self.assertEqual(doc["uploader"]["credential"], "absent")

    def test_self_test_when_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = os.environ.copy()
            env["AIRVIX_FLIGHTLOG_ENABLED"] = "0"
            env["AIRVIX_FLIGHTLOG_DIR"] = tmp
            env["AIRVIX_FLIGHTLOG_STATUS_FILE"] = str(Path(tmp) / "status.json")
            proc = subprocess.run(
                [sys.executable, str(ROOT / "flightlog_service.py"), "--self-test"],
                cwd=str(ROOT),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=20,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))
            doc = json.loads(proc.stdout.decode("utf-8"))
            self.assertFalse(doc["enabled"])
            self.assertNotIn("app_key", json.dumps(doc).lower())


class CompanionHookTests(unittest.TestCase):
    def test_status_missing_valid_and_garbage(self):
        agent = (REPO / "scripts" / "jetson-companion" / "companion_agent.py").read_text(encoding="utf-8")
        self.assertIn("uart_reader", agent)
        self.assertIn("fanout_uart", agent)
        self.assertIn('"2.5.0"', agent)
        self.assertNotIn("ARM", agent)
        self.assertNotIn(".recv_match(", agent)
        joined = "\n".join(path.read_text(encoding="utf-8") for path in ROOT.glob("flight*.py"))
        self.assertNotIn("/dev/ttyACM0", joined)
        with tempfile.TemporaryDirectory() as tmp:
            status = Path(tmp) / "flightlog.json"
            env = os.environ.copy()
            env["VLC_SKIP_RELAY"] = "1"
            env["VLC_HTTP_BIND"] = "127.0.0.1"
            env["VLC_HTTP_PORT"] = "0"
            env["VLC_UPLINK_BOOT"] = "0"
            env["VLC_GIMBAL_POLL"] = "0"
            env["VLC_COMPANION_TOKEN"] = ""
            env["AIRVIX_FLIGHTLOG_STATUS_FILE"] = str(status)
            # Port 0 is not honored (int default). Pick a free port.
            sock = socket.socket()
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
            sock.close()
            env["VLC_HTTP_PORT"] = str(port)
            proc = subprocess.Popen(
                [sys.executable, str(ROOT / "companion_agent.py")],
                cwd=str(ROOT),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            try:
                self._wait_http(port)
                missing = self._get(port, "/api/v1/flight-log/status")
                self.assertFalse(missing["present"])
                self.assertEqual(missing["state"], "absent")
                status.write_text(json.dumps({"enabled": False, "state": "idle", "credential": "absent"}), encoding="utf-8")
                valid = self._get(port, "/api/flight-log/status")
                self.assertTrue(valid["present"])
                self.assertEqual(valid["state"], "idle")
                status.write_text("not-json", encoding="utf-8")
                garbage = self._get(port, "/api/v1/flight-log/status")
                self.assertFalse(garbage["present"])
                self.assertIn("error", garbage)
                health = self._get(port, "/api/health")
                self.assertIn("flight_log", health)
                self.assertFalse(health["flight_log"]["present"])
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()

    def _wait_http(self, port):
        deadline = time.time() + 8
        last = None
        while time.time() < deadline:
            try:
                self._get(port, "/api/health")
                return
            except Exception as exc:
                last = exc
                time.sleep(0.1)
        raise AssertionError("companion http did not start: %s" % last)

    def _get(self, port, path):
        with urllib.request.urlopen("http://127.0.0.1:%s%s" % (port, path), timeout=2) as resp:
            return json.loads(resp.read().decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
