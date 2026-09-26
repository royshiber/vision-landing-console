#!/usr/bin/env bash
# Copy-later companion. Default is dry-run. No SSH. No apply/restart.
# Agent files go to DEST (the running tree is /home/royshiber/vlc-companion).
# uplink-nm.sh is installed separately, root:root 0755, at the sudo path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${AIRVIX_COMPANION_DEST:-/home/royshiber/vlc-companion}"
NM_BIN="${VLC_UPLINK_NM_BIN:-/opt/airvix/jetson-companion/uplink-nm.sh}"
UDEV_SRC="$ROOT/ov9281/99-airvix-cameras.rules"
UDEV_DEST="${VLC_UDEV_RULES_DEST:-/etc/udev/rules.d/99-airvix-cameras.rules}"
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

FILES=(companion_agent.py version_rollback.py camera_ingest.py siyi_sdk.py siyi-net.sh annotated_encoder.py fc_telemetry.py uplink_status.py uplink_control.py uplink-nm.sh airvix-uplink.sudoers README.md flightlog_service.py flightlog_common.py flight_detector.py flight_events.py flight_logger.py flight_packager.py flight_derive.py tlog_writer.py mav_tap.py mav_frames.py log_uploader.py s3_sigv4.py system_events.py airvix-flightlog.service flightlog.env.example flightlog-storage.env.example cam0.json)
DIRS=(cam0 ov9281)

echo "{\"ok\":true,\"mode\":\"$MODE\",\"dest\":\"$DEST\",\"nm_bin\":\"$NM_BIN\",\"files\":[\"${FILES[*]}\"]}"

if [[ "$MODE" == "dry-run" ]]; then
  for f in "${FILES[@]}"; do
    if [[ ! -f "$ROOT/$f" ]]; then
      echo "{\"ok\":false,\"missing\":\"$f\"}" >&2
      exit 1
    fi
  done
  for d in "${DIRS[@]}"; do
    if [[ ! -d "$ROOT/$d" ]]; then
      echo "{\"ok\":false,\"missing\":\"$d\"}" >&2
      exit 1
    fi
  done
  if [[ ! -f "$UDEV_SRC" ]]; then
    echo "{\"ok\":false,\"missing\":\"ov9281/99-airvix-cameras.rules\"}" >&2
    exit 1
  fi
  echo "{\"ok\":true,\"applied\":false,\"flightlog_unit\":false,\"udev\":false,\"backup\":\"${DEST}.backups/YYYYMMDDTHHMMSSZ\",\"manifest\":\"version,deployed_at,git_sha,known_good\",\"note\":\"dry-run; nothing copied. A real apply copies the current tree to a timestamped backup beside it and writes airvix-deploy.json. The udev rule is installed only on --apply, and only when its text differs. uplink-nm.sh sudo target is the root-owned /opt path, not the home copy. --enable-flightlog does not install or start the unit in dry-run. cam0/ is the OV9281 package. ov9281/ holds the dual overlay source and the udev rule.\"}"
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

VER=$(sed -n 's/.*VLC_AGENT_VERSION", "\([^"]*\)".*/\1/p' "$ROOT/companion_agent.py" | head -n 1)
SHA=$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || true)
if [[ -z "$SHA" ]]; then
  SHA="unknown"
fi
WHEN=$(date -u +%Y-%m-%dT%H:%M:%SZ)
python3 "$ROOT/version_rollback.py" --snapshot-existing --dest "$DEST"
mkdir -p "$DEST"
install -d -o root -g root -m 0755 "$(dirname "$NM_BIN")"
for f in "${FILES[@]}"; do
  if [[ "$f" == "uplink-nm.sh" ]]; then
    continue
  fi
  install -m 755 "$ROOT/$f" "$DEST/$f"
done
for d in "${DIRS[@]}"; do
  rm -rf "$DEST/$d"
  cp -a "$ROOT/$d" "$DEST/$d"
done
install -o root -g root -m 0755 "$ROOT/uplink-nm.sh" "$NM_BIN"
FLIGHTLOG_UNIT=false
if [[ "$ENABLE_FLIGHTLOG" == "1" ]]; then
  install -m 0644 "$ROOT/airvix-flightlog.service" /etc/systemd/system/airvix-flightlog.service
  FLIGHTLOG_UNIT=true
fi
UDEV_WROTE=false
if [[ ! -f "$UDEV_DEST" ]] || ! cmp -s "$UDEV_SRC" "$UDEV_DEST"; then
  install -m 0644 "$UDEV_SRC" "$UDEV_DEST"
  UDEV_WROTE=true
  if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules || true
    udevadm trigger --subsystem-match=video4linux || true
  fi
fi
python3 "$ROOT/version_rollback.py" --write-live --dest "$DEST" --version "$VER" --git-sha "$SHA" --deployed-at "$WHEN"
echo "{\"ok\":true,\"applied\":true,\"dest\":\"$DEST\",\"nm_bin\":\"$NM_BIN\",\"nm_owner\":\"root:root\",\"nm_mode\":\"0755\",\"flightlog_unit\":$FLIGHTLOG_UNIT,\"flightlog_started\":false,\"backup_root\":\"${DEST}.backups\",\"manifest\":\"airvix-deploy.json\",\"version\":\"$VER\",\"git_sha\":\"$SHA\",\"deployed_at\":\"$WHEN\",\"known_good\":false,\"udev\":\"$UDEV_DEST\",\"udev_wrote\":$UDEV_WROTE}"
