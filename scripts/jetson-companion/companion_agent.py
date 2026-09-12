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
AGENT_VERSION = os.environ.get("VLC_AGENT_VERSION", "2.2.0")
FC_READ_ONLY = os.environ.get("VLC_FC_READ_ONLY", "0").strip().lower() in {"1", "true", "yes", "on"}
LOG_DIRS = [
    Path(os.environ.get("VLC_LOG_DIR", "")) if os.environ.get("VLC_LOG_DIR") else None,
    Path.home() / "logs",
    Path("/var/log"),
]

STATE = {
    "fc_linked": False,
    "fc_heartbeat": False,
    "relay_clients": 0,
    "fc_read_only": FC_READ_ONLY,
    "relay_tcp_to_uart": not FC_READ_ONLY,
    "cpuLoadPct": None,
    "memPct": None,
    "tempC": None,
}

CLIENTS = []
CLIENTS_LOCK = threading.Lock()
UART_WRITE_LOCK = threading.Lock()
HEARTBEAT_CRC_EXTRA = 50


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
            STATE["cpuLoadPct"] = cpu
            STATE["memPct"] = mem
            STATE["tempC"] = temp
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


def mav_crc(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        tmp = (b ^ (crc & 0xFF)) & 0xFF
        tmp = (tmp ^ ((tmp << 4) & 0xFF)) & 0xFF
        crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF
    return crc


def chunk_has_heartbeat(data: bytes) -> bool:
    """Detect a CRC-valid HEARTBEAT in raw UART bytes. Does not consume a parser buffer."""
    i = 0
    n = len(data)
    while i < n:
        if data[i] == 0xFE and i + 8 <= n:
            ln = data[i + 1]
            total = 8 + ln
            if i + total > n:
                break
            if data[i + 5] == 0:
                body = data[i + 1 : i + 6 + ln] + bytes([HEARTBEAT_CRC_EXTRA])
                rx = data[i + 6 + ln] | (data[i + 7 + ln] << 8)
                if mav_crc(body) == rx:
                    return True
            i += 1
            continue
        if data[i] == 0xFD and i + 12 <= n:
            ln = data[i + 1]
            signed = data[i + 2] & 0x01
            total = 12 + ln + (13 if signed else 0)
            if i + total > n:
                break
            if data[i + 7] == 0 and data[i + 8] == 0 and data[i + 9] == 0:
                crc_off = i + 10 + ln
                body = data[i + 1 : i + 10 + ln] + bytes([HEARTBEAT_CRC_EXTRA])
                rx = data[crc_off] | (data[crc_off + 1] << 8)
                if mav_crc(body) == rx:
                    return True
            i += 1
            continue
        i += 1
    return False


def open_fc_serial():
    try:
        import serial  # pyserial; usually present with pymavlink
        ser = serial.Serial(FC_DEVICE, FC_BAUD, timeout=0.02)
        return ser
    except Exception as exc:
        if mavutil is None:
            raise RuntimeError(f"serial open failed: {exc}") from exc
        conn = mavutil.mavlink_connection(f"{FC_DEVICE}:{FC_BAUD}", autoreconnect=True)
        # Raw port only — never recv_match(); that would steal HEARTBEAT from the relay.
        port = conn.port
        try:
            port.timeout = 0.02
        except Exception:
            pass
        return port


def fanout_uart(data: bytes):
    dead = []
    with CLIENTS_LOCK:
        peers = list(CLIENTS)
    for sock in peers:
        try:
            sock.sendall(data)
        except OSError:
            dead.append(sock)
    if dead:
        with CLIENTS_LOCK:
            for sock in dead:
                if sock in CLIENTS:
                    CLIENTS.remove(sock)
                    STATE["relay_clients"] = max(0, STATE["relay_clients"] - 1)
                try:
                    sock.close()
                except OSError:
                    pass


def drop_client(sock):
    with CLIENTS_LOCK:
        if sock in CLIENTS:
            CLIENTS.remove(sock)
            STATE["relay_clients"] = max(0, STATE["relay_clients"] - 1)
    try:
        sock.close()
    except OSError:
        pass


def client_to_uart(client_sock, fc_serial):
    client_sock.settimeout(0.2)
    try:
        while True:
            try:
                data = client_sock.recv(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            if not data:
                break
            if FC_READ_ONLY:
                continue
            try:
                with UART_WRITE_LOCK:
                    fc_serial.write(data)
            except Exception:
                break
    finally:
        drop_client(client_sock)


def uart_reader(fc_serial, stop):
    while not stop.is_set():
        try:
            data = fc_serial.read(4096)
        except Exception:
            time.sleep(0.05)
            continue
        if not data:
            continue
        if chunk_has_heartbeat(data):
            STATE["fc_heartbeat"] = True
        fanout_uart(data)


def mavlink_relay_server():
    """Byte-level UART ↔ TCP fan-out. One UART reader; pymavlink must not parse the same port."""
    print(f"[relay] FC {FC_DEVICE} @ {FC_BAUD} → TCP :{RELAY_PORT} (read_only={FC_READ_ONLY})")
    while True:
        srv = None
        fc_serial = None
        stop = threading.Event()
        try:
            fc_serial = open_fc_serial()
            STATE["fc_linked"] = True
            STATE["fc_read_only"] = FC_READ_ONLY
            STATE["relay_tcp_to_uart"] = not FC_READ_ONLY
            threading.Thread(target=uart_reader, args=(fc_serial, stop), daemon=True).start()
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind(("0.0.0.0", RELAY_PORT))
            srv.listen(4)
            srv.settimeout(1.0)
            while True:
                try:
                    client, addr = srv.accept()
                    print(f"[relay] GCS client {addr}")
                    with CLIENTS_LOCK:
                        CLIENTS.append(client)
                        STATE["relay_clients"] = len(CLIENTS)
                    threading.Thread(
                        target=client_to_uart, args=(client, fc_serial), daemon=True
                    ).start()
                except socket.timeout:
                    continue
        except Exception as exc:
            STATE["fc_linked"] = False
            STATE["fc_heartbeat"] = False
            print(f"[relay] restart: {exc}")
            stop.set()
            with CLIENTS_LOCK:
                for sock in CLIENTS:
                    try:
                        sock.close()
                    except OSError:
                        pass
                CLIENTS.clear()
                STATE["relay_clients"] = 0
            if srv:
                try:
                    srv.close()
                except OSError:
                    pass
            if fc_serial:
                try:
                    fc_serial.close()
                except Exception:
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
            # Console Status gauges read cpuLoadPct / memPct / tempC here when /api/v1/status is 404.
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
