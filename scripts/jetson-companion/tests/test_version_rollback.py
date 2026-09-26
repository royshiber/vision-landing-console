"""Unit tests for companion backup restore: armed refusal and auto-revert."""

import json
import sys
import tempfile
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
            ctx = vr.build_context("2.6.0", False)
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
            self.assertEqual(first, 202)
            self.assertEqual(second, 409)
            self.assertEqual(second_body["reason"], "busy")
            self.assertEqual(len(spawned), 1)
            self.assertEqual(first_body["state"], "restarting")



if __name__ == "__main__":
    unittest.main()
