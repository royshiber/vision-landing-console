#!/bin/sh
# Restart the AIRVIX console on this machine.
# PORT already in the environment wins. Otherwise PORT from .env. Otherwise 4010.
# Stops only this install: the pidfile when its cwd is this tree, and node server.js in this cwd.
# Does not send flight commands and does not touch .env, data/, or var/.
set -eu
cd "$(dirname "$0")"
APP_DIR=$(pwd)

resolve_port() {
  case "${PORT:-}" in
    ''|*[!0-9]*) ;;
    *) printf '%s' "$PORT"; return ;;
  esac
  port=4010
  if [ -f "$APP_DIR/.env" ]; then
    line=$(grep -E '^PORT=' "$APP_DIR/.env" | tail -n 1 || true)
    val=$(printf '%s' "$line" | cut -d= -f2- | tr -d "\"' \r")
    case "$val" in
      ''|*[!0-9]*) ;;
      *) port=$val ;;
    esac
  fi
  printf '%s' "$port"
}

stop_install() {
  pidfile="$APP_DIR/data/console.pid"
  if [ -f "$pidfile" ]; then
    pid=$(tr -cd '0-9' < "$pidfile")
    if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then
      cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
      cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
      case "$cwd" in
        "$APP_DIR"|"$APP_DIR"/*) kill "$pid" 2>/dev/null || true ;;
        *)
          case "$cmd" in
            *"$APP_DIR/server.js"*) kill "$pid" 2>/dev/null || true ;;
          esac
          ;;
      esac
    fi
  fi
  for proc in /proc/[0-9]*; do
    [ -d "$proc" ] || continue
    pid=${proc##*/}
    cwd=$(readlink "$proc/cwd" 2>/dev/null || true)
    case "$cwd" in
      "$APP_DIR"|"$APP_DIR"/*) ;;
      *) continue ;;
    esac
    cmd=$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)
    case "$cmd" in
      *"$APP_DIR"/server.js*|*"$APP_DIR/server.js"*) kill "$pid" 2>/dev/null || true ;;
    esac
  done
}

PORT=$(resolve_port)
stop_install

LOG="${TMPDIR:-/tmp}/airvix-console.log"
nohup node server.js >> "$LOG" 2>&1 &
echo "started pid $! on port $PORT"
