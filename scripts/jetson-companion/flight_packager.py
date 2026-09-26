# -*- coding: utf-8 -*-
"""Build spool/flights/<id>/ and enqueue uploads. Part A artifacts only."""

from __future__ import print_function

import gzip
import json
import os
import subprocess
import sys
from pathlib import Path

from flight_events import EventNormalizer, rows_to_jsonl_events
from flightlog_common import (
    DERIVE_REV,
    FLIGHTLOG_VERSION,
    atomic_write_json,
    env_str,
    index_key,
    object_key,
    redact_text,
    sha256_file,
    utc_iso,
)

PART_A_ARTIFACTS = (
    ("summary.json", "summary", False),
    ("events.jsonl.gz", "events", True),
    ("series.json.gz", "series", True),
    ("track.geojson.gz", "track", True),
    ("telemetry.tlog.gz", "tlog", True),
    ("jetson/journal.jsonl.gz", "journal", True),
    ("jetson/system.jsonl.gz", "system", True),
)

PRIORITY = {
    "index": 10,
    "manifest": 10,
    "summary": 20,
    "events": 20,
    "series": 20,
    "track": 20,
    "tlog": 30,
    "journal": 40,
    "system": 40,
}


def observations_from_tlog(path):
    from pymavlink import mavutil

    from flight_events import obs_from_message

    if not Path(path).is_file() or Path(path).stat().st_size < 8:
        return []
    mlog = mavutil.mavlink_connection(str(path))
    rows = []
    try:
        while True:
            msg = mlog.recv_match(blocking=False)
            if msg is None:
                break
            if msg.get_type() == "BAD_DATA":
                continue
            ts = getattr(msg, "_timestamp", None)
            if ts is None:
                continue
            rows.append(obs_from_message(ts, msg))
    finally:
        try:
            mlog.close()
        except Exception:
            pass
    return rows


def gzip_bytes(data):
    return gzip.compress(data if isinstance(data, bytes) else data.encode("utf-8"))


