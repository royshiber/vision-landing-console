"""Out-of-process frame-bus worker.

A slow module runs here so it cannot stall capture. It only reads the bus.

  python3 -m cam0.worker --bus cam0-123 --module marker
"""

from __future__ import annotations

import argparse
import json
import time

from .bus import FrameBus
from .marker import MarkerModule


def main(argv=None):
    parser = argparse.ArgumentParser(description="Cam0 frame-bus worker")
    parser.add_argument("--bus", required=True)
    parser.add_argument("--module", default="marker")
    parser.add_argument("--seconds", type=float, default=2.0)
    args = parser.parse_args(argv)
    bus = FrameBus(name=args.bus, create=False).attach()
    module = MarkerModule() if args.module == "marker" else None
    if module is None:
        raise SystemExit("unknown module")
    sub = bus.subscribe()
    end = time.monotonic() + args.seconds
    last = None
    while time.monotonic() < end:
        view = sub.wait(0.2)
        if view is None:
            continue
        last = module.on_frame(view)
    print(json.dumps({"ok": True, "dropped": sub.dropped, "result": last}, default=str))
    bus.close()


if __name__ == "__main__":
    main()
