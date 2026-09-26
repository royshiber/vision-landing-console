"""Minimal frame-bus module.

Copy this file, change `name` and `on_frame`, and register it on the host.
The view's mono8 array aliases shared memory. Do not keep it after return.
Publish a dict; never send a vehicle command.
"""

from __future__ import annotations


class MeanModule:
    name = "mean"

    def on_frame(self, view):
        mono = view.mono8
        total = int(mono.size) or 1
        return {
            "module": self.name,
            "frame_index": view.index,
            "mean": float(mono.sum()) / total / 255.0,
        }
