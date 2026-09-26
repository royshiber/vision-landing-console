#!/bin/bash
# Install the OV9281 module and CAM0 overlay on a Jetson. Idempotent.
# Backs up extlinux.conf once, then adds a single OVERLAYS entry on the
# default label. Does not rewrite other labels. Prints that a reboot is required.
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
  echo "install.sh must run as root on the Jetson" >&2
  exit 1
fi

if [[ ! -f /etc/nv_tegra_release ]] && [[ "$(uname -r)" != *tegra* ]]; then
  echo "this host is not a Jetson" >&2
  exit 1
fi

if [[ ! -f "${ROOT}/${KO_NAME}" || ! -f "${ROOT}/${DTBO_NAME}" ]]; then
  "${ROOT}/build.sh"
fi

krel=$(uname -r)
moddir="/lib/modules/${krel}/updates/drivers/media/i2c"
install -d "${moddir}"
install -m 0644 "${ROOT}/${KO_NAME}" "${moddir}/${KO_NAME}"
depmod -a "${krel}"

install -m 0644 "${ROOT}/${DTBO_NAME}" "${DTBO_BOOT}"

if [[ ! -f "${EXTLINUX}" ]]; then
  echo "missing ${EXTLINUX}" >&2
  exit 1
fi

if [[ ! -f "${BACKUP}" ]]; then
  cp -a "${EXTLINUX}" "${BACKUP}"
fi

python3 "${ROOT}/extlinux_overlay.py" add --file "${EXTLINUX}" --dtbo "${DTBO_BOOT}"

if [[ -x /opt/nvidia/jetson-io/config-by-hardware.py ]]; then
  echo "jetson-io config-by-hardware is present."
  echo "It only lists NVIDIA's own cameras, so this install edits extlinux OVERLAYS directly."
  echo "The dtbo name Camera OV9281-A is also visible to jetson-io after reboot."
fi

echo "OV9281 CAM0 driver and overlay are installed."
echo "A reboot is required before the sensor can probe."
