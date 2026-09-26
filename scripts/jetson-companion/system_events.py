# -*- coding: utf-8 -*-
"""Companion health, route, and tailscale probes. Every probe fails soft."""

from __future__ import print_function

import json
import os
import subprocess
import urllib.request

from flightlog_common import redact_text


class SystemEvents(object):
    def __init__(self, base_url, token="", timeout=0.3, route_fn=None, tailscale_fn=None, disk_fn=None):
        self.base_url = (base_url or "").rstrip("/")
        self.token = token or ""
        self.timeout = timeout
        self.route_fn = route_fn
        self.tailscale_fn = tailscale_fn
        self.disk_fn = disk_fn
        self._prev = None
        self._uart_stall_since = None
        self._last_route = None
        self._last_route_at = 0.0
        self._last_tail = None
        self._disk_low = False

    def poll(self, now):
        events = []
        health = self._health()
        if health is not None:
            events.extend(self._health_deltas(now, health))
        if now - self._last_route_at >= 5.0:
            self._last_route_at = now
            events.extend(self._route(now))
            events.extend(self._tailscale(now))
        events.extend(self._disk(now))
        for event in events:
            event["msg"] = redact_text(event.get("msg") or "")
            if event.get("msg_he"):
                event["msg_he"] = redact_text(event["msg_he"])
            event["origin"] = "health_poll"
            event["t"] = now
        return events

    def _health(self):
        if not self.base_url:
            return None
        url = self.base_url + "/api/health"
        req = urllib.request.Request(url)
        if self.token:
            req.add_header("X-Companion-Token", self.token)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = resp.read()
        except Exception:
            return None
        try:
            doc = json.loads(body.decode("utf-8"))
        except Exception:
            return None
        return doc if isinstance(doc, dict) else None

    def _health_deltas(self, now, health):
        events = []
        snap = {
            "relay": health.get("relay_clients"),
            "uart": health.get("uart_bytes_rx"),
            "fc": (health.get("fc") or {}).get("connected") if isinstance(health.get("fc"), dict) else health.get("fc_heartbeat"),
            "temp": (health.get("system") or {}).get("tempC") if isinstance(health.get("system"), dict) else health.get("tempC"),
            "modem_state": (health.get("modem") or {}).get("state") if isinstance(health.get("modem"), dict) else None,
            "modem_present": (health.get("modem") or {}).get("present") if isinstance(health.get("modem"), dict) else None,
            "cameras": _cameras(health),
        }
        prev = self._prev
        self._prev = snap
        if prev is None:
            return events
        if snap["relay"] != prev["relay"] and snap["relay"] is not None:
            events.append(_ev("companion", "companion.relay_client", "info", "relay clients %s → %s" % (prev["relay"], snap["relay"]), "מספר לקוחות הממסר השתנה", {"from": prev["relay"], "to": snap["relay"]}))
        if snap["uart"] is not None and snap["uart"] == prev["uart"]:
            if self._uart_stall_since is None:
                self._uart_stall_since = now
            elif now - self._uart_stall_since > 2.0:
                events.append(_ev("companion", "companion.uart_stall", "warning", "UART bytes stalled", "זרם הבקר נעצר", {}))
                self._uart_stall_since = now + 30.0
        else:
            self._uart_stall_since = None
        if snap["fc"] != prev["fc"] and snap["fc"] is not None:
            events.append(_ev("companion", "companion.fc_heartbeat", "info", "fc heartbeat %s → %s" % (prev["fc"], snap["fc"]), "דופק הבקר השתנה", {"from": prev["fc"], "to": snap["fc"]}))
        if snap["temp"] is not None and snap["temp"] > 80 and (prev["temp"] is None or prev["temp"] <= 80):
            events.append(_ev("companion", "companion.temp_high", "warning", "tempC %s" % snap["temp"], "טמפרטורה גבוהה", {"tempC": snap["temp"]}))
        if snap["modem_state"] != prev["modem_state"] or snap["modem_present"] != prev["modem_present"]:
            events.append(_ev("link", "link.modem_state", "info", "modem %s/%s → %s/%s" % (prev["modem_present"], prev["modem_state"], snap["modem_present"], snap["modem_state"]), "מצב המודם השתנה", {"state": snap["modem_state"], "present": snap["modem_present"]}))
        for cam, cur in (snap["cameras"] or {}).items():
            old = (prev["cameras"] or {}).get(cam) or {}
            if cur.get("camera_ok") != old.get("camera_ok"):
                events.append(_ev("vision", "vision.camera_ok_change", "warning" if cur.get("camera_ok") is False else "info", "camera %s ok %s" % (cam, cur.get("camera_ok")), "מצב מצלמה השתנה", {"camera": cam, "camera_ok": cur.get("camera_ok")}))
            if cur.get("fps") is not None and old.get("fps") is not None and old["fps"] > 0 and cur["fps"] < old["fps"] * 0.5:
                events.append(_ev("vision", "vision.fps_drop", "warning", "camera %s fps %s → %s" % (cam, old["fps"], cur["fps"]), "קצב פריימים ירד", {"camera": cam, "from": old["fps"], "to": cur["fps"]}))
        return events

    def _route(self, now):
        try:
            info = self.route_fn() if self.route_fn else _default_route()
        except Exception:
            return []
        if not info:
            return []
        kind = info.get("kind")
        iface = info.get("iface")
        if self._last_route is None:
            self._last_route = (kind, iface)
            return []
        if (kind, iface) != self._last_route:
            prev = self._last_route
            self._last_route = (kind, iface)
            return [_ev("link", "link.route_change", "notice", "route %s → %s" % (prev[0], kind), "נתיב הרשת השתנה", {"from": prev[0], "to": kind, "iface": iface})]
        return []

    def _tailscale(self, now):
        try:
            state = self.tailscale_fn() if self.tailscale_fn else _tailscale_state()
        except Exception:
            return []
        if state is None:
            return []
        if self._last_tail is None:
            self._last_tail = state
            return []
        if state != self._last_tail:
            prev = self._last_tail
            self._last_tail = state
            return [_ev("link", "link.tailscale", "info", "tailscale %s → %s" % (prev, state), "מצב הרשת הווירטואלית השתנה", {"from": prev, "to": state})]
        return []

    def _disk(self, now):
        try:
            free_mb = self.disk_fn() if self.disk_fn else None
        except Exception:
            return []
        if free_mb is None:
            return []
        if free_mb < 500 and not self._disk_low:
            self._disk_low = True
            return [_ev("companion", "companion.disk_low", "warning", "disk free %s MB" % free_mb, "מעט מקום פנוי בדיסק", {"free_mb": free_mb})]
        if free_mb >= 500:
            self._disk_low = False
        return []


