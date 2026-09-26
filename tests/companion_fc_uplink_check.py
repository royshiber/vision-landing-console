#!/usr/bin/env python3
"""Recorded-payload checks for FC telemetry and HiLink/uplink status."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts", "jetson-companion"))

from fc_telemetry import FcObserver
from uplink_status import (
    hilink_status,
    reset_uplink_caches,
    set_clock,
    set_hilink_fetcher,
    set_host_reader,
    uplinks_payload,
)

# Built with mavlink-mappings CRC extras (0=50, 1=124, 147=154, 152=208, 11039=142).
AP = "fd0900000001010000000a00000001038103038057"
GCS = "fd09000000ffbe00000000000000060800030338c4"
INVALID_AP = "fd090000000101000000000000000108000303de10"
COMP0 = "fd090000000100000000000000000103800303b604"
QUAD = "fd090000002a010000000000000002030003039a9f"
UNKNOWN_MODE = "fd09000000010100000063000000010300030395de"
SIGNED = "fd090100000701000000050000000103800303eda611111111111111111111111111"
SYS = "fd1f0000000101010000000000000000000000000000fa00a04100003412000000000000000000004868df"
SYS_SHORT = "fd10000000010101000000000000000000000000000064005c2b3452"
BAT = "fd240000000101930000ffffffffffffffffff7f68105e1054107210ffffffffffffffffffffffffffff000000500c14"
MEM = "fd080000000101980000e8030010400d03003df1"
MEM_SHORT = "fd04000000010198000032000008c4a3"
MCU = "fd0900000001011f2b00b411e40c0000000001ec45"

SES = "<response><SesInfo>SessionID=abc</SesInfo><TokInfo>tok-1</TokInfo></response>"
SIGNAL = "<response><rssi>-75dBm</rssi><rsrp>-95dBm</rsrp><rsrq>-11dB</rsrq><sinr>15dB</sinr></response>"
MON = "<response><ConnectionStatus>901</ConnectionStatus><CurrentNetworkTypeEx>101</CurrentNetworkTypeEx><SignalIcon>4</SignalIcon></response>"
SIGNAL_EMPTY = (
    "<response><rssi></rssi><rsrp></rsrp><rsrq></rsrq><sinr></sinr>"
    "<pci></pci><cell_id></cell_id><lte_bandinfo></lte_bandinfo><mode>7</mode></response>"
)
MON_ICON = (
    "<response><SignalIcon>5</SignalIcon><maxsignal>5</maxsignal>"
    "<CurrentNetworkTypeEx>101</CurrentNetworkTypeEx><ConnectionStatus>901</ConnectionStatus>"
    "<SignalStrength></SignalStrength></response>"
)
PLMN = (
    "<response><FullName>Partner</FullName><ShortName>Partner</ShortName>"
    "<Numeric>42501</Numeric><Rat>7</Rat></response>"
)
SIGNAL_PARA = "<response><Rscp>-145dBm</Rscp><Ecio>-32dB</Ecio></response>"


def b(hex_str):
    return bytes.fromhex(hex_str)


def check(cond, msg):
    if not cond:
        raise SystemExit(msg)


def test_fc():
    clock = [0.0]
    obs = FcObserver(now_fn=lambda: clock[0])
    obs.feed(b(GCS))
    snap = obs.snapshot()
    check(snap["connected"] is False, "gcs heartbeat must not connect")
    check(snap["last_heartbeat_age_ms"] is None, "gcs must not start the age clock")
    check(snap["armed"] is None and snap["mode"] is None, "gcs must not invent fc fields")

    obs.feed(b(INVALID_AP))
    obs.feed(b(COMP0))
    check(obs.snapshot()["connected"] is False, "invalid autopilot or compid 0 must not connect")

    obs.feed(b(AP[:8]))
    check(obs.snapshot()["connected"] is False, "split frame must wait for the tail")
    obs.feed(b(AP[8:]))
    snap = obs.snapshot()
    check(snap["connected"] is True, "autopilot heartbeat connects")
    check(snap["mode"] == "AUTO", snap["mode"])
    check(snap["custom_mode"] == 10, "custom_mode")
    check(snap["armed"] is True, "armed bit")
    check(snap["system_id"] == 1 and snap["component_id"] == 1, "ids")
    check(snap["autopilot"] == 3, "autopilot")
    check(snap["heartbeat"]["validity"] == "valid", "validity")
    check(snap["last_heartbeat_age_ms"] == 0, "age 0")

    obs.feed(b(SYS) + b(MEM) + b(MCU))
    snap = obs.snapshot()
    check(snap["load_pct"] == 25.0, snap["load_pct"])
    check(snap["battery_v"] == 16.8, snap["battery_v"])
    check(snap["battery_pct"] == 72, snap["battery_pct"])
    check(snap["battery_source"] == "sys_status", snap["battery_source"])
    check(abs(snap["meminfo_free_kb"] - (200000 / 1024.0)) < 1e-6, snap["meminfo_free_kb"])
    check(abs(snap["mcu_temp_c"] - 45.32) < 1e-6, snap["mcu_temp_c"])

    obs.feed(b(BAT))
    snap = obs.snapshot()
    check(snap["battery_source"] == "battery_status", snap["battery_source"])
    check(abs(snap["battery_v"] - 16.78) < 1e-6, snap["battery_v"])
    check(snap["battery_pct"] == 80, snap["battery_pct"])
    check(snap["load_pct"] == 25.0, "load still from sys_status")

    clock[0] = 3.0
    check(obs.snapshot()["connected"] is True, "age 3s still connected")
    clock[0] = 3.1
    snap = obs.snapshot()
    check(snap["connected"] is False, "age 3.1s disconnects")
    check(snap["armed"] is None and snap["mode"] is None, "stale live fields")
    check(snap["load_pct"] is None and snap["battery_v"] is None, "stale gauges")
    check(snap["battery_pct"] is None and snap["meminfo_free_kb"] is None, "stale mem")
    check(snap["mcu_temp_c"] is None, "stale temp")
    check(snap["last_heartbeat_age_ms"] == 3100, snap["last_heartbeat_age_ms"])
    check(snap["heartbeat"]["validity"] == "invalid", "invalid when stale")

    clock[0] = 0.0
    obs.reset()
    obs.feed(b(SYS_SHORT))
    obs.feed(b(AP))
    snap = obs.snapshot()
    check(snap["load_pct"] == 10.0, snap["load_pct"])
    check(snap["battery_v"] == 11.1, snap["battery_v"])
    check(snap["battery_pct"] is None, "trimmed remaining must stay null")
    check(snap["battery_source"] == "sys_status", snap["battery_source"])

    obs.reset()
    obs.feed(b(MEM_SHORT))
    obs.feed(b(AP))
    snap = obs.snapshot()
    check(snap["meminfo_free_kb"] == 2.0, snap["meminfo_free_kb"])

    obs.reset()
    obs.feed(b(QUAD))
    snap = obs.snapshot()
    check(snap["connected"] is True and snap["mode"] is None, "non-plane type has no plane name")
    check(snap["armed"] is False, "base_mode 0 is disarmed, not null")
    check(snap["system_id"] == 42, snap["system_id"])

    obs.reset()
    obs.feed(b(UNKNOWN_MODE))
    snap = obs.snapshot()
    check(snap["connected"] is True and snap["mode"] is None and snap["custom_mode"] == 99, "unknown mode")

    obs.reset()
    obs.feed(b(SIGNED))
    snap = obs.snapshot()
    check(snap["connected"] is True and snap["mode"] == "FBWA" and snap["armed"] is True, "signed v2")
    check(snap["system_id"] == 7, snap["system_id"])

    obs.reset()
    bad = bytearray(b(AP))
    bad[-1] ^= 0xFF
    obs.feed(bytes(bad))
    check(obs.snapshot()["connected"] is False, "bad crc ignored")

    obs.reset()
    obs.feed(b(SYS))
    clock[0] = 6.0
    obs.feed(b(AP))
    snap = obs.snapshot()
    check(snap["connected"] is True, "fresh heartbeat")
    check(snap["load_pct"] is None and snap["battery_v"] is None, "sys older than 5s is not live")


class Host:
    def __init__(self):
        self.wifi_up = True
        self.cell_up = True

    def cell_iface(self):
        return "enx0c5b8f279a64"

    def oper_up(self, iface):
        if iface == "wlP1p1s0":
            return self.wifi_up
        if iface == "enx0c5b8f279a64":
            return self.cell_up
        return False

    def ipv4(self, iface):
        if iface == "wlP1p1s0" and self.wifi_up:
            return "192.168.1.20"
        if iface == "enx0c5b8f279a64" and self.cell_up:
            return "192.168.8.100"
        return None

    def iw(self, iface):
        if iface == "wlP1p1s0" and self.wifi_up:
            return {"ssid": "lab-net", "signal_dbm": -48}
        return {"ssid": None, "signal_dbm": None}

    def routes(self):
        return [
            {"iface": "wlP1p1s0", "metric": 600},
            {"iface": "enx0c5b8f279a64", "metric": 50},
            {"iface": "enp0s5", "metric": 100},
        ]


def test_uplink():
    os.environ.pop("VLC_E3372_HILINK_URL", None)
    os.environ.pop("VLC_CELL_IFACE", None)
    os.environ["VLC_UPLINKS_STATE"] = "/tmp/airvix-uplinks-fixture-missing.json"
    reset_uplink_caches()
    clock = [0.0]
    set_clock(lambda: clock[0])
    blank = hilink_status()
    check(blank["probed"] is False, "no iface and no url must not probe")
    check(blank["age_ms"] is None, "no age without a read")
    check(blank["signal"]["rssi"] is None, "no invented rssi")

    calls = {"n": 0, "saw_token": False}

    def fetch(url, headers, timeout):
        check(timeout <= 0.5, "timeout")
        calls["n"] += 1
        if url.endswith("/api/webserver/SesTokInfo"):
            return SES
        check(headers.get("Cookie") == "SessionID=abc", headers)
        check(headers.get("__RequestVerificationToken") == "tok-1", headers)
        calls["saw_token"] = True
        if url.endswith("/api/device/signal"):
            return SIGNAL
        if url.endswith("/api/monitoring/status"):
            return MON
        if url.endswith("/api/net/current-plmn"):
            return "<response></response>"
        raise SystemExit("unexpected " + url)

    os.environ["VLC_E3372_HILINK_URL"] = "http://192.168.8.1"
    set_hilink_fetcher(fetch)
    host = Host()
    set_host_reader(host)
    snap = hilink_status()
    check(calls["n"] == 4, calls["n"])
    check(calls["saw_token"] is True, "token")
    check(snap["signal"]["rssi"] == -75, snap["signal"])
    check(snap["signal"]["rsrp"] == -95, snap["signal"])
    check(snap["signal"]["rsrq"] == -11, snap["signal"])
    check(snap["signal"]["sinr"] == 15, snap["signal"])
    check(snap["connection_status"] == "901", snap["connection_status"])
    check(snap["connection_label"] == "connected", snap["connection_label"])
    check(snap["network_type"] == "101", snap["network_type"])
    check(snap["signal_icon"] == 4, snap["signal_icon"])
    check(snap["signal_max"] is None, snap["signal_max"])
    check(snap["network_label"] == "LTE", snap["network_label"])
    check(snap["operator"]["short"] is None and snap["operator"]["full"] is None, snap["operator"])
    check(snap["wan_ip"] == "192.168.8.100", snap["wan_ip"])
    check(snap["age_ms"] == 0, snap["age_ms"])
    hilink_status()
    check(calls["n"] == 4, "cache must hold for 5s")
    clock[0] = 4.0
    aged = hilink_status()
    check(aged["age_ms"] == 4000, aged["age_ms"])
    check(aged["signal"]["rssi"] == -75, "cached signal")
    check(calls["n"] == 4, "still cached")

    def fail(_url, _headers, _timeout):
        calls["n"] += 1
        raise OSError("down")

    clock[0] = 10.0
    set_hilink_fetcher(fail)
    failed = hilink_status()
    check(failed["signal"]["rssi"] is None, "failed refresh must not keep stale rssi")
    check(failed["connection_status"] is None, "failed refresh clears status")
    check(failed["age_ms"] == 0, failed["age_ms"])

    set_hilink_fetcher(fetch)
    # cache now holds the failure; jump past it and restore a good read for uplinks
    clock[0] = 20.0
    calls["n"] = 0
    body = uplinks_payload()
    check(body["read_only"] is False, "control is available")
    check(body["wifi"]["enabled"] is True and body["cellular"]["enabled"] is True, body)
    check(body["wifi"]["iface"] == "wlP1p1s0", body["wifi"])
    check(body["wifi"]["up"] is True and body["wifi"]["ssid"] == "lab-net", body["wifi"])
    check(body["wifi"]["signal_dbm"] == -48, body["wifi"])
    check(body["wifi"]["ip"] == "192.168.1.20", body["wifi"])
    check(body["wifi"]["default_route"] is False, "cell metric wins")
    check(body["cellular"]["iface"] == "enx0c5b8f279a64", body["cellular"])
    check(body["cellular"]["up"] is True, body["cellular"])
    check(body["cellular"]["ip"] == "192.168.8.100", body["cellular"])
    check(body["cellular"]["route_metric"] == 50, body["cellular"])
    check(body["cellular"]["default_route"] is True, body["cellular"])
    check(body["cellular"]["signal"]["rsrp"] == -95, body["cellular"])
    check(body["cellular"]["signal_icon"] == 4, body["cellular"])
    check(body["cellular"]["network_label"] == "LTE", body["cellular"])
    check(body["cellular"]["signal_max"] is None, body["cellular"])
    check(body["default_iface"] == "enx0c5b8f279a64", body["default_iface"])

    host.routes = lambda: None
    clock[0] = 30.0
    down = uplinks_payload()
    check(down["default_iface"] is None, "route command failure stays null")
    check(down["cellular"]["route_metric"] is None, down["cellular"])

    host.wifi_up = False
    host.cell_up = False
    quiet = uplinks_payload()
    check(quiet["wifi"]["ssid"] is None and quiet["wifi"]["signal_dbm"] is None, quiet["wifi"])
    check(quiet["wifi"]["ip"] is None and quiet["cellular"]["ip"] is None, "down has no invented ip")


def test_e3372_icon():
    """E3372h-153 hides dBm. Bars come from SignalIcon, not signal-para."""
    os.environ["VLC_E3372_HILINK_URL"] = "http://192.168.8.1"
    reset_uplink_caches()
    clock = [100.0]
    set_clock(lambda: clock[0])
    urls = []

    def fetch(url, headers, timeout):
        check(timeout <= 0.5, timeout)
        urls.append(url)
        if url.endswith("/api/webserver/SesTokInfo"):
            return SES
        check(headers.get("Cookie") == "SessionID=abc", headers)
        check(headers.get("__RequestVerificationToken") == "tok-1", headers)
        if url.endswith("/api/device/signal"):
            return SIGNAL_EMPTY
        if url.endswith("/api/monitoring/status"):
            return MON_ICON
        if url.endswith("/api/net/current-plmn"):
            return PLMN
        if "signal-para" in url:
            raise SystemExit("signal-para must not be read")
        raise SystemExit("unexpected " + url)

    set_hilink_fetcher(fetch)
    snap = hilink_status()
    check(all("signal-para" not in url for url in urls), urls)
    check(sum(1 for url in urls if url.endswith("/api/net/current-plmn")) == 1, urls)
    check(snap["signal"]["rssi"] is None, snap["signal"])
    check(snap["signal"]["rsrp"] is None, snap["signal"])
    check(snap["signal"]["rsrq"] is None, snap["signal"])
    check(snap["signal"]["sinr"] is None, snap["signal"])
    check(snap["signal_icon"] == 5, snap["signal_icon"])
    check(snap["signal_max"] == 5, snap["signal_max"])
    check(snap["network_type"] == "101", snap["network_type"])
    check(snap["network_label"] == "LTE", snap["network_label"])
    check(snap["operator"]["short"] == "Partner", snap["operator"])
    check(snap["operator"]["full"] == "Partner", snap["operator"])
    check("Rscp" not in str(snap["signal"]), snap["signal"])

    hilink_status()
    check(sum(1 for url in urls if url.endswith("/api/net/current-plmn")) == 1, "plmn stays in the cache")

    def typed(url, headers, timeout):
        check(timeout <= 0.5, timeout)
        if url.endswith("/api/webserver/SesTokInfo"):
            return SES
        if url.endswith("/api/device/signal"):
            return SIGNAL_EMPTY
        if url.endswith("/api/monitoring/status"):
            code = typed.code
            return (
                "<response><SignalIcon>2</SignalIcon><maxsignal>5</maxsignal>"
                f"<CurrentNetworkTypeEx>{code}</CurrentNetworkTypeEx>"
                "<ConnectionStatus>901</ConnectionStatus></response>"
            )
        if url.endswith("/api/net/current-plmn"):
            raise OSError("plmn down")
        raise SystemExit("unexpected " + url)

    typed.code = "1011"
    clock[0] = 110.0
    set_hilink_fetcher(typed)
    lte_plus = hilink_status()
    check(lte_plus["network_label"] == "LTE+", lte_plus["network_label"])
    check(lte_plus["signal_icon"] == 2, lte_plus["signal_icon"])
    check(lte_plus["operator"]["short"] is None, lte_plus["operator"])
    check(lte_plus["signal"]["rsrp"] is None, "plmn failure must not invent rsrp")

    for code, label in (("3", "EDGE"), ("7", "HSPA"), ("41", "WCDMA"), ("999", None), ("0", None)):
        typed.code = code
        clock[0] += 10.0
        got = hilink_status()
        check(got["network_label"] == label, (code, got["network_label"]))
        check(got["network_type"] == code, got["network_type"])

    typed.code = "101"
    clock[0] += 10.0

    def empty_max(url, headers, timeout):
        if url.endswith("/api/webserver/SesTokInfo"):
            return SES
        if url.endswith("/api/device/signal"):
            return SIGNAL_EMPTY
        if url.endswith("/api/monitoring/status"):
            return "<response><SignalIcon></SignalIcon><maxsignal></maxsignal><CurrentNetworkTypeEx>101</CurrentNetworkTypeEx></response>"
        if url.endswith("/api/net/current-plmn"):
            return "<response><ShortName> </ShortName><FullName></FullName></response>"
        raise SystemExit(url)

    set_hilink_fetcher(empty_max)
    blank_icon = hilink_status()
    check(blank_icon["signal_icon"] is None, blank_icon["signal_icon"])
    check(blank_icon["signal_max"] is None, blank_icon["signal_max"])
    check(blank_icon["network_label"] == "LTE", blank_icon["network_label"])
    check(blank_icon["operator"]["short"] is None and blank_icon["operator"]["full"] is None, blank_icon["operator"])

    host = Host()
    set_host_reader(host)
    set_hilink_fetcher(fetch)
    clock[0] += 10.0
    body = uplinks_payload()
    cell = body["cellular"]
    check(cell["signal"]["rssi"] is None and cell["signal"]["rsrp"] is None, cell["signal"])
    check(cell["signal_icon"] == 5 and cell["signal_max"] == 5, cell)
    check(cell["network_label"] == "LTE", cell)
    check(cell["operator"]["short"] == "Partner" and cell["operator"]["full"] == "Partner", cell["operator"])
    check(SIGNAL_PARA not in str(cell), "signal-para values must not appear")


if __name__ == "__main__":
    test_fc()
    test_uplink()
    test_e3372_icon()
    print("ok")
