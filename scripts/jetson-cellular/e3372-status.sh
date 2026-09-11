#!/bin/sh
# Report Huawei E3372 presence for the AIRVIX cellular MAVLink path.
# Default without USB: modem_absent. Mock via AIRVIX_CELLULAR_MOCK=present
# (same meaning as console CELLULAR_MODEM_MOCK=present). Never talks to an FC.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "${ROOT}/lib/e3372-common.sh"

WRITE=0
MOCK=0
DRY=0

usage() {
  cat <<'EOF'
Usage: e3372-status.sh [--write] [--mock] [--dry-run]

Print a JSON snapshot of the Huawei E3372 stick.

  --write     also write AIRVIX_E3372_STATUS_FILE (default /run/airvix/e3372.status)
  --mock      force mock_present (console dual-link stays software-only)
  --dry-run   do not require /run; print only

No live modem is required. Exit 0 on modem_absent.
EOF
}

for arg in "$@"; do
  case "${arg}" in
    --write) WRITE=1 ;;
    --mock) MOCK=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: ${arg}" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "${MOCK}" = "1" ]; then
  AIRVIX_CELLULAR_MOCK=present
  export AIRVIX_CELLULAR_MOCK
fi

if [ "${DRY}" = "1" ]; then
  AIRVIX_E3372_DRY_RUN=1
  export AIRVIX_E3372_DRY_RUN
fi

set -- $(e3372_probe)
present=$1
state=$2
transport=$3
iface=$4
reason=$5

if [ "${WRITE}" = "1" ]; then
  e3372_write_status "${present}" "${state}" "${transport}" "${iface}" "${reason}"
else
  AIRVIX_E3372_DRY_RUN=1
  AIRVIX_E3372_DRY_STATUS_FILE="${AIRVIX_E3372_DRY_STATUS_FILE:-/tmp/airvix-e3372-status-dry.json}"
  export AIRVIX_E3372_DRY_RUN AIRVIX_E3372_DRY_STATUS_FILE
  e3372_write_status "${present}" "${state}" "${transport}" "${iface}" "${reason}"
fi

exit 0
