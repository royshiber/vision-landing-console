"""Unit tests for companion backup restore: armed refusal and auto-revert."""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import version_rollback as vr  # noqa: E402


def _tree(root: Path):
    live = root / "vlc-companion"
    backup = root / "vlc-companion.backups" / "20260926T100000Z"
    live.mkdir(parents=True)
    backup.mkdir(parents=True)
    (live / "marker.txt").write_text("LIVE", encoding="utf-8")
    (backup / "marker.txt").write_text("OLD", encoding="utf-8")
    vr.write_manifest(live, vr.manifest_fields("2.6.0", "2026-09-26T12:00:00Z", "aaa", False))
    vr.write_manifest(backup, vr.manifest_fields("2.5.0", "2026-09-26T10:00:00Z", "bbb", True, "20260926T100000Z"))
    return live, backup


class RollbackTests(unittest.TestCase):
    def test_armed_refusal_does_not_swap_or_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, _backup = _tree(Path(tmp))
            restarts = []
            status, body = vr.perform_rollback(
                live,
                "20260926T100000Z",
                armed=True,
                restart=lambda: restarts.append("restart"),
                wait_healthy=lambda _timeout: True,
                running_version="2.6.0",
                timeout_s=30,
            )
            self.assertEqual(status, 409)
            self.assertEqual(body["reason"], "armed")
            self.assertEqual((live / "marker.txt").read_text(encoding="utf-8"), "LIVE")
            self.assertEqual(restarts, [])

    def test_auto_revert_when_health_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, backup = _tree(Path(tmp))
            restarts = []
            status, body = vr.perform_rollback(
                live,
                "20260926T100000Z",
                armed=False,
                restart=lambda: restarts.append("restart"),
                wait_healthy=lambda _timeout: False,
                running_version="2.6.0",
                timeout_s=30,
            )
            self.assertEqual(status, 200)
            self.assertTrue(body["reverted"])
            self.assertEqual(body["from"], "2.6.0")
            self.assertEqual(body["to"], "2.5.0")
            self.assertEqual((live / "marker.txt").read_text(encoding="utf-8"), "LIVE")
            self.assertEqual((backup / "marker.txt").read_text(encoding="utf-8"), "OLD")
            self.assertEqual(restarts, ["restart", "restart"])

    def test_successful_swap_restarts_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, backup = _tree(Path(tmp))
            restarts = []
            status, body = vr.perform_rollback(
                live,
                "20260926T100000Z",
                armed=False,
                restart=lambda: restarts.append("restart"),
                wait_healthy=lambda _timeout: True,
                running_version="2.6.0",
                timeout_s=30,
            )
            self.assertEqual(status, 200)
            self.assertTrue(body["ok"])
            self.assertFalse(body["reverted"])
            self.assertEqual((live / "marker.txt").read_text(encoding="utf-8"), "OLD")
            self.assertEqual((backup / "marker.txt").read_text(encoding="utf-8"), "LIVE")
            self.assertEqual(restarts, ["restart"])

    def test_snapshot_writes_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "vlc-companion"
            dest.mkdir()
            (dest / "companion_agent.py").write_text("print(1)\n", encoding="utf-8")
            vr.write_live_manifest(dest, "2.6.0", "abc123", "2026-09-26T12:00:00Z", False)
            snap = vr.snapshot_existing(dest)
            self.assertEqual(snap["version"], "2.6.0")
            self.assertEqual(snap["git_sha"], "abc123")
            self.assertFalse(snap["known_good"])
            self.assertTrue(vr.valid_backup_id(snap["id"]))
            stored = json.loads((vr.backups_root(dest) / snap["id"] / vr.MANIFEST_NAME).read_text(encoding="utf-8"))
            self.assertEqual(stored["deployed_at"], "2026-09-26T12:00:00Z")

    def test_second_swap_is_rejected_while_the_lock_is_held(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, _backup = _tree(Path(tmp))
            held = vr.acquire_rollback_lock(live)
            self.assertIsNotNone(held)
            try:
                status, body = vr.perform_rollback(
                    live,
                    "20260926T100000Z",
                    armed=False,
                    restart=lambda: None,
                    wait_healthy=lambda _timeout: True,
                    running_version="2.6.0",
                )
            finally:
                vr.release_rollback_lock(held)
            self.assertEqual(status, 409)
            self.assertEqual(body["reason"], "busy")
            self.assertEqual((live / "marker.txt").read_text(encoding="utf-8"), "LIVE")

    def test_failed_armed_check_is_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, _backup = _tree(Path(tmp))

            def blocked():
                raise RuntimeError("fc down")

            status, body = vr.perform_rollback(
                live,
                "20260926T100000Z",
                blocked=blocked,
                restart=lambda: None,
                wait_healthy=lambda _timeout: True,
                running_version="2.6.0",
            )
            self.assertEqual(status, 409)
            self.assertEqual(body["reason"], "unknown")
            self.assertEqual((live / "marker.txt").read_text(encoding="utf-8"), "LIVE")

    def test_recheck_blocks_immediately_before_the_swap(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, _backup = _tree(Path(tmp))
            calls = {"n": 0}

            def blocked():
                calls["n"] += 1
                return None if calls["n"] == 1 else "armed"

            status, body = vr.perform_rollback(
                live,
                "20260926T100000Z",
                blocked=blocked,
                restart=lambda: None,
                wait_healthy=lambda _timeout: True,
                running_version="2.6.0",
            )
            self.assertGreaterEqual(calls["n"], 2)
            self.assertEqual(status, 409)
            self.assertEqual(body["reason"], "armed")
            self.assertEqual(body["state"], "failed")
            self.assertEqual((live / "marker.txt").read_text(encoding="utf-8"), "LIVE")
            stored = json.loads((vr.backups_root(live) / vr.RESULT_NAME).read_text(encoding="utf-8"))
            self.assertEqual(stored["state"], "failed")

    def test_http_claim_rejects_a_second_swap(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, _backup = _tree(Path(tmp))
            vr.write_flight_gate(live, False, False)
            previous = os.environ.get("VLC_COMPANION_DEST")
            os.environ["VLC_COMPANION_DEST"] = str(live)
            ctx = vr.build_context("2.6.0", None)
            ctx["inline"] = False
            ctx["dest"] = live
            spawned = []
            original = vr.spawn_worker
            vr.spawn_worker = lambda *args, **kwargs: spawned.append(args)
            try:
                first, first_body = vr.http_post(
                    "/api/v1/versions/rollback",
                    {"confirm": True, "backup_id": "20260926T100000Z"},
                    ctx,
                )
                second, second_body = vr.http_post(
                    "/api/v1/versions/rollback",
                    {"confirm": True, "backup_id": "20260926T100000Z"},
                    ctx,
                )
            finally:
                vr.spawn_worker = original
                vr.release_claim(live)
                if previous is None:
                    os.environ.pop("VLC_COMPANION_DEST", None)
                else:
                    os.environ["VLC_COMPANION_DEST"] = previous
            self.assertEqual(first, 202)
            self.assertEqual(second, 409)
            self.assertEqual(second_body["reason"], "busy")
            self.assertEqual(len(spawned), 1)
            self.assertEqual(first_body["state"], "restarting")

    def test_flight_gate_cases(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, _backup = _tree(Path(tmp))
            now = time.time()
            self.assertEqual(vr.read_flight_gate(live, now), "missing")
            vr.write_flight_gate(live, False, False, now)
            self.assertIsNone(vr.read_flight_gate(live, now))
            vr.write_flight_gate(live, True, False, now)
            self.assertEqual(vr.read_flight_gate(live, now), "armed")
            vr.write_flight_gate(live, False, True, now)
            self.assertEqual(vr.read_flight_gate(live, now), "in_flight")
            vr.write_flight_gate(live, None, False, now)
            self.assertEqual(vr.read_flight_gate(live, now), "unknown")
            vr.write_flight_gate(live, False, False, now - 4)
            self.assertEqual(vr.read_flight_gate(live, now), "stale")
            restarts = []
            status, body = vr.perform_rollback(
                live,
                "20260926T100000Z",
                blocked=lambda: vr.read_flight_gate(live, now),
                restart=lambda: restarts.append("restart"),
                wait_healthy=lambda _timeout: True,
                running_version="2.6.0",
            )
            self.assertEqual(status, 409)
            self.assertEqual(body["reason"], "stale")
            self.assertEqual(body["message"], "לא ניתן לשחזר כרגע: מצב הטיסה לא עדכני.")
            self.assertEqual((live / "marker.txt").read_text(encoding="utf-8"), "LIVE")
            self.assertEqual(restarts, [])
            vr.write_flight_gate(live, False, False, now)
            status, body = vr.perform_rollback(
                live,
                "20260926T100000Z",
                blocked=lambda: vr.read_flight_gate(live, now),
                restart=lambda: restarts.append("restart"),
                wait_healthy=lambda _timeout: True,
                running_version="2.6.0",
            )
            self.assertEqual(status, 200)
            self.assertTrue(body["ok"])
            self.assertEqual(restarts, ["restart"])

    def test_env_allow_does_not_skip_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, _backup = _tree(Path(tmp))
            previous_refuse = os.environ.get("VLC_VERSIONS_REFUSE")
            previous_dest = os.environ.get("VLC_COMPANION_DEST")
            os.environ["VLC_VERSIONS_REFUSE"] = "0"
            os.environ["VLC_COMPANION_DEST"] = str(live)
            try:
                self.assertEqual(vr.read_flight_block(), "missing")
                vr.write_flight_gate(live, True, False)
                self.assertEqual(vr.read_flight_block(), "armed")
            finally:
                if previous_refuse is None:
                    os.environ.pop("VLC_VERSIONS_REFUSE", None)
                else:
                    os.environ["VLC_VERSIONS_REFUSE"] = previous_refuse
                if previous_dest is None:
                    os.environ.pop("VLC_COMPANION_DEST", None)
                else:
                    os.environ["VLC_COMPANION_DEST"] = previous_dest
        root = Path(__file__).resolve().parents[1]
        for name in ("version_rollback.py", "companion_agent.py"):
            self.assertNotIn("VLC_VERSIONS_REFUSE", (root / name).read_text(encoding="utf-8"))

    def test_live_heartbeat_is_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, _backup = _tree(Path(tmp))
            previous_refuse = os.environ.get("VLC_VERSIONS_REFUSE")
            previous_dest = os.environ.get("VLC_COMPANION_DEST")
            os.environ["VLC_VERSIONS_REFUSE"] = "0"
            os.environ["VLC_COMPANION_DEST"] = str(live)
            import companion_agent
            from fc_telemetry import reset_fc_observer
            try:
                reset_fc_observer()
                self.assertEqual(companion_agent._versions_blocked(), "unknown")
                companion_agent.observe_uart_bytes(_heartbeat(0x80, 3))
                self.assertEqual(companion_agent._versions_blocked(), "armed")
                reset_fc_observer()
                companion_agent.observe_uart_bytes(_heartbeat(0, 4))
                self.assertEqual(companion_agent._versions_blocked(), "in_flight")
                reset_fc_observer()
                companion_agent.observe_uart_bytes(_heartbeat(0, 3))
                self.assertIsNone(companion_agent._versions_blocked())
            finally:
                reset_fc_observer()
                if previous_refuse is None:
                    os.environ.pop("VLC_VERSIONS_REFUSE", None)
                else:
                    os.environ["VLC_VERSIONS_REFUSE"] = previous_refuse
                if previous_dest is None:
                    os.environ.pop("VLC_COMPANION_DEST", None)
                else:
                    os.environ["VLC_COMPANION_DEST"] = previous_dest


def _heartbeat(base_mode: int, system_status: int) -> bytes:
    payload = bytes([0, 0, 0, 0, 1, 3, base_mode, system_status, 3])
    body = bytes([len(payload), 1, 1, 1, 0]) + payload
    crc = vr_crc(body + bytes([50]))
    return bytes([0xFE]) + body + bytes([crc & 0xFF, (crc >> 8) & 0xFF])


def vr_crc(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        tmp = (byte ^ (crc & 0xFF)) & 0xFF
        tmp = (tmp ^ ((tmp << 4) & 0xFF)) & 0xFF
        crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF
    return crc


if __name__ == "__main__":
    unittest.main()
