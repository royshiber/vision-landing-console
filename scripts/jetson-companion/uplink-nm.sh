#!/bin/bash
# NetworkManager verbs for the two AIRVIX uplinks. No free-form connection name.
# Does not write an APN. "Wired connection 2" is expected to already use uinternet.
set -euo pipefail

WIFI_IFACE="${VLC_WIFI_IFACE:-wlP1p1s0}"
CELL_CONN="${VLC_CELL_NM_CONNECTION:-Wired connection 2}"
verb="${1:-}"
if [[ $# -ne 1 ]]; then
  echo "usage: uplink-nm.sh wifi-up|wifi-down|cell-up|cell-down" >&2
  exit 2
fi

cell_iface() {
  if [[ -n "${VLC_CELL_IFACE:-}" ]]; then
    printf '%s\n' "$VLC_CELL_IFACE"
    return 0
  fi
  local node uevent
  for node in /sys/class/net/enx*; do
    [[ -d "$node" ]] || continue
    uevent="$node/device/uevent"
    [[ -f "$uevent" ]] || continue
    if grep -qi 'PRODUCT=12d1/' "$uevent"; then
      basename "$node"
      return 0
    fi
  done
  return 1
}

wifi_connection() {
  local line name dev
  while IFS= read -r line; do
    name="${line%%:*}"
    dev="${line#*:}"
    if [[ "$dev" == "$WIFI_IFACE" && -n "$name" ]]; then
      printf '%s\n' "$name"
      return 0
    fi
  done < <(nmcli -t -f NAME,DEVICE connection show || true)
  return 1
}

case "$verb" in
  wifi-up)
    nmcli device set "$WIFI_IFACE" autoconnect yes
    if name="$(wifi_connection)"; then
      nmcli connection up "$name"
    else
      nmcli device connect "$WIFI_IFACE"
    fi
    ;;
  wifi-down)
    if name="$(wifi_connection)"; then
      nmcli connection down "$name" || true
    fi
    nmcli device disconnect "$WIFI_IFACE" || true
    nmcli device set "$WIFI_IFACE" autoconnect no
    ;;
  cell-up)
    nmcli connection up "$CELL_CONN"
    if iface="$(cell_iface)"; then
      nmcli device set "$iface" autoconnect yes || true
    fi
    ;;
  cell-down)
    nmcli connection down "$CELL_CONN"
    if iface="$(cell_iface)"; then
      nmcli device set "$iface" autoconnect no || true
    fi
    ;;
  *)
    echo "bad verb" >&2
    exit 2
    ;;
esac
