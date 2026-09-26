"""Per-module threads on the frame bus.

A module that sleeps cannot block publish: the subscription only reads the
newest slot and counts the ones it skipped.
"""

from __future__ import annotations

import threading
import time
from collections import deque


class ModuleHost:
    def __init__(self, bus):
        self.bus = bus
        self._lock = threading.Lock()
        self._mods = {}
        self._stop = threading.Event()

    def register(self, module, enabled=True):
        name = module.name
        with self._lock:
            self._mods[name] = {
                "module": module,
                "enabled": bool(enabled),
                "thread": None,
                "frames": 0,
                "dropped": 0,
                "latency_ms": None,
                "cpu": None,
                "fps": None,
                "results": deque(maxlen=8),
                "error": None,
                "_times": deque(maxlen=30),
            }

    def set_enabled(self, name, enabled):
        with self._lock:
            slot = self._mods.get(name)
            if slot is None:
                return False
            slot["enabled"] = bool(enabled)
            return True

    def start(self):
        self._stop.clear()
        with self._lock:
            items = list(self._mods.items())
        for name, slot in items:
            if slot["thread"] and slot["thread"].is_alive():
                continue
            thread = threading.Thread(target=self._run, args=(name,), name=f"cam0-{name}", daemon=True)
            slot["thread"] = thread
            thread.start()

    def stop(self):
        self._stop.set()

    def _run(self, name):
        sub = self.bus.subscribe()
        while not self._stop.is_set():
            with self._lock:
                slot = self._mods.get(name)
                enabled = bool(slot and slot["enabled"])
            view = sub.wait(0.25)
            if view is None:
                continue
            with self._lock:
                slot = self._mods.get(name)
                if slot is not None:
                    slot["dropped"] = sub.dropped
            if not enabled:
                continue
            t0 = time.perf_counter()
            c0 = time.thread_time()
            try:
                result = slot["module"].on_frame(view)
                err = None
            except Exception as exc:
                result = None
                err = type(exc).__name__
            if result is None and err is None:
                continue
            dt = (time.perf_counter() - t0) * 1000.0
            cpu_s = time.thread_time() - c0
            with self._lock:
                slot = self._mods.get(name)
                if slot is None:
                    continue
                slot["frames"] += 1
                slot["latency_ms"] = round(dt, 3)
                slot["cpu"] = round(cpu_s / max(dt / 1000.0, 1e-6), 3)
                slot["error"] = err
                slot["_times"].append(time.monotonic())
                if len(slot["_times"]) >= 2:
                    span = slot["_times"][-1] - slot["_times"][0]
                    slot["fps"] = round((len(slot["_times"]) - 1) / span, 2) if span > 0 else None
                if result is not None:
                    if isinstance(result, dict):
                        result = dict(result)
                        result["latency_ms"] = round(dt, 3)
                    slot["results"].append(result)

    def list(self):
        with self._lock:
            out = []
            for name, slot in self._mods.items():
                out.append({
                    "name": name,
                    "enabled": slot["enabled"],
                    "frames": slot["frames"],
                    "dropped": slot["dropped"],
                    "fps": slot["fps"],
                    "latency_ms": slot["latency_ms"],
                    "cpu": slot["cpu"],
                    "error": slot["error"],
                })
            return out

    def results(self, name):
        with self._lock:
            slot = self._mods.get(name)
            if slot is None:
                return None
            return list(slot["results"])

    def latest(self, name):
        rows = self.results(name)
        if not rows:
            return None
        return rows[-1]
