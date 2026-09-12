#!/usr/bin/env python3
"""Vision Landing Console — Jetson companion: MAVLink relay + HTTP API + heartbeat.

AGENT_VERSION 2.3.2 = 2.3.1 byte-level UART fan-out plus honest observe-only
camera / runway HTTP status. No camera pipeline and no runway detector on
current hardware — never invent camera_ok=true or runway detected/locked.

Hardware default (Matek H743 SERIAL3 ↔ Jetson UART1):
  FC /dev/ttyTHS1 @ 921600, FC_READ_ONLY=1

The relay MUST stay byte-level:
  uart_reader → fanout_uart
  NEVER pymavlink recv_match() on the relay UART — that steals HEARTBEAT
  bytes so TCP :5770 clients see bytesRx=0 while /api/health shows fc_heartbeat.
"""

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
# Matek SERIAL3 (UART3) is wired to Jetson UART1 → /dev/ttyTHS1 @ 921600.
FC_DEVICE = os.environ.get("VLC_FC_DEVICE", "/dev/ttyTHS1")
FC_BAUD = int(os.environ.get("VLC_FC_BAUD", "921600"))
FC_SERIAL_NAME = os.environ.get("VLC_FC_SERIAL_NAME", "SERIAL3")
RELAY_PORT = int(os.environ.get("VLC_RELAY_PORT", "5770"))
HTTP_PORT = int(os.environ.get("VLC_HTTP_PORT", "8081"))
AGENT_VERSION = os.environ.get("VLC_AGENT_VERSION", "2.3.2")
FC_READ_ONLY = os.environ.get("VLC_FC_READ_ONLY", "1").strip().lower() in {"1", "true", "yes", "on"}
SKIP_RELAY = os.environ.get("VLC_SKIP_RELAY", "").strip().lower() in {"1", "true", "yes", "on"}
HTTP_BIND = os.environ.get("VLC_HTTP_BIND", "0.0.0.0")
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
    "tcp_to_uart_suppressed": 0,
    "uart_bytes_rx": 0,
    "uart_bytes_tx": 0,
    "last_heartbeat_at": None,
    "fc_device": FC_DEVICE,
    "fc_baud": FC_BAUD,
    "fc_serial_name": FC_SERIAL_NAME,
    "cpuLoadPct": None,
    "memPct": None,
    "tempC": None,
}

CLIENTS = []
CLIENTS_LOCK = threading.Lock()
UART_WRITE_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
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
                "fcDevice": FC_DEVICE,
                "fcBaud": FC_BAUD,
                "fcSerialName": FC_SERIAL_NAME,
                "fcReadOnly": FC_READ_ONLY,
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


def canned_heartbeat_frame() -> bytes:
    """MAVLink1 HEARTBEAT (ArduPilot Fixed Wing) for transport-test. Not sent to the FC."""
    payload = bytes([0, 0, 0, 0, 1, 3, 0, 3, 3])
    mid = bytes([len(payload), 7, 1, 1, 0])
    crc = mav_crc(mid + payload + bytes([HEARTBEAT_CRC_EXTRA]))
    return bytes([0xFE]) + mid + payload + bytes([crc & 0xFF, (crc >> 8) & 0xFF])


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
                with STATE_LOCK:
                    STATE["tcp_to_uart_suppressed"] = int(STATE.get("tcp_to_uart_suppressed") or 0) + 1
                continue
            try:
                with UART_WRITE_LOCK:
                    fc_serial.write(data)
                with STATE_LOCK:
                    STATE["uart_bytes_tx"] = int(STATE.get("uart_bytes_tx") or 0) + len(data)
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
        with STATE_LOCK:
            STATE["uart_bytes_rx"] = int(STATE.get("uart_bytes_rx") or 0) + len(data)
        if chunk_has_heartbeat(data):
            STATE["fc_heartbeat"] = True
            STATE["last_heartbeat_at"] = time.time()
        fanout_uart(data)


def mavlink_relay_server():
    """Byte-level UART ↔ TCP fan-out. One UART reader; pymavlink must not parse the same port."""
    print(
        f"[relay] FC {FC_DEVICE} @ {FC_BAUD} ({FC_SERIAL_NAME}) → TCP :{RELAY_PORT} "
        f"(read_only={FC_READ_ONLY})"
    )
    while True:
        srv = None
        fc_serial = None
        stop = threading.Event()
        try:
            fc_serial = open_fc_serial()
            STATE["fc_linked"] = True
            STATE["fc_read_only"] = FC_READ_ONLY
            STATE["relay_tcp_to_uart"] = not FC_READ_ONLY
            STATE["fc_device"] = FC_DEVICE
            STATE["fc_baud"] = FC_BAUD
            STATE["fc_serial_name"] = FC_SERIAL_NAME
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


def _now_ts():
    now_ns = int(time.time() * 1e9)
    return {"t_monotonic_ns": now_ns, "t_utc_ns": now_ns}


def vision_status_payload():
    """Observe-only camera / vision. Default hardware has no pipeline — camera_ok is false."""
    return {
        "ok": True,
        "observe_only": True,
        "camera_ok": False,
        "running": False,
        "health": "unavailable",
        "fps": None,
        "latency_ms": None,
        "last_valid": None,
        "frame_id": None,
        "source_id": "none",
        "quality": {"confidence": None, "label": "unknown"},
        "implemented": False,
        "note": "no camera pipeline on this companion; camera_ok is false; not invented",
    }


def landing_status_payload():
    """Observe-only runway detect / lock. Default hardware has no runway detector."""
    return {
        "ok": True,
        "observe_only": True,
        "timestamp": _now_ts(),
        "source": "none",
        "validity": "invalid",
        "quality": {"confidence": None, "label": "unknown"},
        "target": None,
        "detections": [],
        "runway_detector": False,
        "runway_detected": None,
        "implemented": False,
        "present": False,
        "enabled": False,
        "note": "no runway detector on this companion; runway_detector is false; not invented",
    }


