#!/bin/sh
# Build a tarball of this directory for later scp onto a Jetson.
# Does not SSH. Does not include secrets or machine addresses.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PARENT=$(CDPATH= cd -- "${ROOT}/.." && pwd)
OUT="${1:-${PARENT}/airvix-jetson-cellular.tgz}"

if [ "${1:-}" = "--dry-run" ]; then
  echo "dry-run: would tar ${ROOT} -> ${PARENT}/airvix-jetson-cellular.tgz"
  find "${ROOT}" -type f | sort
  exit 0
fi

tar -czf "${OUT}" -C "${PARENT}" jetson-cellular
echo "${OUT}"
