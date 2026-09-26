"""Operator on/off for Wi-Fi and Huawei cellular. Not a flight command.

POST persists the choice in /var/lib/airvix/uplinks.json and asks NetworkManager
through the root-owned /opt/airvix/jetson-companion/uplink-nm.sh (sudo -n).
A link is turned down only when the operator disables it and the other link
is up, owns a default route, and answers a reachability probe. Startup never
takes an active link down. Cellular is never stored as disabled while the
Wi-Fi interface is absent.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path

from uplink_status import _oper_up, _routes, _wifi_iface, cellular_iface_name

LAST_UPLINK_MESSAGE = "אי אפשר לכבות את הקישור האחרון"
NM_FAIL_MESSAGE = "שינוי הקישור נכשל"
BAD_BODY_MESSAGE = "גוף הבקשה לא תקין"
DEFAULT_UPLINK_NM = "/opt/airvix/jetson-companion/uplink-nm.sh"

_RUNNER = None
_REACH = None
_PRESENCE = None
BOOT_FALLBACK = None
_CLOCK = None
_GUARD = {"armed": None, "seen": False}
_GUARD_LOCK = threading.Lock()
_REVERT_THREAD = None
WIFI_REVERT_S = 60.0


def set_nm_runner(fn):
    global _RUNNER
    _RUNNER = fn


def set_reachability(fn):
    global _REACH
    _REACH = fn


def set_presence(fn):
    global _PRESENCE
    _PRESENCE = fn


def reset_uplink_control():
    global _RUNNER, _REACH, _PRESENCE, BOOT_FALLBACK, _CLOCK
    _RUNNER = None
    _REACH = None
    _PRESENCE = None
    BOOT_FALLBACK = None
    _CLOCK = None
    with _GUARD_LOCK:
        _GUARD["armed"] = None
        _GUARD["seen"] = False


def set_clock(fn):
    """Tests inject a monotonic clock. A fake clock does not start the revert thread."""
    global _CLOCK
    _CLOCK = fn


def _now():
    if _CLOCK is not None:
        return float(_CLOCK())
    return time.monotonic()


def note_console_request():
    """A live console request after Wi-Fi went down means another path still works."""
    with _GUARD_LOCK:
        if _GUARD["armed"] is not None:
            _GUARD["seen"] = True


def _revert_seconds():
    raw = os.environ.get("VLC_WIFI_REVERT_S", "").strip()
    if not raw:
        return WIFI_REVERT_S
    try:
        value = float(raw)
    except ValueError:
        return WIFI_REVERT_S
    return value if value > 0 else WIFI_REVERT_S


def arm_wifi_revert():
    with _GUARD_LOCK:
        _GUARD["armed"] = _now()
        _GUARD["seen"] = False
    if _CLOCK is None:
        _ensure_revert_thread()


def clear_wifi_revert():
    with _GUARD_LOCK:
        _GUARD["armed"] = None
        _GUARD["seen"] = False


def tick_wifi_revert():
    """Re-enable Wi-Fi if the console has not been heard since it was turned off."""
    with _GUARD_LOCK:
        armed = _GUARD["armed"]
        if armed is None:
            return "idle"
        if _now() - armed < _revert_seconds():
            return "waiting"
        seen = _GUARD["seen"]
        _GUARD["armed"] = None
        _GUARD["seen"] = False
    if seen:
        return "kept"
    code, _body = set_uplink("wifi", True)
    return "reverted" if code == 200 else "revert_failed"


def _ensure_revert_thread():
    global _REVERT_THREAD
    if _REVERT_THREAD is not None and _REVERT_THREAD.is_alive():
        return

    def loop():
        while _CLOCK is None:
            time.sleep(1.0)
            if _CLOCK is not None:
                return
            try:
                tick_wifi_revert()
            except Exception:
                pass

    _REVERT_THREAD = threading.Thread(target=loop, name="wifi-revert", daemon=True)
    _REVERT_THREAD.start()


def state_path():
    raw = os.environ.get("VLC_UPLINKS_STATE", "/var/lib/airvix/uplinks.json").strip()
    return Path(raw or "/var/lib/airvix/uplinks.json")


def default_prefs():
    return {"wifi": {"enabled": True}, "cellular": {"enabled": True}}


def _stored_flags():
    """File contents. Missing or broken file means both links stay enabled."""
    path = state_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return None
    if not isinstance(data, dict):
        return None

    def flag(key):
        node = data.get(key)
        if isinstance(node, dict) and isinstance(node.get("enabled"), bool):
            return node["enabled"]
        return True

    return {"wifi": {"enabled": flag("wifi")}, "cellular": {"enabled": flag("cellular")}}


def load_prefs():
    stored = _stored_flags()
    if stored is None:
        return default_prefs()
    if stored["wifi"]["enabled"] is False and stored["cellular"]["enabled"] is False:
        return default_prefs()
    return stored


def save_prefs(prefs):
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "wifi": {"enabled": prefs["wifi"]["enabled"] is True},
        "cellular": {"enabled": prefs["cellular"]["enabled"] is True},
    }
    if payload["wifi"]["enabled"] is False and payload["cellular"]["enabled"] is False:
        payload = default_prefs()
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return payload


def iface_present(kind):
    if _PRESENCE is not None:
        return _PRESENCE(kind) is True
    if kind == "wifi":
        return Path(f"/sys/class/net/{_wifi_iface()}").exists()
    name = cellular_iface_name()
    return bool(name) and Path(f"/sys/class/net/{name}").exists()


def _iface_name(kind):
    if kind == "wifi":
        return _wifi_iface()
    return cellular_iface_name()


def _is_up(kind):
    if not iface_present(kind):
        return False
    name = _iface_name(kind)
    return bool(name) and _oper_up(name) is True


def _has_default_route(iface):
    routes = _routes()
    if not isinstance(routes, list) or not iface:
        return False
    return any(route.get("iface") == iface for route in routes)


def reachability_ok(iface):
    if not iface:
        return False
    if _REACH is not None:
        return _REACH(iface) is True
    flag = os.environ.get("VLC_UPLINK_REACH", "").strip()
    if flag == "1":
        return True
    if flag == "0":
        return False
    host = os.environ.get("VLC_UPLINK_REACH_HOST", "1.1.1.1").strip() or "1.1.1.1"
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,253}", host):
        return False
    try:
        proc = subprocess.run(
            ["ping", "-I", iface, "-c", "1", "-W", "1", host],
            timeout=2.5,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0


def other_link_ready(kind):
    other = "cellular" if kind == "wifi" else "wifi"
    if not iface_present(other):
        return False
    name = _iface_name(other)
    if not name or not _is_up(other):
        return False
    if not _has_default_route(name):
        return False
    return reachability_ok(name)


def uplink_nm_argv(action):
    """sudo -n the root-owned script. VLC_UPLINK_NM replaces the whole command (tests)."""
    override = os.environ.get("VLC_UPLINK_NM", "").strip()
    if override:
        return [override, action]
    script = os.environ.get("VLC_UPLINK_NM_BIN", "").strip() or DEFAULT_UPLINK_NM
    return ["sudo", "-n", script, action]


def run_nm(action):
    if action not in {"wifi-up", "wifi-down", "cell-up", "cell-down"}:
        raise ValueError("bad action")
    if action in {"wifi-up", "cell-up"}:
        kind = "wifi" if action == "wifi-up" else "cellular"
        if _is_up(kind):
            return
    if _RUNNER is not None:
        result = _RUNNER(action)
        # True == 1 in Python, so an exit code of 1 must not count as success.
        ok = result is None or result is True or (result == 0 and result is not False)
        if not ok:
            raise RuntimeError("nm failed")
        return
    cmd = uplink_nm_argv(action)
    proc = subprocess.run(cmd, timeout=8, text=True, capture_output=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError("nm failed")


def annotate_uplinks(body):
    if not isinstance(body, dict):
        return body
    prefs = load_prefs()
    body["read_only"] = False
    wifi = body.get("wifi") if isinstance(body.get("wifi"), dict) else {}
    cell = body.get("cellular") if isinstance(body.get("cellular"), dict) else {}
    wifi["enabled"] = prefs["wifi"]["enabled"] is True
    cell["enabled"] = prefs["cellular"]["enabled"] is True
    body["wifi"] = wifi
    body["cellular"] = cell
    body["boot_fallback"] = BOOT_FALLBACK
    return body


def uplinks_view():
    from uplink_status import uplinks_payload

    return uplinks_payload()


def _refuse_last():
    return 409, {
        "ok": False,
        "reason": "last_uplink",
        "message": LAST_UPLINK_MESSAGE,
    }


def set_uplink(kind, enabled):
    if kind not in {"wifi", "cellular"}:
        return 404, {"ok": False, "reason": "bad_link", "message": "קישור לא מוכר"}
    if not isinstance(enabled, bool):
        return 400, {"ok": False, "reason": "bad_body", "message": BAD_BODY_MESSAGE}
    if enabled is False:
        if kind == "cellular" and not iface_present("wifi"):
            return _refuse_last()
        if not other_link_ready(kind):
            return _refuse_last()
    action = ("wifi-up" if enabled else "wifi-down") if kind == "wifi" else ("cell-up" if enabled else "cell-down")
    try:
        run_nm(action)
    except Exception:
        return 503, {"ok": False, "reason": "nmcli_failed", "message": NM_FAIL_MESSAGE}
    prefs = load_prefs()
    prefs[kind]["enabled"] = enabled
    if prefs["cellular"]["enabled"] is False and not iface_present("wifi"):
        prefs["cellular"]["enabled"] = True
    try:
        save_prefs(prefs)
    except OSError:
        return 503, {"ok": False, "reason": "persist_failed", "message": "שמירת הבחירה נכשלה"}
    if kind == "wifi" and enabled is False:
        arm_wifi_revert()
    elif kind == "wifi" and enabled is True:
        clear_wifi_revert()
    return 200, uplinks_view()


def apply_boot_policy():
    """Bring enabled links up. Never take an active link down.

    `*-up` is a no-op when that link is already up, so NetworkManager does not
    drop and reconnect it. A stored disable is left for the operator POST.
    If an enabled link is not available, bring the other up and report it.
    Never leave the file saying cellular is off when Wi-Fi is absent.
    """
    global BOOT_FALLBACK
    wifi_ok = iface_present("wifi")
    cell_ok = iface_present("cellular")
    stored = _stored_flags() or default_prefs()
    changed = False
    if stored["wifi"]["enabled"] is False and stored["cellular"]["enabled"] is False:
        stored = default_prefs()
        changed = True
    if not wifi_ok and stored["cellular"]["enabled"] is not True:
        stored["cellular"]["enabled"] = True
        changed = True
    if changed:
        try:
            save_prefs(stored)
        except OSError:
            pass
    prefs = load_prefs()

    def up(kind):
        if kind == "wifi" and not wifi_ok:
            return False
        if kind == "cellular" and not cell_ok:
            return False
        try:
            run_nm("wifi-up" if kind == "wifi" else "cell-up")
        except Exception:
            return False
        return _is_up(kind)

    if prefs["wifi"]["enabled"] and wifi_ok:
        up("wifi")
    if prefs["cellular"]["enabled"] and cell_ok:
        up("cellular")

    fallback = None
    if prefs["wifi"]["enabled"] and wifi_ok and not _is_up("wifi") and cell_ok:
        if up("cellular") or _is_up("cellular"):
            fallback = "cellular"
    if prefs["cellular"]["enabled"] and cell_ok and not _is_up("cellular") and wifi_ok:
        if up("wifi") or _is_up("wifi"):
            if fallback is None:
                fallback = "wifi"

    if not wifi_ok and cell_ok and not _is_up("cellular"):
        up("cellular")
        fallback = "cellular"
    if not cell_ok and wifi_ok and not _is_up("wifi"):
        up("wifi")
        fallback = "wifi"

    if not _is_up("wifi") and not _is_up("cellular"):
        if cell_ok and (up("cellular") or _is_up("cellular")):
            fallback = fallback or "cellular"
        elif wifi_ok and (up("wifi") or _is_up("wifi")):
            fallback = fallback or "wifi"

    BOOT_FALLBACK = fallback
    return {"fallback": fallback, "prefs": load_prefs()}
