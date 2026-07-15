#!/usr/bin/env bash
set -euo pipefail
umask 077

LABEL="com.ai-worklog.collector"
SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RUNNER_PATH="$SCRIPT_DIRECTORY/run.sh"
CONFIG_PATH="$HOME/.config/ai-worklog/collector.env"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIRECTORY="$HOME/Library/Logs/AIWorklog"
DRY_RUN="false"

safe_event() {
  printf '{"event":"ai-worklog-install","status":"%s"}\n' "$1"
}

fail_install() {
  safe_event "failed" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --config)
      (($# >= 2)) || fail_install
      CONFIG_PATH="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    *) fail_install ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || fail_install
[[ -f "$RUNNER_PATH" ]] || fail_install
[[ "$CONFIG_PATH" != *$'\n'* && "$CONFIG_PATH" != *$'\r'* ]] || fail_install
CONFIG_DIRECTORY="$(cd "$(dirname "$CONFIG_PATH")" 2>/dev/null && pwd -P)" || fail_install
CONFIG_PATH="$CONFIG_DIRECTORY/$(basename "$CONFIG_PATH")"
/bin/bash "$RUNNER_PATH" --config "$CONFIG_PATH" --validate-only >/dev/null 2>&1 || fail_install

if [[ "$DRY_RUN" == "true" ]]; then
  safe_event "dry-run"
  exit 0
fi

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g'
}

mkdir -p "$(dirname "$PLIST_PATH")" "$LOG_DIRECTORY"
chmod 700 "$LOG_DIRECTORY"
temporary_plist="$(mktemp "$PLIST_PATH.tmp.XXXXXX")"
cleanup() {
  rm -f "$temporary_plist"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

runner_xml="$(xml_escape "$RUNNER_PATH")"
config_xml="$(xml_escape "$CONFIG_PATH")"
log_xml="$(xml_escape "$LOG_DIRECTORY")"
cat >"$temporary_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$runner_xml</string>
    <string>--config</string>
    <string>$config_xml</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>18</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>$log_xml/schedule.log</string>
  <key>StandardErrorPath</key><string>$log_xml/schedule-error.log</string>
</dict>
</plist>
PLIST

/usr/bin/plutil -lint "$temporary_plist" >/dev/null || fail_install
/bin/launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
mv "$temporary_plist" "$PLIST_PATH"
chmod 600 "$PLIST_PATH"
/bin/launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || fail_install
/bin/launchctl enable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || fail_install
safe_event "installed"
