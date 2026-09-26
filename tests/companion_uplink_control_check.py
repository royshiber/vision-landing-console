#!/usr/bin/env python3
"""Uplink on/off with a mocked nmcli runner. No live NetworkManager and no ping."""

import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "jetson-companion"))

os.environ["VLC_SKIP_RELAY"] = "1"
os.environ.pop("VLC_E3372_HILINK_URL", None)
os.environ.pop("VLC_UPLINK_REACH", None)

from uplink_control import (  # noqa: E402
    apply_boot_policy,
    load_prefs,
    reset_uplink_control,
    save_prefs,
    set_nm_runner,
    set_presence,
    set_reachability,
    set_uplink,
)
from uplink_status import reset_uplink_caches, set_hilink_fetcher, set_host_reader  # noqa: E402


def check(cond, detail):
    if not cond:
        raise SystemExit(f"fail line {sys._getframe(1).f_lineno}: {detail}")


class Host:
    def __init__(self):
        self.up = {"wlP1p1s0": True, "enx0c5b8f279a64": True}
        self.route_rows = [
            {"iface": "wlP1p1s0", "metric": 600},
            {"iface": "enx0c5b8f279a64", "metric": 50},
        ]

    def oper_up(self, iface):
        return self.up.get(iface) is True

    def cell_iface(self):
        return "enx0c5b8f279a64"

    def ipv4(self, iface):
        if not self.up.get(iface):
            return None
        if iface == "wlP1p1s0":
            return "192.168.1.20"
        return "192.168.8.100"

    def iw(self, _iface):
        return {"ssid": None, "signal_dbm": None}

    def routes(self):
        return [row for row in self.route_rows if self.up.get(row["iface"])]


def fail_fetch(*_args, **_kwargs):
    raise OSError("no hilink")


