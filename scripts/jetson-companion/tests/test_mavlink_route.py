# -*- coding: utf-8 -*-
"""Companion MAVLink whitelist and a two-port routing sim."""

from __future__ import print_function

import os
import pty
import select
import struct
import sys
import threading
import time
import tty
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mavlink_route import (  # noqa: E402
    CMD_GIMBAL,
    CMD_TRACK,
    CMD_UPLINK,
    COMP_ID,
    MSG_COMMAND_ACK,
    MSG_COMMAND_LONG,
    MSG_HEARTBEAT,
    MSG_NAMED_VALUE_FLOAT,
    MSG_PARAM_SET,
    CompanionRouter,
    build_frame,
    command_long_fields,
    parse_frames,
)


def _heartbeat(seq, sysid, compid, mav_type, autopilot):
    payload = struct.pack("<IBBBBB", 0, mav_type, autopilot, 0x51, 4, 3)
    return build_frame(MSG_HEARTBEAT, payload, seq, sysid, compid)


def _command(seq, command, params, target_sys=1, target_comp=COMP_ID, sysid=255, compid=190):
    values = list(params) + [0.0] * (7 - len(params))
    payload = struct.pack("<7f", *values[:7]) + struct.pack("<HBBB", command & 0xFFFF, target_sys, target_comp, 0)
    return build_frame(MSG_COMMAND_LONG, payload, seq, sysid, compid)


def _names(blob):
    frames, _rest = parse_frames(blob)
    found = []
    for frame in frames:
        if frame["msgid"] != MSG_NAMED_VALUE_FLOAT or len(frame["payload"]) < 18:
            continue
        found.append(frame["payload"][4:14].split(b"\x00", 1)[0].decode("ascii"))
    return found


class WhitelistTests(unittest.TestCase):
    def test_rejects_flight_commands_and_param_set(self):
        calls = []
        router = CompanionRouter(gimbal=lambda action, body: calls.append((action, body)) or (200, {}))
        arm = router.feed(_command(1, 400, [0]))
        frames, _rest = parse_frames(arm)
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["msgid"], MSG_COMMAND_ACK)
        self.assertEqual(frames[0]["payload"][2], 3)
        self.assertEqual(calls, [])
        self.assertEqual(router.feed(build_frame(MSG_PARAM_SET, b"\x00" * 23, 2, 255, 190)), b"")
        self.assertEqual(router.feed(_command(3, 21, [], target_comp=1)), b"")

    def test_gimbal_uplink_and_disabled_track(self):
        gimbal = []
        uplink = []
        router = CompanionRouter(
            gimbal=lambda action, body: gimbal.append((action, body)) or (200, {}),
            uplink=lambda kind, enabled: uplink.append((kind, enabled)) or (200, {}),
        )
        ack = router.feed(_command(1, CMD_GIMBAL, [1, 10, -4]))
        frames, _rest = parse_frames(ack)
        self.assertEqual(frames[0]["payload"][2], 0)
        self.assertEqual(gimbal, [("rate", {"yaw": 10, "pitch": -4})])
        router.feed(_command(2, CMD_UPLINK, [1, 1]))
        self.assertEqual(uplink, [("cellular", True)])
        track = router.feed(_command(3, CMD_TRACK, [1]))
        frames, _rest = parse_frames(track)
        self.assertEqual(frames[0]["payload"][2], 3)
        self.assertEqual(router.last_command, "track")

    def test_status_names_omit_unknown_gimbal(self):
        router = CompanionRouter(status=lambda: {"wifi": True, "cell": False, "cam0": True, "cam1": False})
        names = _names(router.tick())
        self.assertEqual(names, ["UP_WIFI", "UP_CELL", "CAM0_OK", "CAM1_OK"])
        known = CompanionRouter(status=lambda: {"wifi": 0, "yaw": 12.5, "pitch": -3, "mode": 1})
        names = _names(known.tick())
        self.assertIn("GMB_YAW", names)
        self.assertIn("GMB_MODE", names)


