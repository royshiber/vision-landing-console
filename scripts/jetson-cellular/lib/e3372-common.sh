#!/bin/sh
# Shared Huawei E3372 helpers for Jetson (Orin / Xavier) host USB.
# Software-only. No live modem required. No flight commands. No secrets.

# shellcheck disable=SC2034

AIRVIX_E3372_MODEL="Huawei E3372"
AIRVIX_E3372_VID="12d1"

# Mass-storage / CD-ROM appearance before usb_modeswitch.
AIRVIX_E3372_PIDS_INITIAL="1f01 14fe 1446"

# HiLink CDC ethernet after switch (most E3372h retail sticks).
AIRVIX_E3372_PIDS_HILINK="14dc 14db 155e"

# Classic stick / option tty after switch (E3372s and some firmware).
AIRVIX_E3372_PIDS_STICK="1506 1001"

AIRVIX_E3372_ALL_PIDS="${AIRVIX_E3372_PIDS_INITIAL} ${AIRVIX_E3372_PIDS_HILINK} ${AIRVIX_E3372_PIDS_STICK}"

e3372_pack_root() {
  if [ -n "${AIRVIX_E3372_ROOT:-}" ] && [ -d "${AIRVIX_E3372_ROOT}" ]; then
    printf '%s\n' "${AIRVIX_E3372_ROOT}"
    return 0
  fi
  # When sourced, $0 is the caller. Prefer this file's directory.
  _here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  if [ -d "${_here}/udev" ]; then
    printf '%s\n' "${_here}"
    return 0
  fi
  if [ -d "${_here}/../udev" ]; then
    CDPATH= cd -- "${_here}/.." && pwd
    return 0
  fi
  printf '%s\n' "${_here}"
}

e3372_status_file() {
  printf '%s\n' "${AIRVIX_E3372_STATUS_FILE:-/run/airvix/e3372.status}"
}

e3372_env_flag() {
  # Usage: e3372_env_flag CELLULAR_MODEM_MOCK
  _name=$1
  eval "_val=\${${_name}:-}"
  _val=$(printf '%s' "${_val}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  case "${_val}" in
    present|1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

e3372_mock_requested() {
  if e3372_env_flag AIRVIX_CELLULAR_MOCK; then
    return 0
  fi
  if e3372_env_flag CELLULAR_MODEM_MOCK; then
    return 0
  fi
  return 1
}

e3372_is_jetson() {
  if [ -f /etc/nv_tegra_release ]; then
    return 0
  fi
  if [ -r /proc/device-tree/model ]; then
    if tr -d '\0' < /proc/device-tree/model | grep -qiE 'tegra|jetson|orin|xavier'; then
      return 0
    fi
  fi
  return 1
}

e3372_pid_class() {
  _pid=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "${_pid}" in
    1f01|14fe|1446) printf '%s\n' "initial" ;;
    14dc|14db|155e) printf '%s\n' "hilink" ;;
    1506|1001) printf '%s\n' "stick" ;;
    *) printf '%s\n' "unknown" ;;
  esac
}