def _ev(src, etype, sev, msg, msg_he, data):
    return {"src": src, "type": etype, "sev": sev, "msg": msg, "msg_he": msg_he, "data": data}


def _cameras(health):
    extras = health.get("extras") if isinstance(health.get("extras"), dict) else {}
    cams = extras.get("cameras") if isinstance(extras.get("cameras"), dict) else {}
    if not cams and isinstance(health.get("cameras"), dict):
        cams = health.get("cameras")
    out = {}
    for key, value in cams.items():
        if isinstance(value, dict):
            out[key] = {"camera_ok": value.get("camera_ok"), "fps": value.get("fps")}
    return out


def _default_route():
    from log_uploader import classify_iface, modem_iface_from_status

    try:
        proc = subprocess.run(["ip", "route", "get", "1.1.1.1"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1.0, check=False)
        parts = proc.stdout.decode("utf-8", "replace").split()
    except Exception:
        return None
    if "dev" not in parts:
        return None
    iface = parts[parts.index("dev") + 1]
    return {"iface": iface, "kind": classify_iface(iface, modem_iface_from_status())}


def _tailscale_state():
    if not _which("tailscale"):
        return None
    try:
        proc = subprocess.run(["tailscale", "status", "--json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1.0, check=False)
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    try:
        doc = json.loads(proc.stdout.decode("utf-8", "replace"))
    except Exception:
        return None
    backend = doc.get("BackendState") if isinstance(doc, dict) else None
    return backend if isinstance(backend, str) else None


def _which(name):
    for folder in os.environ.get("PATH", "").split(":"):
        if folder and os.path.isfile(os.path.join(folder, name)):
            return True
    return False
