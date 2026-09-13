#!/bin/sh
# Print the documented cellular MAVLink bind (console dual-link default).
# Dry-run only: never opens a socket, never talks to an FC.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "${ROOT}/lib/e3372-common.sh"

usage() {
  cat <<'EOF'
Usage: cellular-mavlink-endpoint.sh [--dry-run]

Print the cellular MAVLink second-path endpoint that matches console
DEFAULT_CELLULAR_ENDPOINT (udp 0.0.0.0:14560 unless overridden).

Does not bind, relay, or send. Companion-HTTP is not this path.
EOF
}

for arg in "$@"; do
  case "${arg}" in
    --dry-run) ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: ${arg}" >&2; usage >&2; exit 2 ;;
  esac
done

printf '%s\n' \
  "{" \
  "  \"ok\": true," \
  "  \"dryRun\": true," \
  "  \"bound\": false," \
  "  \"type\": \"$(e3372_mavlink_type)\"," \
  "  \"host\": \"$(e3372_mavlink_host)\"," \
  "  \"port\": $(e3372_mavlink_port)," \
  "  \"role\": \"cellular\"," \
  "  \"alignsWithConsole\": true," \
  "  \"companionHttpCommandPath\": false," \
  "  \"flightCommands\": false," \
  "  \"noteHe\": \"יעד סלולר לפקודות ולטלמטריה. לא דרך HTTP.\"" \
  "}"
exit 0
