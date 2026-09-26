#!/usr/bin/env python3
"""State transitions, aborts, and the disabled send guard for auto-land."""

import os
import struct
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts", "jetson-companion"))

from autoland import (  # noqa: E402
    AutoLandMachine,
    GuardedSender,
    MarkerDetectorPlugin,
    build_machine_from_env,
    load_marker_detector,
)
from fc_telemetry import mav_crc  # noqa: E402

TOKEN = "op-token"


def good_telem(**overrides):
    body = {
        "position_valid": True,
        "mode_valid": True,
        "mode": "AUTO",
        "link_healthy": True,
        "battery_pct": 80,
        "arm_token": TOKEN,
    }
    body.update(overrides)
    return body


def target(**overrides):
    body = {
        "valid": True,
        "age_s": 0.1,
        "cross_track_m": 2.0,
        "glideslope_error_m": 1.0,
        "range_m": 800.0,
        "height_m": 60.0,
        "angle_x": 0.01,
        "angle_y": -0.08,
        "distance_m": 802.0,
    }
    body.update(overrides)
    return body


def machine(**kwargs):
    opts = {
        "enabled": False,
        "shadow": True,
        "expected_token": TOKEN,
        "transport": None,
    }
    opts.update(kwargs)
    return AutoLandMachine(**opts)


def v2(msgid, payload, extra):
    header = bytes([0xFD, len(payload), 0, 0, 1, 1, 1, msgid & 0xFF, (msgid >> 8) & 0xFF, (msgid >> 16) & 0xFF])
    raw = header + payload
    crc = mav_crc(raw[1:] + bytes([extra]))
    return raw + bytes([crc & 0xFF, (crc >> 8) & 0xFF])


