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


if __name__ == "__main__":
    unittest.main()
