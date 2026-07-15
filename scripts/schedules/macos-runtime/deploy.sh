#!/usr/bin/env bash
set -euo pipefail
umask 077

export PATH="/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/../../.." && pwd -P)"
MANAGED_ROOT="$HOME/Library/Application Support/AIWorklog"
DESTINATION="$MANAGED_ROOT/app"
DRY_RUN="false"

safe_event() {
  printf '{"event":"ai-worklog-runtime-deploy","status":"%s"}\n' "$1"
}

fail_deploy() {
  safe_event "failed" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --project-root)
      (($# >= 2)) || fail_deploy
      PROJECT_ROOT="$2"
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
case "$PROJECT_ROOT/" in
  "$MANAGED_ROOT/"*) fail_deploy ;;
esac

file_mode() {
  /usr/bin/stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null
}

file_owner() {
  /usr/bin/stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1" 2>/dev/null
}

ENVIRONMENT_FILE="$PROJECT_ROOT/.env.local"
NEXT_CLI="$PROJECT_ROOT/node_modules/next/dist/bin/next"
BUILD_ID="$PROJECT_ROOT/apps/web/.next/BUILD_ID"
[[ -f "$ENVIRONMENT_FILE" && ! -L "$ENVIRONMENT_FILE" ]] || fail_deploy
[[ -f "$NEXT_CLI" && -f "$BUILD_ID" && -s "$BUILD_ID" ]] || fail_deploy
mode="$(file_mode "$ENVIRONMENT_FILE")" || fail_deploy
owner="$(file_owner "$ENVIRONMENT_FILE")" || fail_deploy
[[ "$mode" == "600" && "$owner" == "$(id -u)" ]] || fail_deploy
[[ -x /usr/bin/rsync ]] || fail_deploy

if [[ "$DRY_RUN" == "true" ]]; then
  safe_event "dry-run"
  exit 0
fi

mkdir -p "$MANAGED_ROOT" "$DESTINATION"
chmod 700 "$MANAGED_ROOT" "$DESTINATION"
[[ ! -e "$DESTINATION/.git" ]] || fail_deploy

/usr/bin/rsync -a --delete \
  --exclude '.git' \
  --exclude 'artifacts' \
  --exclude 'coverage' \
  --exclude 'playwright-report' \
  --exclude 'test-results' \
  "$PROJECT_ROOT/" "$DESTINATION/" >/dev/null || fail_deploy

chmod 700 "$MANAGED_ROOT" "$DESTINATION"
chmod 600 "$DESTINATION/.env.local"
for required in \
  "$DESTINATION/node_modules/next/dist/bin/next" \
  "$DESTINATION/apps/web/.next/BUILD_ID" \
  "$DESTINATION/scripts/schedules/macos-web/run.sh" \
  "$DESTINATION/scripts/schedules/macos-worker/run.sh" \
  "$DESTINATION/scripts/schedules/macos/run.sh"; do
  [[ -f "$required" && ! -L "$required" ]] || fail_deploy
done

safe_event "deployed"
