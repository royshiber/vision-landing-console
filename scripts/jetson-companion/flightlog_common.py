# -*- coding: utf-8 -*-
"""Shared helpers for the flight logger. Python 3.8. No secrets in output."""

from __future__ import print_function

import hashlib
import json
import math
import os
import re
import socket
import tempfile
from pathlib import Path

FLIGHTLOG_VERSION = "2.5.0"
DERIVE_REV = 1
DETECTOR_VERSION = "1.0.0"
PART_BYTES_DEFAULT = 8 * 1024 * 1024
CONTROL_MAX_BYTES = 16 * 1024

_SECRET_VALUE = re.compile(
    r"(?i)([A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Za-z0-9_]*)\s*=\s*(\S+)"
)
_BEARER = re.compile(r"(?i)Bearer\s+\S+")
_TOKEN_Q = re.compile(r"(?i)token=\S+")
_AUTHZ = re.compile(r"(?i)Authorization:\s*\S+")


def env_str(name, default=""):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip()


def env_flag(name, default="0"):
    return env_str(name, default).lower() in {"1", "true", "yes", "on"}


def env_float(name, default):
    raw = env_str(name, "")
    if raw == "":
        return float(default)
    try:
        return float(raw)
    except ValueError:
        return float(default)


def env_int(name, default):
    raw = env_str(name, "")
    if raw == "":
        return int(default)
    try:
        return int(float(raw))
    except ValueError:
        return int(default)


def utc_iso(unix_s):
    import datetime

    if unix_s is None:
        return None
    dt = datetime.datetime.fromtimestamp(float(unix_s), datetime.timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (int(dt.microsecond / 1000))


def utc_compact(unix_s):
    import datetime

    dt = datetime.datetime.fromtimestamp(float(unix_s), datetime.timezone.utc)
    return dt.strftime("%Y%m%dT%H%M%SZ")


def now_unix():
    import time

    return time.time()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def md5_b64(data):
    import base64

    return base64.b64encode(hashlib.md5(data).digest()).decode("ascii")


def atomic_write_bytes(path, data, do_fsync=True):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            if do_fsync:
                os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def atomic_write_text(path, text, do_fsync=True):
    atomic_write_bytes(path, text.encode("utf-8"), do_fsync=do_fsync)


def atomic_write_json(path, obj, do_fsync=True):
    atomic_write_text(path, json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")), do_fsync)


def redact_text(text):
    if text is None:
        return ""
    raw = str(text)
    raw = _BEARER.sub("Bearer [redacted]", raw)
    raw = _TOKEN_Q.sub("token=[redacted]", raw)
    raw = _AUTHZ.sub("Authorization: [redacted]", raw)
    raw = _SECRET_VALUE.sub(lambda m: m.group(1) + "=[redacted]", raw)
    return raw


def redact_obj(value):
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [redact_obj(item) for item in value]
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            lk = str(key).lower()
            if any(tok in lk for tok in ("secret", "token", "password", "app_key", "authorization")):
                out[key] = "[redacted]"
            else:
                out[key] = redact_obj(item)
        return out
    return value


def haversine_m(lat1, lon1, lat2, lon2):
    radius = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2.0) ** 2
    return 2.0 * radius * math.asin(min(1.0, math.sqrt(a)))


def choose_spool_dir():
    preferred = Path(env_str("AIRVIX_FLIGHTLOG_DIR", "/var/lib/airvix/flightlog"))
    try:
        preferred.mkdir(parents=True, exist_ok=True)
        probe = preferred / ".write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return preferred
    except Exception:
        fallback = Path.home() / "airvix-flightlog"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


def status_path(spool_dir):
    raw = env_str("AIRVIX_FLIGHTLOG_STATUS_FILE", "/run/airvix/flightlog.json")
    path = Path(raw)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        probe = path.parent / ".write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return path
    except Exception:
        return Path(spool_dir) / "status.json"


def disk_free_mb(path):
    try:
        st = os.statvfs(str(path))
        return int((st.f_bavail * st.f_frsize) / (1024 * 1024))
    except Exception:
        return None


def hostname_vehicle():
    explicit = env_str("AIRVIX_VEHICLE_ID", "")
    if explicit:
        return explicit
    try:
        name = socket.gethostname().split(".")[0]
    except Exception:
        name = "jetson"
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in name) or "jetson"
    return cleaned


def flight_id_for(arm_unix, vehicle_id):
    stamp = utc_compact(arm_unix)
    digest = hashlib.sha256(("%s|%s" % (stamp, vehicle_id)).encode("utf-8")).hexdigest()[:4]
    return "%s-%s-%s" % (stamp, vehicle_id, digest)


def object_key(prefix, vehicle_id, flight_id, name):
    prefix = (prefix or "v1").strip("/")
    return "%s/%s/flights/%s/%s" % (prefix, vehicle_id, flight_id, name)


def index_key(prefix, vehicle_id, flight_id, variant=None):
    """One object per flight, plus a distinct key for each in-progress variant.

    The canonical index is written once. in_flight and processing never reuse
    that key, because a create-only bucket rejects overwrite.
    """
    prefix = (prefix or "v1").strip("/")
    name = "%s.json" % flight_id
    if variant and str(variant) not in ("final", "complete"):
        safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in str(variant))
        name = "%s--%s.json" % (flight_id, safe or "state")
    return "%s/%s/index/%s" % (prefix, vehicle_id, name)


def apply_env_file(path, override=False):
    """Load KEY=VALUE lines. Empty values and comments are skipped. Never logs values."""
    file_path = Path(path)
    try:
        text = file_path.read_text(encoding="utf-8")
    except OSError:
        return False
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if value == "":
            continue
        if not override and os.environ.get(key):
            continue
        os.environ[key] = value
    return True


def apply_storage_env():
    """Fill unset storage vars from the Jetson file, then the optional system file."""
    home = os.environ.get("HOME") or ""
    paths = []
    if home:
        paths.append(str(Path(home) / "vlc-companion" / "flightlog-storage.env"))
    paths.append("/home/royshiber/vlc-companion/flightlog-storage.env")
    paths.append("/etc/airvix/flightlog.env")
    seen = set()
    for path in paths:
        if path in seen:
            continue
        seen.add(path)
        apply_env_file(path, override=False)


def public_status(doc):
    """Drop anything that could carry a credential before it is written or served."""
    if not isinstance(doc, dict):
        return {"ok": True, "present": False, "state": "absent", "error": "not_object"}
    return redact_obj(doc)
