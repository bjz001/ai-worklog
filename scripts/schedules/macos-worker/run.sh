#!/usr/bin/env bash
set -euo pipefail
umask 077

export PATH="/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/../../.." && pwd -P)"
NODE_BINARY=""
MODE="run"

safe_event() {
  local phase="$1"
  local status="$2"
  local timestamp
  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '{"event":"ai-worklog-worker-schedule","phase":"%s","status":"%s","at":"%s"}\n' \
    "$phase" "$status" "$timestamp"
}

fail_validation() {
  safe_event "validation" "failed" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --project-root)
      (($# >= 2)) || fail_validation
      PROJECT_ROOT="$2"
      shift 2
      ;;
    --node)
      (($# >= 2)) || fail_validation
      NODE_BINARY="$2"
      shift 2
      ;;
    --dry-run)
      MODE="dry-run"
      shift
      ;;
    --validate-only)
      MODE="validate-only"
      shift
      ;;
    *)
      fail_validation
      ;;
  esac
done

[[ "$PROJECT_ROOT" != *$'\n'* && "$PROJECT_ROOT" != *$'\r'* ]] || fail_validation
[[ -d "$PROJECT_ROOT" ]] || fail_validation
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd -P)" || fail_validation
[[ "$NODE_BINARY" == /* && "$NODE_BINARY" != *$'\n'* && "$NODE_BINARY" != *$'\r'* ]] || fail_validation
[[ -f "$NODE_BINARY" && -x "$NODE_BINARY" ]] || fail_validation

environment_mode() {
  /usr/bin/stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null
}

environment_owner() {
  /usr/bin/stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1" 2>/dev/null
}

ENVIRONMENT_FILE="$PROJECT_ROOT/.env.local"
[[ -f "$ENVIRONMENT_FILE" && ! -L "$ENVIRONMENT_FILE" && -r "$ENVIRONMENT_FILE" ]] || fail_validation
mode="$(environment_mode "$ENVIRONMENT_FILE")" || fail_validation
owner="$(environment_owner "$ENVIRONMENT_FILE")" || fail_validation
[[ "$mode" =~ ^[0-7]{3,4}$ && "$owner" == "$(id -u)" ]] || fail_validation
numeric_mode=$((8#$mode))
(( (numeric_mode & 077) == 0 )) || fail_validation

TSX_CLI="$PROJECT_ROOT/node_modules/tsx/dist/cli.mjs"
WORKER_ENTRY="$PROJECT_ROOT/apps/worker/src/index.ts"
[[ -f "$TSX_CLI" && -f "$WORKER_ENTRY" ]] || fail_validation

cd "$PROJECT_ROOT"
unset NODE_OPTIONS NODE_PATH TS_NODE_PROJECT TSX_TSCONFIG_PATH

if [[ "$MODE" == "dry-run" ]]; then
  safe_event "validation" "dry-run"
  exit 0
fi
if [[ "$MODE" == "validate-only" ]]; then
  safe_event "validation" "ok"
  exit 0
fi

LOCK_PARENT="$HOME/Library/Caches/AIWorklog"
LOCK_DIRECTORY="$LOCK_PARENT/worker-schedule.lock"
mkdir -p "$LOCK_PARENT"
chmod 700 "$LOCK_PARENT"

write_lock_owner() {
  if ! printf '%s\n' "$$" >"$LOCK_DIRECTORY/pid"; then
    rm -f "$LOCK_DIRECTORY/pid"
    rmdir "$LOCK_DIRECTORY" 2>/dev/null || true
    return 1
  fi
}

acquire_lock() {
  local existing_pid stale_directory
  if mkdir "$LOCK_DIRECTORY" 2>/dev/null; then
    write_lock_owner || return 1
    return 0
  fi

  existing_pid=""
  if [[ -d "$LOCK_DIRECTORY" && ! -L "$LOCK_DIRECTORY" ]]; then
    IFS= read -r existing_pid 2>/dev/null <"$LOCK_DIRECTORY/pid" || true
    if [[ -z "$existing_pid" ]]; then
      sleep 1
      IFS= read -r existing_pid 2>/dev/null <"$LOCK_DIRECTORY/pid" || true
    fi
  else
    return 1
  fi
  if [[ "$existing_pid" =~ ^[1-9][0-9]*$ && "$existing_pid" != "1" ]] && \
     kill -0 "$existing_pid" 2>/dev/null; then
    return 1
  fi

  stale_directory="$LOCK_PARENT/worker-schedule.stale.$$"
  mv "$LOCK_DIRECTORY" "$stale_directory" 2>/dev/null || return 1
  rm -rf "$stale_directory"
  mkdir "$LOCK_DIRECTORY" 2>/dev/null || return 1
  write_lock_owner || return 1
}

if ! acquire_lock; then
  safe_event "lock" "skipped"
  exit 0
fi

cleanup() {
  rm -f "$LOCK_DIRECTORY/pid"
  rmdir "$LOCK_DIRECTORY" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

safe_event "worker" "started"
if "$NODE_BINARY" "$TSX_CLI" "$WORKER_ENTRY" >/dev/null 2>&1; then
  safe_event "worker" "completed"
  exit 0
fi
safe_event "worker" "failed" >&2
exit 1
