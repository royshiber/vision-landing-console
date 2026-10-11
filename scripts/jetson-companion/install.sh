#!/usr/bin/env bash
# Copy-later companion. Default is dry-run. No SSH.
# --apply backs up the live tree, copies, restarts airvix-companion,
# checks /api/health with X-Companion-Token, and restores the backup
# if that service crashes or restarts within 30 seconds.
# -E so the ERR trap still runs when a function such as restart_service fails.
# A first install with nothing to restore reports rolled_back false.
# Agent files go to DEST (the running tree is /home/royshiber/vlc-companion).
# uplink-nm.sh is installed separately, root:root 0755, at the sudo path.
set -Eeuo pipefail

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

FILES=(companion_agent.py mavlink_route.py version_rollback.py camera_ingest.py vision_tracks.py siyi_sdk.py siyi-net.sh measure_camera_latency.py annotated_encoder.py fc_telemetry.py uplink_status.py uplink_control.py uplink-nm.sh airvix-uplink.sudoers README.md flightlog_service.py flightlog_common.py flight_detector.py flight_events.py flight_logger.py flight_packager.py flight_derive.py tlog_writer.py mav_tap.py mav_frames.py log_uploader.py s3_sigv4.py system_events.py airvix-flightlog.service flightlog.env.example flightlog-storage.env.example cam0.json provision_vision_model.sh requirements-vision.txt)
DIRS=(cam0 ov9281)

SERVICE_NAME="${AIRVIX_COMPANION_SERVICE:-airvix-companion}"
WATCH_S="${VLC_DEPLOY_WATCH_S:-30}"
deployed=0
backup_dir=""

backup_owner_name() {
  if id royshiber >/dev/null 2>&1; then
    printf '%s\n' royshiber
  else
    id -un
  fi
}

systemctl_cmd() {
  if [[ -n "${AIRVIX_DEPLOY_SYSTEMCTL:-}" ]]; then
    "${AIRVIX_DEPLOY_SYSTEMCTL}" "$@"
    return
  fi
  if systemctl "$@" 2>/dev/null; then
    return 0
  fi
  systemctl --user "$@"
}

restart_service() {
  systemctl_cmd restart "$SERVICE_NAME"
}

service_prop() {
  local prop="$1"
  systemctl_cmd show -p "$prop" --value "$SERVICE_NAME"
}

health_once() {
  local url="http://127.0.0.1:${VLC_HTTP_PORT:-8081}/api/health"
  local token="${VLC_COMPANION_TOKEN:-}"
  if [[ -n "${AIRVIX_DEPLOY_CURL:-}" ]]; then
    "${AIRVIX_DEPLOY_CURL}" -fsS --max-time 2 -H "X-Companion-Token: ${token}" "$url"
    return
  fi
  curl -fsS --max-time 2 -H "X-Companion-Token: ${token}" "$url" >/dev/null
}

restore_tree() {
  local backup="$1"
  local hold="${DEST}.deploy-hold.$$"
  rm -rf "$hold"
  mv "$DEST" "$hold"
  if ! mv "$backup" "$DEST"; then
    mv "$hold" "$DEST" || true
    return 1
  fi
  mv "$hold" "$backup"
  restart_service || true
}

fail_deploy() {
  local error="$1"
  local status="$2"
  trap - ERR
  local rolled=false
  if [[ "$deployed" == "1" && -n "$backup_dir" && -d "$backup_dir" ]]; then
    restore_tree "$backup_dir" || true
    rolled=true
    backup_dir=""
  fi
  echo "{\"ok\":false,\"error\":\"${error}\",\"rolled_back\":${rolled}}" >&2
  exit "$status"
}

on_deploy_err() {
  fail_deploy "deploy_failed" "$?"
}

verify_backup() {
  local backup="$1"
  local live="$2"
  local owner root
  [[ -d "$backup" ]]
  [[ -f "$backup/companion_agent.py" ]]
  [[ -f "$live/companion_agent.py" ]]
  cmp -s "$live/companion_agent.py" "$backup/companion_agent.py"
  owner="$(backup_owner_name)"
  root="$(dirname "$backup")"
  if [[ "$(id -u)" -eq 0 ]]; then
    chown -R "${owner}:${owner}" "$root"
    su -s /bin/sh "$owner" -c "test -w $(printf '%q' "$backup") && test -w $(printf '%q' "$root")"
  else
    [[ -w "$backup" && -w "$root" ]]
  fi
}

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

