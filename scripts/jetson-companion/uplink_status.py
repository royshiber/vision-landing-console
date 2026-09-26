"""Wi-Fi / Huawei E3372 HiLink status.

Signal is reported only from a real HiLink reply. A missing iface or a
failed read stays null. Link on/off lives in uplink_control.py.
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

HILINK_CACHE_S = 5.0
HILINK_TIMEOUT_S = 0.5
WIFI_IFACE_DEFAULT = "wlP1p1s0"
HUAWEI_VENDOR = "12d1"

# Huawei HiLink ConnectionStatus values we actually know. Anything else stays raw.
CONNECTION_LABELS = {
    "901": "connected",
    "902": "disconnected",
}

# CurrentNetworkTypeEx → short label. Unknown codes stay null. Do not invent one.
# 101 / 19 are LTE. 1011 is LTE-A (shown as LTE+). The rest are common 2G/3G codes.
NETWORK_LABELS = {
    "1": "GSM",
    "2": "GPRS",
    "3": "EDGE",
    "4": "WCDMA",
    "5": "HSDPA",
    "6": "HSUPA",
    "7": "HSPA",
    "8": "TD-SCDMA",
    "9": "HSPA+",
    "19": "LTE",
    "41": "WCDMA",
    "42": "HSDPA",
    "43": "HSUPA",
    "44": "HSPA",
    "45": "HSPA+",
    "46": "DC-HSPA+",
    "61": "TD-SCDMA",
    "62": "TD-HSDPA",
    "63": "TD-HSUPA",
    "64": "TD-HSPA",
    "65": "TD-HSPA+",
    "101": "LTE",
    "1011": "LTE+",
}

_LOCK = threading.Lock()
_cache = None
_fetcher = None
_host = None
_clock = time.monotonic


def set_clock(now_fn):
    global _clock
    _clock = now_fn or time.monotonic


def set_hilink_fetcher(fn):
    global _fetcher
    _fetcher = fn


def set_host_reader(reader):
    global _host
    _host = reader


def reset_uplink_caches():
    global _cache, _fetcher, _host, _clock
    with _LOCK:
        _cache = None
        _fetcher = None
        _host = None
        _clock = time.monotonic


def _now():
    return _clock()


def _num_prefix(text):
    if text is None:
        return None
    match = re.match(r"^\s*([+-]?\d+(?:\.\d+)?)", str(text))
    if not match:
        return None
    raw = match.group(1)
    if "." in raw:
        return float(raw)
    return int(raw)


def _int_or_none(text):
    number = _num_prefix(text)
    if isinstance(number, bool) or number is None:
        return None
    if isinstance(number, int):
        return number
    if isinstance(number, float) and number.is_integer():
        return int(number)
    return None


def _name_or_none(text):
    if text is None:
        return None
    cleaned = str(text).strip()
    return cleaned or None


def _blank_operator():
    return {"short": None, "full": None}


def _network_label(code):
    if code is None or str(code).strip() == "":
        return None
    return NETWORK_LABELS.get(str(code).strip())


def _xml_tag(xml, tag):
    if not xml:
        return None
    match = re.search(rf"<{tag}>(.*?)</{tag}>", xml, re.I | re.S)
    if not match:
        return None
    return match.group(1).strip()


def _default_fetch(url, headers, timeout):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def cellular_iface_name():
    override = os.environ.get("VLC_CELL_IFACE", "").strip()
    if override:
        return override
    if _host is not None and hasattr(_host, "cell_iface"):
        return _host.cell_iface()
    net = Path("/sys/class/net")
    if not net.is_dir():
        return None
    for node in sorted(net.glob("enx*")):
        uevent = node / "device" / "uevent"
        try:
            text = uevent.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if re.search(r"PRODUCT=12d1/", text, re.I):
            return node.name
    return None


def hilink_base_url():
    """None unless an override URL is set or a Huawei enx iface exists."""
    explicit = os.environ.get("VLC_E3372_HILINK_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    if cellular_iface_name():
        return "http://192.168.8.1"
    return None


def _empty_signal():
    return {"rssi": None, "rsrp": None, "rsrq": None, "sinr": None}


def _blank_hilink():
    return {
        "probed": False,
        "ok": False,
        "signal": _empty_signal(),
        "connection_status": None,
        "connection_label": None,
        "network_type": None,
        "network_label": None,
        "signal_icon": None,
        "signal_max": None,
        "operator": _blank_operator(),
        "wan_ip": None,
        "age_ms": None,
        "signal_seen": False,
    }


def _fetch_hilink(base):
    fetch = _fetcher or _default_fetch
    timeout = HILINK_TIMEOUT_S
    ses_xml = fetch(f"{base}/api/webserver/SesTokInfo", {}, timeout)
    ses = _xml_tag(ses_xml, "SesInfo")
    tok = _xml_tag(ses_xml, "TokInfo")
    headers = {}
    if ses:
        headers["Cookie"] = ses
    if tok:
        headers["__RequestVerificationToken"] = tok
    signal_xml = fetch(f"{base}/api/device/signal", headers, timeout)
    status_xml = fetch(f"{base}/api/monitoring/status", headers, timeout)
    # /api/net/signal-para is a 3G placeholder on this firmware. Never read it.
    operator = _fetch_operator(fetch, base, headers, timeout)
    signal = {
        "rssi": _num_prefix(_xml_tag(signal_xml, "rssi")),
        "rsrp": _num_prefix(_xml_tag(signal_xml, "rsrp")),
        "rsrq": _num_prefix(_xml_tag(signal_xml, "rsrq")),
        "sinr": _num_prefix(_xml_tag(signal_xml, "sinr")),
    }
    connection = _xml_tag(status_xml, "ConnectionStatus")
    icon = _int_or_none(_xml_tag(status_xml, "SignalIcon"))
    network_type = _xml_tag(status_xml, "CurrentNetworkTypeEx")
    seen = any(signal[k] is not None for k in signal) or connection is not None or icon is not None
    body = {
        "probed": True,
        "ok": seen,
        "signal": signal,
        "connection_status": connection,
        "connection_label": CONNECTION_LABELS.get(str(connection)) if connection else None,
        "network_type": network_type,
        "network_label": _network_label(network_type),
        "signal_icon": icon,
        "signal_max": _int_or_none(_xml_tag(status_xml, "maxsignal")),
        "operator": operator,
        "wan_ip": _iface_ipv4(cellular_iface_name()),
        "signal_seen": seen,
    }
    return body


def _fetch_operator(fetch, base, headers, timeout):
    """Best-effort PLMN. A failure leaves the operator null and does not fail signal."""
    try:
        xml = fetch(f"{base}/api/net/current-plmn", headers, timeout)
    except Exception:
        return _blank_operator()
    return {
        "short": _name_or_none(_xml_tag(xml, "ShortName")),
        "full": _name_or_none(_xml_tag(xml, "FullName")),
    }


def hilink_status():
    base = hilink_base_url()
    now = _now()
    if not base:
        return _blank_hilink()
    global _cache
    with _LOCK:
        cached = _cache
    if cached and cached.get("base") == base and (now - cached["t"]) < HILINK_CACHE_S:
        return _with_age(cached["body"], now, cached["t"])
    try:
        body = _fetch_hilink(base)
    except Exception:
        body = _blank_hilink()
        body["probed"] = True
        body["ok"] = False
    with _LOCK:
        _cache = {"t": now, "base": base, "body": body}
    return _with_age(body, now, now)


def _with_age(body, now, fetched_at):
    out = dict(body)
    out["signal"] = dict(body.get("signal") or _empty_signal())
    operator = body.get("operator") if isinstance(body.get("operator"), dict) else _blank_operator()
    out["operator"] = {
        "short": operator.get("short"),
        "full": operator.get("full"),
    }
    out["age_ms"] = int(round((now - fetched_at) * 1000))
    return out


def enrich_modem(body):
    """Add HiLink fields onto the status-file snapshot. Never invents signal."""
    if not isinstance(body, dict):
        return body
    snap = hilink_status()
    body["signal"] = snap["signal"]
    body["connection_status"] = snap["connection_status"]
    body["connection_label"] = snap["connection_label"]
    body["network_type"] = snap["network_type"]
    body["network_label"] = snap.get("network_label")
    body["signal_icon"] = snap["signal_icon"]
    body["signal_max"] = snap.get("signal_max")
    body["operator"] = dict(snap.get("operator") or _blank_operator())
    body["wan_ip"] = snap["wan_ip"]
    body["age_ms"] = snap["age_ms"]
    body["hilink_probed"] = snap["probed"] is True
    if snap.get("signal_seen") and body.get("present") is not True:
        body["present"] = True
        body["state"] = "hilink"
        body["source"] = "hilink"
        if not body.get("ip") and snap.get("wan_ip"):
            body["ip"] = snap["wan_ip"]
        if body.get("reason") in {None, "modem_absent"}:
            body["reason"] = "hilink"
    return body


def _wifi_iface():
    name = os.environ.get("VLC_WIFI_IFACE", WIFI_IFACE_DEFAULT).strip() or WIFI_IFACE_DEFAULT
    return name


def _sys_root():
    raw = os.environ.get("VLC_NET_SYS_ROOT", "/sys").strip() or "/sys"
    return Path(raw)


def _read_sys(iface, name):
    path = _sys_root() / "class" / "net" / iface / name
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return None


def _carrier_on(iface):
    if _host is not None and hasattr(_host, "carrier"):
        got = _host.carrier(iface)
        return got == 1 or got is True
    return _read_sys(iface, "carrier") == "1"


def _nm_connected(iface):
    """True when NetworkManager reports this device connected. Missing nmcli is not connected."""
    if not iface:
        return False
    if _host is not None and hasattr(_host, "nm_connected"):
        return _host.nm_connected(iface) is True
    try:
        out = subprocess.check_output(
            ["nmcli", "-t", "-f", "DEVICE,STATE", "device", "status"],
            timeout=0.4,
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    for line in out.splitlines():
        device, _, state = line.partition(":")
        if device == iface and state.strip().lower().startswith("connected"):
            return True
    return False


def _oper_up(iface):
    """Link is up.

    USB HiLink modems often report operstate "unknown" while carrier is 1 and
    NetworkManager is connected. That is up. operstate "down" stays down.
    """
    if not iface:
        return False
    if _host is not None and hasattr(_host, "oper_up"):
        return _host.oper_up(iface) is True
    state = _read_sys(iface, "operstate")
    if state == "up":
        return True
    if state == "unknown" and (_carrier_on(iface) or _nm_connected(iface)):
        return True
    return False


def _iface_ipv4(iface):
    if not iface:
        return None
    if _host is not None and hasattr(_host, "ipv4"):
        ip = _host.ipv4(iface)
        return ip if isinstance(ip, str) and ip else None
    try:
        out = subprocess.check_output(
            ["ip", "-4", "-o", "addr", "show", "dev", iface],
            timeout=0.4,
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"\binet\s+(\d+\.\d+\.\d+\.\d+)", out)
    return match.group(1) if match else None


def _iw(iface):
    if not iface:
        return {"ssid": None, "signal_dbm": None}
    if _host is not None and hasattr(_host, "iw"):
        got = _host.iw(iface) or {}
        return {
            "ssid": got.get("ssid") if got.get("ssid") else None,
            "signal_dbm": got.get("signal_dbm") if isinstance(got.get("signal_dbm"), (int, float)) else None,
        }
    try:
        out = subprocess.check_output(
            ["iw", "dev", iface, "link"],
            timeout=0.4,
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return {"ssid": None, "signal_dbm": None}
    ssid = None
    signal = None
    ssid_m = re.search(r"^\s*SSID:\s*(.+)$", out, re.M)
    if ssid_m:
        ssid = ssid_m.group(1).strip() or None
    sig_m = re.search(r"signal:\s*([+-]?\d+)", out)
    if sig_m:
        signal = int(sig_m.group(1))
    return {"ssid": ssid, "signal_dbm": signal}


def _routes():
    if _host is not None and hasattr(_host, "routes"):
        got = _host.routes()
        return got if isinstance(got, list) else None
    try:
        out = subprocess.check_output(
            ["ip", "-4", "route", "show", "default"],
            timeout=0.4,
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    routes = []
    for line in out.splitlines():
        dev = re.search(r"\bdev\s+(\S+)", line)
        if not dev:
            continue
        metric = re.search(r"\bmetric\s+(\d+)", line)
        routes.append({
            "iface": dev.group(1),
            "metric": int(metric.group(1)) if metric else None,
        })
    return routes


def _default_iface(routes):
    if not routes:
        return None, None
    ranked = []
    for route in routes:
        iface = route.get("iface")
        if not iface:
            continue
        metric = route.get("metric")
        ranked.append((metric if isinstance(metric, int) else 10**9, iface, metric))
    if not ranked:
        return None, None
    ranked.sort()
    _score, iface, metric = ranked[0]
    return iface, metric


def uplinks_payload():
    wifi_name = _wifi_iface()
    cell_name = cellular_iface_name()
    routes = _routes()
    default_iface, _default_metric = _default_iface(routes)
    if default_iface not in {wifi_name, cell_name}:
        default_iface = None
    cell_metric = None
    if routes and cell_name:
        for route in routes:
            if route.get("iface") == cell_name and isinstance(route.get("metric"), int):
                cell_metric = route["metric"]
                break
    wifi_link = _iw(wifi_name) if _oper_up(wifi_name) or (_host is not None) else {"ssid": None, "signal_dbm": None}
    if not _oper_up(wifi_name):
        wifi_link = {"ssid": None, "signal_dbm": None}
    hilink = hilink_status()
    signal = hilink["signal"] if hilink.get("probed") else _empty_signal()
    body = {
        "ok": True,
        "read_only": True,
        "wifi": {
            "iface": wifi_name,
            "up": _oper_up(wifi_name),
            "ssid": wifi_link["ssid"],
            "signal_dbm": wifi_link["signal_dbm"],
            "ip": _iface_ipv4(wifi_name) if _oper_up(wifi_name) else None,
            "default_route": default_iface == wifi_name,
        },
        "cellular": {
            "iface": cell_name,
            "up": _oper_up(cell_name) if cell_name else False,
            "ip": _iface_ipv4(cell_name) if cell_name and _oper_up(cell_name) else None,
            "route_metric": cell_metric,
            "signal": signal,
            "signal_icon": hilink.get("signal_icon"),
            "signal_max": hilink.get("signal_max"),
            "network_type": hilink.get("network_type"),
            "network_label": hilink.get("network_label"),
            "operator": dict(hilink.get("operator") or _blank_operator()),
            "default_route": bool(cell_name) and default_iface == cell_name,
        },
        "default_iface": default_iface,
    }
    try:
        from uplink_control import annotate_uplinks
    except ImportError:
        return body
    return annotate_uplinks(body)
