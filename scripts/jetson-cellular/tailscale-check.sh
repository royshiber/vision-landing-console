#!/bin/sh
# Observe-only Tailscale readiness on the Jetson host.
# Default --dry-run. Does not ping a remote machine, does not print secrets,
# and does not start Tailscale. Keep Tailscale up when the cell NIC appears.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "${ROOT}/lib/e3372-common.sh"

DRY=1

usage() {
  cat <<'EOF'
Usage: tailscale-check.sh [--dry-run] [--live]

Report whether Tailscale looks installed on this host.

  --dry-run   default. Inspect local binary / iface only. No network.
  --live      also read `tailscale status --json` BackendState if present.
              Still does not ping a Jetson or a production vehicle.

Keep Tailscale enabled after the E3372 USB ethernet appears so home tests
and cellular ops share the same MagicDNS path. Do not put host addresses
or auth keys in this pack.
EOF
}

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY=1 ;;
    --live) DRY=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: ${arg}" >&2; usage >&2; exit 2 ;;
  esac
done

binary=false
iface=null
backend=null
up=false
reason="not_installed"

if command -v tailscale >/dev/null 2>&1; then
  binary=true
  reason="installed"
fi

if [ -d /sys/class/net/tailscale0 ]; then
  iface="tailscale0"
  if [ "${reason}" = "installed" ]; then
    reason="iface_present"
  fi
fi

if [ "${DRY}" != "1" ] && command -v tailscale >/dev/null 2>&1; then
  raw=$(tailscale status --json 2>/dev/null || true)
  if [ -n "${raw}" ]; then
    backend=$(printf '%s' "${raw}" | awk -F'"' '/"BackendState"/ { print $4; exit }')
    [ -n "${backend}" ] || backend=null
    case "${backend}" in
      Running) up=true; reason="running" ;;
      *) reason="not_running" ;;
    esac
  fi
fi

if [ "${up}" = "true" ]; then
  :
elif [ "${iface}" != "null" ] && [ "${binary}" = "true" ]; then
  reason="iface_present"
elif [ "${binary}" = "true" ]; then
  reason="installed"
fi

printf '%s\n' \
  "{" \
  "  \"ok\": true," \
  "  \"dryRun\": $( [ "${DRY}" = "1" ] && echo true || echo false )," \
  "  \"binary\": ${binary}," \
  "  \"iface\": $(e3372_json_str "${iface}")," \
  "  \"backend\": $(e3372_json_str "${backend}")," \
  "  \"up\": ${up}," \
  "  \"reason\": $(e3372_json_str "${reason}")," \
  "  \"keepUpOverCellular\": true," \
  "  \"keepUpOverCellularHe\": \"השאירו את רשת הבית פעילה גם על סלולר.\"," \
  "  \"flightCommands\": false," \
  "  \"companionHttpCommandPath\": false" \
  "}"
exit 0
