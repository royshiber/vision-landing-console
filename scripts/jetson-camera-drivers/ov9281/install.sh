#!/bin/bash
# Install the OV9281 module and CAM0 overlay on a Jetson. Idempotent.
# UEFI ignores OVERLAYS on a label that has no FDT line, so this does not
# edit the primary label in place. It asks jetson-io to create label
# JetsonIO (FDT + OVERLAYS, DEFAULT JetsonIO). If jetson-io is missing,
# it writes that same label itself. A reboot is required.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
DTBO_NAME="tegra234-p3767-camera-p3768-ov9281-A.dtbo"
KO_NAME="nv_ov9281.ko"
OVERLAY_NAME="Camera OV9281-A"
EXTLINUX="/boot/extlinux/extlinux.conf"
BACKUP="${EXTLINUX}.ov9281.bak"
DTBO_BOOT="/boot/${DTBO_NAME}"
JETSON_IO="/opt/nvidia/jetson-io/config-by-hardware.py"

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

if python3 "${ROOT}/extlinux_overlay.py" has-jetsonio --file "${EXTLINUX}" --dtbo "${DTBO_BOOT}"; then
  echo "JetsonIO already applies ${DTBO_BOOT}. extlinux left unchanged."
else
  # Drop the OVERLAYS line UEFI ignored on primary before writing a real label.
  python3 "${ROOT}/extlinux_overlay.py" remove --file "${EXTLINUX}" --dtbo "${DTBO_BOOT}"

  if [[ -f "${JETSON_IO}" ]]; then
    if [[ -n "${OV9281_CSI_HEADER:-}" ]]; then
      header="${OV9281_CSI_HEADER}"
    else
      list_out=$(cd /opt/nvidia/jetson-io && python3 ./config-by-hardware.py -l 2>&1) || {
        echo "config-by-hardware.py -l failed" >&2
        printf '%s\n' "${list_out}" >&2
        exit 1
      }
      header=$(printf '%s\n' "${list_out}" | python3 -c '
import re, sys
text = sys.stdin.read()
patterns = (
    r"Header\s+(\d+)\b.*22pin.*CSI",
    r"^\s*(\d+)\s*[.:].*22pin.*CSI",
)
found = ""
for line in text.splitlines():
    for pat in patterns:
        m = re.search(pat, line, re.I)
        if m:
            found = m.group(1)
            break
    if found:
        break
if not found:
    sys.exit(1)
print(found)
') || {
        echo "could not find the 22pin CSI header in config-by-hardware.py -l" >&2
        echo "Set OV9281_CSI_HEADER to the header number (2 on the Orin Nano devkit)." >&2
        printf '%s\n' "${list_out}" >&2
        exit 1
      }
    fi
    echo "Applying ${OVERLAY_NAME} with jetson-io header ${header}."
    (
      cd /opt/nvidia/jetson-io
      python3 ./config-by-hardware.py -n "${header}=${OVERLAY_NAME}"
    )
  else
    echo "jetson-io is not installed. Writing label JetsonIO directly."
    fdt="${OV9281_FDT:-}"
    if [[ -z "${fdt}" ]]; then
      prop="/proc/device-tree/nvidia,dtsfilename"
      if [[ -f "${prop}" ]]; then
        base=$(tr -d '\0' < "${prop}")
        base=$(basename "${base}")
        base="${base%.dts}"
        base="${base%.dtsi}"
        if [[ "${base}" != kernel_* ]]; then
          base="kernel_${base}"
        fi
        if [[ -f "/boot/dtb/${base}.dtb" ]]; then
          fdt="/boot/dtb/${base}.dtb"
        fi
      fi
    fi
    if [[ -z "${fdt}" && -f /boot/dtb/kernel_tegra234-p3768-0000+p3767-0005-nv-super.dtb ]]; then
      fdt="/boot/dtb/kernel_tegra234-p3768-0000+p3767-0005-nv-super.dtb"
    fi
    if [[ -z "${fdt}" || ! -f "${fdt}" ]]; then
      echo "could not find the base FDT. Set OV9281_FDT to the /boot/dtb/kernel_*.dtb UEFI should load." >&2
      exit 1
    fi
    echo "FDT ${fdt}"
    python3 "${ROOT}/extlinux_overlay.py" add-jetsonio \
      --file "${EXTLINUX}" --dtbo "${DTBO_BOOT}" --fdt "${fdt}"
  fi
fi

if ! python3 "${ROOT}/extlinux_overlay.py" has-jetsonio --file "${EXTLINUX}" --dtbo "${DTBO_BOOT}"; then
  echo "extlinux has no bootable JetsonIO label for ${DTBO_BOOT}." >&2
  echo "UEFI ignores OVERLAYS unless that label also has an FDT line and is DEFAULT." >&2
  if [[ -f "${EXTLINUX}" ]]; then
    awk '
      /^[Ll][Aa][Bb][Ee][Ll] / { show = ($2 == "JetsonIO" || $2 == "primary"); }
      show { print }
      /^[Ll][Aa][Bb][Ee][Ll] / && $2 != "JetsonIO" && $2 != "primary" { show = 0 }
    ' "${EXTLINUX}" >&2 || true
  fi
  exit 1
fi

echo "OV9281 CAM0 driver and overlay are installed."
echo "DEFAULT is JetsonIO. primary was left without this overlay."
echo "A reboot is required before the sensor can probe."
