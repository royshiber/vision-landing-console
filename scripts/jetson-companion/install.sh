#!/usr/bin/env bash
# Copy-later companion. Default is dry-run. No SSH. No apply/restart.
# Agent files go to DEST (the running tree is /home/royshiber/vlc-companion).
# uplink-nm.sh is installed separately, root:root 0755, at the sudo path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${AIRVIX_COMPANION_DEST:-/home/royshiber/vlc-companion}"
NM_BIN="${VLC_UPLINK_NM_BIN:-/opt/airvix/jetson-companion/uplink-nm.sh}"
MODE="dry-run"
ENABLE_FLIGHTLOG=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --apply) MODE="apply"; shift ;;
    --dest) DEST="$2"; shift 2 ;;
    --force-lab) FORCE_LAB=1; shift ;;
    --enable-flightlog) ENABLE_FLIGHTLOG=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--dry-run|--apply] [--dest PATH] [--enable-flightlog]"
      echo "--enable-flightlog copies airvix-flightlog.service only during --apply. It never starts the unit."
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

FILES=(companion_agent.py camera_ingest.py siyi_sdk.py siyi-net.sh annotated_encoder.py fc_telemetry.py uplink_status.py uplink_control.py uplink-nm.sh airvix-uplink.sudoers README.md flightlog_service.py flightlog_common.py flight_detector.py flight_events.py flight_logger.py flight_packager.py flight_derive.py tlog_writer.py mav_tap.py log_uploader.py s3_sigv4.py system_events.py airvix-flightlog.service flightlog.env.example flightlog-storage.env.example)

echo "{\"ok\":true,\"mode\":\"$MODE\",\"dest\":\"$DEST\",\"nm_bin\":\"$NM_BIN\",\"files\":[\"${FILES[*]}\"]}"

if [[ "$MODE" == "dry-run" ]]; then
  for f in "${FILES[@]}"; do
    if [[ ! -f "$ROOT/$f" ]]; then
      echo "{\"ok\":false,\"missing\":\"$f\"}" >&2
      exit 1
    fi
  done
  echo '{"ok":true,"applied":false,"flightlog_unit":false,"note":"dry-run; nothing copied. uplink-nm.sh sudo target is the root-owned /opt path, not the home copy. --enable-flightlog does not install or start the unit in dry-run"}'
  exit 0
fi

if [[ -z "${FORCE_LAB:-}" && ! -e /etc/nv_tegra_release && ! -d /proc/device-tree ]]; then
  echo '{"ok":false,"error":"not_a_jetson","note":"use --dry-run or --force-lab"}' >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo '{"ok":false,"error":"need_root","note":"uplink-nm.sh must be installed root:root mode 0755"}' >&2
  exit 1
fi

mkdir -p "$DEST"
install -d -o root -g root -m 0755 "$(dirname "$NM_BIN")"
for f in "${FILES[@]}"; do
  if [[ "$f" == "uplink-nm.sh" ]]; then
    continue
  fi
  install -m 755 "$ROOT/$f" "$DEST/$f"
done
install -o root -g root -m 0755 "$ROOT/uplink-nm.sh" "$NM_BIN"
FLIGHTLOG_UNIT=false
if [[ "$ENABLE_FLIGHTLOG" == "1" ]]; then
  install -m 0644 "$ROOT/airvix-flightlog.service" /etc/systemd/system/airvix-flightlog.service
  FLIGHTLOG_UNIT=true
fi
echo "{\"ok\":true,\"applied\":true,\"dest\":\"$DEST\",\"nm_bin\":\"$NM_BIN\",\"nm_owner\":\"root:root\",\"nm_mode\":\"0755\",\"flightlog_unit\":$FLIGHTLOG_UNIT,\"flightlog_started\":false}"
