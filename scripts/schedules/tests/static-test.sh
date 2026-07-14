#!/usr/bin/env bash
set -euo pipefail

SCHEDULE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROJECT_ROOT="$(cd "$SCHEDULE_ROOT/../.." && pwd -P)"

required_files=(
  "$SCHEDULE_ROOT/collector.env.example"
  "$SCHEDULE_ROOT/macos/com.ai-worklog.collector.plist.template"
  "$SCHEDULE_ROOT/macos/install.sh"
  "$SCHEDULE_ROOT/macos/run.sh"
  "$SCHEDULE_ROOT/macos/uninstall.sh"
  "$SCHEDULE_ROOT/windows/Install.ps1"
  "$SCHEDULE_ROOT/windows/Run.ps1"
  "$SCHEDULE_ROOT/windows/Uninstall.ps1"
  "$PROJECT_ROOT/README_SCHEDULES.md"
)

for file in "${required_files[@]}"; do
  [[ -f "$file" ]] || {
    printf 'missing required schedule file: %s\n' "$file" >&2
    exit 1
  }
done

for script in "$SCHEDULE_ROOT"/macos/*.sh "$SCHEDULE_ROOT/tests/"*.sh; do
  bash -n "$script"
done

plist="$SCHEDULE_ROOT/macos/com.ai-worklog.collector.plist.template"
grep -q '<integer>23</integer>' "$plist"
grep -q '<integer>30</integer>' "$plist"
grep -q '<string>--config</string>' "$plist"
if grep -Eqi 'AI_WORKLOG_DEVICE_TOKEN|Authorization:|Bearer[[:space:]]|123456' "$plist"; then
  printf 'launchd template must not contain credentials\n' >&2
  exit 1
fi

windows_install="$SCHEDULE_ROOT/windows/Install.ps1"
windows_runner="$SCHEDULE_ROOT/windows/Run.ps1"
grep -q 'AddHours(23)' "$windows_install"
grep -q 'AddMinutes(30)' "$windows_install"
grep -Fq '"CLAUDE_CODE_SOURCE_INSTANCE_ID"' "$windows_runner"
grep -Fq '"CLAUDE_CODE_SOURCE_PATH"' "$windows_runner"
windows_phase_patterns=(
  '-LogPhase "prepare-codex" -SourceType "CODEX"'
  '-LogPhase "prepare-claude-code" -SourceType "CLAUDE_CODE"'
  '-LogPhase "sync" -SourceType ""'
)
for pattern in "${windows_phase_patterns[@]}"; do
  phase_count="$(grep -Fc -- "$pattern" "$windows_runner")"
  [[ "$phase_count" == "1" ]] || {
    printf 'Windows runner must declare each collector phase exactly once\n' >&2
    exit 1
  }
done
if grep -Eqi 'AI_WORKLOG_DEVICE_TOKEN|Authorization:|Bearer[[:space:]]|123456' "$windows_install"; then
  printf 'Task Scheduler installer must not contain credentials\n' >&2
  exit 1
fi

grep -Fq 'CLAUDE_CODE_SOURCE_INSTANCE_ID=' "$SCHEDULE_ROOT/collector.env.example"
grep -Fq 'CLAUDE_CODE_SOURCE_PATH=' "$SCHEDULE_ROOT/collector.env.example"
grep -Fq 'CLAUDE_CODE prepare' "$PROJECT_ROOT/README_SCHEDULES.md"

if grep -Eq '(^|[[:space:]])source[[:space:]]|eval[[:space:]]' "$SCHEDULE_ROOT/macos/run.sh"; then
  printf 'macOS runner must parse, not execute, its config file\n' >&2
  exit 1
fi
if grep -Eqi 'Invoke-Expression|(^|[^A-Za-z])iex([^A-Za-z]|$)' "$SCHEDULE_ROOT/windows/Run.ps1"; then
  printf 'Windows runner must parse, not execute, its config file\n' >&2
  exit 1
fi

grep -Fq '>/dev/null 2>&1' "$SCHEDULE_ROOT/macos/run.sh"
grep -Fq '*> $null' "$SCHEDULE_ROOT/windows/Run.ps1"
grep -Fq '[Console]::Out.WriteLine($line)' "$SCHEDULE_ROOT/windows/Run.ps1"
if grep -Fq 'Write-Output $line' "$SCHEDULE_ROOT/windows/Run.ps1"; then
  printf 'safe logging must not pollute PowerShell function return values\n' >&2
  exit 1
fi

if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$plist" >/dev/null
fi
if command -v pwsh >/dev/null 2>&1; then
  for script in "$SCHEDULE_ROOT"/windows/*.ps1; do
    pwsh -NoLogo -NoProfile -NonInteractive -Command \
      '$null = [scriptblock]::Create([IO.File]::ReadAllText($args[0]))' "$script"
  done
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
mkdir -p "$temporary_directory/path with spaces"
config="$temporary_directory/path with spaces/collector.env"
owned_path="$temporary_directory/path with spaces/config-was-executed"
fake_node="$temporary_directory/path with spaces/fake-node"
capture_path="$temporary_directory/path with spaces/calls.log"
codex_source="$temporary_directory/path with spaces/codex source"
claude_code_source="$temporary_directory/path with spaces/claude code.jsonl"
canary='SCHEDULER_SECRET_CANARY_DO_NOT_PRINT'
mkdir -p "$codex_source"
: >"$claude_code_source"

cat >"$fake_node" <<'FAKE_NODE'
#!/usr/bin/env bash
printf '%s:%s\n' "${AI_WORKLOG_SOURCE_TYPE:-unset}" "${@: -1}" >>"$SCHEDULE_CAPTURE_PATH"
if [[ -n "${SCHEDULE_FAIL_SOURCE_TYPE:-}" && "${AI_WORKLOG_SOURCE_TYPE:-unset}" == "$SCHEDULE_FAIL_SOURCE_TYPE" ]]; then
  exit 1
fi
FAKE_NODE
chmod 700 "$fake_node"

cat >"$config" <<'CONFIG'
AI_WORKLOG_ACCOUNT_ID=account-test
AI_WORKLOG_DEVICE_ID=device-test
CODEX_SOURCE_INSTANCE_ID=codex-test
CLAUDE_CODE_SOURCE_INSTANCE_ID=claude-code-test
AI_WORKLOG_SYNC_URL=https://example.invalid/api/v1/sync/batches
AI_WORKLOG_DEVICE_TOKEN=SCHEDULER_SECRET_CANARY_DO_NOT_PRINT
CONFIG
printf 'CODEX_SOURCE_PATH=%s\n' "$codex_source" >>"$config"
printf 'CLAUDE_CODE_SOURCE_PATH=%s\n' "$claude_code_source" >>"$config"
printf 'AI_WORKLOG_PATH_HMAC_KEY=$(touch "%s")\n' "$owned_path" >>"$config"
printf 'NODE_BINARY=%s\n' "$fake_node" >>"$config"
chmod 600 "$config"

dry_run_output="$(bash "$SCHEDULE_ROOT/macos/run.sh" --config "$config" --dry-run 2>&1)"
[[ ! -e "$owned_path" ]] || {
  printf 'config value was executed as shell code\n' >&2
  exit 1
}
[[ "$dry_run_output" != *"$canary"* ]] || {
  printf 'dry-run exposed the device token\n' >&2
  exit 1
}
[[ "$dry_run_output" == *'"status":"dry-run"'* ]] || {
  printf 'dry-run did not report successful validation\n' >&2
  exit 1
}

chmod 644 "$config"
if bash "$SCHEDULE_ROOT/macos/run.sh" --config "$config" --dry-run \
  >"$temporary_directory/permissive.out" 2>&1; then
  printf 'runner accepted a group/world-readable config file\n' >&2
  exit 1
fi
chmod 600 "$config"

mkdir -p "$temporary_directory/home"
stale_lock="$temporary_directory/home/Library/Caches/AIWorklog/schedule.lock"
mkdir -p "$stale_lock"
printf '2147483647\n' >"$stale_lock/pid"
run_output="$(HOME="$temporary_directory/home" \
  SCHEDULE_CAPTURE_PATH="$capture_path" \
  bash "$SCHEDULE_ROOT/macos/run.sh" --config "$config" 2>&1)"
[[ "$run_output" != *"$canary"* ]] || {
  printf 'scheduled run exposed the device token\n' >&2
  exit 1
}
[[ "$run_output" == *'"phase":"prepare-codex","status":"ok"'* ]] || {
  printf 'scheduled run did not prepare Codex after recovering a stale lock\n' >&2
  exit 1
}
[[ "$run_output" == *'"phase":"prepare-claude-code","status":"ok"'* ]] || {
  printf 'scheduled run did not prepare Claude Code\n' >&2
  exit 1
}
[[ "$run_output" == *'"phase":"sync","status":"ok"'* ]] || {
  printf 'scheduled run did not sync after preparing\n' >&2
  exit 1
}
[[ "$run_output" == *'"phase":"schedule","status":"completed"'* ]] || {
  printf 'scheduled run did not report completion\n' >&2
  exit 1
}
[[ ! -e "$stale_lock" ]] || {
  printf 'scheduled run left a stale lock behind\n' >&2
  exit 1
}
expected_calls=$'CODEX:prepare\nCLAUDE_CODE:prepare\nunset:sync'
actual_calls="$(cat "$capture_path")"
[[ "$actual_calls" == "$expected_calls" ]] || {
  printf 'collector phases did not run exactly once in CODEX, CLAUDE_CODE, sync order\n' >&2
  exit 1
}

: >"$capture_path"
if HOME="$temporary_directory/home" \
  SCHEDULE_CAPTURE_PATH="$capture_path" \
  SCHEDULE_FAIL_SOURCE_TYPE="CODEX" \
  bash "$SCHEDULE_ROOT/macos/run.sh" --config "$config" \
  >"$temporary_directory/partial.out" 2>&1; then
  printf 'scheduled run hid a partial prepare failure\n' >&2
  exit 1
fi
partial_calls="$(cat "$capture_path")"
[[ "$partial_calls" == "$expected_calls" ]] || {
  printf 'a failed source prevented the other source or Outbox sync\n' >&2
  exit 1
}
grep -q '"phase":"prepare-codex","status":"failed"' "$temporary_directory/partial.out"
grep -q '"phase":"prepare-claude-code","status":"ok"' "$temporary_directory/partial.out"
grep -q '"phase":"sync","status":"ok"' "$temporary_directory/partial.out"
grep -q '"phase":"schedule","status":"partial"' "$temporary_directory/partial.out"

if [[ "$(uname -s)" == "Darwin" ]]; then
  install_output="$(HOME="$temporary_directory/home" \
    bash "$SCHEDULE_ROOT/macos/install.sh" --config "$config" --dry-run 2>&1)"
  [[ "$install_output" == *'"status":"dry-run"'* ]] || {
    printf 'macOS installer dry-run failed\n' >&2
    exit 1
  }
  uninstall_output="$(HOME="$temporary_directory/home" \
    bash "$SCHEDULE_ROOT/macos/uninstall.sh" --dry-run 2>&1)"
  [[ "$uninstall_output" == *'"status":"dry-run"'* ]] || {
    printf 'macOS uninstaller dry-run failed\n' >&2
    exit 1
  }
fi

invalid_config="$temporary_directory/invalid.env"
cp "$config" "$invalid_config"
printf 'UNSUPPORTED_SENSITIVE_VALUE=do-not-print-this\n' >>"$invalid_config"
chmod 600 "$invalid_config"
if bash "$SCHEDULE_ROOT/macos/run.sh" --config "$invalid_config" --dry-run \
  >"$temporary_directory/invalid.out" 2>&1; then
  printf 'runner accepted an unknown config key\n' >&2
  exit 1
fi
if grep -q 'do-not-print-this' "$temporary_directory/invalid.out"; then
  printf 'runner exposed an invalid config value\n' >&2
  exit 1
fi

duplicate_config="$temporary_directory/duplicate.env"
cp "$config" "$duplicate_config"
printf 'AI_WORKLOG_DEVICE_ID=duplicate-do-not-print\n' >>"$duplicate_config"
chmod 600 "$duplicate_config"
if bash "$SCHEDULE_ROOT/macos/run.sh" --config "$duplicate_config" --dry-run \
  >"$temporary_directory/duplicate.out" 2>&1; then
  printf 'runner accepted a duplicate config key\n' >&2
  exit 1
fi
if grep -q 'duplicate-do-not-print' "$temporary_directory/duplicate.out"; then
  printf 'runner exposed a duplicate config value\n' >&2
  exit 1
fi

bad_endpoint_config="$temporary_directory/bad-endpoint.env"
sed 's#https://example.invalid#https://user:embedded-secret@example.invalid#' \
  "$config" >"$bad_endpoint_config"
chmod 600 "$bad_endpoint_config"
if bash "$SCHEDULE_ROOT/macos/run.sh" --config "$bad_endpoint_config" --dry-run \
  >"$temporary_directory/bad-endpoint.out" 2>&1; then
  printf 'runner accepted credentials embedded in the sync URL\n' >&2
  exit 1
fi
if grep -q 'embedded-secret' "$temporary_directory/bad-endpoint.out"; then
  printf 'runner exposed credentials embedded in the sync URL\n' >&2
  exit 1
fi

printf 'schedule static checks passed\n'