class Transitions(unittest.TestCase):
    def test_idle_to_armed_when_operational_gates_pass_in_shadow(self):
        auto = machine()
        snap = auto.tick(good_telem(), now=1)
        self.assertEqual(snap["state"], "ARMED_FOR_APPROACH")
        self.assertFalse(snap["enabled"])
        self.assertEqual(snap["labelHe"], "מושבת")
        self.assertEqual(snap["commands"], [])
        self.assertEqual(snap["commandsSent"], 0)

    def test_idle_refuses_each_operational_gate(self):
        cases = [
            {"position_valid": False},
            {"mode_valid": False, "mode": None},
            {"link_healthy": False},
            {"arm_token": ""},
            {"arm_token": "other"},
        ]
        for override in cases:
            auto = machine()
            snap = auto.tick(good_telem(**override), now=1)
            self.assertEqual(snap["state"], "IDLE", override)

    def test_disabled_and_not_shadow_refuses_even_with_gates(self):
        auto = machine(enabled=False, shadow=False)
        snap = auto.tick(good_telem(), now=1)
        self.assertEqual(snap["state"], "IDLE")
        config = next(g for g in snap["gates"] if g["id"] == "config_enabled")
        self.assertFalse(config["ok"])
        self.assertEqual(config["reasonHe"], "מושבת")

    def test_armed_waits_without_a_target(self):
        auto = machine()
        auto.tick(good_telem(), now=1)
        snap = auto.tick(good_telem(), target=None, now=2)
        self.assertEqual(snap["state"], "ARMED_FOR_APPROACH")
        self.assertIsNone(snap["target"])

    def test_armed_to_approach_logs_mode_and_land_start_without_sending(self):
        sent = []
        auto = machine(transport=lambda kind, fields: sent.append((kind, fields)))
        auto.tick(good_telem(mode="FBWA"), now=1)
        snap = auto.tick(good_telem(mode="FBWA"), target=target(), now=2)
        self.assertEqual(snap["state"], "APPROACH")
        kinds = [item["kind"] for item in snap["commands"]]
        self.assertEqual(kinds, ["SET_MODE", "DO_LAND_START"])
        self.assertEqual(snap["commands"][0]["fields"]["custom_mode"], 10)
        self.assertEqual(snap["commands"][1]["fields"]["command"], 189)
        self.assertTrue(all(item["sent"] is False and item["reason"] == "shadow" for item in snap["commands"]))
        self.assertEqual(sent, [])
        self.assertFalse(snap["flightCommandsSent"])
        self.assertFalse(snap["paramWrites"])

    def test_already_auto_skips_mode_change(self):
        auto = machine()
        auto.tick(good_telem(), now=1)
        snap = auto.tick(good_telem(), target=target(), now=2)
        self.assertEqual([item["kind"] for item in snap["commands"]], ["DO_LAND_START"])

    def test_approach_to_final(self):
        auto = machine()
        auto.tick(good_telem(), now=1)
        auto.tick(good_telem(), target=target(), now=2)
        snap = auto.tick(good_telem(), target=target(range_m=120, height_m=20), now=3)
        self.assertEqual(snap["state"], "FINAL")
        self.assertIn("LANDING_TARGET", [item["kind"] for item in snap["commands"]])

    def test_final_to_flare(self):
        auto = machine()
        self._to_final(auto)
        snap = auto.tick(good_telem(), target=target(range_m=40, height_m=6), now=4)
        self.assertEqual(snap["state"], "FLARE")

    def test_flare_to_rollout(self):
        auto = machine()
        self._to_final(auto)
        auto.tick(good_telem(), target=target(range_m=20, height_m=5), now=4)
        snap = auto.tick(good_telem(), target=target(range_m=5, height_m=0.4), now=5)
        self.assertEqual(snap["state"], "ROLLOUT")
        self.assertTrue(all(item["sent"] is False for item in snap["commands"]))

    def test_rollout_holds_through_link_loss(self):
        auto = machine()
        self._to_rollout(auto)
        snap = auto.tick(good_telem(link_healthy=False), target=None, now=9)
        self.assertEqual(snap["state"], "ROLLOUT")
        self.assertIsNone(snap["abortReason"])

    def _to_final(self, auto):
        auto.tick(good_telem(), now=1)
        auto.tick(good_telem(), target=target(), now=2)
        snap = auto.tick(good_telem(), target=target(range_m=100, height_m=30), now=3)
        self.assertEqual(snap["state"], "FINAL")

    def _to_rollout(self, auto):
        self._to_final(auto)
        auto.tick(good_telem(), target=target(range_m=20, height_m=4), now=4)
        snap = auto.tick(good_telem(), target=target(range_m=4, height_m=0.2), now=5)
        self.assertEqual(snap["state"], "ROLLOUT")


