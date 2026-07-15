#!/usr/bin/env bash
set -euo pipefail
umask 077

export PATH="/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/../../.." && pwd -P)"
MANAGED_ROOT="$HOME/Library/Application Support/AIWorklog"
DESTINATION="$MANAGED_ROOT/app"
NODE_BINARY=""
DRY_RUN="false"
CURRENT_PHASE="validation"

STAGING_DIRECTORY=""
BACKUP_DIRECTORY=""
FAILED_DIRECTORY=""
OLD_DESTINATION_PRESENT="false"
NEW_DESTINATION_ACTIVE="false"
SERVICES_SUSPENDED="false"
DEPLOY_COMMITTED="false"

LABELS=(
  "com.ai-worklog.web"
  "com.ai-worklog.collector"
  "com.ai-worklog.worker"
)
PLIST_PATHS=(
  "$HOME/Library/LaunchAgents/com.ai-worklog.web.plist"
  "$HOME/Library/LaunchAgents/com.ai-worklog.collector.plist"
  "$HOME/Library/LaunchAgents/com.ai-worklog.worker.plist"
)
LOADED_INDEXES=()
DISABLED_INDEXES=()
STOPPED_INDEXES=()
RELOADED_INDEXES=()
LOADED_COUNT=0
DISABLED_COUNT=0
STOPPED_COUNT=0
RELOADED_COUNT=0
WEB_WAS_LOADED="false"
DISABLED_STATE_OUTPUT=""
LAUNCH_DOMAIN="gui/$(id -u)"
LOCK_PARENT="$HOME/Library/Caches/AIWorklog"
DEPLOY_LOCK="$LOCK_PARENT/runtime-deploy.lock"
BARRIER_LOCKS=(
  "$LOCK_PARENT/schedule.lock"
  "$LOCK_PARENT/worker-schedule.lock"
)
ACQUIRED_LOCKS=()
ACQUIRED_LOCK_COUNT=0

safe_event() {
  printf '{"event":"ai-worklog-runtime-deploy","phase":"%s","status":"%s"}\n' \
    "$CURRENT_PHASE" "$1"
}

fail_deploy() {
  safe_event "failed" >&2
  exit 1
}

file_owner() {
  /usr/bin/stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1" 2>/dev/null
}

is_regular_file_within() {
  local root="$1"
  local candidate="$2"
  local canonical_root canonical_parent
  [[ -f "$candidate" && ! -L "$candidate" ]] || return 1
  canonical_root="$(cd "$root" 2>/dev/null && pwd -P)" || return 1
  canonical_parent="$(cd "$(dirname "$candidate")" 2>/dev/null && pwd -P)" || return 1
  case "$canonical_parent/" in
    "$canonical_root/"*) return 0 ;;
    *) return 1 ;;
  esac
}

