#!/usr/bin/env python3
"""Timestamped backups of the companion tree and a safe restore.

Deploy copies ~/vlc-companion to ~/vlc-companion.backups/YYYYMMDDTHHMMSSZ
before replacing it, and writes airvix-deploy.json (version, time, git sha,
known_good). Restore swaps that directory back, restarts airvix-companion,
and swaps it back again if health does not return within about 30 seconds.
Refuses while the flight controller reports armed.
"""

from __future__ import annotations

import calendar
import fcntl
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

MANIFEST_NAME = "airvix-deploy.json"
RESULT_NAME = "rollback-result.json"
STAMP_LEN = 16  # YYYYMMDDTHHMMSSZ
HEALTH_TIMEOUT_S = 30.0
SERVICE_NAME = "airvix-companion"


def backups_root(dest: Path) -> Path:
    return dest.with_name(dest.name + ".backups")


def stamp_now(now=None) -> str:
    moment = now or time.gmtime()
    return time.strftime("%Y%m%dT%H%M%SZ", moment)


def valid_backup_id(backup_id: str) -> bool:
    text = str(backup_id or "")
    if len(text) != STAMP_LEN or text[8] != "T" or not text.endswith("Z"):
        return False
    body = text[:8] + text[9:15]
    return body.isdigit()


