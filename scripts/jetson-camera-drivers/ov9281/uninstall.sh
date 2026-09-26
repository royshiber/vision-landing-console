#!/bin/bash
# Remove the OV9281 module and the JetsonIO extlinux label.
# Sets DEFAULT back to primary and deletes label JetsonIO. Also strips
# this dtbo from any OVERLAYS line, including the one UEFI ignored on
# primary. Does not restore extlinux.conf.ov9281.bak over the live file:
# that snapshot can predate later jetson-io edits on a board that already
# has the JetsonIO label.
# Safe to run again after a successful uninstall.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
DTBO_NAME="tegra234-p3767-camera-p3768-ov9281-A.dtbo"
KO_NAME="nv_ov9281.ko"
EXTLINUX="/boot/extlinux/extlinux.conf"
BACKUP="${EXTLINUX}.ov9281.bak"
DTBO_BOOT="/boot/${DTBO_NAME}"

if [[ "${1:-}" == "--self-test" ]]; then
  python3 "${ROOT}/extlinux_overlay.py" --self-test
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "uninstall.sh must run as root on the Jetson" >&2
  exit 1
fi

if [[ ! -f /etc/nv_tegra_release ]] && [[ "$(uname -r)" != *tegra* ]]; then
  echo "this host is not a Jetson" >&2
  exit 1
fi

if [[ -f "${EXTLINUX}" ]]; then
  python3 "${ROOT}/extlinux_overlay.py" remove-jetsonio --file "${EXTLINUX}" --dtbo "${DTBO_BOOT}"
  if python3 "${ROOT}/extlinux_overlay.py" has-jetsonio --file "${EXTLINUX}" --dtbo "${DTBO_BOOT}"; then
    echo "JetsonIO still applies ${DTBO_BOOT}" >&2
    exit 1
  fi
  if grep -q 'LABEL JetsonIO' "${EXTLINUX}"; then
    echo "LABEL JetsonIO is still in ${EXTLINUX}" >&2
    exit 1
  fi
fi

# The snapshot is the pre-overlay file from the first install. The live
# file is now primary again. Drop the snapshot so a later install records
# the current primary instead of restoring an older copy.
rm -f "${BACKUP}"

krel=$(uname -r)
moddir="/lib/modules/${krel}/updates/drivers/media/i2c"
rm -f "${moddir}/${KO_NAME}" "${DTBO_BOOT}"
if [[ -d "/lib/modules/${krel}" ]]; then
  depmod -a "${krel}"
fi

if lsmod | grep -q '^nv_ov9281 '; then
  if ! modprobe -r nv_ov9281; then
    echo "nv_ov9281 is still loaded. Reboot to finish the uninstall." >&2
  fi
fi

echo "OV9281 CAM0 driver removed. DEFAULT is primary. Label JetsonIO is gone."
echo "Reboot so UEFI stops applying the overlay."
