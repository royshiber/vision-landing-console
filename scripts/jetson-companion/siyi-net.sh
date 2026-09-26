#!/usr/bin/env bash
# Idempotent NetworkManager profile for the SIYI A8 Ethernet link.
# Static 192.168.144.20/24 on the wired NIC. Never touches Wi-Fi or cellular.
set -euo pipefail

PROFILE="airvix-siyi"
ADDRESS="192.168.144.20/24"
NMCLI="${NMCLI:-nmcli}"
IFACE="${VLC_SIYI_IFACE:-}"
ACTION="apply"
NO_UP=0

usage() {
  echo "Usage: $0 [--status|--remove|--dry-run] [--iface NAME] [--no-up]"
  echo "Creates NetworkManager profile ${PROFILE}: ${ADDRESS}, never-default, no DNS, ipv6 disabled."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status) ACTION="status"; shift ;;
    --remove) ACTION="remove"; shift ;;
    --dry-run) ACTION="dry-run"; shift ;;
    --no-up) NO_UP=1; shift ;;
    --iface)
      IFACE="${2:-}"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

is_wireless() {
  local name="$1"
  [[ -d "/sys/class/net/${name}/wireless" ]] && return 0
  [[ "$name" == wl* ]] && return 0
  return 1
}

is_forbidden_iface() {
  local name="$1"
  [[ "$name" == "lo" ]] && return 0
  is_wireless "$name" && return 0
  [[ "$name" == wwan* || "$name" == usb* || "$name" == docker* || "$name" == veth* || "$name" == tailscale* || "$name" == can* ]] && return 0
  return 1
}

detect_iface() {
  if [[ -n "$IFACE" ]]; then
    printf '%s\n' "$IFACE"
    return 0
  fi
  if [[ -d /sys/class/net/enP8p1s0 ]] && ! is_forbidden_iface enP8p1s0; then
    printf '%s\n' enP8p1s0
    return 0
  fi
  local entry name typ
  for entry in /sys/class/net/*; do
    [[ -e "$entry" ]] || continue
    name="$(basename "$entry")"
    is_forbidden_iface "$name" && continue
    typ="$(cat "$entry/type" 2>/dev/null || echo "")"
    [[ "$typ" == "1" ]] || continue
    printf '%s\n' "$name"
    return 0
  done
  return 1
}

refuse_iface() {
  local name="$1"
  if is_forbidden_iface "$name"; then
    echo "{\"ok\":false,\"error\":\"refusing_iface\",\"iface\":\"${name}\",\"note\":\"wifi and cellular are not modified\"}" >&2
    exit 3
  fi
}

profile_exists() {
  "$NMCLI" -t -f NAME connection show 2>/dev/null | grep -qx "$PROFILE"
}

print_plan() {
  local iface="$1"
  printf '%s\n' "$NMCLI connection add-or-modify type ethernet ifname ${iface} con-name ${PROFILE} connection.interface-name ${iface} connection.autoconnect yes connection.autoconnect-priority 10 ipv4.method manual ipv4.addresses ${ADDRESS} ipv4.never-default yes ipv4.ignore-auto-dns yes ipv6.method disabled"
  if [[ "$NO_UP" -eq 0 ]]; then
    printf '%s\n' "$NMCLI connection up ${PROFILE}"
  fi
}

apply_profile() {
  local iface="$1"
  if profile_exists; then
    "$NMCLI" connection modify "$PROFILE" \
      connection.interface-name "$iface" \
      connection.autoconnect yes \
      connection.autoconnect-priority 10 \
      ipv4.method manual \
      ipv4.addresses "$ADDRESS" \
      ipv4.never-default yes \
      ipv4.ignore-auto-dns yes \
      ipv6.method disabled
  else
    "$NMCLI" connection add type ethernet ifname "$iface" con-name "$PROFILE" \
      connection.autoconnect yes \
      connection.autoconnect-priority 10 \
      ipv4.method manual \
      ipv4.addresses "$ADDRESS" \
      ipv4.never-default yes \
      ipv4.ignore-auto-dns yes \
      ipv6.method disabled
  fi
  if [[ "$NO_UP" -eq 0 ]]; then
    "$NMCLI" connection up "$PROFILE"
  fi
}

case "$ACTION" in
  remove)
    if profile_exists; then
      "$NMCLI" connection delete "$PROFILE"
      echo "{\"ok\":true,\"removed\":true,\"profile\":\"${PROFILE}\"}"
    else
      echo "{\"ok\":true,\"removed\":false,\"profile\":\"${PROFILE}\",\"note\":\"profile absent\"}"
    fi
    ;;
  status)
    iface="$(detect_iface || true)"
    present=false
    active=false
    address=""
    if profile_exists; then
      present=true
    fi
    if [[ -n "$iface" && -d "/sys/class/net/${iface}" ]]; then
      address="$(ip -4 -o addr show dev "$iface" 2>/dev/null | awk '{print $4}' | head -n 1 || true)"
    fi
    if [[ "$present" == true && "$address" == "$ADDRESS" ]]; then
      active=true
    fi
    printf '{"ok":true,"profile":"%s","present":%s,"active":%s,"iface":"%s","address":"%s"}\n' \
      "$PROFILE" "$present" "$active" "${iface:-}" "${address:-}"
    ;;
  dry-run)
    iface="$(detect_iface)" || { echo '{"ok":false,"error":"no_wired_iface"}' >&2; exit 1; }
    refuse_iface "$iface"
    echo "{\"ok\":true,\"dry_run\":true,\"profile\":\"${PROFILE}\",\"iface\":\"${iface}\",\"address\":\"${ADDRESS}\"}"
    print_plan "$iface"
    ;;
  apply)
    iface="$(detect_iface)" || { echo '{"ok":false,"error":"no_wired_iface"}' >&2; exit 1; }
    refuse_iface "$iface"
    apply_profile "$iface"
    echo "{\"ok\":true,\"applied\":true,\"profile\":\"${PROFILE}\",\"iface\":\"${iface}\",\"address\":\"${ADDRESS}\"}"
    ;;
esac