def video_status_payload():
    """Observe-only video metadata. No annotated stream and no raw pipeline."""
    return {
        "ok": True,
        "observe_only": True,
        "raw_pipeline": "none",
        "annotated_pipeline": "none",
        "raw_fps": None,
        "annotated_fps": None,
        "bitrate_kbps": None,
        "raw_kind": "raw",
        "annotated_kind": "annotated",
        "note": "no video pipeline on this companion; not invented",
    }


def extras_status_payload():
    return {
        "camera_ok": False,
        "camera_connected": False,
        "runway_detector": False,
        "runway_detected": None,
        "observe_only": True,
    }


def status_payload():
    """Companion v1 status overlay. System gauges plus honest absent vision/landing."""
    return {
        "ok": True,
        "timestamp": _now_ts(),
        "companion_version": AGENT_VERSION,
        "agentVersion": AGENT_VERSION,
        "api_version": "1",
        "observe_only": True,
        "system": {
            "cpu_percent": STATE.get("cpuLoadPct"),
            "cpuLoadPct": STATE.get("cpuLoadPct"),
            "memPct": STATE.get("memPct"),
            "temperature_c": STATE.get("tempC"),
            "tempC": STATE.get("tempC"),
        },
        "vision": vision_status_payload(),
        "landing": landing_status_payload(),
        "video": video_status_payload(),
        "extras": extras_status_payload(),
        "fc": {},
        "mavlink": {},
    }


def health_payload():
    return {
        "ok": True,
        "agentVersion": AGENT_VERSION,
        "api_version": "1",
        "observe_only": True,
        **STATE,
        "vision": vision_status_payload(),
        "landing": landing_status_payload(),
        "video": video_status_payload(),
        "extras": extras_status_payload(),
    }


def transport_test_payload(self_test=False):
    body = {
        "ok": True,
        "agentVersion": AGENT_VERSION,
        "fc_device": FC_DEVICE,
        "fc_baud": FC_BAUD,
        "fc_serial_name": FC_SERIAL_NAME,
        "matek_serial": FC_SERIAL_NAME,
        "relay_port": RELAY_PORT,
        "fc_read_only": FC_READ_ONLY,
        "relay_tcp_to_uart": not FC_READ_ONLY,
        "tcp_to_uart_suppressed": int(STATE.get("tcp_to_uart_suppressed") or 0),
        "uart_bytes_rx": int(STATE.get("uart_bytes_rx") or 0),
        "uart_bytes_tx": int(STATE.get("uart_bytes_tx") or 0),
        "fc_linked": STATE.get("fc_linked") is True,
        "fc_heartbeat": STATE.get("fc_heartbeat") is True,
        "last_heartbeat_at": STATE.get("last_heartbeat_at"),
        "relay_clients": int(STATE.get("relay_clients") or 0),
        "fanout": "byte-level",
        "recv_match": False,
        "note": "byte-level uart_reader + fanout_uart; never recv_match on the relay UART",
    }
    if self_test:
        frame = canned_heartbeat_frame()
        body["self_test"] = {
            "ok": True,
            "heartbeat_detected": chunk_has_heartbeat(frame),
            "bytes": len(frame),
            "wrote_uart": False,
        }
        body["ok"] = body["self_test"]["heartbeat_detected"] is True
    return body


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

    def _path(self):
        return self.path.split("?", 1)[0]

    def do_GET(self):
        if not self._auth_ok():
            return self._json(401, {"ok": False, "message": "Unauthorized"})
        path = self._path()
        if path == "/api/logs" or path == "/api/logs/":
            logs = [{"name": p.name, "size": p.stat().st_size} for p in iter_log_files()]
            return self._json(200, {"ok": True, "logs": logs})
        if path.startswith("/api/logs/"):
            name = path.split("/api/logs/", 1)[1]
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
        if path in ("/api/health", "/api/v1/health"):
            # Console Status gauges read cpuLoadPct / memPct / tempC here when /api/v1/status is 404.
            # vision / landing / video / extras are honest absent overlays for Experiment #1.
            return self._json(200, health_payload())
        if path in ("/api/status", "/api/v1/status"):
            return self._json(200, status_payload())
        if path in ("/api/status/vision", "/api/v1/status/vision"):
            return self._json(200, vision_status_payload())
        if path in ("/api/status/landing", "/api/v1/status/landing"):
            return self._json(200, landing_status_payload())
        if path in ("/api/status/video", "/api/v1/status/video"):
            return self._json(200, video_status_payload())
        if path in ("/api/transport-test", "/api/v1/transport-test"):
            return self._json(200, transport_test_payload(self_test=False))
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
        path = self._path()
        if path in ("/api/transport-test", "/api/v1/transport-test"):
            return self._json(200, transport_test_payload(self_test=True))
        if path == "/api/install":
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
    print(f"  FC: {FC_DEVICE} @ {FC_BAUD} ({FC_SERIAL_NAME})")
    print(f"  Relay TCP: 0.0.0.0:{RELAY_PORT}")
    print(f"  HTTP: {HTTP_BIND}:{HTTP_PORT}")
    print(f"  FC_READ_ONLY: {FC_READ_ONLY}")
    if not SKIP_RELAY:
        threading.Thread(target=heartbeat_loop, daemon=True).start()
        threading.Thread(target=mavlink_relay_server, daemon=True).start()
    else:
        print("  SKIP_RELAY: HTTP observe-status only")
    httpd = ThreadingHTTPServer((HTTP_BIND, HTTP_PORT), Handler)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