def collect_journal(start_unix, end_unix, units):
    override = env_str("AIRVIX_FLIGHTLOG_JOURNAL_OVERRIDE", "")
    if override:
        try:
            return Path(override).read_text(encoding="utf-8", errors="replace"), None
        except Exception as exc:
            return "", "no_journal_permission" if "permission" in str(exc).lower() else "journal_unavailable"
    cmd = ["journalctl", "-o", "json", "--no-pager", "--since", "@%d" % int(start_unix), "--until", "@%d" % int(end_unix)]
    for unit in units:
        if unit:
            cmd.extend(["-u", unit])
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
    except Exception:
        return "", "journal_unavailable"
    err = proc.stderr.decode("utf-8", "replace").lower()
    if proc.returncode != 0 and ("permission" in err or "access denied" in err or "not permitted" in err):
        return "", "no_journal_permission"
    text = proc.stdout[: 20 * 1024 * 1024].decode("utf-8", "replace")
    try:
        kern = subprocess.run(
            ["journalctl", "-k", "-o", "json", "--no-pager", "--since", "@%d" % int(start_unix), "--until", "@%d" % int(end_unix)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
            check=False,
        )
        if kern.returncode == 0:
            text += kern.stdout[: 2 * 1024 * 1024].decode("utf-8", "replace")
    except Exception:
        pass
    return text, None


def run_derive(tlog_path, out_dir, arm_unix, end_unix, air_time):
    script = Path(__file__).resolve().parent / "flight_derive.py"
    inline = env_str("AIRVIX_FLIGHTLOG_DERIVE_INLINE", "")
    if inline.lower() in {"1", "true", "yes", "on"}:
        from flight_derive import derive_tlog, write_outputs

        result = derive_tlog(tlog_path, arm_unix, end_unix)
        write_outputs(result, out_dir, air_time_s=air_time)
        return result
    cmd = ["nice", "-n", "15", sys.executable, str(script), "--tlog", str(tlog_path), "--out", str(out_dir), "--arm-unix", str(arm_unix)]
    if end_unix is not None:
        cmd.extend(["--end-unix", str(end_unix)])
    if air_time is not None:
        cmd.extend(["--air-time", str(air_time)])
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
    except Exception:
        cmd = [sys.executable, str(script), "--tlog", str(tlog_path), "--out", str(out_dir), "--arm-unix", str(arm_unix)]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace")[:400])
    from flight_derive import derive_tlog

    return derive_tlog(tlog_path, arm_unix, end_unix)


def package_flight(session, spool_dir, writer, uploader, vehicle_id, prefix, time_source="jetson_unsynced"):
    """session is a detector snapshot plus events_obs list and system_events list."""
    flight_id = session["flight_id"]
    root = Path(spool_dir) / "flights" / flight_id
    root.mkdir(parents=True, exist_ok=True)
    arm = session.get("arm_t")
    end = session.get("disarm_t") or session.get("closed_t") or arm
    preroll = float(session.get("preroll_s") or 60)
    postroll = float(session.get("postroll_s") or 0)
    window_start = (arm or end) - preroll
    window_end = (end or arm) + postroll
    tlog_path = root / "telemetry.tlog"
    writer.slice(window_start, window_end, tlog_path)
    tlog_gz = root / "telemetry.tlog.gz"
    tlog_gz.write_bytes(gzip_bytes(tlog_path.read_bytes()))
    norm = EventNormalizer()
    for obs in observations_from_tlog(tlog_path):
        norm.feed_obs(obs)
    for event in session.get("extra_events") or []:
        if event.get("t") is None or event["t"] < window_start - 1 or event["t"] > window_end + 1:
            continue
        norm.add_external(event)
    rows = norm.finalize(arm)
    events = rows_to_jsonl_events(rows, arm)
    counts = _counts(events)
    events_path = root / "events.jsonl.gz"
    payload = "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in events)
    events_path.write_bytes(gzip_bytes(redact_text(payload)))
    air = 0.0
    for seg in session.get("segments") or []:
        air += float(seg.get("air_time_s") or 0)
    derive = None
    derive_error = None
    try:
        derive = run_derive(str(tlog_path), str(root), arm, window_end, air)
    except Exception as exc:
        derive_error = str(exc)[:200]
    for name in ("summary.json", "series.json", "track.geojson"):
        src = root / name
        if src.is_file() and name != "summary.json":
            gz = root / (name + ".gz")
            gz.write_bytes(gzip_bytes(src.read_bytes()))
    system_lines = session.get("system_lines") or []
    system_text = "".join(redact_text(line) + "\n" for line in system_lines)
    (root / "jetson").mkdir(parents=True, exist_ok=True)
    (root / "jetson" / "system.jsonl.gz").write_bytes(gzip_bytes(system_text))
    units = [part.strip() for part in env_str(
        "AIRVIX_FLIGHTLOG_JOURNAL_UNITS",
        "airvix-companion,airvix-flightlog,airvix-e3372-bringup,airvix-e3372-status,NetworkManager,ModemManager,tailscaled",
    ).split(",") if part.strip()]
    journal_text, journal_reason = collect_journal(window_start, window_end, units)
    journal_path = root / "jetson" / "journal.jsonl.gz"
    if journal_reason:
        journal_body = ""
    else:
        journal_body = redact_text(journal_text)
        journal_path.write_bytes(gzip_bytes(journal_body))
    classification = session.get("classification") or "unknown_no_telemetry"
    if classification in ("bench", "ground_run"):
        state = "complete"
    else:
        state = "awaiting_fc_log"
    manifest = _manifest(
        session,
        flight_id,
        vehicle_id,
        prefix,
        classification,
        state,
        window_start,
        window_end,
        time_source,
        derive,
        counts,
        journal_reason,
        derive_error,
        root,
    )
    atomic_write_json(root / "manifest.json", manifest)
    index = _index(manifest, session, derive)
    atomic_write_json(root / "index.json", index)
    if uploader is not None:
        _enqueue(uploader, flight_id, root, vehicle_id, prefix, journal_reason)
        uploader.enqueue_file(flight_id, "index.json", str(root / "index.json"), index_key(prefix, vehicle_id, flight_id), "index", PRIORITY["index"])
        uploader.enqueue_file(flight_id, "manifest.json", str(root / "manifest.json"), object_key(prefix, vehicle_id, flight_id, "manifest.json"), "manifest", PRIORITY["manifest"])
    return {"flight_id": flight_id, "dir": str(root), "manifest": manifest, "index": index}


def _counts(events):
    warnings = errors = critical = 0
    for event in events:
        sev = event.get("sev")
        if sev == "warning":
            warnings += 1
        elif sev == "error":
            errors += 1
        elif sev == "critical":
            critical += 1
    return {"events": len(events), "warnings": warnings, "errors": errors, "critical": critical}


def _artifact(name, kind, root, prefix, vehicle_id, flight_id, reason=None):
    path = root / name
    key = object_key(prefix, vehicle_id, flight_id, name)
    if reason:
        return {"name": name, "kind": kind, "key": key, "bytes": None, "sha256": None, "state": "unavailable", "reason": reason, "chunked": False}
    if not path.is_file():
        return {"name": name, "kind": kind, "key": key, "bytes": None, "sha256": None, "state": "unavailable", "reason": "missing", "chunked": False}
    return {
        "name": name,
        "kind": kind,
        "key": key,
        "bytes": path.stat().st_size,
        "sha256": sha256_file(str(path)),
        "state": "pending",
        "reason": None,
        "chunked": path.stat().st_size > 8 * 1024 * 1024,
    }


def _manifest(session, flight_id, vehicle_id, prefix, classification, state, window_start, window_end, time_source, derive, counts, journal_reason, derive_error, root):
    segments = []
    for seg in session.get("segments") or []:
        segments.append(
            {
                "n": seg.get("n"),
                "takeoff_utc": utc_iso(seg.get("takeoff_t")),
                "landed_utc": utc_iso(seg.get("landed_t")),
                "air_time_s": float(seg.get("air_time_s") or 0),
            }
        )
    evidence = {}
    for key, value in (session.get("evidence") or {}).items():
        evidence[key] = {
            "rule": value.get("rule"),
            "t_utc": utc_iso(value.get("t")),
            "values": value.get("values"),
        }
    artifacts = []
    for name, kind, _gz in PART_A_ARTIFACTS:
        reason = None
        if name.startswith("jetson/journal") and journal_reason:
            reason = journal_reason
        if derive_error and name in ("summary.json", "series.json.gz", "track.geojson.gz"):
            reason = "derive_failed"
        artifacts.append(_artifact(name, kind, root, prefix, vehicle_id, flight_id, reason))
    offset = None if not derive else derive.get("jetson_minus_fc_s")
    if derive and derive.get("saw_system_time") and time_source == "jetson_unsynced":
        time_source = "fc_system_time"
    now = utc_iso(session.get("closed_t") or window_end)
    return {
        "schema": "airvix.flight.manifest/1",
        "manifest_rev": int(session.get("manifest_rev") or 1),
        "flight_id": flight_id,
        "vehicle_id": vehicle_id,
        "classification": classification,
        "state": state,
        "end_reason": session.get("end_reason") or "unknown",
        "times": {
            "arm_utc": utc_iso(session.get("arm_t")),
            "takeoff_utc": utc_iso(session.get("takeoff_t")),
            "landed_utc": utc_iso(session.get("landed_t")),
            "disarm_utc": utc_iso(session.get("disarm_t")),
            "window_start_utc": utc_iso(window_start),
            "window_end_utc": utc_iso(window_end),
            "time_source": time_source,
            "jetson_minus_fc_s": offset,
        },
        "segments": segments,
        "detector": {
            "version": session.get("detector_version") or "1.0.0",
            "params": session.get("params") or {},
            "evidence": evidence,
        },
        "versions": {
            "companion_agent": env_str("VLC_AGENT_VERSION", "2.6.3") or "2.6.3",
            "flightlog": FLIGHTLOG_VERSION,
            "derive_rev": DERIVE_REV,
            "fc_firmware": None if not derive else derive.get("fc_firmware"),
            "fc_sysid": None if not derive else derive.get("fc_sysid"),
        },
        "artifacts": artifacts,
        "counts": counts,
        "upload": {"network_used": [], "cellular_bytes": 0},
        "created_utc": now,
        "updated_utc": now,
    }


def _index(manifest, session, derive):
    stats = {} if not derive else (derive.get("summary") or {}).get("stats") or {}
    modes = [] if not derive else derive.get("modes") or []
    return {
        "schema": "airvix.flight.index/1",
        "flight_id": manifest["flight_id"],
        "vehicle_id": manifest["vehicle_id"],
        "classification": manifest["classification"],
        "state": manifest["state"],
        "manifest_rev": manifest["manifest_rev"],
        "arm_utc": manifest["times"]["arm_utc"],
        "takeoff_utc": manifest["times"].get("takeoff_utc"),
        "landed_utc": manifest["times"].get("landed_utc"),
        "disarm_utc": manifest["times"].get("disarm_utc"),
        "time_source": manifest["times"]["time_source"],
        "duration_s": stats.get("duration_s"),
        "air_time_s": stats.get("air_time_s"),
        "max_rel_alt_m": stats.get("max_rel_alt_m"),
        "max_airspeed_mps": stats.get("max_airspeed_mps"),
        "max_groundspeed_mps": stats.get("max_groundspeed_mps"),
        "distance_m": stats.get("distance_m"),
        "modes": modes,
        "warnings": manifest["counts"]["warnings"],
        "errors": manifest["counts"]["errors"],
        "critical": manifest["counts"]["critical"],
        "end_reason": manifest["end_reason"],
        "has_fc_log": False,
        "artifacts_pending": sum(1 for art in manifest["artifacts"] if art.get("state") == "pending"),
        "updated_utc": manifest["updated_utc"],
    }


def _enqueue(uploader, flight_id, root, vehicle_id, prefix, journal_reason):
    mapping = {
        "summary.json": "summary",
        "events.jsonl.gz": "events",
        "series.json.gz": "series",
        "track.geojson.gz": "track",
        "telemetry.tlog.gz": "tlog",
        "jetson/system.jsonl.gz": "system",
    }
    for name, kind in mapping.items():
        path = root / name
        if path.is_file():
            uploader.enqueue_file(flight_id, name, str(path), object_key(prefix, vehicle_id, flight_id, name), kind, PRIORITY[kind])
    journal = root / "jetson" / "journal.jsonl.gz"
    if journal.is_file() and not journal_reason:
        uploader.enqueue_file(flight_id, "jetson/journal.jsonl.gz", str(journal), object_key(prefix, vehicle_id, flight_id, "jetson/journal.jsonl.gz"), "journal", PRIORITY["journal"])


def bump_manifest_state(root, state, artifact_states=None):
    path = Path(root) / "manifest.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["manifest_rev"] = int(doc.get("manifest_rev") or 1) + 1
    doc["state"] = state
    doc["updated_utc"] = utc_iso(__import__("time").time())
    if artifact_states:
        for art in doc.get("artifacts") or []:
            if art["name"] in artifact_states:
                art["state"] = artifact_states[art["name"]]
    atomic_write_json(path, doc)
    index_path = Path(root) / "index.json"
    if index_path.is_file():
        index = json.loads(index_path.read_text(encoding="utf-8"))
        index["state"] = state
        index["manifest_rev"] = doc["manifest_rev"]
        index["updated_utc"] = doc["updated_utc"]
        atomic_write_json(index_path, index)
    return doc
