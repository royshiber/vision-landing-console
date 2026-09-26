"""Bidirectional MAVLink frame pipe between the FC UART and a CP2102 radio.

Off unless VLC_RF_ENABLED is set. The radio is chosen from /dev/serial/by-id
and must be a CP2102. Huawei E3372 ttyUSB devices are never opened.
This module only forwards bytes. It does not build flight commands.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path

RF_BAUD_DEFAULT = 57600
BY_ID_DIR = "/dev/serial/by-id"
_REJECT = ("e3372", "huawei", "modem", "gsm", "mobile")


def env_enabled(env=None):
    raw = str((env or os.environ).get("VLC_RF_ENABLED", "0")).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def env_baud(env=None):
    raw = str((env or os.environ).get("VLC_RF_BAUD", RF_BAUD_DEFAULT)).strip()
    try:
        baud = int(raw)
    except ValueError:
        return RF_BAUD_DEFAULT
    if baud < 1200 or baud > 921600:
        return RF_BAUD_DEFAULT
    return baud


def is_cp2102_name(name):
    base = str(name or "").replace("\\", "/").split("/")[-1]
    low = base.lower()
    if not base or low.startswith("ttyusb"):
        return False
    if "cp2102" not in low:
        return False
    if any(tok in low for tok in _REJECT):
        return False
    return True


def resolve_cp2102(names, directory=BY_ID_DIR):
    """Pick a by-id CP2102 path. Never a bare ttyUSB node."""
    good = []
    for name in names or []:
        base = str(name).replace("\\", "/").split("/")[-1]
        if is_cp2102_name(base):
            good.append(base)
    if not good:
        return None
    good.sort()

    def rank(base):
        low = base.lower()
        if "lr900" in low or "micoair" in low or "mico" in low:
            return (0, base)
        return (1, base)

    chosen = sorted(good, key=rank)[0]
    return str(Path(directory) / chosen)


def list_by_id(directory=BY_ID_DIR):
    root = Path(directory)
    if not root.is_dir():
        return []
    try:
        return [p.name for p in root.iterdir()]
    except OSError:
        return []


class RfForwarder:
    def __init__(
        self,
        *,
        enabled,
        baud=RF_BAUD_DEFAULT,
        list_names=None,
        open_serial=None,
        write_fc=None,
        directory=BY_ID_DIR,
        monotonic=None,
    ):
        self.enabled = bool(enabled)
        self.baud = int(baud or RF_BAUD_DEFAULT)
        self._list_names = list_names or (lambda: list_by_id(directory))
        self._open_serial = open_serial
        self._write_fc = write_fc or (lambda _data: False)
        self._directory = directory
        self._now = monotonic or time.monotonic
        self._port_path = None
        self._ser = None
        self.rx_bytes = 0
        self.tx_bytes = 0
        self._last_packet = None
        self._stop = threading.Event()
        self._thread = None
        self._lock = threading.Lock()

    def _scan(self):
        try:
            names = self._list_names() or []
        except Exception:
            names = []
        return resolve_cp2102(names, self._directory)

    def _close(self):
        ser = self._ser
        self._ser = None
        if ser is None:
            return
        try:
            ser.close()
        except Exception:
            pass

    def poll_once(self):
        """One scan / read. Safe to call after the radio disappears."""
        path = self._scan()
        with self._lock:
            if not self.enabled:
                self._close()
                self._port_path = path
                return
            if path != self._port_path:
                self._close()
                self._port_path = path
            if path and self._ser is None and self._open_serial is not None:
                try:
                    self._ser = self._open_serial(path, self.baud)
                except Exception:
                    self._ser = None
            ser = self._ser
        if ser is None:
            return
        try:
            data = ser.read(4096) or b""
        except Exception:
            with self._lock:
                if self._ser is ser:
                    self._close()
                    self._port_path = None
            return
        if not data:
            return
        with self._lock:
            self.rx_bytes += len(data)
            self._last_packet = self._now()
        try:
            self._write_fc(data)
        except Exception:
            pass

    def on_fc_bytes(self, data):
        """FC UART bytes toward the radio. No-op when the radio is closed."""
        if not self.enabled or not data:
            return
        with self._lock:
            ser = self._ser
        if ser is None:
            return
        try:
            ser.write(data)
        except Exception:
            with self._lock:
                if self._ser is ser:
                    self._close()
                    self._port_path = None
            return
        with self._lock:
            self.tx_bytes += len(data)
            self._last_packet = self._now()

    def start(self):
        if self._thread is not None:
            return
        self._stop.clear()

        def loop():
            while not self._stop.is_set():
                try:
                    self.poll_once()
                except Exception:
                    self._close()
                self._stop.wait(0.4)

        self._thread = threading.Thread(target=loop, name="rf-forwarder", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._close()

    def status(self):
        if self._port_path is None and self._ser is None:
            self._port_path = self._scan()
        age = None
        if self._last_packet is not None:
            age = max(0.0, float(self._now() - self._last_packet))
        return {
            "present": self._port_path is not None,
            "enabled": self.enabled,
            "port": self._port_path,
            "baud": self.baud,
            "rx_bytes": int(self.rx_bytes),
            "tx_bytes": int(self.tx_bytes),
            "last_packet_age": age,
        }