e3372_scan_usb() {
  # Prints "vid:pid class" lines for matching Huawei nodes. No lsusb required.
  for _d in /sys/bus/usb/devices/*; do
    [ -f "${_d}/idVendor" ] || continue
    _vid=$(tr -d '[:space:]' < "${_d}/idVendor" 2>/dev/null || true)
    _pid=$(tr -d '[:space:]' < "${_d}/idProduct" 2>/dev/null || true)
    _vid=$(printf '%s' "${_vid}" | tr '[:upper:]' '[:lower:]')
    _pid=$(printf '%s' "${_pid}" | tr '[:upper:]' '[:lower:]')
    [ "${_vid}" = "${AIRVIX_E3372_VID}" ] || continue
    case " ${AIRVIX_E3372_ALL_PIDS} " in
      *" ${_pid} "*)
        printf '%s:%s %s\n' "${_vid}" "${_pid}" "$(e3372_pid_class "${_pid}")"
        ;;
    esac
  done
  return 0
}

e3372_first_match() {
  e3372_scan_usb | awk 'NR==1 { print $1, $2 }'
}

e3372_hilink_iface() {
  # Only claim a netdev whose USB parent is Huawei (12d1). Do not treat a
  # generic usb0 / enx* name as an E3372 — that would fake a live modem.
  for _n in /sys/class/net/*; do
    [ -d "${_n}" ] || continue
    _name=$(basename "${_n}")
    case "${_name}" in
      lo) continue ;;
    esac
    _uevent="${_n}/device/uevent"
    if [ -r "${_uevent}" ] && grep -q 'PRODUCT=12d1/' "${_uevent}" 2>/dev/null; then
      printf '%s\n' "${_name}"
      return 0
    fi
  done
  return 1
}

e3372_stick_node() {
  for _p in /dev/cdc-wdm0 /dev/ttyUSB0 /dev/ttyUSB1 /dev/ttyUSB2; do
    if [ -e "${_p}" ]; then
      printf '%s\n' "${_p}"
      return 0
    fi
  done
  return 1
}

e3372_json_str() {
  if [ -z "$1" ] || [ "$1" = "null" ]; then
    printf 'null'
  else
    printf '"%s"' "$(printf '%s' "$1" | tr -d '"\\')"
  fi
}

e3372_write_status() {
  # Args: present(true|false) state transport iface reason
  _present=$1
  _state=$2
  _transport=$3
  _iface=$4
  _reason=$5
  _file=$(e3372_status_file)
  _dir=$(dirname -- "${_file}")
  if [ "${AIRVIX_E3372_DRY_RUN:-0}" = "1" ]; then
    _file="${AIRVIX_E3372_DRY_STATUS_FILE:-${_file}}"
    _dir=$(dirname -- "${_file}")
  fi
  if [ ! -d "${_dir}" ]; then
    mkdir -p "${_dir}" 2>/dev/null || true
  fi
  _body=$(printf '%s\n' \
    "{" \
    "  \"model\": \"${AIRVIX_E3372_MODEL}\"," \
    "  \"present\": ${_present}," \
    "  \"state\": $(e3372_json_str "${_state}")," \
    "  \"transport\": $(e3372_json_str "${_transport}")," \
    "  \"iface\": $(e3372_json_str "${_iface}")," \
    "  \"reason\": $(e3372_json_str "${_reason}")," \
    "  \"role\": \"cellular\"," \
    "  \"videoPath\": \"cellular\"," \
    "  \"mavlinkSecondPath\": true," \
    "  \"companionHttpCommandPath\": false," \
    "  \"flightCommands\": false," \
    "  \"neverRadioVideo\": true" \
    "}")
  if [ -d "${_dir}" ] && [ -w "${_dir}" ]; then
    printf '%s\n' "${_body}" > "${_file}" || true
  fi
  printf '%s\n' "${_body}"
}

e3372_probe() {
  # Prints: present state transport iface reason
  if e3372_mock_requested; then
    printf '%s\n' "true mock_present mock mock0 mock_present"
    return 0
  fi
  _match=$(e3372_first_match)
  if [ -n "${_match}" ]; then
    _id=$(printf '%s' "${_match}" | awk '{ print $1 }')
    _class=$(printf '%s' "${_match}" | awk '{ print $2 }')
    _iface=""
    _transport="usb"
    case "${_class}" in
      hilink)
        _iface=$(e3372_hilink_iface || true)
        _transport="cdc_ether"
        ;;
      stick)
        _iface=$(e3372_stick_node || true)
        _transport="option"
        ;;
      initial)
        _iface="${_id}"
        _transport="mass_storage"
        ;;
    esac
    [ -n "${_iface}" ] || _iface="${_id}"
    printf '%s\n' "true present ${_transport} ${_iface} device_node"
    return 0
  fi
  _iface=$(e3372_hilink_iface || true)
  if [ -n "${_iface}" ]; then
    printf '%s\n' "true present cdc_ether ${_iface} netdev"
    return 0
  fi
  _node=$(e3372_stick_node || true)
  if [ -n "${_node}" ]; then
    # Generic ttyUSB without a Huawei USB id is not enough to claim E3372.
    printf '%s\n' "false modem_absent null null unplugged"
    return 0
  fi
  printf '%s\n' "false modem_absent null null unplugged"
}