class FcSim(object):
    """Learn component sides from heartbeats and forward targeted commands."""

    def __init__(self):
        self.sides = {}
        self.autopilot = []
        self._buf = {"ground": b"", "companion": b""}

    def feed(self, side, data):
        self._buf[side] += bytes(data or b"")
        frames, self._buf[side] = parse_frames(self._buf[side])
        other = b""
        for frame in frames:
            if frame["msgid"] == MSG_HEARTBEAT:
                self.sides[(frame["sys"], frame["comp"])] = side
            if frame["msgid"] == MSG_PARAM_SET:
                continue
            if frame["msgid"] == MSG_COMMAND_LONG:
                command, _params, target_system, target_component = command_long_fields(frame["payload"])
                if target_component == 1:
                    self.autopilot.append(command)
                    continue
                dest = self.sides.get((target_system or 1, target_component))
                other_side = "companion" if side == "ground" else "ground"
                if dest == other_side:
                    other += frame["raw"]
                continue
            if frame["msgid"] in (MSG_HEARTBEAT, MSG_NAMED_VALUE_FLOAT, MSG_COMMAND_ACK, 253):
                other += frame["raw"]
        return other


class RoutingSimTests(unittest.TestCase):
    def test_virtual_pair_routes_companion_and_keeps_arm_on_the_fc(self):
        g_master, g_slave = pty.openpty()
        c_master, c_slave = pty.openpty()
        for fd in (g_master, g_slave, c_master, c_slave):
            tty.setraw(fd)
        sim = FcSim()
        seen = []
        router = CompanionRouter(
            gimbal=lambda action, body: seen.append(action) or (200, {}),
            status=lambda: {"wifi": True, "cam0": True, "cam1": False},
        )
        stop = threading.Event()

        def pump():
            while not stop.is_set():
                ready, _w, _x = select.select([g_master, c_master], [], [], 0.05)
                for fd, side, peer in ((g_master, "ground", c_master), (c_master, "companion", g_master)):
                    if fd not in ready:
                        continue
                    try:
                        data = os.read(fd, 4096)
                    except OSError:
                        continue
                    out = sim.feed(side, data)
                    if out:
                        os.write(peer, out)

        def companion():
            while not stop.is_set():
                ready, _w, _x = select.select([c_slave], [], [], 0.05)
                if c_slave not in ready:
                    continue
                try:
                    data = os.read(c_slave, 4096)
                except OSError:
                    continue
                reply = router.feed(data)
                if reply:
                    os.write(c_slave, reply)

        threads = [
            threading.Thread(target=pump),
            threading.Thread(target=companion),
        ]
        for thread in threads:
            thread.daemon = True
            thread.start()
        try:
            os.write(c_slave, router.tick())
            os.write(g_slave, _heartbeat(1, 1, 1, 1, 3))
            deadline = time.time() + 2
            while time.time() < deadline and sim.sides.get((1, COMP_ID)) != "companion":
                time.sleep(0.02)
            self.assertEqual(sim.sides.get((1, COMP_ID)), "companion")
            os.write(g_slave, _command(4, CMD_GIMBAL, [2, 1]))
            os.write(g_slave, _command(5, 400, [], target_comp=1, sysid=255, compid=190))
            buf = b""
            ack = None
            deadline = time.time() + 2
            while time.time() < deadline:
                ready, _w, _x = select.select([g_slave], [], [], 0.05)
                if g_slave in ready:
                    buf += os.read(g_slave, 4096)
                frames, buf = parse_frames(buf)
                for frame in frames:
                    if frame["msgid"] == MSG_COMMAND_ACK and frame["comp"] == COMP_ID:
                        ack = frame
                if ack is not None and 400 in sim.autopilot:
                    self.assertEqual(ack["payload"][2], 0)
                    self.assertEqual(seen, ["zoom"])
                    self.assertEqual(router.ignored_flight, 0)
                    return
            self.fail("routing sim did not deliver the gimbal ack")
        finally:
            stop.set()
            for thread in threads:
                thread.join(timeout=1)
            for fd in (g_master, g_slave, c_master, c_slave):
                os.close(fd)


if __name__ == "__main__":
    unittest.main()
