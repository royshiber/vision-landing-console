"""Persisted optical-landing profile on the Jetson.

The file is the source of truth. Bounds match
scripts/jetson-companion/jetson_numeric_schema.json, which
lib/param-schema.mjs loads as JETSON_NUMERIC_SCHEMA.
Vision landing reads the stored numbers through for_landing().
"""

import json
import os
from pathlib import Path

SCHEMA_PATH = Path(__file__).with_name("jetson_numeric_schema.json")
PROFILE_NAME = "landing-profile.json"


def schema():
    with SCHEMA_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def data_dir():
    raw = os.environ.get("VLC_COMPANION_DATA") or os.environ.get("VLC_COMPANION_DEST") or ""
    if raw.strip():
        return Path(raw)
    return Path.home() / "vlc-companion"


def profile_path():
    return data_dir() / PROFILE_NAME


def _finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def reject(raw_profile):
    """Same verdicts as rejectJetsonProfile in lib/param-schema.mjs. No clamping."""
    accepted = {}
    rejected = {}
    if not isinstance(raw_profile, dict):
        return {"ok": False, "accepted": accepted, "rejected": {"profile": "invalid_object"}}
    bounds = schema()
    for key, raw_value in raw_profile.items():
        spec = bounds.get(key)
        if spec is None:
            rejected[key] = "unknown_key"
            continue
        number = _finite(raw_value)
        if number is None:
            rejected[key] = "not_numeric"
            continue
        if number < float(spec["min"]) or number > float(spec["max"]):
            rejected[key] = "out_of_range"
            continue
        accepted[key] = number
    ok = len(rejected) == 0 and len(accepted) > 0
    return {"ok": ok, "accepted": accepted, "rejected": rejected}


def _corrupt(reason="corrupt"):
    """A file on disk is never the same as 'no profile'."""
    return {
        "ok": False,
        "present": True,
        "corrupt": True,
        "profile": {},
        "rejected": {"profile": reason},
    }


def read():
    path = profile_path()
    if not path.is_file():
        return {"ok": True, "present": False, "corrupt": False, "profile": {}, "rejected": {}}
    try:
        with path.open("r", encoding="utf-8") as handle:
            body = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return _corrupt()
    if not isinstance(body, dict):
        return _corrupt()
    profile = body.get("profile")
    if not isinstance(profile, dict):
        if body.get("present") is True:
            return _corrupt()
        return {"ok": True, "present": False, "corrupt": False, "profile": {}, "rejected": {}}
    if not profile and body.get("present") is not True:
        return {"ok": True, "present": False, "corrupt": False, "profile": {}, "rejected": {}}
    verdict = reject(profile)
    if verdict["rejected"] or not verdict["ok"]:
        return {
            "ok": False,
            "present": True,
            "corrupt": False,
            "profile": verdict["accepted"],
            "rejected": verdict["rejected"] or {"profile": "invalid"},
        }
    return {
        "ok": True,
        "present": True,
        "corrupt": False,
        "profile": verdict["accepted"],
        "rejected": {},
    }


def _atomic_write(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    payload = json.dumps(body, ensure_ascii=False, indent=2).encode("utf-8")
    with tmp.open("wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def put(raw):
    current = read()
    if current.get("corrupt") or current.get("rejected"):
        return 409, {
            "ok": False,
            "present": True,
            "corrupt": current.get("corrupt") is True,
            "rejected": current.get("rejected") or {},
            "profile": current.get("profile") or {},
        }
    incoming = raw.get("profile") if isinstance(raw, dict) and "profile" in raw else raw
    verdict = reject(incoming)
    if not verdict["ok"]:
        return 400, {
            "ok": False,
            "present": current["present"] is True,
            "rejected": verdict["rejected"],
            "profile": current.get("profile") or {},
        }
    profile = dict(current["profile"]) if current["present"] else {}
    profile.update(verdict["accepted"])
    _atomic_write(profile_path(), {"present": True, "profile": profile})
    stored = read()
    return 200, {
        "ok": True,
        "present": True,
        "corrupt": False,
        "rejected": {},
        "profile": stored.get("profile") or profile,
    }


def for_landing():
    """Optical landing reads these numbers. A bad file is not an empty profile."""
    stored = read()
    blocked = stored.get("corrupt") is True or bool(stored.get("rejected"))
    return {
        "present": stored["present"] is True or blocked,
        "corrupt": stored.get("corrupt") is True,
        "rejected": dict(stored.get("rejected") or {}),
        "profile": dict(stored.get("profile") or {}) if stored["present"] or blocked else {},
    }
