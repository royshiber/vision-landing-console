#!/bin/sh
# AIRVIX Linux updater.
# Downloads master into a temp dir, runs npm ci there, then swaps code.
# Never deletes .env, data/, or var/. Keeps a rollback copy of the previous code.
# --dry-run prints the plan and does not touch the network or the app tree.
set -eu

DRY=0
ROLLBACK_MODE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --rollback) ROLLBACK_MODE=1 ;;
  esac
done

APP_DIR="${AIRVIX_APP_DIR:-}"
if [ -z "$APP_DIR" ]; then
  APP_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
fi

LOG="${AIRVIX_UPDATE_LOG:-${TMPDIR:-/tmp}/airvix-update.log}"
STATUS="${AIRVIX_UPDATE_STATUS:-${TMPDIR:-/tmp}/airvix-update-status.json}"
TARBALL_URL="https://codeload.github.com/royshiber/vision-landing-console/tar.gz/refs/heads/master"
PARENT=$(dirname "$APP_DIR")
ROLLBACK="$PARENT/airvix-rollback"

write_status() {
  # $1 state  $2 error
  printf '{"state":"%s","error":"%s","logPath":"%s"}\n' "$1" "$2" "$LOG" > "$STATUS" 2>/dev/null || true
}

if [ "$ROLLBACK_MODE" = 1 ] && [ "$DRY" = 1 ]; then
  echo "rollback-dry-run"
  echo "source=$ROLLBACK/console"
  echo "preserve=.env,data,var"
  echo "restart=./restart.sh"
  exit 0
fi

if [ "$DRY" = 1 ]; then
  echo "dry-run"
  echo "app-dir=$APP_DIR"
  echo "download=$TARBALL_URL"
  echo "extract=temp"
  echo "npm-ci=temp"
  echo "exclude=.env,data,var,node_modules"
  echo "preserve=.env,data,var"
  echo "rollback=previous-code"
  echo "swap=after-success"
  echo "restart=./restart.sh"
  exit 0
fi

log() {
  printf '%s\n' "$*" >> "$LOG"
}

fail() {
  log "FAILED: $1"
  write_status failed "$1"
  exit 1
}

stop_port() {
  port="$1"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
    return
  fi
  if command -v ss >/dev/null 2>&1; then
    pids=$(ss -ltnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u)
    for pid in $pids; do
      cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
      case "$cmd" in
        node|nodejs) kill "$pid" 2>/dev/null || true ;;
      esac
    done
  fi
}

