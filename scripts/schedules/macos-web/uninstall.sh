#!/usr/bin/env bash
set -euo pipefail

LABEL="com.ai-worklog.web"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
DRY_RUN="false"

safe_event() {
  printf '{"event":"ai-worklog-web-uninstall","status":"%s"}\n' "$1"
}

if (($# > 1)); then
  safe_event "failed" >&2
  exit 1
fi
if (($# == 1)); then
  [[ "$1" == "--dry-run" ]] || {
    safe_event "failed" >&2
    exit 1
  }
  DRY_RUN="true"
fi

[[ "$(uname -s)" == "Darwin" ]] || {
  safe_event "failed" >&2
  exit 1
}
if [[ "$DRY_RUN" == "true" ]]; then
  safe_event "dry-run"
  exit 0
fi

service_target="gui/$(id -u)/$LABEL"
if /bin/launchctl print "$service_target" >/dev/null 2>&1; then
  if ! /bin/launchctl bootout "$service_target" >/dev/null 2>&1; then
    safe_event "failed" >&2
    exit 1
  fi
fi
rm -f "$PLIST_PATH"
safe_event "uninstalled"