LAB_UNPRIV=0
if [[ "$(id -u)" -ne 0 ]]; then
  if [[ -n "${FORCE_LAB:-}" ]]; then
    LAB_UNPRIV=1
  else
    echo '{"ok":false,"error":"need_root","note":"uplink-nm.sh must be installed root:root mode 0755"}' >&2
    exit 1
  fi
fi

VER=$(sed -n 's/.*VLC_AGENT_VERSION", "\([^"]*\)".*/\1/p' "$ROOT/companion_agent.py" | head -n 1)
SHA=$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || true)
if [[ -z "$SHA" ]]; then
  SHA="unknown"
fi
WHEN=$(date -u +%Y-%m-%dT%H:%M:%SZ)
trap on_deploy_err ERR

if [[ -d "$DEST" ]] && [[ -n "$(ls -A "$DEST" 2>/dev/null || true)" ]]; then
  snap_json=$(python3 "$ROOT/version_rollback.py" --snapshot-existing --dest "$DEST")
  backup_id=$(python3 -c 'import json,sys; row=(json.loads(sys.argv[1]).get("backup") or {}); print(row.get("id") or "")' "$snap_json")
  [[ -n "$backup_id" ]]
  backup_dir="${DEST}.backups/${backup_id}"
  verify_backup "$backup_dir" "$DEST"
fi

mkdir -p "$DEST"
deployed=1
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

FLIGHTLOG_UNIT=false
UDEV_WROTE=false
if [[ "$LAB_UNPRIV" != "1" ]]; then
  install -d -o root -g root -m 0755 "$(dirname "$NM_BIN")"
  install -o root -g root -m 0755 "$ROOT/uplink-nm.sh" "$NM_BIN"
  if [[ "$ENABLE_FLIGHTLOG" == "1" ]]; then
    install -m 0644 "$ROOT/airvix-flightlog.service" /etc/systemd/system/airvix-flightlog.service
    FLIGHTLOG_UNIT=true
  fi
  if [[ ! -f "$UDEV_DEST" ]] || ! cmp -s "$UDEV_SRC" "$UDEV_DEST"; then
    install -m 0644 "$UDEV_SRC" "$UDEV_DEST"
    UDEV_WROTE=true
    if command -v udevadm >/dev/null 2>&1; then
      udevadm control --reload-rules || true
      udevadm trigger --subsystem-match=video4linux || true
    fi
  fi
fi
python3 "$ROOT/version_rollback.py" --write-live --dest "$DEST" --version "$VER" --git-sha "$SHA" --deployed-at "$WHEN"

restart_service
up=0
for _try in 1 2 3 4 5 6 7 8 9 10; do
  if health_once; then
    up=1
    break
  fi
  sleep 1
done
if [[ "$up" != "1" ]]; then
  fail_deploy "unhealthy" 1
fi

base_pid="$(service_prop MainPID)"
base_restarts="$(service_prop NRestarts)"
base_state="$(service_prop ActiveState)"
[[ -n "$base_pid" && "$base_pid" != "0" ]]
[[ "$base_state" == "active" ]]
watch_end=$((SECONDS + WATCH_S))
while (( SECONDS < watch_end )); do
  sleep 1
  now_pid="$(service_prop MainPID)"
  now_restarts="$(service_prop NRestarts)"
  now_state="$(service_prop ActiveState)"
  if [[ "$now_state" != "active" || "$now_pid" != "$base_pid" || "$now_pid" == "0" || "$now_restarts" != "$base_restarts" ]]; then
    fail_deploy "crashed" 1
  fi
  if ! health_once; then
    fail_deploy "unhealthy" 1
  fi
done

trap - ERR
deployed=0
echo "{\"ok\":true,\"applied\":true,\"dest\":\"$DEST\",\"nm_bin\":\"$NM_BIN\",\"nm_owner\":\"root:root\",\"nm_mode\":\"0755\",\"flightlog_unit\":$FLIGHTLOG_UNIT,\"flightlog_started\":false,\"backup_root\":\"${DEST}.backups\",\"backup\":\"${backup_dir}\",\"manifest\":\"airvix-deploy.json\",\"version\":\"$VER\",\"git_sha\":\"$SHA\",\"deployed_at\":\"$WHEN\",\"known_good\":false,\"udev\":\"$UDEV_DEST\",\"udev_wrote\":$UDEV_WROTE,\"watched_s\":${WATCH_S},\"service\":\"${SERVICE_NAME}\"}"