def main():
    tmp = Path(tempfile.mkdtemp(prefix="uplink-ctl-"))
    state = tmp / "uplinks.json"
    os.environ["VLC_UPLINKS_STATE"] = str(state)
    host = Host()
    calls = []

    def runner(action):
        calls.append(action)
        if action == "wifi-down":
            host.up["wlP1p1s0"] = False
        elif action == "wifi-up":
            host.up["wlP1p1s0"] = True
        elif action == "cell-down":
            host.up["enx0c5b8f279a64"] = False
        elif action == "cell-up":
            host.up["enx0c5b8f279a64"] = True
        else:
            return 1
        return 0

    def reach(iface):
        return host.up.get(iface) is True

    def boot(presence, stored=None, nm=runner):
        calls.clear()
        reset_uplink_control()
        reset_uplink_caches()
        set_host_reader(host)
        set_hilink_fetcher(fail_fetch)
        set_nm_runner(nm)
        set_reachability(reach)
        set_presence(lambda kind: presence.get(kind) is True)
        if stored is None:
            if state.exists():
                state.unlink()
        else:
            state.write_text(json.dumps(stored), encoding="utf-8")
        return apply_boot_policy()

    reset_uplink_control()
    reset_uplink_caches()
    set_host_reader(host)
    set_hilink_fetcher(fail_fetch)
    set_nm_runner(runner)
    set_reachability(reach)
    set_presence(lambda kind: True)
    save_prefs({"wifi": {"enabled": True}, "cellular": {"enabled": True}})

    calls.clear()
    host.up["enx0c5b8f279a64"] = False
    code, body = set_uplink("wifi", False)
    check(code == 409 and body["reason"] == "last_uplink", body)
    check(body["message"] == "אי אפשר לכבות את הקישור האחרון", body)
    check(calls == [], calls)
    check(load_prefs()["wifi"]["enabled"] is True, "pref unchanged")

    host.up["enx0c5b8f279a64"] = True
    host.route_rows = [{"iface": "enx0c5b8f279a64", "metric": 50}]
    set_reachability(lambda _iface: False)
    code, body = set_uplink("wifi", False)
    check(code == 409 and body["reason"] == "last_uplink", "reach")
    check(calls == [], calls)

    host.route_rows = []
    set_reachability(lambda _iface: True)
    code, _body = set_uplink("wifi", False)
    check(code == 409, "no default route")
    check(calls == [], calls)

    host.route_rows = [{"iface": "enx0c5b8f279a64", "metric": 50}]
    calls.clear()
    code, body = set_uplink("wifi", False)
    check(code == 200, body)
    check(calls == ["wifi-down"], calls)
    check(body["wifi"]["enabled"] is False and body["wifi"]["up"] is False, body["wifi"])
    check(body["cellular"]["up"] is True and body["cellular"]["enabled"] is True, body["cellular"])
    check(load_prefs()["wifi"]["enabled"] is False, "persisted off")

    calls.clear()
    code, body = set_uplink("wifi", True)
    check(code == 200 and calls == ["wifi-up"], (code, calls))
    check(body["wifi"]["enabled"] is True and body["wifi"]["up"] is True, body["wifi"])

    set_presence(lambda kind: kind == "cellular")
    calls.clear()
    code, body = set_uplink("cellular", False)
    check(code == 409 and calls == [], (code, calls, body))
    stored = json.loads(state.read_text(encoding="utf-8"))
    check(stored["cellular"]["enabled"] is True, stored)

    calls.clear()
    set_nm_runner(lambda _action: 1)
    set_presence(lambda kind: True)
    host.up["wlP1p1s0"] = True
    host.up["enx0c5b8f279a64"] = True
    host.route_rows = [{"iface": "wlP1p1s0", "metric": 100}]
    code, body = set_uplink("cellular", False)
    check(code == 503 and body["reason"] == "nmcli_failed", body)
    check(load_prefs()["cellular"]["enabled"] is True, "failed nm does not persist")

    report = boot({"wifi": True, "cellular": True})
    check(report["fallback"] is None, report)
    check(calls[:2] == ["wifi-up", "cell-up"], calls)
    check("wifi-down" not in calls and "cell-down" not in calls, calls)

    host.up = {"wlP1p1s0": False, "enx0c5b8f279a64": False}

    def runner_wifi_stays_down(action):
        calls.append(action)
        if action == "cell-up":
            host.up["enx0c5b8f279a64"] = True
        return 0

    report = boot(
        {"wifi": True, "cellular": True},
        {"wifi": {"enabled": True}, "cellular": {"enabled": False}},
        runner_wifi_stays_down,
    )
    check(report["fallback"] == "cellular", report)
    check("cell-up" in calls, calls)
    check("cell-down" not in calls, calls)
    check(load_prefs()["cellular"]["enabled"] is False, "fallback does not rewrite the pref")
    check(host.up["enx0c5b8f279a64"] is True, "other link was brought up")

    host.up = {"wlP1p1s0": False, "enx0c5b8f279a64": False}
    report = boot(
        {"wifi": False, "cellular": True},
        {"wifi": {"enabled": True}, "cellular": {"enabled": False}},
    )
    check(load_prefs()["cellular"]["enabled"] is True, load_prefs())
    check("cell-up" in calls and "cell-down" not in calls, calls)
    check(json.loads(state.read_text(encoding="utf-8"))["cellular"]["enabled"] is True, "rewritten")

    report = boot(
        {"wifi": True, "cellular": True},
        {"wifi": {"enabled": False}, "cellular": {"enabled": False}},
    )
    check(load_prefs()["wifi"]["enabled"] is True and load_prefs()["cellular"]["enabled"] is True, load_prefs())
    check("wifi-up" in calls and "cell-up" in calls, calls)

    script = ROOT / "scripts" / "jetson-companion" / "uplink-nm.sh"
    check(script.stat().st_mode & stat.S_IXUSR, "script executable")
    bindir = tmp / "bin"
    bindir.mkdir()
    log = tmp / "nm.log"
    fake = bindir / "nmcli"
    fake.write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NM_LOG\"\nexit 0\n",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    env = {**os.environ, "PATH": f"{bindir}:{os.environ.get('PATH', '')}", "NM_LOG": str(log)}

    def run_script(*args):
        log.write_text("", encoding="utf-8")
        return subprocess.run([str(script), *args], env=env, text=True, capture_output=True)

    bad = run_script("nope")
    check(bad.returncode == 2, bad.stderr)
    check(log.read_text(encoding="utf-8") == "", "bad verb must not call nmcli")

    extra = run_script("wifi-up", "extra")
    check(extra.returncode == 2, extra.stderr)

    up = run_script("wifi-up")
    check(up.returncode == 0, up.stderr)
    text = log.read_text(encoding="utf-8")
    check("device set wlP1p1s0 autoconnect yes" in text, text)
    check("device connect wlP1p1s0" in text, text)
    check("gsm.apn" not in text and "connection modify" not in text, text)

    cell = run_script("cell-up")
    check(cell.returncode == 0, cell.stderr)
    cell_text = log.read_text(encoding="utf-8")
    check('connection up Wired connection 2' in cell_text or "connection up Wired connection 2" in cell_text, cell_text)
    check("connection modify" not in cell_text, cell_text)
    check("uinternet" not in cell_text, "script must not write the APN")

    print("ok")


if __name__ == "__main__":
    main()
