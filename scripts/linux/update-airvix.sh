#!/bin/sh
# AIRVIX Linux updater.
# Downloads master into a temp dir, runs npm ci there, then swaps code.
# Never deletes .env, data/, or var/. Keeps a rollback copy of the previous code.
# --dry-run prints the plan and does not touch the network or the app tree.
# Port matches the app: an already-set PORT wins, else PORT in .env, else 4010.
# Stop only this install. Failed copies stay inside the backup dir, with a timestamp.
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

start_console() {
  PORT=$(resolve_port)
  log "stop install port $PORT"
  log "restart=updater-owned"
  stop_install
  if ! command -v node >/dev/null 2>&1; then
    log "node missing"
    return 1
  fi
  console_log="${TMPDIR:-/tmp}/airvix-console.log"
  (
    cd "$APP_DIR" || exit 1
    nohup node server.js >> "$console_log" 2>&1 &
  )
}

stamp() {
  date -u +%Y%m%dT%H%M%SZ
}

safe_rm_child() {
  root="$1"
  target="$2"
  [ -d "$root" ] || return 0
  [ -e "$target" ] || return 0
  root_real=$(CDPATH= cd -- "$root" && pwd -P)
  target_real=$(CDPATH= cd -- "$target" && pwd -P) || return 0
  case "$target_real" in
    "$root_real"/*) rm -rf "$target_real" ;;
  esac
}

prune_backup_copies() {
  root="$1"
  [ -d "$root" ] || return 0
  root_real=$(CDPATH= cd -- "$root" && pwd -P)
  list=$(find "$root_real" -mindepth 1 -maxdepth 1 -type d \( -name 'failed-*' -o -name 'outgoing-*' -o -name 'replaced-*' \) -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk 'NR>3 { print substr($0, index($0, " ") + 1) }')
  if [ -z "$list" ]; then
    return 0
  fi
  printf '%s\n' "$list" | while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    safe_rm_child "$root_real" "$dir"
  done
}

move_aside() {
  # $1 path that should leave the app tree, kept under the backup dir
  src="$1"
  [ -e "$src" ] || return 0
  mkdir -p "$ROLLBACK"
  name=$(basename "$src")
  dest="$ROLLBACK/replaced-$(stamp)-$$-$name"
  mv "$src" "$dest"
}

if [ "$ROLLBACK_MODE" = 1 ] && [ "$DRY" = 1 ]; then
  echo "rollback-dry-run"
  echo "source=$ROLLBACK/console"
  echo "preserve=.env,data,var"
  echo "restart=updater-owned"
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
  echo "restart=updater-owned"
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

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

if [ "$ROLLBACK_MODE" = 1 ]; then
  PREV="$ROLLBACK/console"
  log "AIRVIX rollback start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_status rolling_back ""
  if [ ! -d "$PREV" ] || [ ! -f "$PREV/server.js" ]; then
    fail "previous tree missing"
  fi
  PORT=$(resolve_port)
  log "stop install port $PORT"
  stop_install
  KEEP=$(mktemp -d "${TMPDIR:-/tmp}/airvix-keep.XXXXXX")
  for name in .env data var; do
    if [ -e "$APP_DIR/$name" ]; then
      mv "$APP_DIR/$name" "$KEEP/$name"
    fi
  done
  mkdir -p "$ROLLBACK"
  OUT="$ROLLBACK/outgoing-$(stamp)-$$"
  if ! mv "$APP_DIR" "$OUT"; then
    mkdir -p "$APP_DIR"
    for name in .env data var; do
      if [ -e "$KEEP/$name" ]; then
        mv "$KEEP/$name" "$APP_DIR/$name"
      fi
    done
    fail "could not move current tree aside"
  fi
  if ! mv "$PREV" "$APP_DIR"; then
    mv "$OUT" "$APP_DIR" || true
    for name in .env data var; do
      if [ -e "$KEEP/$name" ] && [ ! -e "$APP_DIR/$name" ]; then
        mv "$KEEP/$name" "$APP_DIR/$name"
      fi
    done
    fail "rollback swap failed"
  fi
  for name in .env data var; do
    if [ -e "$KEEP/$name" ]; then
      if [ -e "$APP_DIR/$name" ]; then
        move_aside "$APP_DIR/$name"
      fi
      mv "$KEEP/$name" "$APP_DIR/$name"
    fi
  done
  rm -rf "$KEEP"
  if [ -e "$ROLLBACK/console" ]; then
    mv "$ROLLBACK/console" "$ROLLBACK/failed-$(stamp)-$$"
  fi
  mv "$OUT" "$ROLLBACK/console"
  prune_backup_copies "$ROLLBACK"
  if ! start_console; then
    log "rollback restart failed"
    fail "restart failed"
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

PORT=$(resolve_port)
log "stop install port $PORT"
stop_install

KEEP=$(mktemp -d "${TMPDIR:-/tmp}/airvix-keep.XXXXXX")
for name in .env data var; do
  if [ -e "$APP_DIR/$name" ]; then
    mv "$APP_DIR/$name" "$KEEP/$name"
  fi
done

log "rollback=previous-code"
mkdir -p "$ROLLBACK"
if [ -d "$ROLLBACK/console" ]; then
  mv "$ROLLBACK/console" "$ROLLBACK/failed-$(stamp)-$$"
fi
if ! mv "$APP_DIR" "$ROLLBACK/console"; then
  mkdir -p "$APP_DIR"
  for name in .env data var; do
    if [ -e "$KEEP/$name" ]; then
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
    if [ -e "$APP_DIR/$name" ]; then
      move_aside "$APP_DIR/$name"
    fi
    mv "$KEEP/$name" "$APP_DIR/$name"
  fi
done
rm -rf "$KEEP"
prune_backup_copies "$ROLLBACK"

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
  bad="$ROLLBACK/failed-$(stamp)-$$"
  mv "$APP_DIR" "$bad" 2>/dev/null || true
  if ! mv "$ROLLBACK/console" "$APP_DIR"; then
    mv "$bad" "$APP_DIR" 2>/dev/null || true
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
      if [ -e "$APP_DIR/$name" ]; then
        move_aside "$APP_DIR/$name"
      fi
      mv "$hold/$name" "$APP_DIR/$name"
    fi
  done
  rm -rf "$hold"
  prune_backup_copies "$ROLLBACK"
  start_console || true
  return 0
}

log "preserve=.env,data,var"
log "exclude=.env,data,var,node_modules"
log "restart=updater-owned"
if ! start_console; then
  log "restart failed; restoring previous code"
  restore_previous || true
  fail "restart failed"
fi

write_status ok ""
log "AIRVIX update done"
trap - EXIT
rm -rf "$STAGE"
exit 0
