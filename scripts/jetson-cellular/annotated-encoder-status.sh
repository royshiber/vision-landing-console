#!/bin/sh
# Observe-only annotated vision egress status over cellular.
# Never invents frames. Radio never satisfies this path.
# Default: modem_absent or stream_absent. available only with a real stream URL/path.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "${ROOT}/lib/e3372-common.sh"

usage() {
  cat <<'EOF'
Usage: annotated-encoder-status.sh [--dry-run] [--status]

Observe-only annotated encoder honesty for cellular vision.

  --dry-run   default. Print status. Does not start an encoder.
  --status    same report. Still does not encode or invent frames.

available:true only when the modem is present (or mock) AND a real
stream URL/path exists (AIRVIX_ANNOTATED_STREAM_URL or the stream
status file). Radio never satisfies video.
EOF
}

for arg in "$@"; do
  case "${arg}" in
    --dry-run|--status) ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: ${arg}" >&2; usage; exit 2 ;;
  esac
done

status_file=$(e3372_status_file)
stream_file=$(e3372_annotated_stream_file)
status_file_missing=true
modem_present=false
modem_reason="modem_absent"
stream_url=""
stream_present=false
available=false
reason="modem_absent"
reason_he="אין שידור. מודם סלולר לא מחובר. ראייה מסומנת מגיעה רק ממחשב משימה."

if [ -f "${status_file}" ]; then
  status_file_missing=false
  if grep -q '"present": true' "${status_file}" 2>/dev/null; then
    modem_present=true
    modem_reason="device_node"
  fi
fi
if e3372_mock_requested; then
  modem_present=true
  modem_reason="mock_present"
fi

stream_url=$(e3372_annotated_stream_url || true)
if [ -n "${stream_url}" ] && e3372_is_real_stream_url "${stream_url}"; then
  stream_present=true
fi

if [ "${modem_present}" != "true" ]; then
  reason="modem_absent"
  reason_he="אין שידור. מודם סלולר לא מחובר. ראייה מסומנת מגיעה רק ממחשב משימה."
  available=false
  stream_present=false
elif [ "${stream_present}" != "true" ]; then
  reason="stream_absent"
  reason_he="אין שידור. אין זרם מסומן ממחשב משימה. ראייה מסומנת לא עוברת ברדיו."
  available=false
else
  reason="cellular_connected"
  reason_he="ראייה מסומנת זמינה דרך סלולר ממחשב משימה."
  available=true
fi

printf '%s\n' \
  "{" \
  "  \"ok\": true," \
  "  \"dryRun\": true," \
  "  \"observeOnly\": true," \
  "  \"available\": ${available}," \
  "  \"path\": \"cellular\"," \
  "  \"neverRadio\": true," \
  "  \"radioSatisfies\": false," \
  "  \"streamPresent\": ${stream_present}," \
  "  \"streamUrl\": $(e3372_json_str "${stream_url}")," \
  "  \"frames\": false," \
  "  \"inventedFrames\": false," \
  "  \"annotated_pipeline\": \"none\"," \
  "  \"annotated_fps\": null," \
  "  \"modemPresent\": ${modem_present}," \
  "  \"modemReason\": $(e3372_json_str "${modem_reason}")," \
  "  \"statusFile\": $(e3372_json_str "${status_file}")," \
  "  \"statusFileMissing\": ${status_file_missing}," \
  "  \"streamFile\": $(e3372_json_str "${stream_file}")," \
  "  \"reason\": $(e3372_json_str "${reason}")," \
  "  \"reasonHe\": $(e3372_json_str "${reason_he}")," \
  "  \"companionHttpCommandPath\": false," \
  "  \"flightCommands\": false," \
  "  \"noteHe\": \"ראייה מסומנת רק בסלולר. בלי זרם אין שידור.\"" \
  "}"
exit 0
