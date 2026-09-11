#!/bin/sh
# Install AIRVIX Huawei E3372 host files onto a Jetson (Orin / Xavier).
# Default is --dry-run. --apply copies udev + systemd stubs. No live modem,
# no SSH, no secrets, no flight commands, no Companion apply/restart.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "${ROOT}/lib/e3372-common.sh"

APPLY=0
FORCE_LAB=0
DRY=1

DEST_ROOT="${AIRVIX_E3372_DEST:-/opt/airvix/jetson-cellular}"
UDEV_DEST="${AIRVIX_E3372_UDEV_DEST:-/etc/udev/rules.d/99-huawei-e3372.rules}"
SYSTEMD_DEST="${AIRVIX_E3372_SYSTEMD_DEST:-/etc/systemd/system}"
ENV_DEST="${AIRVIX_E3372_ENV_DEST:-/etc/airvix/e3372.env}"

APT_PKGS="usb-modeswitch usb-modeswitch-data usbutils iproute2"

usage() {
  cat <<'EOF'
Usage: install.sh [--dry-run] [--apply] [--force-lab]

  --dry-run    print the plan and validate pack files (default)
  --apply      copy pack to /opt/airvix/jetson-cellular and enable units
               (refuses unless this host looks like a Jetson, unless --force-lab)
  --force-lab  allow --apply on a non-Jetson lab box (still localhost only)

Later copy from the console repo (placeholder host, never commit a real address):

  tar czf airvix-jetson-cellular.tgz -C scripts jetson-cellular
  scp airvix-jetson-cellular.tgz USER@JETSON-HOST:~/
  ssh USER@JETSON-HOST 'tar xzf airvix-jetson-cellular.tgz && sudo ./jetson-cellular/install.sh --dry-run'

Do not run --apply from a Cloud Agent VM against a production Jetson.
EOF
}

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY=1; APPLY=0 ;;
    --apply) APPLY=1; DRY=0 ;;
    --force-lab) FORCE_LAB=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: ${arg}" >&2; usage >&2; exit 2 ;;
  esac
done

required_files="
README.md
e3372-status.sh
e3372-bringup.sh
install.sh
pack.sh
lib/e3372-common.sh
udev/99-huawei-e3372.rules
systemd/airvix-e3372-status.service
systemd/airvix-e3372-bringup.service
usb-modeswitch/12d1:1f01
usb-modeswitch/12d1:14fe
conf/e3372.env.example
"

missing=0
for rel in ${required_files}; do
  if [ ! -e "${ROOT}/${rel}" ]; then
    echo "missing pack file: ${rel}" >&2
    missing=1
  fi
done
if [ "${missing}" -ne 0 ]; then
  exit 1
fi

echo "AIRVIX E3372 pack: ${ROOT}"
echo "Jetson host: $(e3372_is_jetson && echo yes || echo no)"
echo "apt packages: ${APT_PKGS}"
echo "dest root: ${DEST_ROOT}"
echo "udev: ${UDEV_DEST}"
echo "systemd: ${SYSTEMD_DEST}"
echo "env: ${ENV_DEST}"
echo "dual-link: cellular = MAVLink second path; annotated video = cellular only"
echo "console mock: CELLULAR_MODEM_MOCK=present / AIRVIX_CELLULAR_MOCK=present"
echo "absent USB: modem_absent (success)"

if [ "${DRY}" = "1" ]; then
  echo "dry-run: would copy pack, install udev + systemd stubs, enable status unit"
  echo "dry-run: would not apt-get, systemctl, or talk to a modem"
  AIRVIX_E3372_DRY_RUN=1
  export AIRVIX_E3372_DRY_RUN
  "${ROOT}/e3372-status.sh" --dry-run >/dev/null
  "${ROOT}/e3372-bringup.sh" --dry-run >/dev/null
  echo "dry-run: ok"
  exit 0
fi

if [ "${APPLY}" = "1" ]; then
  if ! e3372_is_jetson && [ "${FORCE_LAB}" != "1" ]; then
    echo "refusing --apply on a non-Jetson host (use --dry-run, or --force-lab in a lab)" >&2
    exit 1
  fi
  if [ "$(id -u)" -ne 0 ]; then
    echo "--apply needs root to write /opt /etc" >&2
    exit 1
  fi
  mkdir -p "${DEST_ROOT}" "$(dirname -- "${UDEV_DEST}")" "${SYSTEMD_DEST}" "$(dirname -- "${ENV_DEST}")"
  # Copy pack files only — no .env secrets.
  cp -a "${ROOT}/README.md" "${DEST_ROOT}/"
  cp -a "${ROOT}/e3372-status.sh" "${ROOT}/e3372-bringup.sh" "${ROOT}/install.sh" "${ROOT}/pack.sh" "${DEST_ROOT}/"
  cp -a "${ROOT}/lib" "${ROOT}/udev" "${ROOT}/systemd" "${ROOT}/usb-modeswitch" "${ROOT}/conf" "${DEST_ROOT}/"
  chmod 0755 "${DEST_ROOT}/e3372-status.sh" "${DEST_ROOT}/e3372-bringup.sh" "${DEST_ROOT}/install.sh" "${DEST_ROOT}/pack.sh"
  cp "${ROOT}/udev/99-huawei-e3372.rules" "${UDEV_DEST}"
  cp "${ROOT}/systemd/airvix-e3372-status.service" "${SYSTEMD_DEST}/"
  cp "${ROOT}/systemd/airvix-e3372-bringup.service" "${SYSTEMD_DEST}/"
  if [ ! -f "${ENV_DEST}" ]; then
    cp "${ROOT}/conf/e3372.env.example" "${ENV_DEST}"
  fi
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y ${APT_PKGS} || true
  fi
  if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules || true
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || true
    systemctl enable airvix-e3372-status.service || true
    # Bring-up is udev-triggered. Enable so a boot with the stick already in
    # still records status. Missing stick is success.
    systemctl enable airvix-e3372-bringup.service || true
    systemctl start airvix-e3372-status.service || true
  fi
  echo "applied E3372 host stubs. Plug the stick later; console stays modem_absent until then."
  exit 0
fi

echo "nothing to do" >&2
exit 2
