#!/bin/sh
# Exit 0 when bring-up should run. Exit 1 skips the oneshot (systemd ExecCondition).
# Match /dev/cdc-wdm0 OR an enx* netdev whose USB parent is Huawei 12d1.
# usb0 is the Jetson USB gadget and must not satisfy this check.
# Idempotent: only looks at nodes. Does not configure the modem.
set -eu

SYS_ROOT="${AIRVIX_E3372_SYS_ROOT:-}"
if [ -n "${SYS_ROOT}" ]; then
  DEV="${SYS_ROOT}/dev"
  NET="${SYS_ROOT}/sys/class/net"
else
  DEV=/dev
  NET=/sys/class/net
fi

if [ -e "${DEV}/cdc-wdm0" ]; then
  exit 0
fi

for _n in "${NET}"/enx*; do
  [ -d "${_n}" ] || continue
  _base=$(basename "${_n}")
  case "${_base}" in
    enx*) ;;
    *) continue ;;
  esac
  _uevent="${_n}/device/uevent"
  if [ -r "${_uevent}" ] && grep -q 'PRODUCT=12d1/' "${_uevent}"; then
    exit 0
  fi
done

exit 1
