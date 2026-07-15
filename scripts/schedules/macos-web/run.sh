#!/usr/bin/env bash
set -euo pipefail
umask 077

export PATH="/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/../../.." && pwd -P)"
NODE_BINARY=""
HOST="172.18.209.21"
PORT="3000"
MODE="run"

safe_event() {
  local phase="$1"
  local status="$2"
  local timestamp
  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '{"event":"ai-worklog-web-schedule","phase":"%s","status":"%s","at":"%s"}\n' \
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
    --host)
      (($# >= 2)) || fail_validation
      HOST="$2"
      shift 2
      ;;
    --port)
      (($# >= 2)) || fail_validation
      PORT="$2"
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

[[ "$(uname -s)" == "Darwin" ]] || fail_validation
is_private_ipv4 "$HOST" || fail_validation
[[ "$PORT" =~ ^[1-9][0-9]{3,4}$ ]] || fail_validation
((10#$PORT >= 1024 && 10#$PORT <= 65535)) || fail_validation
[[ "$PROJECT_ROOT" != *$'\n'* && "$PROJECT_ROOT" != *$'\r'* ]] || fail_validation
[[ -d "$PROJECT_ROOT" ]] || fail_validation
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd -P)" || fail_validation
[[ "$NODE_BINARY" == /* && "$NODE_BINARY" != *$'\n'* && "$NODE_BINARY" != *$'\r'* ]] || fail_validation
[[ -f "$NODE_BINARY" && -x "$NODE_BINARY" ]] || fail_validation

file_mode() {
  /usr/bin/stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null
}

file_owner() {
  /usr/bin/stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1" 2>/dev/null
}

ENVIRONMENT_FILE="$PROJECT_ROOT/.env.local"
[[ -f "$ENVIRONMENT_FILE" && ! -L "$ENVIRONMENT_FILE" && -r "$ENVIRONMENT_FILE" ]] || fail_validation
mode="$(file_mode "$ENVIRONMENT_FILE")" || fail_validation
owner="$(file_owner "$ENVIRONMENT_FILE")" || fail_validation
[[ "$mode" == "600" && "$owner" == "$(id -u)" ]] || fail_validation

expected_origin="http://$HOST:$PORT"
app_base_url=""
app_base_count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  if [[ "$line" == APP_BASE_URL=* ]]; then
    ((app_base_count += 1))
    app_base_url="${line#APP_BASE_URL=}"
    if ((${#app_base_url} >= 2)) &&
      { [[ "${app_base_url:0:1}" == '"' && "${app_base_url: -1}" == '"' ]] ||
        [[ "${app_base_url:0:1}" == "'" && "${app_base_url: -1}" == "'" ]]; }; then
      app_base_url="${app_base_url:1:${#app_base_url}-2}"
    fi
  fi
done <"$ENVIRONMENT_FILE"
[[ "$app_base_count" == "1" && "$app_base_url" == "$expected_origin" ]] || fail_validation

/sbin/ifconfig | /usr/bin/awk -v host="$HOST" \
  '$1 == "inet" && $2 == host { found = 1 } END { exit(found ? 0 : 1) }' || fail_validation

NEXT_CLI="$PROJECT_ROOT/node_modules/next/dist/bin/next"
BUILD_ID="$PROJECT_ROOT/apps/web/.next/BUILD_ID"
[[ -f "$NEXT_CLI" && ! -L "$NEXT_CLI" ]] || fail_validation
[[ -f "$BUILD_ID" && ! -L "$BUILD_ID" && -s "$BUILD_ID" ]] || fail_validation

cd "$PROJECT_ROOT"
unset NODE_ENV NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED

if [[ "$MODE" == "dry-run" ]]; then
  safe_event "validation" "dry-run"
  exit 0
fi
if [[ "$MODE" == "validate-only" ]]; then
  safe_event "validation" "ok"
  exit 0
fi

safe_event "server" "starting"
exec "$NODE_BINARY" "$NEXT_CLI" start "$PROJECT_ROOT/apps/web" \
  --hostname "$HOST" --port "$PORT"
