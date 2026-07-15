#!/usr/bin/env bash
set -euo pipefail
umask 077

RUNNER_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$RUNNER_DIRECTORY/../../.." && pwd -P)"
DEFAULT_CONFIG="$HOME/.config/ai-worklog/collector.env"
CONFIG_PATH="$DEFAULT_CONFIG"
MODE="run"

safe_event() {
  local phase="$1"
  local status="$2"
  local timestamp
  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '{"event":"ai-worklog-schedule","phase":"%s","status":"%s","at":"%s"}\n' \
    "$phase" "$status" "$timestamp"
}

fail_config() {
  safe_event "configuration" "failed" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --config)
      (($# >= 2)) || fail_config
      CONFIG_PATH="$2"
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
      fail_config
      ;;
  esac
done

CONFIG_KEYS=(
  AI_WORKLOG_ACCOUNT_ID
  AI_WORKLOG_DEVICE_ID
  CODEX_SOURCE_INSTANCE_ID
  CODEX_SOURCE_PATH
  CLAUDE_CODE_SOURCE_INSTANCE_ID
  CLAUDE_CODE_SOURCE_PATH
  AI_WORKLOG_PATH_HMAC_KEY
  COLLECTOR_DB_PATH
  AI_WORKLOG_SYNC_URL
  AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP
  AI_WORKLOG_DEVICE_TOKEN
  NODE_BINARY
)
unset "${CONFIG_KEYS[@]}"
unset AI_WORKLOG_SOURCE_TYPE NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED NODE_OPTIONS NODE_PATH

config_mode() {
  /usr/bin/stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null
}

config_owner() {
  /usr/bin/stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1" 2>/dev/null
}

load_config() {
  local file="$1"
  local size mode owner numeric_mode line key value seen_keys
  seen_keys="|"
  [[ -f "$file" && ! -L "$file" && -r "$file" ]] || return 1

  size="$(wc -c <"$file" | tr -d '[:space:]')"
  [[ "$size" =~ ^[0-9]+$ ]] && ((size <= 65536)) || return 1
  mode="$(config_mode "$file")" || return 1
  owner="$(config_owner "$file")" || return 1
  [[ "$mode" =~ ^[0-7]{3,4}$ && "$owner" == "$(id -u)" ]] || return 1
  numeric_mode=$((8#$mode))
  (( (numeric_mode & 077) == 0 )) || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || return 1
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    ((${#value} <= 8192)) || return 1
    case "$key" in
      AI_WORKLOG_ACCOUNT_ID|AI_WORKLOG_DEVICE_ID|CODEX_SOURCE_INSTANCE_ID|CODEX_SOURCE_PATH|CLAUDE_CODE_SOURCE_INSTANCE_ID|CLAUDE_CODE_SOURCE_PATH|AI_WORKLOG_PATH_HMAC_KEY|COLLECTOR_DB_PATH|AI_WORKLOG_SYNC_URL|AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP|AI_WORKLOG_DEVICE_TOKEN|NODE_BINARY) ;;
      *) return 1 ;;
    esac
    case "$seen_keys" in
      *"|$key|"*) return 1 ;;
    esac
    seen_keys="${seen_keys}${key}|"
    if ((${#value} >= 2)); then
      if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]] || \
         [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi
    export "$key=$value"
  done <"$file"
}

if ! load_config "$CONFIG_PATH"; then
  fail_config
fi

REQUIRED_KEYS=(
  AI_WORKLOG_ACCOUNT_ID
  AI_WORKLOG_DEVICE_ID
  CODEX_SOURCE_INSTANCE_ID
  CODEX_SOURCE_PATH
  CLAUDE_CODE_SOURCE_INSTANCE_ID
  CLAUDE_CODE_SOURCE_PATH
  AI_WORKLOG_SYNC_URL
  AI_WORKLOG_DEVICE_TOKEN
)
for key in "${REQUIRED_KEYS[@]}"; do
  [[ "${!key:-}" =~ [^[:space:]] ]] || fail_config
done
[[ "$CODEX_SOURCE_PATH" == /* && "$CLAUDE_CODE_SOURCE_PATH" == /* ]] || fail_config
if [[ -n "${COLLECTOR_DB_PATH:-}" ]]; then
  [[ "$COLLECTOR_DB_PATH" == /* ]] || fail_config
fi
[[ -e "$CODEX_SOURCE_PATH" ]] || fail_config
[[ -e "$CLAUDE_CODE_SOURCE_PATH" ]] || fail_config
[[ "$CODEX_SOURCE_INSTANCE_ID" != "$CLAUDE_CODE_SOURCE_INSTANCE_ID" ]] || fail_config
[[ "$CODEX_SOURCE_PATH" != "$CLAUDE_CODE_SOURCE_PATH" ]] || fail_config

sync_authority="${AI_WORKLOG_SYNC_URL#*://}"
sync_authority="${sync_authority%%/*}"
[[ -n "$sync_authority" && "$sync_authority" != *"@"* ]] || fail_config

is_private_ipv4() {
  local address="$1"
  local first second third fourth octet
  [[ "$address" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  first="${BASH_REMATCH[1]}"
  second="${BASH_REMATCH[2]}"
  third="${BASH_REMATCH[3]}"
  fourth="${BASH_REMATCH[4]}"
  for octet in "$first" "$second" "$third" "$fourth"; do
    [[ "$octet" == "0" || "$octet" != 0* ]] || return 1
    ((10#$octet <= 255)) || return 1
  done
  ((
    first == 10 ||
    (first == 172 && second >= 16 && second <= 31) ||
    (first == 192 && second == 168)
  ))
}

insecure_lan_http="${AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP:-false}"
[[ "$insecure_lan_http" == "true" || "$insecure_lan_http" == "false" ]] || fail_config
case "$AI_WORKLOG_SYNC_URL" in
  https://*) ;;
  http://localhost|http://localhost/*|http://localhost:*|http://127.0.0.1|http://127.0.0.1/*|http://127.0.0.1:*|http://\[::1\]|http://\[::1\]/*|http://\[::1\]:*) ;;
  http://*)
    [[ "$insecure_lan_http" == "true" ]] || fail_config
    sync_host="${sync_authority%%:*}"
    [[ "$sync_authority" == "$sync_host" || "$sync_authority" == "$sync_host:"* ]] || fail_config
    is_private_ipv4 "$sync_host" || fail_config
    ;;
  *) fail_config ;;
esac

if [[ -n "${NODE_BINARY:-}" ]]; then
  [[ "$NODE_BINARY" == /* && -f "$NODE_BINARY" && -x "$NODE_BINARY" ]] || fail_config
else
  NODE_BINARY="$(command -v node 2>/dev/null || true)"
  [[ -n "$NODE_BINARY" && -x "$NODE_BINARY" ]] || fail_config
fi

TSX_CLI="$PROJECT_ROOT/node_modules/tsx/dist/cli.mjs"
COLLECTOR_CLI="$PROJECT_ROOT/apps/collector/src/index.ts"
[[ -f "$TSX_CLI" && -f "$COLLECTOR_CLI" ]] || fail_config

if [[ "$MODE" == "dry-run" ]]; then
  safe_event "validation" "dry-run"
  exit 0
fi
if [[ "$MODE" == "validate-only" ]]; then
  safe_event "validation" "ok"
  exit 0
fi

LOCK_PARENT="$HOME/Library/Caches/AIWorklog"
LOCK_FILE="$LOCK_PARENT/schedule.lock"
mkdir -p "$LOCK_PARENT"
chmod 700 "$LOCK_PARENT"
[[ -d "$LOCK_PARENT" && ! -L "$LOCK_PARENT" ]] || fail_config
[[ "$(config_owner "$LOCK_PARENT")" == "$(id -u)" ]] || fail_config
if [[ -e "$LOCK_FILE" || -L "$LOCK_FILE" ]]; then
  [[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] || fail_config
  [[ "$(config_owner "$LOCK_FILE")" == "$(id -u)" ]] || fail_config
fi
exec 9>"$LOCK_FILE" || fail_config
chmod 600 "$LOCK_FILE"
if ! /usr/bin/lockf -s -t 0 9; then
  safe_event "lock" "skipped"
  exit 0
fi

trap 'exit 130' INT
trap 'exit 143' TERM

run_collector_phase() {
  local command="$1"
  local log_phase="$2"
  local source_type="$3"
  if [[ -n "$source_type" ]]; then
    export AI_WORKLOG_SOURCE_TYPE="$source_type"
  else
    unset AI_WORKLOG_SOURCE_TYPE
  fi
  if "$NODE_BINARY" "$TSX_CLI" "$COLLECTOR_CLI" "$command" >/dev/null 2>&1; then
    safe_event "$log_phase" "ok"
    return 0
  fi
  safe_event "$log_phase" "failed" >&2
  return 1
}

safe_event "schedule" "started"
schedule_failed=0
run_collector_phase "prepare" "prepare-codex" "CODEX" || schedule_failed=1
run_collector_phase "prepare" "prepare-claude-code" "CLAUDE_CODE" || schedule_failed=1
run_collector_phase "sync" "sync" "" || schedule_failed=1
if ((schedule_failed == 0)); then
  safe_event "schedule" "completed"
  exit 0
fi
safe_event "schedule" "partial" >&2
exit 1
