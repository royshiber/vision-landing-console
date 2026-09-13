#!/bin/sh
# Print the documented cellular MAVLink bind (console dual-link default).
# Optional --status reads the host E3372 status file when present.
# Dry-run / status: never opens a socket, never talks to an FC.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "${ROOT}/lib/e3372-common.sh"

WANT_STATUS=0

usage() {
  cat <<'EOF'
Usage: cellular-mavlink-endpoint.sh [--dry-run] [--status]

Print the cellular MAVLink second-path endpoint that matches console
DEFAULT_CELLULAR_ENDPOINT (udp 0.0.0.0:14560 unless overridden).

  --dry-run   print the documented bind. Does not bind.
  --status    also report the host E3372 status file. Missing file is
              modem_absent + statusFileMissing. Still does not bind.

Does not bind, relay, or send. Companion-HTTP is not this path.
EOF
}

for arg in "$@"; do
  case "${arg}" in
    --dry-run) ;;
    --status) WANT_STATUS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: ${arg}" >&2; usage; exit 2 ;;
  esac
done

status_file=$(e3372_status_file)
status_present=false
status_file_missing=true
modem_present=false
modem_reason="modem_absent"
modem_state="modem_absent"

if [ -f "${status_file}" ]; then
  status_present=true
  status_file_missing=false
  if grep -q '"present": true' "${status_file}" 2>/dev/null; then
    modem_present=true
    modem_reason="device_node"
    modem_state="present"
  fi
fi

printf '%s\n' \
  "{" \
  "  \"ok\": true," \
  "  \"dryRun\": true," \
  "  \"bound\": false," \
  "  \"type\": \"$(e3372_mavlink_type)\"," \
  "  \"host\": \"$(e3372_mavlink_host)\"," \
  "  \"port\": $(e3372_mavlink_port)," \
  "  \"role\": \"cellular\"," \
  "  \"alignsWithConsole\": true," \
  "  \"companionHttpCommandPath\": false," \
  "  \"flightCommands\": false," \
  "  \"statusRequested\": $([ "${WANT_STATUS}" = "1" ] && printf true || printf false)," \
  "  \"statusFile\": $(e3372_json_str "${status_file}")," \
  "  \"statusFilePresent\": ${status_present}," \
  "  \"statusFileMissing\": ${status_file_missing}," \
  "  \"modemPresent\": ${modem_present}," \
  "  \"modemState\": $(e3372_json_str "${modem_state}")," \
  "  \"reason\": $(e3372_json_str "${modem_reason}")," \
  "  \"noteHe\": \"יעד סלולר לפקודות ולטלמטריה. לא דרך HTTP.\"" \
  "}"
exit 0