def read_manifest(tree: Path) -> dict | None:
    path = tree / MANIFEST_NAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def write_manifest(tree: Path, payload: dict) -> None:
    tree.mkdir(parents=True, exist_ok=True)
    path = tree / MANIFEST_NAME
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _clean(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def manifest_fields(version, deployed_at, git_sha, known_good, backup_id=None) -> dict:
    body = {
        "version": _clean(version),
        "deployed_at": _clean(deployed_at),
        "git_sha": _clean(git_sha),
        "known_good": bool(known_good),
    }
    if backup_id:
        body["id"] = backup_id
    return body


def snapshot_existing(dest: Path, now=None) -> dict | None:
    """Copy the live tree aside before a deploy replaces it. Nothing is invented."""
    dest = Path(dest)
    if not dest.is_dir():
        return None
    try:
        has_files = any(dest.iterdir())
    except OSError:
        return None
    if not has_files:
        return None
    previous = read_manifest(dest) or {}
    base = time.time() if now is None else calendar.timegm(now)
    root = backups_root(dest)
    root.mkdir(parents=True, exist_ok=True)
    target = None
    backup_id = None
    for step in range(8):
        backup_id = stamp_now(time.gmtime(base + step))
        candidate = root / backup_id
        if not candidate.exists():
            target = candidate
            break
    if target is None or backup_id is None:
        return None
    shutil.copytree(dest, target, symlinks=True)
    payload = manifest_fields(
        previous.get("version"),
        previous.get("deployed_at"),
        previous.get("git_sha"),
        previous.get("known_good") is True,
        backup_id=target.name,
    )
    write_manifest(target, payload)
    return payload


def write_live_manifest(dest: Path, version, git_sha, deployed_at, known_good=False) -> dict:
    payload = manifest_fields(version, deployed_at, git_sha, known_good)
    write_manifest(Path(dest), payload)
    return payload


def list_backups(dest: Path) -> list[dict]:
    root = backups_root(Path(dest))
    if not root.is_dir():
        return []
    rows = []
    for child in root.iterdir():
        if not child.is_dir() or not valid_backup_id(child.name):
            continue
        manifest = read_manifest(child) or {}
        rows.append({
            "id": child.name,
            "version": _clean(manifest.get("version")),
            "deployed_at": _clean(manifest.get("deployed_at")),
            "git_sha": _clean(manifest.get("git_sha")),
            "known_good": manifest.get("known_good") is True,
        })
    rows.sort(key=lambda row: row["id"], reverse=True)
    return rows


def versions_payload(dest: Path, running_version: str) -> dict:
    dest = Path(dest)
    manifest = read_manifest(dest) if dest.is_dir() else None
    result = None
    result_path = backups_root(dest) / RESULT_NAME
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        result = None
    version = _clean((manifest or {}).get("version")) or _clean(running_version)
    return {
        "ok": True,
        "version": version,
        "deployed_at": _clean((manifest or {}).get("deployed_at")),
        "git_sha": _clean((manifest or {}).get("git_sha")),
        "known_good": (manifest or {}).get("known_good") is True,
        "backups": list_backups(dest),
        "rollback": result if isinstance(result, dict) else None,
    }


def set_known_good(dest: Path, running_version: str, known_good=True) -> dict:
    dest = Path(dest)
    current = read_manifest(dest) or {}
    payload = manifest_fields(
        current.get("version") or running_version,
        current.get("deployed_at"),
        current.get("git_sha"),
        known_good,
    )
    write_manifest(dest, payload)
    return payload


def _swap_trees(live: Path, backup: Path) -> None:
    """Exchange live and the chosen backup. Both renames stay on one filesystem."""
    if not live.is_dir() or not backup.is_dir():
        raise FileNotFoundError("missing tree")
    root = backup.parent
    hold = root / f".hold-{os.getpid()}-{backup.name}"
    if hold.exists():
        shutil.rmtree(hold)
    os.rename(live, hold)
    try:
        os.rename(backup, live)
    except Exception:
        os.rename(hold, live)
        raise
    os.rename(hold, backup)


def _write_result(dest: Path, payload: dict) -> None:
    root = backups_root(dest)
    root.mkdir(parents=True, exist_ok=True)
    body = dict(payload)
    body.setdefault("finished_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    path = root / RESULT_NAME
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(body, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def lock_file(dest: Path) -> Path:
    root = backups_root(Path(dest))
    root.mkdir(parents=True, exist_ok=True)
    return root / ".rollback.lock"


def claim_file(dest: Path) -> Path:
    root = backups_root(Path(dest))
    root.mkdir(parents=True, exist_ok=True)
    return root / ".rollback.claim"


def acquire_rollback_lock(dest: Path, blocking: bool = False):
    path = lock_file(dest)
    fh = open(path, "a+")
    flags = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
    try:
        fcntl.flock(fh.fileno(), flags)
    except BlockingIOError:
        fh.close()
        return None
    return fh


def release_rollback_lock(fh) -> None:
    if fh is None:
        return
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass
    try:
        fh.close()
    except OSError:
        pass


def claim_rollback(dest: Path) -> bool:
    """Atomic claim so a second request is rejected before a worker starts."""
    path = claim_file(dest)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        try:
            age = time.time() - path.stat().st_mtime
        except OSError:
            return False
        if age < 90:
            return False
        fh = acquire_rollback_lock(dest, blocking=False)
        if fh is None:
            return False
        try:
            if path.exists() and time.time() - path.stat().st_mtime >= 90:
                path.unlink()
        finally:
            release_rollback_lock(fh)
        return claim_rollback(dest)
    try:
        os.write(fd, str(time.time()).encode("ascii"))
    finally:
        os.close(fd)
    return True


def release_claim(dest: Path) -> None:
    try:
        claim_file(dest).unlink()
    except OSError:
        pass


def _block_message(reason: str) -> str:
    table = {
        "armed": "המטוס חמוש. אין שחזור.",
        "in_flight": "המטוס באוויר. אין שחזור.",
        "unknown": "מצב הטיסה לא ידוע. אין שחזור.",
        "stale": "מצב הטיסה ישן. אין שחזור.",
        "missing": "אין מצב טיסה ממחשב המשימה. אין שחזור.",
        "busy": "שחזור כבר מתבצע.",
    }
    return table.get(reason, "אין שחזור.")


def _block_body(reason: str) -> dict:
    return {"ok": False, "reason": reason, "message": _block_message(reason)}


def _block_reason(blocked, armed) -> str | None:
    if blocked is None:
        return "armed" if armed is True else None
    try:
        reason = blocked()
    except Exception:
        return "unknown"
    if reason is True:
        return "armed"
    if reason is False or reason is None or reason == "":
        return None
    if reason in ("armed", "in_flight", "unknown", "stale", "missing"):
        return reason
    return "unknown"


GATE_NAME = "fc-flight-gate.json"
GATE_MAX_AGE_S = 3.0
_FLYING_STATUSES = {4, 5, 6, 8}


def flight_gate_path(dest: Path) -> Path:
    return backups_root(Path(dest)) / GATE_NAME


def decide_flight_gate(armed, in_flight) -> str | None:
    """None only when the aircraft is explicitly disarmed and not flying."""
    if armed is True:
        return "armed"
    if in_flight is True:
        return "in_flight"
    if armed is False and in_flight is False:
        return None
    return "unknown"


def write_flight_gate(dest: Path, armed, in_flight, now: float | None = None) -> None:
    path = flight_gate_path(dest)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {
        "written_at": time.time() if now is None else float(now),
        "armed": armed if isinstance(armed, bool) else None,
        "in_flight": in_flight if isinstance(in_flight, bool) else None,
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(body, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def read_flight_gate(dest: Path, now: float | None = None, max_age: float = GATE_MAX_AGE_S) -> str | None:
    """None when a fresh gate says disarmed and not flying. Otherwise a block reason."""
    path = flight_gate_path(dest)
    if not path.is_file():
        return "missing"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return "unknown"
    if not isinstance(data, dict):
        return "unknown"
    written = data.get("written_at")
    if not isinstance(written, (int, float)):
        return "unknown"
    age = (time.time() if now is None else float(now)) - float(written)
    if age < 0 or age > float(max_age):
        return "stale"
    return decide_flight_gate(data.get("armed"), data.get("in_flight"))


def read_flight_block():
    """Worker gate. Reads the file the running companion just wrote. Never a private empty observer."""
    override = os.environ.get("VLC_VERSIONS_REFUSE")
    if override == "1":
        return "armed"
    if override == "0":
        return None
    if override == "unknown":
        return "unknown"
    if override == "stale":
        return "stale"
    if override == "in_flight":
        return "in_flight"
    dest = Path(os.environ.get("VLC_COMPANION_DEST") or (Path.home() / "vlc-companion"))
    return read_flight_gate(dest)


def perform_rollback(dest: Path, backup_id: str, *, armed=False, blocked=None, restart, wait_healthy, running_version: str, timeout_s=HEALTH_TIMEOUT_S, lock_fh=None) -> tuple[int, dict]:
    dest = Path(dest)
    own_lock = lock_fh is None
    fh = lock_fh if lock_fh is not None else acquire_rollback_lock(dest, blocking=False)
    if fh is None:
        return 409, _block_body("busy")
    try:
        reason = _block_reason(blocked, armed)
        if reason:
            body = _block_body(reason)
            body.update({"state": "failed", "reverted": False, "backup_id": backup_id})
            try:
                _write_result(dest, body)
            except Exception:
                pass
            return 409, body
        if not valid_backup_id(backup_id):
            return 400, {"ok": False, "reason": "bad_backup", "message": "גיבוי לא מוכר."}
        backup = backups_root(dest) / backup_id
        if not backup.is_dir():
            return 404, {"ok": False, "reason": "missing", "message": "הגיבוי לא נמצא."}
        live_manifest = read_manifest(dest) or {}
        backup_manifest = read_manifest(backup) or {}
        from_version = _clean(live_manifest.get("version")) or _clean(running_version)
        to_version = _clean(backup_manifest.get("version"))
        reason = _block_reason(blocked, armed)
        if reason:
            body = _block_body(reason)
            body.update({
                "from": from_version,
                "to": to_version,
                "backup_id": backup_id,
                "state": "failed",
                "reverted": False,
            })
            _write_result(dest, body)
            return 409, body
        try:
            _swap_trees(dest, backup)
        except Exception as err:
            body = {
                "ok": False,
                "reason": "swap_failed",
                "message": "החלפת התיקייה נכשלה.",
                "detail": str(err),
                "from": from_version,
                "to": to_version,
                "reverted": False,
                "state": "failed",
            }
            _write_result(dest, body)
            return 500, body
        restart_error = None
        try:
            restart()
        except Exception as err:
            restart_error = str(err)
        healthy = False
        if restart_error is None:
            try:
                healthy = wait_healthy(timeout_s) is True
            except Exception:
                healthy = False
        if healthy:
            body = {
                "ok": True,
                "state": "done",
                "from": from_version,
                "to": to_version,
                "backup_id": backup_id,
                "reverted": False,
                "message": "הגרסה שוחזרה.",
            }
            _write_result(dest, body)
            return 200, body
        reverted = False
        try:
            _swap_trees(dest, backup)
            reverted = True
            try:
                restart()
            except Exception:
                pass
        except Exception:
            reverted = False
        body = {
            "ok": False,
            "state": "failed",
            "reason": "unhealthy" if restart_error is None else "restart_failed",
            "from": from_version,
            "to": to_version,
            "backup_id": backup_id,
            "reverted": reverted,
            "message": "השירות לא עלה. שוחזרה הגרסה הקודמת." if reverted else "השירות לא עלה והשחזור האוטומטי נכשל.",
        }
        try:
            _write_result(dest, body)
        except Exception:
            pass
        return 200, body
    finally:
        if own_lock:
            release_rollback_lock(fh)
            release_claim(dest)


def default_restart() -> None:
    completed = subprocess.run(
        ["systemctl", "restart", SERVICE_NAME],
        capture_output=True,
        timeout=40,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("restart_failed")


def default_wait_healthy(url: str, timeout_s: float) -> bool:
    deadline = time.monotonic() + float(timeout_s)
    while time.monotonic() < deadline:
        try:
            import urllib.request
            with urllib.request.urlopen(url, timeout=2) as res:
                raw = res.read().decode("utf-8", "replace")
            data = json.loads(raw)
            if isinstance(data, dict) and data.get("ok") is True:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def _env_restart(log_path: str | None):
    def restart():
        if log_path:
            with open(log_path, "a", encoding="utf-8") as handle:
                handle.write("restart\n")
        return None
    return restart


def _env_health(mode: str | None, url: str, timeout_s: float):
    def wait(timeout):
        if mode == "fail":
            return False
        if mode == "ok":
            return True
        return default_wait_healthy(url, timeout if timeout is not None else timeout_s)
    return wait


def build_context(running_version: str, armed_value=None):
    dest = Path(os.environ.get("VLC_COMPANION_DEST") or (Path.home() / "vlc-companion"))
    inline = os.environ.get("VLC_VERSIONS_INLINE") == "1"
    health_mode = os.environ.get("VLC_VERSIONS_HEALTH")
    restart_log = os.environ.get("VLC_VERSIONS_RESTART_LOG")
    port = os.environ.get("VLC_HTTP_PORT", "8081")
    health_url = os.environ.get("VLC_VERSIONS_HEALTH_URL") or f"http://127.0.0.1:{port}/api/v1/health"
    timeout_s = float(os.environ.get("VLC_VERSIONS_HEALTH_TIMEOUT_S") or HEALTH_TIMEOUT_S)
    if inline:
        restart = _env_restart(restart_log)
        wait_healthy = _env_health(health_mode, health_url, timeout_s)
    else:
        restart = default_restart
        wait_healthy = lambda timeout: default_wait_healthy(health_url, timeout)

    def blocked():
        if armed_value is True:
            return "armed"
        if armed_value is False:
            return None
        return read_flight_block()

    return {
        "dest": dest,
        "armed": armed_value is True,
        "blocked": blocked,
        "restart": restart,
        "wait_healthy": wait_healthy,
        "running_version": running_version,
        "timeout_s": timeout_s,
        "inline": inline,
    }


def http_get(dest: Path, running_version: str) -> tuple[int, dict]:
    return 200, versions_payload(dest, running_version)


def spawn_worker(backup_id: str, running_version: str) -> None:
    script = str(Path(__file__).resolve())
    args = [
        sys.executable,
        script,
        "--rollback-worker",
        "--backup-id",
        backup_id,
        "--running-version",
        running_version,
    ]
    try:
        subprocess.Popen(
            ["systemd-run", "--scope", "--collect", "--quiet", *args],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, OSError):
        subprocess.Popen(
            args,
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def http_post(path: str, data: dict, ctx: dict) -> tuple[int, dict]:
    dest = ctx["dest"]
    if path == "/api/v1/versions/known-good":
        payload = set_known_good(dest, ctx["running_version"], True)
        return 200, {"ok": True, "manifest": payload}
    if path != "/api/v1/versions/rollback":
        return 404, {"ok": False}
    if not isinstance(data, dict) or data.get("confirm") is not True:
        return 400, {"ok": False, "reason": "confirm", "message": "נדרש אישור מפורש."}
    backup_id = str(data.get("backup_id") or "")
    blocked = ctx.get("blocked")
    armed = ctx.get("armed") is True
    if ctx.get("inline") is not True:
        reason = _block_reason(blocked, armed)
        if reason:
            return 409, _block_body(reason)
        if not valid_backup_id(backup_id):
            return 400, {"ok": False, "reason": "bad_backup", "message": "גיבוי לא מוכר."}
        if not (backups_root(dest) / backup_id).is_dir():
            return 404, {"ok": False, "reason": "missing", "message": "הגיבוי לא נמצא."}
        if not claim_rollback(dest):
            return 409, _block_body("busy")
        try:
            spawn_worker(backup_id, ctx["running_version"])
        except Exception:
            release_claim(dest)
            raise
        return 202, {
            "ok": True,
            "state": "restarting",
            "backup_id": backup_id,
            "message": "משחזרים גרסה.",
        }
    return perform_rollback(
        dest,
        backup_id,
        armed=armed,
        blocked=blocked,
        restart=ctx["restart"],
        wait_healthy=ctx["wait_healthy"],
        running_version=ctx["running_version"],
        timeout_s=ctx["timeout_s"],
    )


def _cli(argv: list[str]) -> int:
    if "--snapshot-existing" in argv:
        dest = Path(argv[argv.index("--dest") + 1])
        snap = snapshot_existing(dest)
        print(json.dumps({"ok": True, "backup": snap}, ensure_ascii=False))
        return 0
    if "--write-live" in argv:
        dest = Path(argv[argv.index("--dest") + 1])
        version = argv[argv.index("--version") + 1] if "--version" in argv else None
        git_sha = argv[argv.index("--git-sha") + 1] if "--git-sha" in argv else None
        deployed_at = argv[argv.index("--deployed-at") + 1] if "--deployed-at" in argv else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        payload = write_live_manifest(dest, version, git_sha, deployed_at, False)
        print(json.dumps({"ok": True, "manifest": payload}, ensure_ascii=False))
        return 0
    if "--rollback-worker" in argv:
        backup_id = argv[argv.index("--backup-id") + 1]
        running = argv[argv.index("--running-version") + 1] if "--running-version" in argv else ""
        ctx = build_context(running, None)
        status, body = perform_rollback(
            ctx["dest"],
            backup_id,
            armed=False,
            blocked=ctx["blocked"],
            restart=ctx["restart"],
            wait_healthy=ctx["wait_healthy"],
            running_version=ctx["running_version"],
            timeout_s=ctx["timeout_s"],
        )
        print(json.dumps({"status": status, **body}, ensure_ascii=False))
        return 0 if body.get("ok") else 1
    print(json.dumps({"ok": False, "reason": "usage"}))
    return 2


if __name__ == "__main__":
    import sys
    raise SystemExit(_cli(sys.argv[1:]))
