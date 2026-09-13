#!/usr/bin/env python3
"""Observe-only annotated encoder stub for cellular vision egress.

Never invents frames. Radio never satisfies this path.
available:true only when a real stream URL/path exists and the modem is present.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

REASON_HE = {
    "modem_absent": "אין שידור. מודם סלולר לא מחובר. ראייה מסומנת מגיעה רק ממחשב משימה.",
    "stream_absent": "אין שידור. אין זרם מסומן ממחשב משימה. ראייה מסומנת לא עוברת ברדיו.",
    "cellular_connected": "ראייה מסומנת זמינה דרך סלולר ממחשב משימה.",
}


def _env_flag_on(name, env=None):
    src = env if env is not None else os.environ
    return str(src.get(name, "") or "").strip().lower() in {"present", "1", "true", "yes", "on"}


def _modem_status_file(env=None):
    src = env if env is not None else os.environ
    return str(src.get("AIRVIX_E3372_STATUS_FILE", "/run/airvix/e3372.status") or "").strip()


def _stream_status_file(env=None):
    src = env if env is not None else os.environ
    return str(src.get("AIRVIX_ANNOTATED_STREAM_FILE", "/run/airvix/annotated-stream.status") or "").strip()


def _is_real_stream_url(raw):
    url = str(raw or "").strip()
    if not url:
        return False
    lower = url.lower()
    if lower in {"none", "off", "stopped", "idle", "absent", "null", "false"}:
        return False
    if lower.startswith(("rtsp://", "rtsps://", "srt://", "udp://", "http://", "https://")):
        return True
    if url.startswith("/"):
        return Path(url).exists()
    return False


def _read_stream_url(env=None):
    src = env if env is not None else os.environ
    url = str(src.get("AIRVIX_ANNOTATED_STREAM_URL", "") or "").strip()
    if url:
        return url
    path = Path(_stream_status_file(src))
    if not path.is_file():
        return ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return ""
    if isinstance(data, dict):
        return str(data.get("url") or data.get("streamUrl") or data.get("annotated_stream_url") or "").strip()
    return ""


def _modem_present(env=None, modem=None):
    if isinstance(modem, dict) and modem.get("present") is True:
        return True
    src = env if env is not None else os.environ
    if _env_flag_on("AIRVIX_CELLULAR_MOCK", src) or _env_flag_on("CELLULAR_MODEM_MOCK", src):
        return True
    path = Path(_modem_status_file(src))
    if not path.is_file():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False
    return isinstance(data, dict) and data.get("present") is True


def annotated_encoder_status(env=None, modem=None, stream_url=None):
    """Honest annotated egress snapshot. Never invents frames."""
    src = env if env is not None else os.environ
    present = _modem_present(src, modem)
    url = str(stream_url or "").strip() or _read_stream_url(src)
    stream_ok = _is_real_stream_url(url)
    status_path = _modem_status_file(src)
    status_missing = not Path(status_path).is_file()
    if not present:
        reason = "modem_absent"
        available = False
        stream_present = False
        report_url = None
    elif not stream_ok:
        reason = "stream_absent"
        available = False
        stream_present = False
        report_url = None
    else:
        reason = "cellular_connected"
        available = True
        stream_present = True
        report_url = url
    return {
        "ok": True,
        "observe_only": True,
        "dry_run": True,
        "available": available,
        "path": "cellular",
        "neverRadio": True,
        "radioSatisfies": False,
        "streamPresent": stream_present,
        "streamUrl": report_url,
        "annotated_stream_url": report_url,
        "frames": False,
        "inventedFrames": False,
        "annotated_pipeline": "none",
        "annotated_fps": None,
        "modemPresent": present,
        "statusFile": status_path,
        "statusFileMissing": status_missing,
        "streamFile": _stream_status_file(src),
        "reason": reason,
        "reasonHe": REASON_HE[reason],
        "companionHttpCommandPath": False,
        "flightCommands": False,
        "noteHe": "ראייה מסומנת רק בסלולר. בלי זרם אין שידור.",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Observe-only annotated encoder status")
    parser.add_argument("--dry-run", action="store_true", default=True)
    parser.add_argument("--json", action="store_true", default=True)
    args = parser.parse_args(argv)
    body = annotated_encoder_status()
    body["cli"] = {"dry_run": args.dry_run}
    print(json.dumps(body, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
