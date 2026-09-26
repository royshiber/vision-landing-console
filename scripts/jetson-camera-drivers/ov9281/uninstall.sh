#!/bin/bash
# Full revert of install.sh: restore the extlinux snapshot taken at first
# install, delete the module and the dtbo, then depmod.
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

if [[ -f "${BACKUP}" && -f "${EXTLINUX}" ]]; then
  cp -a "${BACKUP}" "${EXTLINUX}"
  rm -f "${BACKUP}"
elif [[ -f "${EXTLINUX}" ]]; then
  python3 "${ROOT}/extlinux_overlay.py" remove --file "${EXTLINUX}" --dtbo "${DTBO_BOOT}"
fi

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

echo "OV9281 CAM0 driver and overlay removed."
echo "Reboot so the kernel drops the overlay."
