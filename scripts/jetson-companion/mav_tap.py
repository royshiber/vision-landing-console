# -*- coding: utf-8 -*-
"""Local TCP client of the companion relay. Reader never writes. Decode is another thread."""

from __future__ import print_function

import queue
import socket
import threading
import time

try:
    from pymavlink.dialects.v20 import ardupilotmega as _dialect
except ImportError:
    _dialect = None


class MavTap(object):
    def __init__(self, host, port, on_frame, stall=None, recv_buf=4 * 1024 * 1024):
        self.host = host
        self.port = int(port)
        self.on_frame = on_frame
        self.stall = stall
        self.recv_buf = recv_buf
        self.stop = threading.Event()
        self.queue = queue.Queue(maxsize=4096)
        self.connected = False
        self.bytes = 0
        self.frames = 0
        self.bad_data = 0
        self.drops = 0
        self.reconnects = 0
        self.last_msg_mono = None
        self._threads = []
        self._ever_connected = False

    def start(self):
        if _dialect is None:
            raise RuntimeError("pymavlink_missing")
        self._threads = [
            threading.Thread(target=self._reader_loop, name="flightlog-tap-read", daemon=True),
            threading.Thread(target=self._decode_loop, name="flightlog-tap-decode", daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    def close(self):
        self.stop.set()
        if self.stall is not None:
            self.stall.set()
        for thread in self._threads:
            thread.join(timeout=2.0)

    def last_msg_age_s(self):
        if self.last_msg_mono is None:
            return None
        return max(0.0, time.monotonic() - self.last_msg_mono)

    def _reader_loop(self):
        delay = 1.0
        while not self.stop.is_set():
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, self.recv_buf)
                sock.settimeout(2.0)
                sock.connect((self.host, self.port))
                self.connected = True
                if self._ever_connected:
                    self.reconnects += 1
                self._ever_connected = True
                delay = 1.0
                self._recv_until_drop(sock)
            except Exception:
                self.connected = False
            finally:
                self.connected = False
                try:
                    sock.close()
                except OSError:
                    pass
            if self.stop.is_set():
                break
            time.sleep(delay)
            delay = min(10.0, delay * 2.0 if delay > 1.0 else 2.0)
            if delay < 1.0:
                delay = 1.0

    def _recv_until_drop(self, sock):
        while not self.stop.is_set():
            try:
                data = sock.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if not data:
                break
            self.bytes += len(data)
            try:
                self.queue.put_nowait((time.time(), data))
            except queue.Full:
                self.drops += 1

    def _decode_loop(self):
        parser = _dialect.MAVLink(None)
        parser.robust_parsing = True
        while not self.stop.is_set():
            if self.stall is not None:
                while not self.stall.is_set() and not self.stop.is_set():
                    time.sleep(0.01)
                if self.stop.is_set():
                    break
            try:
                received_at, data = self.queue.get(timeout=0.2)
            except queue.Empty:
                continue
            before = int(getattr(parser, "total_receive_errors", 0) or 0)
            try:
                parsed = parser.parse_buffer(data)
            except Exception:
                self.bad_data += 1
                continue
            after = int(getattr(parser, "total_receive_errors", 0) or 0)
            if after > before:
                self.bad_data += after - before
            for msg in parsed or []:
                if msg is None or msg.get_type() == "BAD_DATA":
                    self.bad_data += 1
                    continue
                raw = msg.get_msgbuf()
                frame = bytes(raw) if raw else b""
                self.frames += 1
                self.last_msg_mono = time.monotonic()
                try:
                    self.on_frame(received_at, frame, msg)
                except Exception:
                    continue


def parse_relay(spec):
    text = spec or "127.0.0.1:5770"
    if ":" not in text:
        return text, 5770
    host, port = text.rsplit(":", 1)
    return host or "127.0.0.1", int(port)
