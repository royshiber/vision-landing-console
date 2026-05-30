#!/usr/bin/env python3
"""Vision Landing Console — Jetson companion: MAVLink relay + HTTP API + heartbeat."""

from __future__ import annotations

import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from pymavlink import mavutil
except ImportError:
    mavutil = None

CONSOLE_URL = os.environ.get("VLC_CONSOLE_URL", "http://127.0.0.1:4010").rstrip("/")
TOKEN = os.environ.get("VLC_COMPANION_TOKEN", "")
FC_DEVICE = os.environ.get("VLC_FC_DEVICE", "/dev/ttyTHS0")
FC_BAUD = int(os.environ.get("VLC_FC_BAUD", "115200"))
RELAY_PORT = int(os.environ.get("VLC_RELAY_PORT", "5770"))
HTTP_PORT = int(os.environ.get("VLC_HTTP_PORT", "8081"))
AGENT_VERSION = os.environ.get("VLC_AGENT_VERSION", "2.1.0")
LOG_DIRS = [
    Path(os.environ.get("VLC_LOG_DIR", "")) if os.environ.get("VLC_LOG_DIR") else None,
    Path.home() / "logs",
    Path("/var/log"),
]

STATE = {"fc_linked": False, "fc_heartbeat": False, "relay_clients": 0}


def auth_headers():
    h = {"Content-Type": "application/json"}
    if TOKEN:
        h["X-Companion-Token"] = TOKEN
        h["Authorization"] = f"Bearer {TOKEN}"
    return h


def post_json(path, payload):
    req = urllib.request.Request(
        f"{CONSOLE_URL}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers=auth_headers(),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.loads(resp.read().decode("utf-8"))


def heartbeat_loop():
    import psutil
    while True:
        try:
            cpu = psutil.cpu_percent(interval=0.4)
            mem = psutil.virtual_memory().percent
            temps = getattr(psutil, "sensors_temperatures", lambda: {})()
            temp = 0.0
            if temps:
                for arr in temps.values():
                    if arr:
                        temp = float(arr[0].current)
                        break
            post_json("/api/jetson/heartbeat", {
                "cpuLoadPct": cpu,
                "memPct": mem,
                "tempC": temp,
                "agentVersion": AGENT_VERSION,
                "relayPort": RELAY_PORT,
                "companionHttpPort": HTTP_PORT,
                "fcLinked": STATE["fc_linked"],
                "fcHeartbeat": STATE["fc_heartbeat"],
            })
        except Exception as exc:
            print(f"[heartbeat] {exc}")
        time.sleep(5)


def relay_worker(client_sock, fc_serial):
    STATE["relay_clients"] += 1
    client_sock.settimeout(0.02)
    try:
        fc_serial.timeout = 0.02
    except Exception:
        pass
    try:
        while True:
            try:
                data = client_sock.recv(4096)
                if data:
                    fc_serial.write(data)
            except socket.timeout:
                pass
            except OSError:
                break
            try:
                data = fc_serial.read(4096)
                if data:
                    client_sock.sendall(data)
            except Exception:
                pass
    finally:
        STATE["relay_clients"] = max(0, STATE["relay_clients"] - 1)
        try:
            client_sock.close()
        except OSError:
            pass


def mavlink_relay_server():
    if mavutil is None:
        print("[relay] pymavlink missing — pip install pymavlink")
        return
    fc_uri = f"{FC_DEVICE}:{FC_BAUD}"
    print(f"[relay] FC {fc_uri} → TCP :{RELAY_PORT}")
    while True:
        fc = None
        srv = None
        try:
            fc = mavutil.mavlink_connection(fc_uri, autoreconnect=True)
            STATE["fc_linked"] = True
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind(("0.0.0.0", RELAY_PORT))
            srv.listen(4)
            srv.settimeout(1.0)
            fc_serial = fc.port
            while True:
                try:
                    msg = fc.recv_match(type="HEARTBEAT", blocking=False)
                    if msg:
                        STATE["fc_heartbeat"] = True
                except Exception:
                    pass
                try:
                    client, addr = srv.accept()
                    print(f"[relay] GCS client {addr}")
                    threading.Thread(
                        target=relay_worker, args=(client, fc_serial), daemon=True
                    ).start()
                except socket.timeout:
                    continue
        except Exception as exc:
            STATE["fc_linked"] = False
            STATE["fc_heartbeat"] = False
            print(f"[relay] restart: {exc}")
            if srv:
                try:
                    srv.close()
                except OSError:
                    pass
            time.sleep(3)


def iter_log_files():
    seen = set()
    for d in LOG_DIRS:
        if not d or not d.exists():
            continue
        for p in sorted(d.glob("*")):
            if not p.is_file():
                continue
            if p.suffix.lower() not in {".log", ".txt", ".csv", ".bin", ".tlog"}:
                continue
            if p.name in seen:
                continue
            seen.add(p.name)
            yield p


class Handler(BaseHTTPRequestHandler):
    def _auth_ok(self):
        if not TOKEN:
            return True
        return self.headers.get("X-Companion-Token") == TOKEN or self.headers.get("Authorization", "").replace("Bearer ", "") == TOKEN

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._auth_ok():
            return self._json(401, {"ok": False, "message": "Unauthorized"})
        if self.path == "/api/logs" or self.path == "/api/logs/":
            logs = [{"name": p.name, "size": p.stat().st_size} for p in iter_log_files()]
            return self._json(200, {"ok": True, "logs": logs})
        if self.path.startswith("/api/logs/"):
            name = self.path.split("/api/logs/", 1)[1]
            name = name.split("?", 1)[0]
            for p in iter_log_files():
                if p.name == name:
                    data = p.read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
            return self._json(404, {"ok": False, "message": "not found"})
        if self.path == "/api/health":
            return self._json(200, {"ok": True, "agentVersion": AGENT_VERSION, **STATE})
        return self._json(404, {"ok": False})

    def do_POST(self):
        if not self._auth_ok():
            return self._json(401, {"ok": False, "message": "Unauthorized"})
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            data = {}
        if self.path == "/api/install":
            script = data.get("script", "")
            version = data.get("version", AGENT_VERSION)
            dest = Path.home() / "vlc-companion" / "companion_agent.py"
            dest.parent.mkdir(parents=True, exist_ok=True)
            if script:
                dest.write_text(script, encoding="utf-8")
                dest.chmod(0o755)
            return self._json(200, {"ok": True, "path": str(dest), "version": version})
        return self._json(404, {"ok": False})

    def log_message(self, fmt, *args):
        print(f"[http] {self.address_string()} {fmt % args}")


def main():
    print(f"Vision Landing Console companion {AGENT_VERSION}")
    print(f"  Console: {CONSOLE_URL}")
    print(f"  FC: {FC_DEVICE} @ {FC_BAUD}")
    print(f"  Relay TCP: 0.0.0.0:{RELAY_PORT}")
    print(f"  HTTP: 0.0.0.0:{HTTP_PORT}")
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    threading.Thread(target=mavlink_relay_server, daemon=True).start()
    httpd = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Handler)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
