#!/bin/sh
# Restart the AIRVIX console on this machine.
# Stops the node process listening on PORT (from .env, otherwise 3090) and starts server.js.
# Does not send flight commands and does not touch .env, data/, or var/.
set -eu
cd "$(dirname "$0")"

PORT=3090
if [ -f .env ]; then
  line=$(grep -E '^PORT=' .env | tail -n 1 || true)
  val=$(printf '%s' "$line" | cut -d= -f2- | tr -d "\"' \r")
  case "$val" in
    ''|*[!0-9]*) ;;
    *) PORT=$val ;;
  esac
fi

if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
elif command -v ss >/dev/null 2>&1; then
  pids=$(ss -ltnp "sport = :$PORT" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u)
  for pid in $pids; do
    cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    case "$cmd" in
      node|nodejs) kill "$pid" 2>/dev/null || true ;;
    esac
  done
fi

LOG="${TMPDIR:-/tmp}/airvix-console.log"
nohup node server.js >> "$LOG" 2>&1 &
echo "started pid $! on port $PORT"
