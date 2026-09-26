#!/usr/bin/env python3
"""Fly a local ArduPlane SITL approach and check auto-land shadow decisions.

The product machine stays disabled. This harness may arm local SITL only.
It never sets AUTOLAND_ENABLED and never gives the machine a transport.
If the SITL binary or pymavlink is missing, the script exits 0 and prints
RESULT skip so CI can skip it.
"""

from __future__ import annotations

import argparse
import math
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts", "jetson-companion"))

HOME_LAT = -35.363262
HOME_LON = 149.165237
HOME_ALT = 584.0
TOKEN = "sitl-shadow-token"


def sitl_binary():
    env = os.environ.get("ARDUPLANE_SITL", "").strip()
    candidates = [
        env or None,
        shutil.which("arduplane"),
        os.path.expanduser("~/ardupilot/build/sitl/bin/arduplane"),
        "/opt/ardupilot/build/sitl/bin/arduplane",
    ]
    for path in candidates:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def pymavlink_ok():
    try:
        import pymavlink  # noqa: F401
    except ImportError:
        return False
    return True


def probe():
    if sitl_binary() and pymavlink_ok():
        print("present")
    else:
        print("absent")
    return 0


def offset_north(meters):
    return HOME_LAT + (meters / 111320.0), HOME_LON


def geometry(lat, lon, height_m):
    north = (lat - HOME_LAT) * 111320.0
    east = (lon - HOME_LON) * 111320.0 * math.cos(math.radians(HOME_LAT))
    rng = math.hypot(east, north)
    expected = rng * math.tan(math.radians(6.0))
    return {
        "valid": True,
        "age_s": 0.05,
        "cross_track_m": east,
        "glideslope_error_m": height_m - expected,
        "range_m": rng,
        "height_m": height_m,
        "angle_x": math.atan2(east, max(rng, 1.0)),
        "angle_y": math.atan2(height_m, max(rng, 1.0)),
        "distance_m": math.hypot(rng, height_m),
    }


def upload_mission(master, mav):
    north_lat, north_lon = offset_north(400.0)
    items = [
        (0, mav.MAV_FRAME_GLOBAL_INT, mav.MAV_CMD_NAV_WAYPOINT, HOME_LAT, HOME_LON, 0),
        (1, mav.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, mav.MAV_CMD_NAV_TAKEOFF, HOME_LAT, HOME_LON, 40),
        (2, mav.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, mav.MAV_CMD_NAV_WAYPOINT, north_lat, north_lon, 40),
        (3, mav.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, mav.MAV_CMD_DO_LAND_START, north_lat, north_lon, 0),
        (4, mav.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, mav.MAV_CMD_NAV_LAND, HOME_LAT, HOME_LON, 0),
    ]
    master.mav.mission_clear_all_send(master.target_system, master.target_component)
    time.sleep(0.3)
    master.mav.mission_count_send(master.target_system, master.target_component, len(items), 0)
    pending = {item[0] for item in items}
    deadline = time.time() + 15
    while pending and time.time() < deadline:
        msg = master.recv_match(type=["MISSION_REQUEST_INT", "MISSION_REQUEST"], blocking=True, timeout=1)
        if msg is None:
            continue
        seq = int(msg.seq)
        if seq not in pending:
            continue
        _seq, frame, cmd, lat, lon, alt = items[seq]
        master.mav.mission_item_int_send(
            master.target_system,
            master.target_component,
            seq,
            frame,
            cmd,
            1 if seq == 0 else 0,
            1,
            0, 0, 0, 0,
            int(lat * 1e7),
            int(lon * 1e7),
            float(alt),
            mav.MAV_MISSION_TYPE_MISSION,
        )
        pending.discard(seq)
    ack = master.recv_match(type="MISSION_ACK", blocking=True, timeout=5)
    if ack is None or pending:
        raise RuntimeError("mission upload failed")


def set_param(master, name, value):
    master.mav.param_set_send(
        master.target_system,
        master.target_component,
        name.encode("ascii"),
        float(value),
        9,  # MAV_PARAM_TYPE_REAL32
    )