read_port() {
  port=3090
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

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

if [ "$ROLLBACK_MODE" = 1 ]; then
  PREV="$ROLLBACK/console"
  log "AIRVIX rollback start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_status rolling_back ""
  if [ ! -d "$PREV" ] || [ ! -f "$PREV/server.js" ]; then
    fail "previous tree missing"
  fi
  PORT=$(read_port)
  log "stop port $PORT"
  stop_port "$PORT"
  KEEP=$(mktemp -d "${TMPDIR:-/tmp}/airvix-keep.XXXXXX")
  for name in .env data var; do
    if [ -e "$APP_DIR/$name" ]; then
      mv "$APP_DIR/$name" "$KEEP/$name"
    fi
  done
  FAILED="$PARENT/airvix-failed"
  rm -rf "$FAILED"
  if ! mv "$APP_DIR" "$FAILED"; then
    for name in .env data var; do
      if [ -e "$KEEP/$name" ]; then
        mkdir -p "$APP_DIR"
        mv "$KEEP/$name" "$APP_DIR/$name"
      fi
    done
    fail "could not move current tree aside"
  fi
  if ! mv "$PREV" "$APP_DIR"; then
    mv "$FAILED" "$APP_DIR" || true
    for name in .env data var; do
      if [ -e "$KEEP/$name" ] && [ ! -e "$APP_DIR/$name" ]; then
        mv "$KEEP/$name" "$APP_DIR/$name"
      fi
    done
    fail "rollback swap failed"
  fi
  for name in .env data var; do
    if [ -e "$KEEP/$name" ]; then
      rm -rf "$APP_DIR/$name"
      mv "$KEEP/$name" "$APP_DIR/$name"
    fi
  done
  rm -rf "$KEEP"
  mkdir -p "$ROLLBACK"
  mv "$FAILED" "$ROLLBACK/console"
  log "restart=./restart.sh"
  if [ -f "$APP_DIR/restart.sh" ]; then
    if ! (cd "$APP_DIR" && sh ./restart.sh) >> "$LOG" 2>&1; then
      log "rollback restart failed"
      fail "restart failed"
    fi
  else
    fail "restart.sh missing"
  fi
  write_status ok ""
  log "AIRVIX rollback done"
  exit 0
fi

log "AIRVIX update start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_status applying ""

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/airvix-stage.XXXXXX")
cleanup_stage() {
  rm -rf "$STAGE"
}
trap cleanup_stage EXIT

log "download $TARBALL_URL"
if ! curl -fsSL --retry 2 --max-time 180 -o "$STAGE/master.tar.gz" "$TARBALL_URL"; then
  fail "download failed"
fi
log "extract=temp"
if ! tar -xzf "$STAGE/master.tar.gz" -C "$STAGE"; then
  fail "extract failed"
fi
SRC=$(find "$STAGE" -mindepth 1 -maxdepth 1 -type d | head -n 1)
if [ -z "$SRC" ] || [ ! -f "$SRC/server.js" ]; then
  fail "archive missing server.js"
fi

log "npm-ci=temp"
(
  cd "$SRC"
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
  unset NODE_ENV || true
  npm ci --no-audit --no-fund --loglevel error
) >> "$LOG" 2>&1 || fail "npm ci failed"

PORT=$(read_port)
log "stop port $PORT"
stop_port "$PORT"

KEEP=$(mktemp -d "${TMPDIR:-/tmp}/airvix-keep.XXXXXX")
for name in .env data var; do
  if [ -e "$APP_DIR/$name" ]; then
    mv "$APP_DIR/$name" "$KEEP/$name"
  fi
done

log "rollback=previous-code"
rm -rf "$ROLLBACK"
mkdir -p "$ROLLBACK"
if ! mv "$APP_DIR" "$ROLLBACK/console"; then
  for name in .env data var; do
    if [ -e "$KEEP/$name" ]; then
      mkdir -p "$APP_DIR"
      mv "$KEEP/$name" "$APP_DIR/$name"
    fi
  done
  fail "could not move current tree aside"
fi

log "swap=after-success"
if ! mv "$SRC" "$APP_DIR"; then
  mv "$ROLLBACK/console" "$APP_DIR" || true
  for name in .env data var; do
    if [ -e "$KEEP/$name" ] && [ ! -e "$APP_DIR/$name" ]; then
      mv "$KEEP/$name" "$APP_DIR/$name"
    fi
  done
  fail "swap failed"
fi

for name in .env data var; do
  if [ -e "$KEEP/$name" ]; then
    rm -rf "$APP_DIR/$name"
    mv "$KEEP/$name" "$APP_DIR/$name"
  fi
done
rm -rf "$KEEP"

restore_previous() {
  if [ ! -d "$ROLLBACK/console" ]; then
    return 1
  fi
  hold=$(mktemp -d "${TMPDIR:-/tmp}/airvix-hold.XXXXXX")
  for name in .env data var; do
    if [ -e "$APP_DIR/$name" ]; then
      mv "$APP_DIR/$name" "$hold/$name"
    fi
  done
  failed="$PARENT/airvix-failed"
  rm -rf "$failed"
  mv "$APP_DIR" "$failed" 2>/dev/null || true
  if ! mv "$ROLLBACK/console" "$APP_DIR"; then
    mv "$failed" "$APP_DIR" 2>/dev/null || true
    for name in .env data var; do
      if [ -e "$hold/$name" ] && [ ! -e "$APP_DIR/$name" ]; then
        mv "$hold/$name" "$APP_DIR/$name"
      fi
    done
    rm -rf "$hold"
    return 1
  fi
  for name in .env data var; do
    if [ -e "$hold/$name" ]; then
      rm -rf "$APP_DIR/$name"
      mv "$hold/$name" "$APP_DIR/$name"
    fi
  done
  rm -rf "$hold" "$failed"
  if [ -f "$APP_DIR/restart.sh" ]; then
    (cd "$APP_DIR" && sh ./restart.sh) >> "$LOG" 2>&1 || true
  fi
  return 0
}

log "preserve=.env,data,var"
log "exclude=.env,data,var,node_modules"
log "restart=./restart.sh"
if [ -f "$APP_DIR/restart.sh" ]; then
  if ! (cd "$APP_DIR" && sh ./restart.sh) >> "$LOG" 2>&1; then
    log "restart failed; restoring previous code"
    restore_previous || true
    fail "restart failed"
  fi
else
  log "restart.sh missing; restoring previous code"
  restore_previous || true
  fail "restart.sh missing"
fi

write_status ok ""
log "AIRVIX update done"
trap - EXIT
rm -rf "$STAGE"
exit 0