class Aborts(unittest.TestCase):
    def _armed(self):
        auto = machine()
        auto.tick(good_telem(), now=1)
        return auto

    def _approach(self):
        auto = self._armed()
        snap = auto.tick(good_telem(), target=target(), now=2)
        self.assertEqual(snap["state"], "APPROACH")
        return auto

    def _final(self):
        auto = self._approach()
        snap = auto.tick(good_telem(), target=target(range_m=90, height_m=25), now=3)
        self.assertEqual(snap["state"], "FINAL")
        return auto

    def _flare(self):
        auto = self._final()
        snap = auto.tick(good_telem(), target=target(range_m=30, height_m=5), now=4)
        self.assertEqual(snap["state"], "FLARE")
        return auto

    def _expect_abort(self, auto, telem, tgt, reason):
        snap = auto.tick(telem, target=tgt, now=6)
        self.assertEqual(snap["state"], "ABORT")
        self.assertEqual(snap["abortReason"], reason)
        self.assertEqual(snap["abortReasonHe"] != "", True)
        self.assertEqual(snap["fallbackHe"], "נשארת ההתנהגות שכבר מוגדרת בבקר")
        self.assertTrue(all(item["sent"] is False for item in snap["commands"]))
        self.assertNotIn("PARAM_SET", [item["kind"] for item in snap["commands"]])

    def test_armed_aborts(self):
        cases = [
            ("link_loss", good_telem(link_healthy=False), None),
            ("low_battery", good_telem(battery_pct=19), None),
            ("position_invalid", good_telem(position_valid=False), None),
            ("mode_invalid", good_telem(mode_valid=False, mode=None), None),
            ("cross_track", good_telem(), target(cross_track_m=26)),
            ("glideslope", good_telem(), target(glideslope_error_m=16)),
        ]
        for reason, telem, tgt in cases:
            self._expect_abort(self._armed(), telem, tgt, reason)

    def test_target_loss_does_not_abort_before_approach(self):
        auto = self._armed()
        snap = auto.tick(good_telem(), target=None, now=3)
        self.assertEqual(snap["state"], "ARMED_FOR_APPROACH")

    def test_unknown_battery_does_not_abort(self):
        auto = self._armed()
        snap = auto.tick(good_telem(battery_pct=None), now=3)
        self.assertEqual(snap["state"], "ARMED_FOR_APPROACH")

    def test_approach_aborts(self):
        cases = [
            ("link_loss", good_telem(link_healthy=False), target()),
            ("low_battery", good_telem(battery_pct=5), target()),
            ("target_loss", good_telem(), None),
            ("target_loss", good_telem(), target(age_s=2.0)),
            ("cross_track", good_telem(), target(cross_track_m=25.1)),
            ("glideslope", good_telem(), target(glideslope_error_m=-15.1)),
        ]
        for reason, telem, tgt in cases:
            self._expect_abort(self._approach(), telem, tgt, reason)

    def test_final_uses_tighter_cross_track(self):
        self._expect_abort(self._final(), good_telem(), target(range_m=80, height_m=20, cross_track_m=9), "cross_track")

    def test_approach_accepts_cross_track_inside_wide_limit(self):
        auto = self._approach()
        snap = auto.tick(good_telem(), target=target(cross_track_m=20, range_m=400), now=4)
        self.assertEqual(snap["state"], "APPROACH")

    def test_flare_target_loss(self):
        self._expect_abort(self._flare(), good_telem(), None, "target_loss")

    def test_abort_holds_until_reset(self):
        auto = self._approach()
        auto.tick(good_telem(link_healthy=False), now=4)
        snap = auto.tick(good_telem(), target=target(), now=5)
        self.assertEqual(snap["state"], "ABORT")
        auto.reset()
        snap = auto.tick(good_telem(), now=6)
        self.assertEqual(snap["state"], "ARMED_FOR_APPROACH")
        self.assertIsNone(snap["abortReason"])
        self.assertEqual(snap["commands"], [])