def run():
    binary = sitl_binary()
    if not binary or not pymavlink_ok():
        print("RESULT skip sitl-absent")
        return 0
    from pymavlink import mavutil

    from autoland import PLANE_MODES, AutoLandMachine

    port = 5760 + (os.getpid() % 1000)
    proc = subprocess.Popen(
        [
            binary,
            "--model", "plane",
            "--speedup", "20",
            "--wipe",
            "-w",
            "--home", f"{HOME_LAT},{HOME_LON},{HOME_ALT},353",
            f"--serial0=tcp:127.0.0.1:{port}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    calls = []
    machine = AutoLandMachine(
        enabled=False,
        shadow=True,
        expected_token=TOKEN,
        transport=lambda kind, fields: calls.append(kind),
    )
    master = None
    try:
        deadline = time.time() + 25
        last = None
        while time.time() < deadline:
            try:
                master = mavutil.mavlink_connection(f"tcp:127.0.0.1:{port}", source_system=255, retries=2)
                hb = master.wait_heartbeat(timeout=5)
                if hb:
                    break
            except Exception as exc:
                last = exc
                time.sleep(0.4)
        else:
            raise RuntimeError(f"no heartbeat from local SITL: {last}")

        set_param(master, "ARMING_CHECK", 0)
        set_param(master, "FS_GCS_ENABLE", 0)
        time.sleep(0.5)
        upload_mission(master, mavutil.mavlink)
        master.mav.command_long_send(
            master.target_system,
            master.target_component,
            mavutil.mavlink.MAV_CMD_DO_SET_MODE,
            0,
            mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
            10,
            0, 0, 0, 0, 0,
        )
        master.mav.command_long_send(
            master.target_system,
            master.target_component,
            mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
            0,
            1, 0, 0, 0, 0, 0, 0,
        )
        master.mav.command_long_send(
            master.target_system,
            master.target_component,
            mavutil.mavlink.MAV_CMD_MISSION_START,
            0,
            0, 0, 0, 0, 0, 0, 0,
        )

        lat = lon = None
        rel_alt = None
        mode_name = None
        battery = None
        last_hb = time.time()
        end = time.time() + 120
        saw_position = False
        while time.time() < end:
            msg = master.recv_match(blocking=True, timeout=1)
            if msg is None:
                continue
            kind = msg.get_type()
            if kind == "HEARTBEAT" and int(getattr(msg, "autopilot", 0) or 0) != 8:
                mode_name = PLANE_MODES.get(int(msg.custom_mode))
                last_hb = time.time()
            elif kind == "GLOBAL_POSITION_INT":
                lat = msg.lat / 1e7
                lon = msg.lon / 1e7
                rel_alt = msg.relative_alt / 1000.0
                saw_position = True
            elif kind == "SYS_STATUS":
                remaining = getattr(msg, "battery_remaining", -1)
                battery = None if remaining is None or int(remaining) < 0 or int(remaining) > 100 else int(remaining)
            if lat is None or mode_name is None:
                continue
            telem = {
                "position_valid": True,
                "mode_valid": mode_name != "INITIALISING",
                "mode": mode_name,
                "link_healthy": (time.time() - last_hb) < 3,
                "battery_pct": battery,
                "arm_token": TOKEN,
            }
            tgt = None
            if rel_alt is not None and rel_alt > 12:
                sample = geometry(lat, lon, rel_alt)
                if 40 <= sample["range_m"] <= 2000:
                    tgt = sample
            snap = machine.tick(telem, target=tgt)
            if snap["state"] in {"APPROACH", "FINAL", "FLARE", "ROLLOUT"}:
                break
        snap = machine.snapshot()
        kinds = [item["kind"] for item in snap["commands"]]
        if not saw_position:
            raise RuntimeError("SITL did not report a position")
        if "DO_LAND_START" not in kinds:
            raise RuntimeError(f"shadow log missing land start: state={snap['state']} kinds={kinds}")
        if any(item["sent"] for item in snap["commands"]):
            raise RuntimeError("shadow log contains a send")
        if calls:
            raise RuntimeError("transport was called")
        if snap["enabled"] is not False or snap["flightCommandsSent"] is not False:
            raise RuntimeError("machine was enabled")
        print(f"RESULT pass state={snap['state']} commands={len(kinds)}")
        return 0
    finally:
        if master is not None:
            try:
                master.close()
            except Exception:
                pass
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def main(argv):
    parser = argparse.ArgumentParser(description="Local ArduPlane SITL shadow approach")
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args(argv)
    if args.probe:
        return probe()
    try:
        return run()
    except Exception as exc:
        if not sitl_binary() or not pymavlink_ok():
            print("RESULT skip sitl-absent")
            return 0
        print(f"RESULT fail {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
