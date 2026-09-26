"""Pick a V4L2 node without trusting /dev/videoN order.

Cam0 is the OV9281 at i2c 9-0060. Cam1 is the second module at 10-0060.
A stable udev symlink wins. Otherwise the sysfs name is the identity.
"""

from __future__ import annotations

import os
from pathlib import Path


def resolve_device(
    *,
    env_value=None,
    stable_path,
    name_token,
    fallback,
    sysfs_root="/sys/class/video4linux",
    exists=None,
    read_name=None,
):
    exists = os.path.exists if exists is None else exists
    if env_value is not None and str(env_value).strip():
        return str(env_value).strip()
    if stable_path and exists(stable_path):
        return stable_path
    found = video_by_name(name_token, sysfs_root, read_name=read_name)
    if found:
        return found
    return fallback


def video_by_name(token, sysfs_root="/sys/class/video4linux", read_name=None):
    if not token:
        return None
    root = Path(sysfs_root)
    if not root.is_dir():
        return None
    if read_name is None:
        def read_name(path):
            try:
                return Path(path).read_text(encoding="utf-8", errors="replace")
            except Exception:
                return ""
    rows = [child for child in root.iterdir() if child.name.startswith("video")]

    def sort_key(path):
        digits = "".join(ch for ch in path.name if ch.isdigit())
        return int(digits) if digits else 0

    for child in sorted(rows, key=sort_key):
        if token in read_name(child / "name"):
            return f"/dev/{child.name}"
    return None
