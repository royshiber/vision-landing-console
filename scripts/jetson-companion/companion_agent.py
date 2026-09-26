#!/usr/bin/env python3
"""Vision Landing Console — Jetson companion: MAVLink relay + HTTP API + heartbeat.

AGENT_VERSION 2.6.2 turns Wi-Fi back on if the console is silent for 60 seconds
after that link was disabled, and 2.6.1 reports CAM1 from the OV9281 symlink while it is idle,
and serves that camera on /api/v1/cameras/cam1/frame. 2.6.0 adds CAM1 on
/api/v1/cam1.
Capture and JPEG run only while a client holds the stream, capped at 30 fps
and 15 Hz, so the 60 fps CAM0 path stays the priority. It also lists
timestamped backups of the companion tree and can restore one. 2.5.5 keeps the flight
logger under one tenth of a core at
100 messages per second: the tlog stores raw frames, only detector messages
are parsed, and tlog plus status flush about once a second. 2.5.4 keeps
capture at the sensor rate: PNG only on a snapshot, JPEG on another thread
via cv2.imencode when OpenCV imports (numpy Huffman is only the fallback),
and auto exposure starts short and raises gain before the shutter. 2.5.3 aligns
v4l2_format with the 64-bit kernel so VIDIOC_S_FMT
is accepted. 2.5.2 signs Cloud Storage with GOOG4-HMAC-SHA256 and x-goog
headers only, and starts the flight logger from vlc-companion. 2.5.1 adds
the OV9281 Cam0 pipeline (capture, AE, frame bus,
marker output, calibration, stream, record) on top of the 2.5.0 flight logger.
It does not send flight commands. 2.5.0 reads a separate flight-log status
file into health. 2.3.11 added HiLink signal bars from SignalIcon /
maxsignal, a CurrentNetworkTypeEx label, and the PLMN operator name.
dBm fields stay null when the modem leaves them empty. 2.3.10 counted a
HiLink modem as up when operstate is "unknown" and carrier is 1 or
NetworkManager is connected, and did not bounce a link that is already active.
No VIO estimator, no EKF inject, no FC writes, no runway detect.
Gimbal and camera control are not flight commands.
Never invent camera_ok, frames, gimbal attitude, runway detected/locked, or WGS84 position.
Dry-run never claims a real camera.

Hardware default (Matek H743 pads TX3/RX3 = ArduPilot SERIAL4 ↔ Jetson UART1):
  FC /dev/ttyTHS1 @ 921600, FC_READ_ONLY=1, VLC_FC_SERIAL_NAME=SERIAL4

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
# Matek pads TX3/RX3 are ArduPilot SERIAL4 (SERIAL4_PROTOCOL=2) on Jetson UART1.
FC_DEVICE = os.environ.get("VLC_FC_DEVICE", "/dev/ttyTHS1")
FC_BAUD = int(os.environ.get("VLC_FC_BAUD", "921600"))
FC_SERIAL_NAME = os.environ.get("VLC_FC_SERIAL_NAME", "SERIAL4")
RELAY_PORT = int(os.environ.get("VLC_RELAY_PORT", "5770"))
HTTP_PORT = int(os.environ.get("VLC_HTTP_PORT", "8081"))
HTTP_IDLE_S = float(os.environ.get("VLC_HTTP_IDLE_S", "30") or "30")
HTTP_MAX_BODY = 16 * 1024 * 1024
AGENT_VERSION = os.environ.get("VLC_AGENT_VERSION", "2.6.2")
MODEM_STATUS_FILE = os.environ.get("AIRVIX_E3372_STATUS_FILE", "/run/airvix/e3372.status")

try:
    from camera_ingest import CAM_IDS, ingest_frame_jpeg, ingest_snapshot
except ImportError:
    CAM_IDS = ("cam1", "cam2", "cam3")
    ingest_snapshot = None
    ingest_frame_jpeg = None
try:
    from siyi_sdk import gimbal_command, gimbal_status, get_link as get_gimbal_link
except ImportError:
    gimbal_command = None
    gimbal_status = None
    get_gimbal_link = None
try:
    from annotated_encoder import annotated_encoder_status
except ImportError:
    annotated_encoder_status = None
try:
    from fc_telemetry import fc_link_flags, fc_status_payload, observe_uart_bytes as _fc_observe_uart
except ImportError:
    def _fc_observe_uart(_data):
        return None

    def fc_link_flags():
        return {"connected": False, "heartbeat_wall": None}

    def fc_status_payload():
        return {
            "ok": True,
            "status": "disconnected",
            "connected": False,
            "heartbeat_validity": "invalid",
            "armed": None,
            "mode": None,
            "custom_mode": None,
            "load_pct": None,
            "battery_v": None,
            "battery_pct": None,
            "meminfo_free_kb": None,
            "mcu_temp_c": None,
            "last_heartbeat_age_ms": None,
            "heartbeat": {"validity": "invalid", "system_id": None, "component_id": None, "fields": {}},
        }


def observe_uart_bytes(data):
    """Passive FC parse, then Cam0 attitude tagging. Never writes the UART."""
    _fc_observe_uart(data)
    _publish_flight_gate()
    try:
        from cam0.service import get_service
        svc = get_service()
        if svc is not None:
            svc.observe_mavlink(data)
    except Exception:
        return None

_gate_write_at = 0.0


def _flight_gate_fields(payload):
    armed = None
    in_flight = None
    if isinstance(payload, dict) and payload.get("connected") is True:
        flag = payload.get("armed")
        armed = flag if isinstance(flag, bool) else None
        status = ((payload.get("heartbeat") or {}).get("fields") or {}).get("system_status")
        if status in (4, 5, 6, 8):
            in_flight = True
        elif isinstance(status, int):
            in_flight = False
    return armed, in_flight


def _publish_flight_gate(force=False):
    global _gate_write_at
    now = time.time()
    if not force and now - _gate_write_at < 0.5:
        return
    try:
        payload = fc_status_payload()
    except Exception:
        return
    armed, in_flight = _flight_gate_fields(payload)
    try:
        version_rollback.write_flight_gate(_versions_dest(), armed, in_flight, now)
        _gate_write_at = now
    except Exception:
        return
try:
    from uplink_status import enrich_modem, uplinks_payload
except ImportError:
    def enrich_modem(body):
        return body

    def uplinks_payload():
        return {
            "ok": True,
            "read_only": True,
            "wifi": {"iface": "wlP1p1s0", "up": False, "enabled": True, "ssid": None, "signal_dbm": None, "ip": None, "default_route": False},
            "cellular": {"iface": None, "up": False, "enabled": True, "ip": None, "route_metric": None, "signal": None, "default_route": False},
            "default_iface": None,
            "boot_fallback": None,
        }
try:
    from uplink_control import apply_boot_policy, set_uplink
except ImportError:
    apply_boot_policy = None

    def set_uplink(_kind, _enabled):
        return 503, {"ok": False, "reason": "uplink_control_absent", "message": "שליטת קישור לא זמינה"}
try:
    import version_rollback
except ImportError:
    version_rollback = None
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
    "local_tap_clients": 0,
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
LOCAL_TAP_SOCKS = set()
CLIENTS_LOCK = threading.Lock()
UART_WRITE_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
HEARTBEAT_CRC_EXTRA = 50


def _uplink_kind(path):
    for prefix in ("/api/v1/network/uplinks/", "/api/network/uplinks/"):
        if path.startswith(prefix):
            kind = path[len(prefix):]
            if kind in {"wifi", "cellular"}:
                return kind
            return ""
    return None


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


def _client_counts():
    taps = len(LOCAL_TAP_SOCKS)
    STATE["local_tap_clients"] = taps
    STATE["relay_clients"] = max(0, len(CLIENTS) - taps)


def fanout_uart(data: bytes):
    dead = []
    with CLIENTS_LOCK:
        peers = list(CLIENTS)
    for sock in peers:
        try:
            sock.sendall(data)
        except OSError:
            dead.append(sock)
    for sock in dead:
        drop_client(sock)


def drop_client(sock):
    with CLIENTS_LOCK:
        if sock in CLIENTS:
            CLIENTS.remove(sock)
        LOCAL_TAP_SOCKS.discard(sock)
        _client_counts()
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
        # Copy only. fanout_uart still forwards the original bytes.
        # chunk_has_heartbeat() stays for transport-test; link state is the passive observer.
        observe_uart_bytes(data)
        flags = fc_link_flags()
        with STATE_LOCK:
            STATE["uart_bytes_rx"] = int(STATE.get("uart_bytes_rx") or 0) + len(data)
            STATE["fc_heartbeat"] = flags["connected"] is True
            if flags.get("heartbeat_wall") is not None:
                STATE["last_heartbeat_at"] = flags["heartbeat_wall"]
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
                        separate = os.environ.get("VLC_LOCAL_TAP_SEPARATE", "1").strip().lower() in {"1", "true", "yes", "on"}
                        if separate and addr[0] == "127.0.0.1":
                            LOCAL_TAP_SOCKS.add(client)
                        _client_counts()
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
                LOCAL_TAP_SOCKS.clear()
                STATE["relay_clients"] = 0
                STATE["local_tap_clients"] = 0
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


_SLOT_FALLBACK = (
    ("cam1", "forward", "vio_forward", True),
    ("cam2", "down", "optical_flow_down", True),
    ("cam3", "gimbal", "gimbal_observe", False),
)
_GIMBAL_ACTIONS = {
    "/api/v1/gimbal/rate": "rate",
    "/api/gimbal/rate": "rate",
    "/api/v1/gimbal/angle": "angle",
    "/api/gimbal/angle": "angle",
    "/api/v1/gimbal/center": "center",
    "/api/gimbal/center": "center",
    "/api/v1/gimbal/zoom": "zoom",
    "/api/gimbal/zoom": "zoom",
    "/api/v1/gimbal/mode": "mode",
    "/api/gimbal/mode": "mode",
    "/api/v1/gimbal/photo": "photo",
    "/api/gimbal/photo": "photo",
    "/api/v1/gimbal/record": "record",
    "/api/gimbal/record": "record",
}


def _camera_frame_id(path):
    ids = CAM_IDS if CAM_IDS else ("cam1", "cam2", "cam3")
    for cam_id in ids:
        for prefix in ("/api/v1/cameras/", "/api/cameras/"):
            if path in (f"{prefix}{cam_id}/frame", f"{prefix}{cam_id}/frame.jpg"):
                return cam_id
    return None


def _fallback_cameras(error):
    cameras = {}
    for cam_id, role, nav_role, enabled in _SLOT_FALLBACK:
        cameras[cam_id] = {
            "id": cam_id,
            "role": role,
            "nav_role": nav_role,
            "shared_with": "landing_vision",
            "enabled": enabled,
            "state": "disabled" if not enabled else "absent",
            "present": False,
            "camera_ok": False,
            "fps": None,
            "frame_count": None,
            "last_frame_age_ms": None,
            "error": "disabled" if not enabled else error,
            "source": "absent",
            "dry_run": False,
            "real": False,
            "device": None,
            "requested_device": None,
            "resolved_device": None,
            "has_frame": False,
        }
    return cameras


def _now_ts():
    now_ns = int(time.time() * 1e9)
    return {"t_monotonic_ns": now_ns, "t_utc_ns": now_ns}


def _ingest_or_absent():
    """Honest ingest snapshot. Missing module or devices stay camera_ok false."""
    if ingest_snapshot is None:
        return {
            "observe_only": True,
            "implemented": False,
            "dry_run": False,
            "dry_run_mode": None,
            "source": "absent",
            "real": False,
            "camera_ok": False,
            "running": False,
            "health": "unavailable",
            "fps": None,
            "frame_count": None,
            "last_frame_age_ms": None,
            "latency_ms": None,
            "cameras": _fallback_cameras("ingest_module_absent"),
            "slots": ["cam1", "cam2", "cam3"],
            "note": "camera ingest module missing; camera_ok is false; not invented",
        }
    return ingest_snapshot()


def _cam0_slot():
    """Cam0 is a sibling of cam1..cam3. It does not change their honesty."""
    try:
        from cam0.service import service_status
        st = service_status()
    except Exception:
        return None
    return {
        "id": "cam0",
        "role": "down",
        "nav_role": "landing_marker",
        "shared_with": "landing_vision",
        "enabled": st.get("state") != "disabled",
        "state": st.get("state"),
        "present": st.get("camera_ok") is True,
        "camera_ok": st.get("camera_ok") is True,
        "fps": st.get("fps"),
        "frame_count": st.get("frame_index"),
        "last_frame_age_ms": st.get("last_frame_age_ms"),
        "error": st.get("error"),
        "source": st.get("source") or "absent",
        "dry_run": st.get("dry_run") is True,
        "real": st.get("real") is True,
        "device": st.get("device"),
        "has_frame": st.get("has_frame") is True,
        "flight_commands": False,
    }


def _cam1_slot():
    """Second OV9281. Idle with the symlink present is not device_absent."""
    try:
        from cam0.cam1 import get_service
        svc = get_service()
        health = svc.health()
    except Exception:
        return None
    streaming = health.get("camera_ok") is True and health.get("state") == "streaming"
    present = health.get("state") not in {None, "absent", "disabled"}
    return {
        "id": "cam1",
        "role": "forward",
        "nav_role": "vio_forward",
        "shared_with": "landing_vision",
        "enabled": True,
        "state": health.get("state") or "absent",
        "present": bool(present or streaming),
        "camera_ok": streaming,
        "fps": health.get("fps") if streaming else None,
        "frame_count": svc.jpeg_count if streaming else None,
        "last_frame_age_ms": health.get("latency_ms") if streaming else None,
        "error": health.get("error"),
        "source": health.get("source") or "absent",
        "dry_run": health.get("source") == "synthetic",
        "real": health.get("real") is True,
        "device": health.get("resolved_device"),
        "requested_device": health.get("requested_device"),
        "resolved_device": health.get("resolved_device"),
        "has_frame": bool(streaming and svc.jpeg),
        "flight_commands": False,
    }


def _apply_ov9281(cameras):
    """Cam0 and the OV9281 Cam1 replace the ingest slots when they are the real devices."""
    cameras = dict(cameras or {})
    slot0 = _cam0_slot()
    if slot0 is not None:
        cameras["cam0"] = slot0
    slot1 = _cam1_slot()
    if slot1 is None:
        return cameras
    prev = cameras.get("cam1") if isinstance(cameras.get("cam1"), dict) else {}
    ov_here = slot1.get("present") is True or slot1.get("camera_ok") is True
    ingest_here = prev.get("camera_ok") is True or bool(prev.get("resolved_device"))
    if ov_here or not ingest_here:
        cameras["cam1"] = slot1
    return cameras


def cameras_status_payload():
    snap = _ingest_or_absent()
    cameras = _apply_ov9281(snap.get("cameras") or {})
    slot = cameras.get("cam0") if isinstance(cameras.get("cam0"), dict) else _cam0_slot()
    return {
        "ok": True,
        "observe_only": True,
        "implemented": snap.get("implemented"),
        "dry_run": snap.get("dry_run"),
        "dry_run_mode": snap.get("dry_run_mode"),
        "source": snap.get("source"),
        "real": snap.get("real") is True,
        "camera_ok": snap.get("camera_ok") is True,
        "running": snap.get("running") is True,
        "health": snap.get("health"),
        "fps": snap.get("fps"),
        "frame_count": snap.get("frame_count"),
        "last_frame_age_ms": snap.get("last_frame_age_ms"),
        "cameras": cameras,
        "cam0": slot,
        "note": snap.get("note"),
    }


def vision_status_payload():
    """Observe-only camera / vision. Absent device → camera_ok false. Dry-run is never real."""
    snap = _ingest_or_absent()
    any_ok = snap.get("camera_ok") is True
    source_id = "none"
    raw_cams = _apply_ov9281(snap.get("cameras") or {})
    for cam in raw_cams.values():
        if isinstance(cam, dict) and cam.get("camera_ok") is True:
            any_ok = True
            break
    order = [cam_id for cam_id in ("cam1", "cam2", "cam3") if cam_id in raw_cams]
    order.extend(cam_id for cam_id in raw_cams if cam_id not in order)
    for key in order:
        cam = raw_cams.get(key) or {}
        if cam.get("camera_ok") is True and cam.get("enabled") is not False:
            source_id = key
            break
    return {
        "ok": True,
        "observe_only": True,
        "camera_ok": any_ok,
        "running": snap.get("running") is True,
        "health": snap.get("health") or "unavailable",
        "fps": snap.get("fps"),
        "latency_ms": None,
        "last_valid": None,
        "frame_id": snap.get("frame_count"),
        "frame_count": snap.get("frame_count"),
        "last_frame_age_ms": snap.get("last_frame_age_ms"),
        "age_ms": snap.get("last_frame_age_ms"),
        "source_id": source_id,
        "source": snap.get("source") or "absent",
        "dry_run": snap.get("dry_run") is True,
        "real": snap.get("real") is True,
        "cameras": raw_cams,
        "quality": {"confidence": None, "label": "unknown"},
        "implemented": snap.get("implemented") is True,
        "note": snap.get("note") or "no camera device; camera_ok is false; not invented",
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


def annotated_video_status_payload():
    """Observe-only annotated egress. Never invents frames. Cellular only."""
    if annotated_encoder_status:
        return annotated_encoder_status(modem=modem_status_payload())
    modem = modem_status_payload()
    present = modem.get("present") is True
    reason = "stream_absent" if present else "modem_absent"
    reason_he = (
        "אין שידור. אין זרם מסומן ממחשב משימה. ראייה מסומנת לא עוברת ברדיו."
        if present
        else "אין שידור. מודם סלולר לא מחובר. ראייה מסומנת מגיעה רק ממחשב משימה."
    )
    return {
        "ok": True,
        "observe_only": True,
        "dry_run": True,
        "available": False,
        "path": "cellular",
        "neverRadio": True,
        "radioSatisfies": False,
        "streamPresent": False,
        "streamUrl": None,
        "annotated_stream_url": None,
        "frames": False,
        "inventedFrames": False,
        "annotated_pipeline": "none",
        "annotated_fps": None,
        "modemPresent": present,
        "reason": reason,
        "reasonHe": reason_he,
        "companionHttpCommandPath": False,
        "flightCommands": False,
        "noteHe": "ראייה מסומנת רק בסלולר. בלי זרם אין שידור.",
    }


def video_status_payload():
    """Observe-only video metadata. Annotated stays off unless a real stream URL exists."""
    snap = _ingest_or_absent()
    any_ok = snap.get("camera_ok") is True
    raw_name = "none"
    if snap.get("dry_run") and snap.get("dry_run_mode") == "synthetic" and any_ok:
        raw_name = "synthetic"
    elif any_ok and snap.get("real") is True:
        raw_name = "camera_ingest"
    enc = annotated_video_status_payload()
    return {
        "ok": True,
        "observe_only": True,
        "raw_pipeline": raw_name,
        "annotated_pipeline": enc.get("annotated_pipeline") or "none",
        "raw_fps": snap.get("fps") if any_ok else None,
        "annotated_fps": None,
        "bitrate_kbps": None,
        "raw_kind": "raw",
        "annotated_kind": "annotated",
        "dry_run": snap.get("dry_run") is True,
        "real": snap.get("real") is True,
        "available": enc.get("available") is True,
        "streamPresent": enc.get("streamPresent") is True,
        "annotated_stream_url": enc.get("annotated_stream_url") or enc.get("streamUrl"),
        "path": "cellular",
        "neverRadio": True,
        "radioSatisfies": False,
        "reason": enc.get("reason") or "modem_absent",
        "reasonHe": enc.get("reasonHe"),
        "frames": False,
        "inventedFrames": False,
        "note": "annotated stream stays off; raw follows camera ingest; not invented",
        "noteHe": enc.get("noteHe") or "ראייה מסומנת רק בסלולר. בלי זרם אין שידור.",
    }


def optical_nav_status_payload():
    """Observe-only optical nav. Estimator stays off. Per-camera ingest is shared with landing."""
    snap = _ingest_or_absent()
    raw_cams = snap.get("cameras") or {}
    cameras = {}
    order = [cam_id for cam_id in ("cam1", "cam2", "cam3") if cam_id in raw_cams]
    order.extend(cam_id for cam_id in raw_cams if cam_id not in order)
    if not order:
        order = ["cam1", "cam2", "cam3"]
    for cam_id in order:
        src = raw_cams.get(cam_id) or {}
        mount = src.get("role") or {"cam1": "forward", "cam2": "down", "cam3": "gimbal"}.get(cam_id)
        nav_role = src.get("nav_role") or {
            "forward": "vio_forward",
            "down": "optical_flow_down",
            "gimbal": "gimbal_observe",
        }.get(mount, "landing_vision")
        cameras[cam_id] = {
            "id": cam_id,
            "role": nav_role,
            "mount_role": mount,
            "shared_with": "landing_vision",
            "enabled": src.get("enabled") is not False if src else cam_id != "cam3",
            "state": src.get("state"),
            "present": src.get("present") is True,
            "camera_ok": src.get("camera_ok") is True,
            "fps": src.get("fps"),
            "frame_count": src.get("frame_count"),
            "last_frame_age_ms": src.get("last_frame_age_ms"),
            "error": src.get("error"),
            "source": src.get("source") or "absent",
            "dry_run": src.get("dry_run") is True,
            "real": src.get("real") is True,
            "resolved_device": src.get("resolved_device"),
            "requested_device": src.get("requested_device"),
        }
    slot1 = _cam1_slot()
    if slot1 is not None:
        prev = cameras.get("cam1") or {}
        ov_here = slot1.get("present") is True or slot1.get("camera_ok") is True
        ingest_here = prev.get("camera_ok") is True or bool(prev.get("resolved_device"))
        if ov_here or not ingest_here:
            cameras["cam1"] = {
                **prev,
                "state": slot1.get("state"),
                "present": slot1.get("present") is True,
                "camera_ok": slot1.get("camera_ok") is True,
                "fps": slot1.get("fps"),
                "error": slot1.get("error"),
                "source": slot1.get("source") or "absent",
                "resolved_device": slot1.get("resolved_device"),
                "requested_device": slot1.get("requested_device"),
                "real": slot1.get("real") is True,
                "dry_run": slot1.get("dry_run") is True,
            }
    return {
        "ok": True,
        "observe_only": True,
        "present": False,
        "running": False,
        "camera_ok": False,
        "alt_ceiling_m": 300,
        "position": None,
        "velocity": None,
        "age_ms": None,
        "confidence": None,
        "ekf_injected": False,
        "display_only": True,
        "cameras": cameras,
        "ingest": {
            "camera_ok": snap.get("camera_ok") is True,
            "dry_run": snap.get("dry_run") is True,
            "source": snap.get("source") or "absent",
            "real": snap.get("real") is True,
        },
        "implemented": False,
        "note": "no optical-nav estimator; cameras shared with landing/vision; position null; not EKF fused",
    }


def _env_flag_on(name):
    return os.environ.get(name, "").strip().lower() in {"present", "1", "true", "yes", "on"}


def _absent_modem(reason="modem_absent", error=None):
    return {
        "ok": True,
        "present": False,
        "model": "Huawei E3372",
        "state": "modem_absent",
        "transport": None,
        "iface": None,
        "ip": None,
        "error": error,
        "reason": reason,
        "role": "cellular",
        "videoPath": "cellular",
        "mavlinkSecondPath": True,
        "companionHttpCommandPath": False,
        "flightCommands": False,
        "neverRadioVideo": True,
        "source": "status_file",
        "statusFileMissing": False,
    }


def flightlog_status_payload():
    """Read the flight logger status file. Missing or garbage stays honest."""
    path = Path(os.environ.get("AIRVIX_FLIGHTLOG_STATUS_FILE", "/run/airvix/flightlog.json"))
    if not path.is_file():
        return {"ok": True, "present": False, "state": "absent"}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"ok": True, "present": False, "state": "absent", "error": str(exc)[:160]}
    if not isinstance(data, dict):
        return {"ok": True, "present": False, "state": "absent", "error": "not_object"}
    body = {}
    for key, value in data.items():
        lk = str(key).lower()
        if any(tok in lk for tok in ("secret", "token", "password", "app_key", "authorization")):
            continue
        body[key] = value
    body["ok"] = True
    body["present"] = True
    return body


def modem_status_payload():
    """Observe-only E3372 snapshot. Missing file → modem_absent. Never invents up."""
    if _env_flag_on("AIRVIX_CELLULAR_MOCK") or _env_flag_on("CELLULAR_MODEM_MOCK"):
        body = _absent_modem("mock_present")
        body["present"] = True
        body["state"] = "mock_present"
        body["transport"] = "mock"
        body["iface"] = "mock0"
        body["reason"] = "mock_present"
        return enrich_modem(body)
    path = Path(MODEM_STATUS_FILE)
    if not path.is_file():
        body = _absent_modem("modem_absent")
        body["statusFileMissing"] = True
        body["reasonHe"] = "מודם לא מחובר. אין קובץ סטטוס במחשב משימה."
        return enrich_modem(body)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return enrich_modem(_absent_modem("status_unreadable", error=str(exc)[:160]))
    if not isinstance(data, dict):
        return enrich_modem(_absent_modem("status_invalid", error="not_object"))
    present = data.get("present") is True
    ip = data.get("ip") if isinstance(data.get("ip"), str) and data.get("ip") else None
    err = data.get("error") if isinstance(data.get("error"), str) and data.get("error") else None
    return enrich_modem({
        "ok": True,
        "present": present,
        "model": data.get("model") or "Huawei E3372",
        "state": data.get("state") or ("present" if present else "modem_absent"),
        "transport": data.get("transport"),
        "iface": data.get("iface"),
        "ip": ip,
        "error": err,
        "reason": data.get("reason") or ("device_node" if present else "modem_absent"),
        "role": "cellular",
        "videoPath": "cellular",
        "mavlinkSecondPath": True,
        "companionHttpCommandPath": False,
        "flightCommands": False,
        "neverRadioVideo": True,
        "source": "status_file",
    })


def _refresh_fc_link():
    flags = fc_link_flags()
    with STATE_LOCK:
        STATE["fc_heartbeat"] = flags["connected"] is True
        if flags.get("heartbeat_wall") is not None:
            STATE["last_heartbeat_at"] = flags["heartbeat_wall"]


def extras_status_payload():
    snap = _ingest_or_absent()
    any_ok = snap.get("camera_ok") is True
    return {
        "camera_ok": any_ok,
        "camera_connected": any_ok,
        "runway_detector": False,
        "runway_detected": None,
        "optical_nav": optical_nav_status_payload(),
        "cameras": snap.get("cameras") or {},
        "dry_run": snap.get("dry_run") is True,
        "observe_only": True,
    }


def status_payload():
    """Companion v1 status overlay. System gauges plus honest absent vision/landing."""
    _refresh_fc_link()
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
        "optical_nav": optical_nav_status_payload(),
        "landing": landing_status_payload(),
        "video": video_status_payload(),
        "extras": extras_status_payload(),
        "modem": modem_status_payload(),
        "flight_log": flightlog_status_payload(),
        "gimbal": gimbal_status_payload(start=False),
        "fc": fc_status_payload(),
        "mavlink": {},
    }


def gimbal_status_payload(start=False):
    """Honest gimbal snapshot. present is true only after a fresh SDK reply."""
    if gimbal_status is None:
        return {
            "ok": True,
            "present": False,
            "firmware": None,
            "hardware_id": None,
            "attitude": None,
            "zoom": None,
            "mode": None,
            "recording": None,
            "age_ms": None,
            "control_enabled": False,
            "polling": False,
            "error": "sdk_module_absent",
            "note": "no gimbal reply; not invented",
        }
    return gimbal_status(start=start)


def health_payload():
    _refresh_fc_link()
    return {
        "ok": True,
        "agentVersion": AGENT_VERSION,
        "api_version": "1",
        "observe_only": True,
        "capabilities": {"uplinkStatus": True, "uplinkControl": apply_boot_policy is not None},
        "fc": fc_status_payload(),
        **STATE,
        "vision": vision_status_payload(),
        "optical_nav": optical_nav_status_payload(),
        "landing": landing_status_payload(),
        "video": video_status_payload(),
        "extras": extras_status_payload(),
        "modem": modem_status_payload(),
        "flight_log": flightlog_status_payload(),
        "gimbal": gimbal_status_payload(start=False),
    }


def _versions_dest():
    raw = os.environ.get("VLC_COMPANION_DEST")
    return Path(raw) if raw else (Path.home() / "vlc-companion")


def _versions_blocked():
    """None only when this process sees a fresh disarmed, not-flying heartbeat."""
    try:
        payload = fc_status_payload()
    except Exception:
        payload = None
    connected = isinstance(payload, dict) and payload.get("connected") is True
    armed, in_flight = _flight_gate_fields(payload) if connected else (None, None)
    try:
        version_rollback.write_flight_gate(_versions_dest(), armed, in_flight)
    except Exception:
        return "unknown"
    return version_rollback.decide_flight_gate(armed, in_flight)


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


class CompanionHTTPServer(ThreadingHTTPServer):
    """One thread per connection. Idle keep-alive sockets die with the process."""

    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0 closes after every response. HTTP/1.1 keeps the socket when
    # every response carries Content-Length (or is a bodiless 204/304).
    protocol_version = "HTTP/1.1"
    timeout = 30

    def _auth_ok(self):
        if not TOKEN:
            return True
        return self.headers.get("X-Companion-Token") == TOKEN or self.headers.get("Authorization", "").replace("Bearer ", "") == TOKEN

    def _path(self):
        return self.path.split("?", 1)[0]

    def _send_bytes(self, code, body, content_type, extra=None):
        payload = body if isinstance(body, (bytes, bytearray)) else bytes(body)
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        for key, value in extra or ():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)
        try:
            self.wfile.flush()
        except Exception:
            self.close_connection = True

    def _json(self, code, obj):
        self._send_bytes(code, json.dumps(obj).encode("utf-8"), "application/json")

    def send_error(self, code, message=None, explain=None):
        """JSON error with Content-Length. Do not force Connection: close."""
        self._json(int(code), {
            "ok": False,
            "message": message or "error",
            "explain": explain,
        })

    def _read_request_body(self):
        transfer = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in transfer:
            return self._read_chunked()
        raw_len = self.headers.get("Content-Length")
        if raw_len is None:
            return b""
        try:
            length = int(raw_len)
        except ValueError:
            self.close_connection = True
            raise ValueError("bad_length")
        if length < 0 or length > HTTP_MAX_BODY:
            self.close_connection = True
            raise ValueError("bad_length")
        if length == 0:
            return b""
        data = self.rfile.read(length)
        if len(data) != length:
            self.close_connection = True
            raise ValueError("short_body")
        return data

    def _read_chunked(self):
        chunks = []
        total = 0
        while True:
            line = self.rfile.readline(65537)
            if not line or len(line) > 65536:
                self.close_connection = True
                raise ValueError("bad_chunk")
            try:
                size = int(line.split(b";", 1)[0].strip(), 16)
            except ValueError:
                self.close_connection = True
                raise ValueError("bad_chunk")
            if size == 0:
                while True:
                    trailer = self.rfile.readline(65537)
                    if trailer in (b"\r\n", b"\n", b""):
                        break
                return b"".join(chunks)
            if size < 0 or total + size > HTTP_MAX_BODY:
                self.close_connection = True
                raise ValueError("chunk_too_large")
            data = self.rfile.read(size)
            if len(data) != size:
                self.close_connection = True
                raise ValueError("short_chunk")
            delim = self.rfile.read(2)
            if delim not in (b"\r\n", b"\n"):
                self.close_connection = True
                raise ValueError("bad_chunk_end")
            chunks.append(data)
            total += size

    def _note_console(self):
        try:
            from uplink_control import note_console_request
            note_console_request()
        except Exception:
            return

    def do_HEAD(self):
        self.do_GET()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Companion-Token")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()
        try:
            self.wfile.flush()
        except Exception:
            self.close_connection = True

    def do_GET(self):
        if not self._auth_ok():
            return self._json(401, {"ok": False, "message": "Unauthorized"})
        self._note_console()
        path = self._path()
        if path == "/api/logs" or path == "/api/logs/":
            logs = [{"name": p.name, "size": p.stat().st_size} for p in iter_log_files()]
            return self._json(200, {"ok": True, "logs": logs})
        if path.startswith("/api/logs/"):
            name = path.split("/api/logs/", 1)[1]
            for p in iter_log_files():
                if p.name == name:
                    self._send_bytes(200, p.read_bytes(), "application/octet-stream")
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
        if path in ("/api/status/cameras", "/api/v1/status/cameras"):
            return self._json(200, cameras_status_payload())
        if path in ("/api/status/optical-nav", "/api/v1/status/optical-nav"):
            return self._json(200, optical_nav_status_payload())
        if path in ("/api/status/landing", "/api/v1/status/landing"):
            return self._json(200, landing_status_payload())
        if path in ("/api/status/video", "/api/v1/status/video"):
            return self._json(200, video_status_payload())
        if path in ("/api/status/annotated-video", "/api/v1/status/annotated-video"):
            return self._json(200, annotated_video_status_payload())
        if path in ("/api/status/fc", "/api/v1/status/fc"):
            return self._json(200, fc_status_payload())
        if path in ("/api/status/modem", "/api/v1/status/modem"):
            return self._json(200, modem_status_payload())
        if path in ("/api/flight-log/status", "/api/v1/flight-log/status"):
            return self._json(200, flightlog_status_payload())
        if path in ("/api/v1/network/uplinks", "/api/network/uplinks"):
            return self._json(200, uplinks_payload())
        uplink_kind = _uplink_kind(path)
        if uplink_kind:
            return self._json(405, {"ok": False, "reason": "method_not_allowed", "message": "נדרש POST"})
        if path in ("/api/status/gimbal", "/api/v1/status/gimbal"):
            return self._json(200, gimbal_status_payload(start=True))
        if path in ("/api/transport-test", "/api/v1/transport-test"):
            return self._json(200, transport_test_payload(self_test=False))
        if path in ("/api/v1/versions", "/api/v1/versions/backups"):
            if version_rollback is None:
                return self._json(503, {"ok": False, "message": "אין מידע"})
            code, body = version_rollback.http_get(_versions_dest(), AGENT_VERSION)
            return self._json(code, body)
        try:
            from cam0.cam1 import try_handle as cam1_try_handle
            if cam1_try_handle(self):
                return
        except Exception:
            pass
        try:
            from cam0.api import try_handle as cam0_try_handle
            if cam0_try_handle(self):
                return
        except Exception:
            pass
        cam_frame = _camera_frame_id(path)
        if cam_frame:
            jpeg = ingest_frame_jpeg(cam_frame) if ingest_frame_jpeg else None
            if not jpeg:
                return self._json(404, {
                    "ok": False,
                    "camera_ok": False,
                    "reason": "no_frame",
                    "note": "אין פריים",
                })
            self._send_bytes(200, jpeg, "image/jpeg", extra=(("Cache-Control", "no-store"),))
            return
        return self._json(404, {"ok": False})

    def do_POST(self):
        try:
            raw = self._read_request_body()
        except Exception:
            self.close_connection = True
            return self._json(400, {"ok": False, "message": "bad body"})
        if not self._auth_ok():
            return self._json(401, {"ok": False, "message": "Unauthorized"})
        self._note_console()
        if not raw:
            raw = b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            data = {}
        path = self._path()
        if path in ("/api/transport-test", "/api/v1/transport-test"):
            return self._json(200, transport_test_payload(self_test=True))
        action = _GIMBAL_ACTIONS.get(path)
        if action:
            if gimbal_command is None:
                return self._json(503, {
                    "ok": False,
                    "reason": "sdk_module_absent",
                    "message": "שליטת גימבל לא זמינה",
                    "sent": False,
                })
            code, body = gimbal_command(action, data if isinstance(data, dict) else {})
            return self._json(code, body)
        uplink_kind = _uplink_kind(path)
        if uplink_kind:
            enabled = data.get("enabled") if isinstance(data, dict) else None
            code, body = set_uplink(uplink_kind, enabled)
            return self._json(code, body)
        if path in ("/api/v1/versions/rollback", "/api/v1/versions/known-good"):
            if version_rollback is None:
                return self._json(503, {"ok": False, "message": "אין מידע"})
            ctx = version_rollback.build_context(AGENT_VERSION)
            ctx["dest"] = _versions_dest()
            ctx["blocked"] = _versions_blocked
            code, body = version_rollback.http_post(path, data if isinstance(data, dict) else {}, ctx)
            return self._json(code, body)
        try:
            from cam0.cam1 import try_handle as cam1_try_handle
            if cam1_try_handle(self, data if isinstance(data, dict) else {}):
                return
        except Exception:
            pass
        try:
            from cam0.api import try_handle as cam0_try_handle
            if cam0_try_handle(self, data if isinstance(data, dict) else {}):
                return
        except Exception:
            pass
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
    snap = _ingest_or_absent()
    print(f"  Camera ingest: source={snap.get('source')} dry_run={snap.get('dry_run')}")
    try:
        from cam0.service import start_service
        cam0 = start_service()
        if cam0 is None:
            print("  Cam0: off")
        else:
            print(f"  Cam0: source={cam0.config.get('source')} state={cam0.state}")
    except Exception as exc:
        print(f"  Cam0: off ({type(exc).__name__})")
    try:
        from cam0.cam1 import get_service as cam1_service
        cam1 = cam1_service()
        print(f"  Cam1: idle device={cam1.config.get('device')} clients={cam1.clients}")
    except Exception as exc:
        print(f"  Cam1: off ({type(exc).__name__})")
    poll_raw = os.environ.get("VLC_GIMBAL_POLL")
    if poll_raw is None or str(poll_raw).strip() == "":
        want_gimbal_poll = not SKIP_RELAY
    else:
        want_gimbal_poll = str(poll_raw).strip().lower() in {"1", "true", "yes", "on"}
    if not SKIP_RELAY:
        threading.Thread(target=heartbeat_loop, daemon=True).start()
        threading.Thread(target=mavlink_relay_server, daemon=True).start()
    else:
        print("  SKIP_RELAY: HTTP observe-status only")
    if want_gimbal_poll and get_gimbal_link is not None:
        get_gimbal_link(start=True)
        print("  Gimbal poll: on (control still requires VLC_GIMBAL_CONTROL_ENABLED=1)")
    boot_flag = os.environ.get("VLC_UPLINK_BOOT", "1").strip().lower()
    if apply_boot_policy is not None and boot_flag not in {"0", "false", "no", "off"}:
        try:
            report = apply_boot_policy() or {}
            print(f"  Uplink boot: fallback={report.get('fallback')}")
        except Exception:
            print("  Uplink boot: skipped")
    idle = HTTP_IDLE_S if HTTP_IDLE_S > 0 else 30
    Handler.timeout = idle
    httpd = CompanionHTTPServer((HTTP_BIND, HTTP_PORT), Handler)
    httpd.daemon_threads = True
    print(f"  HTTP keep-alive: HTTP/1.1 idle {idle:g}s")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
