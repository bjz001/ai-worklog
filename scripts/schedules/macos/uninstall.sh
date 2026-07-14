#!/usr/bin/env bash
set -euo pipefail

LABEL="com.ai-worklog.collector"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
DRY_RUN="false"

if (($# > 1)); then
  printf '{"event":"ai-worklog-uninstall","status":"failed"}\n' >&2
  exit 1
fi
if (($# == 1)); then
  [[ "$1" == "--dry-run" ]] || {
    printf '{"event":"ai-worklog-uninstall","status":"failed"}\n' >&2
    exit 1
  }
  DRY_RUN="true"
fi

[[ "$(uname -s)" == "Darwin" ]] || {
  printf '{"event":"ai-worklog-uninstall","status":"failed"}\n' >&2
  exit 1
}
if [[ "$DRY_RUN" == "true" ]]; then
  printf '{"event":"ai-worklog-uninstall","status":"dry-run"}\n'
  exit 0
fi

/bin/launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"
printf '{"event":"ai-worklog-uninstall","status":"uninstalled"}\n'
