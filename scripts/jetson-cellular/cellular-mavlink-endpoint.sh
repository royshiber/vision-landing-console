#!/bin/sh
# Cellular MAVLink second-path endpoint (console dual-link default).
# --dry-run / --status: never bind. --bind: only with a present modem or CI mock.
# Does not send flight commands. Companion-HTTP is not this path.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "${ROOT}/lib/e3372-common.sh"

WANT_STATUS=0
WANT_BIND=0
WANT_ONCE=0

usage() {
  cat <<'EOF'
Usage: cellular-mavlink-endpoint.sh [--dry-run] [--status] [--bind] [--once]

Print the cellular MAVLink second-path endpoint that matches console
DEFAULT_CELLULAR_ENDPOINT (udp 0.0.0.0:14560 unless overridden).

  --dry-run   print the documented bind. Does not bind. Default.
  --status    also report the host E3372 status file. Missing file is
              modem_absent + statusFileMissing. Still does not bind.
  --bind      bind udp 0.0.0.0:14560 only when the status file says
              present, or AIRVIX_CELLULAR_MOCK / CELLULAR_MODEM_MOCK /
              AIRVIX_CELLULAR_BIND_FORCE is set. Refuse when modem_absent.
  --once      with --bind: bind, report, unbind, exit. For CI / probe.

Does not auto-start from install. Cloud Agent VMs stay --dry-run.
Does not relay or send. Companion-HTTP is not this path.
EOF
}

for arg in "$@"; do
  case "${arg}" in
    --dry-run) ;;
    --status) WANT_STATUS=1 ;;
    --bind) WANT_BIND=1 ;;
    --once) WANT_ONCE=1 ;;
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
bind_allowed=false
bind_force=false
mock_requested=false

if e3372_mock_requested; then
  mock_requested=true
fi
if e3372_bind_force_requested; then
  bind_force=true
fi

if [ -f "${status_file}" ]; then
  status_present=true
  status_file_missing=false
  if grep -q '"present": true' "${status_file}" 2>/dev/null; then
    modem_present=true
    modem_reason="device_node"
    modem_state="present"
  fi
fi

if [ "${mock_requested}" = "true" ]; then
  modem_present=true
  modem_reason="mock_present"
  modem_state="mock_present"
fi

if e3372_bind_allowed; then
  bind_allowed=true
fi

if [ "${WANT_BIND}" = "1" ] && [ "${bind_allowed}" != "true" ]; then
  printf '%s\n' \
    "{" \
    "  \"ok\": false," \
    "  \"dryRun\": false," \
    "  \"bound\": false," \
    "  \"bindRequested\": true," \
    "  \"bindAllowed\": false," \
    "  \"once\": $([ "${WANT_ONCE}" = "1" ] && printf true || printf false)," \
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
    "  \"modemPresent\": false," \
    "  \"modemState\": $(e3372_json_str "${modem_state}")," \
    "  \"reason\": \"modem_absent\"," \
    "  \"noteHe\": \"מודם לא מחובר. אין האזנה לשקע סלולר.\"" \
    "}"
  exit 1
fi

bound=false
bind_error=""
if [ "${WANT_BIND}" = "1" ]; then
  if [ "${WANT_ONCE}" = "1" ]; then
    if e3372_bind_udp_once; then
      bound=true
    else
      bind_error="bind_failed"
    fi
  else
    printf '%s\n' \
      "{" \
      "  \"ok\": true," \
      "  \"dryRun\": false," \
      "  \"bound\": true," \
      "  \"bindRequested\": true," \
      "  \"bindAllowed\": true," \
      "  \"once\": false," \
      "  \"holding\": true," \
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
      "  \"noteHe\": \"שקע סלולר מאזין. לא פקודות דרך HTTP.\"" \
      "}"
    e3372_bind_udp_hold
    exit $?
  fi
  if [ "${bound}" != "true" ]; then
    printf '%s\n' \
      "{" \
      "  \"ok\": false," \
      "  \"dryRun\": false," \
      "  \"bound\": false," \
      "  \"bindRequested\": true," \
      "  \"bindAllowed\": true," \
      "  \"once\": true," \
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
      "  \"reason\": $(e3372_json_str "${bind_error:-bind_failed}")," \
      "  \"noteHe\": \"האזנה לשקע סלולר נכשלה.\"" \
      "}"
    exit 4
  fi
fi

printf '%s\n' \
  "{" \
  "  \"ok\": true," \
  "  \"dryRun\": $([ "${WANT_BIND}" = "1" ] && printf false || printf true)," \
  "  \"bound\": ${bound}," \
  "  \"bindRequested\": $([ "${WANT_BIND}" = "1" ] && printf true || printf false)," \
  "  \"bindAllowed\": ${bind_allowed}," \
  "  \"bindForce\": ${bind_force}," \
  "  \"once\": $([ "${WANT_ONCE}" = "1" ] && printf true || printf false)," \
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
  "  \"noteHe\": \"$([ "${bound}" = "true" ] && printf '%s' 'שקע סלולר נבדק. לא פקודות דרך HTTP.' || printf '%s' 'יעד סלולר לפקודות ולטלמטריה. לא דרך HTTP.')\"" \
  "}"
exit 0
