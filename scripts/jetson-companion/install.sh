#!/usr/bin/env bash
# Copy-later companion camera ingest. Default is dry-run. No SSH. No apply/restart.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${AIRVIX_COMPANION_DEST:-/opt/airvix/jetson-companion}"
MODE="dry-run"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --apply) MODE="apply"; shift ;;
    --dest) DEST="$2"; shift 2 ;;
    --force-lab) FORCE_LAB=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--dry-run|--apply] [--dest PATH]"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

FILES=(companion_agent.py camera_ingest.py README.md)

echo "{\"ok\":true,\"mode\":\"$MODE\",\"dest\":\"$DEST\",\"files\":[\"${FILES[*]}\"]}"

if [[ "$MODE" == "dry-run" ]]; then
  for f in "${FILES[@]}"; do
    if [[ ! -f "$ROOT/$f" ]]; then
      echo "{\"ok\":false,\"missing\":\"$f\"}" >&2
      exit 1
    fi
  done
  echo '{"ok":true,"applied":false,"note":"dry-run; nothing copied"}'
  exit 0
fi

if [[ -z "${FORCE_LAB:-}" && ! -e /etc/nv_tegra_release && ! -d /proc/device-tree ]]; then
  echo '{"ok":false,"error":"not_a_jetson","note":"use --dry-run or --force-lab"}' >&2
  exit 1
fi

mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  install -m 755 "$ROOT/$f" "$DEST/$f"
done
echo "{\"ok\":true,\"applied\":true,\"dest\":\"$DEST\"}"