class Sender(unittest.TestCase):
    def test_disabled_send_is_a_noop(self):
        sent = []
        sender = GuardedSender(enabled=False, shadow=False, transport=lambda k, f: sent.append(k))
        entry = sender.send("LANDING_TARGET", {"angle_x": 0.1, "angle_y": 0.2, "distance_m": 10})
        self.assertFalse(entry["sent"])
        self.assertEqual(entry["reason"], "disabled")
        self.assertEqual(sent, [])

    def test_shadow_does_not_send_even_if_enabled(self):
        sent = []
        sender = GuardedSender(enabled=True, shadow=True, transport=lambda k, f: sent.append(k))
        entry = sender.send("DO_LAND_START", {"command": 189})
        self.assertEqual(entry["reason"], "shadow")
        self.assertEqual(sent, [])

    def test_enabled_without_shadow_calls_transport_once(self):
        sent = []
        sender = GuardedSender(enabled=True, shadow=False, transport=lambda k, f: sent.append((k, f)))
        entry = sender.send("SET_MODE", {"custom_mode": 10, "mode_name": "AUTO"})
        self.assertTrue(entry["sent"])
        self.assertEqual(sent, [("SET_MODE", {"custom_mode": 10, "mode_name": "AUTO"})])

    def test_missing_transport_does_not_send(self):
        sender = GuardedSender(enabled=True, shadow=False, transport=None)
        entry = sender.send("DO_LAND_START", {"command": 189})
        self.assertEqual(entry["reason"], "no_transport")
        self.assertFalse(entry["sent"])

    def test_rejects_other_kinds(self):
        sender = GuardedSender(enabled=True, shadow=False, transport=lambda k, f: None)
        entry = sender.send("PARAM_SET", {"name": "RTL_ALT"})
        self.assertEqual(entry["reason"], "rejected")
        self.assertFalse(entry["sent"])

    def test_env_default_builds_a_disabled_shadow_machine_without_transport(self):
        env = {}
        auto = build_machine_from_env(env)
        self.assertFalse(auto.enabled)
        self.assertTrue(auto.shadow)
        self.assertIsNone(auto.sender.transport)
        self.assertEqual(auto.expected_token, "")
        snap = auto.tick(good_telem(), now=1)
        self.assertEqual(snap["state"], "IDLE")
        self.assertFalse(next(g for g in snap["gates"] if g["id"] == "config_enabled")["ok"])
        self.assertFalse(next(g for g in snap["gates"] if g["id"] == "arm_token")["ok"])

    def test_env_flags_still_have_no_transport(self):
        auto = build_machine_from_env({
            "AUTOLAND_ENABLED": "true",
            "AUTOLAND_SHADOW": "false",
            "AUTOLAND_ARM_TOKEN": TOKEN,
        })
        self.assertTrue(auto.enabled)
        self.assertFalse(auto.shadow)
        self.assertIsNone(auto.sender.transport)
        auto.tick(good_telem(), now=1)
        snap = auto.tick(good_telem(), target=target(), now=2)
        self.assertEqual(snap["state"], "APPROACH")
        self.assertTrue(snap["commands"])
        self.assertTrue(all(item["sent"] is False and item["reason"] == "no_transport" for item in snap["commands"]))

    def test_source_has_no_parameter_write(self):
        path = os.path.join(os.path.dirname(__file__), "..", "scripts", "jetson-companion", "autoland.py")
        text = open(path, encoding="utf-8").read()
        self.assertNotIn("PARAM_SET", text)
        self.assertNotIn("param_set", text)


class PluginAndPosition(unittest.TestCase):
    def test_missing_marker_detector_is_absent(self):
        self.assertIsNone(load_marker_detector())

    def test_detector_none_does_not_invent_a_target(self):
        plugin = MarkerDetectorPlugin(None)
        plugin.update_frame("cam2", {"jpeg": b"not-a-target"})
        self.assertIsNone(plugin.read(1))

    def test_detector_result_is_used_and_empty_stays_empty(self):
        class Det:
            def __init__(self):
                self.raw = None

            def detect(self, packet, cam_id=None, now_s=None):
                return self.raw

        det = Det()
        plugin = MarkerDetectorPlugin(det)
        bus_events = []

        class Bus:
            def subscribe(self, callback):
                bus_events.append(callback)
                return lambda: None

        auto = machine(plugin=plugin)
        auto.bind_bus(Bus())
        bus_events[0]("cam2", {"frame": 1})
        self.assertIsNone(plugin.read(1))
        det.raw = target()
        got = plugin.read(2)
        self.assertIsNotNone(got)
        self.assertEqual(got["range_m"], 800.0)

    def test_global_position_frame_is_a_valid_fix(self):
        payload = struct.pack("<IiiiihhhH", 1000, int(-35.36 * 1e7), int(149.16 * 1e7), 584000, 40000, 0, 100, -50, 18000)
        frame = v2(33, payload, 104)
        gps = struct.pack("<QB", 1000, 3) + b"\x00" * 20
        gps_frame = v2(24, gps, 24)
        auto = machine()
        clock = {"t": 10.0}
        auto.position.set_clock(lambda: clock["t"])
        auto.observe_bytes(frame + gps_frame)
        pos = auto.position.snapshot(10.0)
        self.assertTrue(pos["valid"])
        self.assertAlmostEqual(pos["relative_alt_m"], 40.0, places=3)
        self.assertEqual(pos["fix_type"], 3)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    if result.wasSuccessful():
        print("ok")
        raise SystemExit(0)
    raise SystemExit(1)
