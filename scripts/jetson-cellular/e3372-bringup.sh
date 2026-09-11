#!/bin/sh
# Bring up Huawei E3372 when the USB node appears.
# Missing stick is success (modem_absent). Does not send AT/APN, flight
# commands, or Companion apply/restart. Dry-run never invokes usb_modeswitch.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "${ROOT}/lib/e3372-common.sh"

DRY=0
MOCK=0

usage() {
  cat <<'EOF'
Usage: e3372-bringup.sh [--dry-run] [--mock]

When a Huawei E3372 USB id is present:
  - if still in mass-storage mode, run usb_modeswitch (skipped on --dry-run)
  - wait briefly for cdc_ether (usb0/enx*) or stick tty
  - write /run/airvix/e3372.status

When the stick is unplugged: write modem_absent and exit 0.

Does not configure APN, does not open a cellular MAVLink socket, and does
not start annotated video. Those wait for hardware + a later Human Gate.
EOF
}

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY=1 ;;
    --mock) MOCK=1 ;;
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

run_modeswitch() {
  _vid=$1
  _pid=$2
  _cfg="${ROOT}/usb-modeswitch/${_vid}:${_pid}"
  if [ "${DRY}" = "1" ]; then
    echo "dry-run: skip usb_modeswitch -v ${_vid} -p ${_pid}" >&2
    return 0
  fi
  if ! command -v usb_modeswitch >/dev/null 2>&1; then
    echo "usb_modeswitch not installed; udev/data package will switch later" >&2
    return 0
  fi
  if [ -f "${_cfg}" ]; then
    usb_modeswitch -v "0x${_vid}" -p "0x${_pid}" -c "${_cfg}" || true
  else
    usb_modeswitch -v "0x${_vid}" -p "0x${_pid}" -J || true
  fi
}

if e3372_mock_requested; then
  e3372_write_status true mock_present mock mock0 mock_present
  exit 0
fi

match=$(e3372_first_match || true)
if [ -n "${match}" ]; then
  id=$(printf '%s' "${match}" | awk '{ print $1 }')
  class=$(printf '%s' "${match}" | awk '{ print $2 }')
  vid=$(printf '%s' "${id}" | awk -F: '{ print $1 }')
  pid=$(printf '%s' "${id}" | awk -F: '{ print $2 }')
  if [ "${class}" = "initial" ]; then
    run_modeswitch "${vid}" "${pid}"
    if [ "${DRY}" != "1" ]; then
      i=0
      while [ "${i}" -lt 8 ]; do
        sleep 1
        next=$(e3372_first_match || true)
        nclass=$(printf '%s' "${next}" | awk '{ print $2 }')
        if [ "${nclass}" = "hilink" ] || [ "${nclass}" = "stick" ]; then
          break
        fi
        i=$((i + 1))
      done
    fi
  fi
fi

set -- $(e3372_probe)
present=$1
state=$2
transport=$3
iface=$4
reason=$5

if [ "${DRY}" = "1" ] && [ "${present}" = "true" ] && [ "${state}" != "mock_present" ]; then
  # Dry-run on a box that happens to have a matching USB id still must not
  # claim a live cellular MAVLink path.
  echo "dry-run: device id seen; not bringing iface up" >&2
fi

e3372_write_status "${present}" "${state}" "${transport}" "${iface}" "${reason}"
exit 0