is_managed_temporary_directory() {
  local candidate="$1"
  case "$candidate" in
    "$MANAGED_ROOT"/.app.stage.*|"$MANAGED_ROOT"/.app.backup.*|"$MANAGED_ROOT"/.app.failed.*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

remove_managed_temporary_directory() {
  local candidate="$1"
  [[ -n "$candidate" ]] || return 0
  is_managed_temporary_directory "$candidate" || return 1
  if [[ -e "$candidate" || -L "$candidate" ]]; then
    [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
    rm -rf "$candidate"
  fi
}

wait_for_service_unloaded() {
  local target="$1"
  local _attempt
  for _attempt in {1..25}; do
    if ! /bin/launchctl print "$target" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

service_pid() {
  local target="$1"
  { /bin/launchctl print "$target" 2>/dev/null || true; } | \
    /usr/bin/awk -F ' = ' '/^[[:space:]]*pid = / { print $2; exit }'
}

service_is_disabled() {
  local label="$1"
  printf '%s\n' "$DISABLED_STATE_OUTPUT" | /usr/bin/awk -v label="$label" '
    index($0, "\"" label "\"") && index($0, "=> disabled") { found = 1 }
    END { exit(found ? 0 : 1) }
  '
}

wait_for_process_exit() {
  local pid="$1"
  local _attempt
  [[ -n "$pid" ]] || return 0
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  for _attempt in {1..50}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

acquire_barrier_lock() {
  local lock_directory="$1"
  local existing_pid=""
  local stale_directory
  local lock_name

  if mkdir "$lock_directory" 2>/dev/null; then
    if printf '%s\n' "$$" >"$lock_directory/pid"; then
      return 0
    fi
    rm -f "$lock_directory/pid"
    rmdir "$lock_directory" 2>/dev/null || true
    return 1
  fi

  [[ -d "$lock_directory" && ! -L "$lock_directory" ]] || return 1
  IFS= read -r existing_pid 2>/dev/null <"$lock_directory/pid" || true
  if [[ -z "$existing_pid" ]]; then
    sleep 1
    IFS= read -r existing_pid 2>/dev/null <"$lock_directory/pid" || true
  fi
  [[ "$existing_pid" =~ ^[1-9][0-9]*$ && "$existing_pid" != "1" ]] || return 1
  if kill -0 "$existing_pid" >/dev/null 2>&1; then
    return 1
  fi

  lock_name="${lock_directory##*/}"
  stale_directory="$LOCK_PARENT/${lock_name}.stale.deploy.$$.$RANDOM"
  [[ ! -e "$stale_directory" && ! -L "$stale_directory" ]] || return 1
  mv "$lock_directory" "$stale_directory" 2>/dev/null || return 1
  [[ -d "$stale_directory" && ! -L "$stale_directory" ]] || return 1
  rm -rf "$stale_directory"
  mkdir "$lock_directory" 2>/dev/null || return 1
  if printf '%s\n' "$$" >"$lock_directory/pid"; then
    return 0
  fi
  rm -f "$lock_directory/pid"
  rmdir "$lock_directory" 2>/dev/null || true
  return 1
}

release_barrier_locks() {
  local position lock_directory owner_pid
  local released="true"
  for ((position = ACQUIRED_LOCK_COUNT - 1; position >= 0; position -= 1)); do
    lock_directory="${ACQUIRED_LOCKS[$position]}"
    owner_pid=""
    if [[ -d "$lock_directory" && ! -L "$lock_directory" ]]; then
      IFS= read -r owner_pid 2>/dev/null <"$lock_directory/pid" || true
      if [[ "$owner_pid" == "$$" ]]; then
        rm -f "$lock_directory/pid" || released="false"
        rmdir "$lock_directory" 2>/dev/null || released="false"
      else
        released="false"
      fi
    elif [[ -e "$lock_directory" || -L "$lock_directory" ]]; then
      released="false"
    fi
  done
  [[ "$released" == "true" ]]
}

bootstrap_service_index() {
  local index="$1"
  local target="$LAUNCH_DOMAIN/${LABELS[$index]}"
  local pid
  /bin/launchctl bootstrap "$LAUNCH_DOMAIN" "${PLIST_PATHS[$index]}" >/dev/null 2>&1 || return 1
  if ! /bin/launchctl enable "$target" >/dev/null 2>&1; then
    pid="$(service_pid "$target")"
    /bin/launchctl bootout "$target" >/dev/null 2>&1 || true
    wait_for_service_unloaded "$target" || true
    wait_for_process_exit "$pid" || true
    return 1
  fi
}

restore_stopped_services() {
  local position index
  local restored="true"
  for ((position = 0; position < STOPPED_COUNT; position += 1)); do
    index="${STOPPED_INDEXES[$position]}"
    bootstrap_service_index "$index" || restored="false"
  done
  [[ "$restored" == "true" ]]
}

reenable_disabled_services() {
  local position index target
  local restored="true"
  for ((position = 0; position < DISABLED_COUNT; position += 1)); do
    index="${DISABLED_INDEXES[$position]}"
    target="$LAUNCH_DOMAIN/${LABELS[$index]}"
    /bin/launchctl enable "$target" >/dev/null 2>&1 || restored="false"
  done
  if [[ "$restored" != "true" ]]; then
    for ((position = 0; position < DISABLED_COUNT; position += 1)); do
      index="${DISABLED_INDEXES[$position]}"
      /bin/launchctl disable "$LAUNCH_DOMAIN/${LABELS[$index]}" >/dev/null 2>&1 || true
    done
  fi
  [[ "$restored" == "true" ]]
}

rollback_deploy() {
  local position index target pid
  local rollback_ok="true"
  local reloaded_stopped="true"
  local runtime_ready="false"
  local services_ready="true"

  for ((position = 0; position < RELOADED_COUNT; position += 1)); do
    index="${RELOADED_INDEXES[$position]}"
    target="$LAUNCH_DOMAIN/${LABELS[$index]}"
    pid="$(service_pid "$target")"
    if ! /bin/launchctl bootout "$target" >/dev/null 2>&1 ||
      ! wait_for_service_unloaded "$target" ||
      ! wait_for_process_exit "$pid"; then
      reloaded_stopped="false"
      rollback_ok="false"
    fi
  done

  if [[ "$reloaded_stopped" == "true" ]]; then
    if [[ "$NEW_DESTINATION_ACTIVE" == "true" \
      && "$OLD_DESTINATION_PRESENT" == "true" \
      && -d "$DESTINATION" && ! -L "$DESTINATION" ]]; then
      FAILED_DIRECTORY="$MANAGED_ROOT/.app.failed.$$.$RANDOM"
      if [[ ! -e "$FAILED_DIRECTORY" && ! -L "$FAILED_DIRECTORY" ]]; then
        mv "$DESTINATION" "$FAILED_DIRECTORY" || rollback_ok="false"
      else
        rollback_ok="false"
      fi
    fi

    if [[ "$OLD_DESTINATION_PRESENT" == "true" \
      && ! -e "$DESTINATION" && ! -L "$DESTINATION" ]]; then
      if [[ -d "$BACKUP_DIRECTORY" && ! -L "$BACKUP_DIRECTORY" ]]; then
        mv "$BACKUP_DIRECTORY" "$DESTINATION" || rollback_ok="false"
      else
        rollback_ok="false"
      fi
    fi

    if [[ -d "$DESTINATION" && ! -L "$DESTINATION" ]]; then
      runtime_ready="true"
      if ! restore_stopped_services; then
        services_ready="false"
        rollback_ok="false"
      fi
    else
      rollback_ok="false"
    fi
  fi

  if [[ "$rollback_ok" == "true" \
    && "$runtime_ready" == "true" && "$services_ready" == "true" ]]; then
    reenable_disabled_services || rollback_ok="false"
  else
    rollback_ok="false"
  fi

  if [[ "$rollback_ok" == "true" && "$runtime_ready" == "true" ]]; then
    remove_managed_temporary_directory "$FAILED_DIRECTORY" || rollback_ok="false"
  fi
  [[ "$rollback_ok" == "true" ]]
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if [[ "$status" -ne 0 && "$SERVICES_SUSPENDED" == "true" \
    && "$DEPLOY_COMMITTED" != "true" ]]; then
    if ! rollback_deploy; then
      CURRENT_PHASE="rollback"
      safe_event "failed" >&2
    fi
  fi

  remove_managed_temporary_directory "$STAGING_DIRECTORY" || true
  if [[ "$status" -eq 0 ]]; then
    remove_managed_temporary_directory "$BACKUP_DIRECTORY" || status=1
  fi
  release_barrier_locks || {
    if [[ "$status" -eq 0 ]]; then
      status=1
    fi
  }
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

while (($# > 0)); do
  case "$1" in
    --project-root)
      (($# >= 2)) || fail_deploy
      PROJECT_ROOT="$2"
      shift 2
      ;;
    --node)
      (($# >= 2)) || fail_deploy
      NODE_BINARY="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    *)
      fail_deploy
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || fail_deploy
[[ "$PROJECT_ROOT" != *$'\n'* && "$PROJECT_ROOT" != *$'\r'* ]] || fail_deploy
[[ -d "$PROJECT_ROOT" ]] || fail_deploy
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd -P)" || fail_deploy
CANONICAL_HOME="$(cd "$HOME" && pwd -P)" || fail_deploy
CANONICAL_MANAGED_ROOT="$CANONICAL_HOME/Library/Application Support/AIWorklog"
if [[ -d "$(dirname "$MANAGED_ROOT")" ]]; then
  CANONICAL_MANAGED_ROOT="$(cd "$(dirname "$MANAGED_ROOT")" && pwd -P)/AIWorklog" || \
    fail_deploy
fi
case "$PROJECT_ROOT/" in
  "$CANONICAL_MANAGED_ROOT/"*) fail_deploy ;;
esac
case "$CANONICAL_MANAGED_ROOT/" in
  "$PROJECT_ROOT/"*) fail_deploy ;;
esac

if [[ -z "$NODE_BINARY" ]]; then
  NODE_BINARY="$(command -v node 2>/dev/null || true)"
fi
[[ "$NODE_BINARY" == /* && "$NODE_BINARY" != *$'\n'* && "$NODE_BINARY" != *$'\r'* ]] || fail_deploy
[[ -f "$NODE_BINARY" && -x "$NODE_BINARY" ]] || fail_deploy

ENVIRONMENT_FILE="$PROJECT_ROOT/.env.local"
NEXT_CLI="$PROJECT_ROOT/node_modules/next/dist/bin/next"
BUILD_ID="$PROJECT_ROOT/apps/web/.next/BUILD_ID"
is_regular_file_within "$PROJECT_ROOT" "$ENVIRONMENT_FILE" || fail_deploy
is_regular_file_within "$PROJECT_ROOT" "$NEXT_CLI" || fail_deploy
is_regular_file_within "$PROJECT_ROOT" "$BUILD_ID" || fail_deploy
[[ -s "$BUILD_ID" ]] || fail_deploy
[[ "$(file_owner "$ENVIRONMENT_FILE")" == "$(id -u)" ]] || fail_deploy
[[ "$(/usr/bin/stat -f '%Lp' "$ENVIRONMENT_FILE")" == "600" ]] || fail_deploy
[[ -x /usr/bin/rsync ]] || fail_deploy

if [[ -e "$MANAGED_ROOT" || -L "$MANAGED_ROOT" ]]; then
  [[ -d "$MANAGED_ROOT" && ! -L "$MANAGED_ROOT" ]] || fail_deploy
  [[ "$(file_owner "$MANAGED_ROOT")" == "$(id -u)" ]] || fail_deploy
fi
if [[ -e "$DESTINATION" || -L "$DESTINATION" ]]; then
  [[ -d "$DESTINATION" && ! -L "$DESTINATION" ]] || fail_deploy
  [[ "$(file_owner "$DESTINATION")" == "$(id -u)" ]] || fail_deploy
fi

if [[ "$DRY_RUN" == "true" ]]; then
  safe_event "dry-run"
  exit 0
fi

CURRENT_PHASE="deployment-lock"
if [[ -e "$LOCK_PARENT" || -L "$LOCK_PARENT" ]]; then
  [[ -d "$LOCK_PARENT" && ! -L "$LOCK_PARENT" ]] || fail_deploy
  [[ "$(file_owner "$LOCK_PARENT")" == "$(id -u)" ]] || fail_deploy
else
  mkdir -p "$LOCK_PARENT" || fail_deploy
fi
chmod 700 "$LOCK_PARENT"
acquire_barrier_lock "$DEPLOY_LOCK" || fail_deploy
ACQUIRED_LOCKS[$ACQUIRED_LOCK_COUNT]="$DEPLOY_LOCK"
ACQUIRED_LOCK_COUNT=$((ACQUIRED_LOCK_COUNT + 1))

CURRENT_PHASE="staging"
mkdir -p "$MANAGED_ROOT"
[[ -d "$MANAGED_ROOT" && ! -L "$MANAGED_ROOT" ]] || fail_deploy
[[ "$(file_owner "$MANAGED_ROOT")" == "$(id -u)" ]] || fail_deploy
chmod 700 "$MANAGED_ROOT"

STAGING_DIRECTORY="$(mktemp -d "$MANAGED_ROOT/.app.stage.XXXXXX")" || fail_deploy
[[ -d "$STAGING_DIRECTORY" && ! -L "$STAGING_DIRECTORY" ]] || fail_deploy
chmod 700 "$STAGING_DIRECTORY"

/usr/bin/rsync -a \
  --exclude '.git' \
  --exclude '.data' \
  --exclude 'artifacts' \
  --exclude 'coverage' \
  --exclude 'playwright-report' \
  --exclude 'test-results' \
  --exclude 'tsconfig.tsbuildinfo' \
  --exclude '开发Promot.md' \
  "$PROJECT_ROOT/" "$STAGING_DIRECTORY/" >/dev/null || fail_deploy

chmod 700 "$STAGING_DIRECTORY"
chmod 600 "$STAGING_DIRECTORY/.env.local"
[[ ! -e "$STAGING_DIRECTORY/.git" && ! -L "$STAGING_DIRECTORY/.git" ]] || fail_deploy
for required in \
  "$STAGING_DIRECTORY/node_modules/next/dist/bin/next" \
  "$STAGING_DIRECTORY/apps/web/.next/BUILD_ID" \
  "$STAGING_DIRECTORY/scripts/schedules/macos-web/run.sh" \
  "$STAGING_DIRECTORY/scripts/schedules/macos-worker/run.sh" \
  "$STAGING_DIRECTORY/scripts/schedules/macos/run.sh"; do
  is_regular_file_within "$STAGING_DIRECTORY" "$required" || fail_deploy
done

/bin/bash "$STAGING_DIRECTORY/scripts/schedules/macos-web/run.sh" \
  --project-root "$STAGING_DIRECTORY" --node "$NODE_BINARY" --validate-only \
  >/dev/null 2>&1 || fail_deploy

CURRENT_PHASE="service-discovery"
DISABLED_STATE_OUTPUT="$(/bin/launchctl print-disabled "$LAUNCH_DOMAIN" 2>/dev/null)" || fail_deploy
for ((index = 0; index < ${#LABELS[@]}; index += 1)); do
  target="$LAUNCH_DOMAIN/${LABELS[$index]}"
  if /bin/launchctl print "$target" >/dev/null 2>&1; then
    [[ -f "${PLIST_PATHS[$index]}" && ! -L "${PLIST_PATHS[$index]}" ]] || fail_deploy
    if [[ "$index" == "0" ]]; then
      if service_is_disabled "${LABELS[$index]}"; then
        fail_deploy
      fi
      WEB_WAS_LOADED="true"
    elif service_is_disabled "${LABELS[$index]}"; then
      continue
    fi
    LOADED_INDEXES[$LOADED_COUNT]="$index"
    LOADED_COUNT=$((LOADED_COUNT + 1))
  elif [[ -e "${PLIST_PATHS[$index]}" || -L "${PLIST_PATHS[$index]}" ]]; then
    [[ -f "${PLIST_PATHS[$index]}" && ! -L "${PLIST_PATHS[$index]}" ]] || fail_deploy
  fi
done

CURRENT_PHASE="schedule-barrier"
for ((position = 0; position < ${#BARRIER_LOCKS[@]}; position += 1)); do
  acquire_barrier_lock "${BARRIER_LOCKS[$position]}" || fail_deploy
  ACQUIRED_LOCKS[$ACQUIRED_LOCK_COUNT]="${BARRIER_LOCKS[$position]}"
  ACQUIRED_LOCK_COUNT=$((ACQUIRED_LOCK_COUNT + 1))
done

CURRENT_PHASE="service-suspend"
SERVICES_SUSPENDED="true"
for ((position = 0; position < LOADED_COUNT; position += 1)); do
  index="${LOADED_INDEXES[$position]}"
  [[ "$index" != "0" ]] || continue
  target="$LAUNCH_DOMAIN/${LABELS[$index]}"
  /bin/launchctl disable "$target" >/dev/null 2>&1 || fail_deploy
  DISABLED_INDEXES[$DISABLED_COUNT]="$index"
  DISABLED_COUNT=$((DISABLED_COUNT + 1))
  state="$(/bin/launchctl print "$target" 2>/dev/null | \
    /usr/bin/awk -F ' = ' '/^[[:space:]]*state = / { print $2; exit }')"
  pid="$(service_pid "$target")"
  [[ "$state" == "not running" && -z "$pid" ]] || fail_deploy
done

for ((position = 0; position < LOADED_COUNT; position += 1)); do
  index="${LOADED_INDEXES[$position]}"
  [[ "$index" == "0" ]] || continue
  target="$LAUNCH_DOMAIN/${LABELS[$index]}"
  pid="$(service_pid "$target")"
  /bin/launchctl bootout "$target" >/dev/null 2>&1 || fail_deploy
  STOPPED_INDEXES[$STOPPED_COUNT]="$index"
  STOPPED_COUNT=$((STOPPED_COUNT + 1))
  wait_for_service_unloaded "$target" || fail_deploy
  wait_for_process_exit "$pid" || fail_deploy
done

CURRENT_PHASE="runtime-switch"
BACKUP_DIRECTORY="$MANAGED_ROOT/.app.backup.$$.$RANDOM"
[[ ! -e "$BACKUP_DIRECTORY" && ! -L "$BACKUP_DIRECTORY" ]] || fail_deploy
if [[ -d "$DESTINATION" && ! -L "$DESTINATION" ]]; then
  mv "$DESTINATION" "$BACKUP_DIRECTORY" || fail_deploy
  OLD_DESTINATION_PRESENT="true"
fi
mv "$STAGING_DIRECTORY" "$DESTINATION" || fail_deploy
STAGING_DIRECTORY=""
NEW_DESTINATION_ACTIVE="true"
chmod 700 "$DESTINATION"
chmod 600 "$DESTINATION/.env.local"

CURRENT_PHASE="service-restore"
for ((position = 0; position < STOPPED_COUNT; position += 1)); do
  index="${STOPPED_INDEXES[$position]}"
  case "$index" in
    0) CURRENT_PHASE="service-restore-web" ;;
    1) CURRENT_PHASE="service-restore-collector" ;;
    2) CURRENT_PHASE="service-restore-worker" ;;
    *) CURRENT_PHASE="service-restore" ;;
  esac
  bootstrap_service_index "$index" || fail_deploy
  RELOADED_INDEXES[$RELOADED_COUNT]="$index"
  RELOADED_COUNT=$((RELOADED_COUNT + 1))
done

if [[ "$WEB_WAS_LOADED" == "true" ]]; then
  CURRENT_PHASE="health-check"
  ready="false"
  for _attempt in {1..60}; do
    status="$(/usr/bin/curl --silent --noproxy '*' --output /dev/null \
      --write-out '%{http_code}' --connect-timeout 1 --max-time 2 \
      'http://172.18.209.21:3000/' 2>/dev/null || true)"
    if [[ "$status" == "401" ]] && \
      /bin/launchctl print "$LAUNCH_DOMAIN/com.ai-worklog.web" >/dev/null 2>&1; then
      ready="true"
      break
    fi
    sleep 0.5
  done
  [[ "$ready" == "true" ]] || fail_deploy
  sleep 1
  /bin/launchctl print "$LAUNCH_DOMAIN/com.ai-worklog.web" >/dev/null 2>&1 || fail_deploy
fi

CURRENT_PHASE="service-restore-schedules"
reenable_disabled_services || fail_deploy

CURRENT_PHASE="cleanup"
DEPLOY_COMMITTED="true"
SERVICES_SUSPENDED="false"
NEW_DESTINATION_ACTIVE="false"
remove_managed_temporary_directory "$BACKUP_DIRECTORY" || fail_deploy
BACKUP_DIRECTORY=""
CURRENT_PHASE="complete"
safe_event "deployed"
