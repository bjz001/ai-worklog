#!/usr/bin/env bash
set -euo pipefail
umask 077

LABEL="com.ai-worklog.web"
SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RUNNER_PATH="$SCRIPT_DIRECTORY/run.sh"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/../../.." && pwd -P)"
NODE_BINARY=""
HOST="172.18.209.21"
PORT="3000"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIRECTORY="$HOME/Library/Logs/AIWorklog"
DRY_RUN="false"
TEMPORARY_PLIST=""
BACKUP_PLIST=""

safe_event() {
  printf '{"event":"ai-worklog-web-install","status":"%s"}\n' "$1"
}

cleanup() {
  [[ -z "$TEMPORARY_PLIST" ]] || rm -f "$TEMPORARY_PLIST"
  [[ -z "$BACKUP_PLIST" ]] || rm -f "$BACKUP_PLIST"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail_install() {
  safe_event "failed" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --project-root)
      (($# >= 2)) || fail_install
      PROJECT_ROOT="$2"
      shift 2
      ;;
    --node)
      (($# >= 2)) || fail_install
      NODE_BINARY="$2"
      shift 2
      ;;
    --host)
      (($# >= 2)) || fail_install
      HOST="$2"
      shift 2
      ;;
    --port)
      (($# >= 2)) || fail_install
      PORT="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    *)
      fail_install
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || fail_install
[[ -f "$RUNNER_PATH" && ! -L "$RUNNER_PATH" ]] || fail_install
[[ "$PROJECT_ROOT" != *$'\n'* && "$PROJECT_ROOT" != *$'\r'* ]] || fail_install
[[ -d "$PROJECT_ROOT" ]] || fail_install
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd -P)" || fail_install
if [[ -z "$NODE_BINARY" ]]; then
  NODE_BINARY="$(command -v node 2>/dev/null || true)"
fi
[[ "$NODE_BINARY" == /* && "$NODE_BINARY" != *$'\n'* && "$NODE_BINARY" != *$'\r'* ]] || fail_install
[[ -f "$NODE_BINARY" && -x "$NODE_BINARY" ]] || fail_install

/bin/bash "$RUNNER_PATH" \
  --project-root "$PROJECT_ROOT" --node "$NODE_BINARY" \
  --host "$HOST" --port "$PORT" --validate-only \
  >/dev/null 2>&1 || fail_install

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
touch "$LOG_DIRECTORY/web-service.log" "$LOG_DIRECTORY/web-service-error.log"
chmod 600 "$LOG_DIRECTORY/web-service.log" "$LOG_DIRECTORY/web-service-error.log"
TEMPORARY_PLIST="$(mktemp "$PLIST_PATH.tmp.XXXXXX")"

runner_xml="$(xml_escape "$RUNNER_PATH")"
project_xml="$(xml_escape "$PROJECT_ROOT")"
node_xml="$(xml_escape "$NODE_BINARY")"
host_xml="$(xml_escape "$HOST")"
port_xml="$(xml_escape "$PORT")"
log_xml="$(xml_escape "$LOG_DIRECTORY")"
cat >"$TEMPORARY_PLIST" <<PLIST
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
    <string>--project-root</string>
    <string>$project_xml</string>
    <string>--node</string>
    <string>$node_xml</string>
    <string>--host</string>
    <string>$host_xml</string>
    <string>--port</string>
    <string>$port_xml</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$project_xml</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$log_xml/web-service.log</string>
  <key>StandardErrorPath</key><string>$log_xml/web-service-error.log</string>
</dict>
</plist>
PLIST

/usr/bin/plutil -lint "$TEMPORARY_PLIST" >/dev/null || fail_install
had_existing="false"
if [[ -f "$PLIST_PATH" && ! -L "$PLIST_PATH" ]]; then
  BACKUP_PLIST="$(mktemp "$PLIST_PATH.backup.XXXXXX")"
  cp -p "$PLIST_PATH" "$BACKUP_PLIST"
  had_existing="true"
elif [[ -e "$PLIST_PATH" ]]; then
  fail_install
fi

/bin/launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
mv "$TEMPORARY_PLIST" "$PLIST_PATH"
TEMPORARY_PLIST=""
chmod 600 "$PLIST_PATH"

rollback() {
  /bin/launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  if [[ "$had_existing" == "true" ]]; then
    cp -p "$BACKUP_PLIST" "$PLIST_PATH"
    /bin/launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
  else
    rm -f "$PLIST_PATH"
  fi
}

if ! /bin/launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 ||
  ! /bin/launchctl enable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 ||
  ! /bin/launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 ||
  ! /bin/launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  rollback
  fail_install
fi

ready="false"
for _attempt in {1..20}; do
  status="$(/usr/bin/curl --silent --noproxy '*' --output /dev/null \
    --write-out '%{http_code}' --connect-timeout 1 --max-time 2 \
    "http://$HOST:$PORT/" 2>/dev/null || true)"
  if [[ "$status" == "401" ]]; then
    ready="true"
    break
  fi
  sleep 0.5
done
if [[ "$ready" != "true" ]]; then
  rollback
  fail_install
fi

safe_event "installed"
