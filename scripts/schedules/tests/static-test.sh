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
  "$SCHEDULE_ROOT/macos-worker/com.ai-worklog.worker.plist.template"
  "$SCHEDULE_ROOT/macos-worker/install.sh"
  "$SCHEDULE_ROOT/macos-worker/run.sh"
  "$SCHEDULE_ROOT/macos-worker/uninstall.sh"
  "$SCHEDULE_ROOT/macos-web/com.ai-worklog.web.plist.template"
  "$SCHEDULE_ROOT/macos-web/install.sh"
  "$SCHEDULE_ROOT/macos-web/run.sh"
  "$SCHEDULE_ROOT/macos-web/uninstall.sh"
  "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
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

for script in \
  "$SCHEDULE_ROOT"/macos/*.sh \
  "$SCHEDULE_ROOT"/macos-worker/*.sh \
  "$SCHEDULE_ROOT"/macos-web/*.sh \
  "$SCHEDULE_ROOT"/macos-runtime/*.sh \
  "$SCHEDULE_ROOT/tests/"*.sh; do
  bash -n "$script"
done

plist="$SCHEDULE_ROOT/macos/com.ai-worklog.collector.plist.template"
collector_installer="$SCHEDULE_ROOT/macos/install.sh"
collector_hour="$(awk '/<key>Hour<\/key>/ { getline; gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit }' "$plist")"
collector_minute="$(awk '/<key>Minute<\/key>/ { getline; gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit }' "$plist")"
[[ "$collector_hour" == '<integer>18</integer>' ]]
[[ "$collector_minute" == '<integer>0</integer>' ]]
grep -q '<key>Hour</key><integer>18</integer>' "$collector_installer"
grep -q '<key>Minute</key><integer>0</integer>' "$collector_installer"
grep -q '<string>--config</string>' "$plist"
if grep -Eqi 'AI_WORKLOG_DEVICE_TOKEN|Authorization:|Bearer[[:space:]]|123456' "$plist"; then
  printf 'launchd template must not contain credentials\n' >&2
  exit 1
fi

worker_plist="$SCHEDULE_ROOT/macos-worker/com.ai-worklog.worker.plist.template"
worker_installer="$SCHEDULE_ROOT/macos-worker/install.sh"
grep -q '<string>com.ai-worklog.worker</string>' "$worker_plist"
grep -q '<integer>23</integer>' "$worker_plist"
grep -q '<integer>40</integer>' "$worker_plist"
grep -q '<key>WorkingDirectory</key>' "$worker_plist"
grep -q '<string>--project-root</string>' "$worker_plist"
grep -q '<string>--node</string>' "$worker_plist"
grep -q '<key>Hour</key><integer>23</integer>' "$worker_installer"
grep -q '<key>Minute</key><integer>40</integer>' "$worker_installer"
grep -q '<key>WorkingDirectory</key>' "$worker_installer"
grep -q -- '--project-root' "$worker_installer"
grep -q -- '--node' "$worker_installer"
if grep -ERqi \
  'MYSQL_(PASSWORD|URL)|DATABASE_URL|LLM_SETTINGS_ENCRYPTION_KEY|API_KEY|Authorization:|Bearer[[:space:]]|123456' \
  "$SCHEDULE_ROOT/macos-worker"; then
  printf 'worker launchd files must not contain credentials\n' >&2
  exit 1
fi
if grep -ERq -- '--backfill|[0-9]{4}-[0-9]{2}-[0-9]{2}' \
  "$SCHEDULE_ROOT/macos-worker"; then
  printf 'scheduled worker must use the bounded default command\n' >&2
  exit 1
fi

web_plist="$SCHEDULE_ROOT/macos-web/com.ai-worklog.web.plist.template"
web_installer="$SCHEDULE_ROOT/macos-web/install.sh"
grep -q '<string>com.ai-worklog.web</string>' "$web_plist"
grep -q '<key>RunAtLoad</key>' "$web_plist"
grep -q '<key>KeepAlive</key><true/>' "$web_plist"
grep -q '<key>ThrottleInterval</key><integer>30</integer>' "$web_plist"
grep -q '<key>WorkingDirectory</key>' "$web_plist"
grep -q '<string>--project-root</string>' "$web_plist"
grep -q '<string>--node</string>' "$web_plist"
grep -q '<string>--host</string>' "$web_plist"
grep -q '<string>--port</string>' "$web_plist"
grep -q '<key>RunAtLoad</key>' "$web_installer"
grep -q '<key>KeepAlive</key><true/>' "$web_installer"
grep -q '<key>ThrottleInterval</key><integer>30</integer>' "$web_installer"
grep -Fq -- "--noproxy '*'" "$web_installer"
if grep -ERqi \
  'MYSQL_(PASSWORD|URL)|DATABASE_URL|LLM_SETTINGS_ENCRYPTION_KEY|API_KEY|Authorization:|Bearer[[:space:]]|123456' \
  "$SCHEDULE_ROOT/macos-web"; then
  printf 'web launchd files must not contain credentials\n' >&2
  exit 1
fi
if grep -Eq '(^|[[:space:]])source[[:space:]]|eval[[:space:]]' \
  "$SCHEDULE_ROOT/macos-web/run.sh"; then
  printf 'web runner must not execute environment files\n' >&2
  exit 1
fi

windows_install="$SCHEDULE_ROOT/windows/Install.ps1"
windows_runner="$SCHEDULE_ROOT/windows/Run.ps1"
grep -q 'AddHours(23)' "$windows_install"
grep -q 'AddMinutes(30)' "$windows_install"
grep -Fq '"CLAUDE_CODE_SOURCE_INSTANCE_ID"' "$windows_runner"
grep -Fq '"CLAUDE_CODE_SOURCE_PATH"' "$windows_runner"
grep -Fq '"AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP"' "$windows_runner"
grep -Fq '"NODE_EXTRA_CA_CERTS"' "$windows_runner"
grep -Fq 'Test-PrivateIPv4' "$windows_runner"
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
if grep -Eqi "NODE_TLS_REJECT_UNAUTHORIZED[^\r\n]*[=:][[:space:]]*0|rejectUnauthorized[[:space:]]*=[[:space:]]*false|curl([.]exe)?[[:space:]].*(-k|--insecure)" \
  "$SCHEDULE_ROOT/windows/Run.ps1" "$PROJECT_ROOT/README_SCHEDULES.md"; then
  printf 'Windows TLS validation must never be disabled\n' >&2
  exit 1
fi

grep -Fq 'CLAUDE_CODE_SOURCE_INSTANCE_ID=' "$SCHEDULE_ROOT/collector.env.example"
grep -Fq 'CLAUDE_CODE_SOURCE_PATH=' "$SCHEDULE_ROOT/collector.env.example"
grep -Fq 'AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP=false' "$SCHEDULE_ROOT/collector.env.example"
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
  plutil -lint "$worker_plist" >/dev/null
  plutil -lint "$web_plist" >/dev/null
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
mkdir -p "$(dirname "$stale_lock")"
printf 'pre-existing-lock-file\n' >"$stale_lock"
chmod 600 "$stale_lock"
run_output="$(HOME="$temporary_directory/home" \
  SCHEDULE_CAPTURE_PATH="$capture_path" \
  bash "$SCHEDULE_ROOT/macos/run.sh" --config "$config" 2>&1)"
[[ "$run_output" != *"$canary"* ]] || {
  printf 'scheduled run exposed the device token\n' >&2
  exit 1
}
[[ "$run_output" == *'"phase":"prepare-codex","status":"ok"'* ]] || {
  printf 'scheduled run did not prepare Codex with a reusable lock file\n' >&2
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
[[ -f "$stale_lock" && ! -L "$stale_lock" ]] || {
  printf 'scheduled run did not preserve its reusable lock file\n' >&2
  exit 1
}
expected_calls=$'CODEX:prepare\nCLAUDE_CODE:prepare\nunset:sync'
actual_calls="$(cat "$capture_path")"
[[ "$actual_calls" == "$expected_calls" ]] || {
  printf 'collector phases did not run exactly once in CODEX, CLAUDE_CODE, sync order\n' >&2
  exit 1
}

: >"$capture_path"
collector_lock_ready="$temporary_directory/collector-lock-ready"
/usr/bin/lockf -k -t 0 "$stale_lock" /bin/bash -c \
  'printf ready >"$1"; sleep 2' lock-holder "$collector_lock_ready" &
collector_lock_holder=$!
for _attempt in {1..40}; do
  [[ -e "$collector_lock_ready" ]] && break
  sleep 0.05
done
[[ -e "$collector_lock_ready" ]] || {
  printf 'collector lock holder did not start\n' >&2
  exit 1
}
collector_lock_output="$(HOME="$temporary_directory/home" \
  SCHEDULE_CAPTURE_PATH="$capture_path" \
  bash "$SCHEDULE_ROOT/macos/run.sh" --config "$config" 2>&1)"
[[ "$collector_lock_output" == *'"phase":"lock","status":"skipped"'* \
  && ! -s "$capture_path" ]] || {
  printf 'collector did not honor an active kernel lock\n' >&2
  exit 1
}
wait "$collector_lock_holder"

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

private_http_config="$temporary_directory/private-http.env"
sed 's#https://example.invalid#http://172.18.209.21:3000#' \
  "$config" >"$private_http_config"
chmod 600 "$private_http_config"
if bash "$SCHEDULE_ROOT/macos/run.sh" --config "$private_http_config" --dry-run \
  >"$temporary_directory/private-http-denied.out" 2>&1; then
  printf 'runner accepted private HTTP without explicit opt-in\n' >&2
  exit 1
fi
printf 'AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP=true\n' >>"$private_http_config"
private_http_output="$(
  bash "$SCHEDULE_ROOT/macos/run.sh" --config "$private_http_config" --dry-run 2>&1
)"
[[ "$private_http_output" == *'"status":"dry-run"'* ]] || {
  printf 'runner rejected explicitly enabled private HTTP\n' >&2
  exit 1
}

if [[ "$(uname -s)" == "Darwin" ]]; then
  web_root="$temporary_directory/web root"
  web_home="$temporary_directory/web-home"
  web_fake_node="$temporary_directory/path with spaces/fake-web-node"
  mkdir -p \
    "$web_root/node_modules/next/dist/bin" \
    "$web_root/apps/web/.next" \
    "$web_home"
  : >"$web_root/node_modules/next/dist/bin/next"
  printf 'test-build\n' >"$web_root/apps/web/.next/BUILD_ID"
  printf 'APP_BASE_URL=http://172.18.209.21:3000\nMYSQL_PASSWORD=WEB_SECRET_CANARY\n' \
    >"$web_root/.env.local"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$web_fake_node"
  chmod 600 "$web_root/.env.local"
  chmod 700 "$web_fake_node"

  web_dry_output="$(HOME="$web_home" bash "$SCHEDULE_ROOT/macos-web/run.sh" \
    --project-root "$web_root" --node "$web_fake_node" --dry-run 2>&1)"
  [[ "$web_dry_output" == *'"status":"dry-run"'* \
    && "$web_dry_output" != *'WEB_SECRET_CANARY'* ]] || {
    printf 'web runner dry-run failed or exposed an environment value\n' >&2
    exit 1
  }
  web_install_output="$(HOME="$web_home" bash "$SCHEDULE_ROOT/macos-web/install.sh" \
    --project-root "$web_root" --node "$web_fake_node" --dry-run 2>&1)"
  [[ "$web_install_output" == *'"status":"dry-run"'* ]] || {
    printf 'web installer dry-run failed\n' >&2
    exit 1
  }
  web_uninstall_output="$(HOME="$web_home" \
    bash "$SCHEDULE_ROOT/macos-web/uninstall.sh" --dry-run 2>&1)"
  [[ "$web_uninstall_output" == *'"status":"dry-run"'* ]] || {
    printf 'web uninstaller dry-run failed\n' >&2
    exit 1
  }

  runtime_project="$temporary_directory/runtime project"
  runtime_fake_node="$temporary_directory/path with spaces/fake-runtime-node"
  mkdir -p \
    "$runtime_project/node_modules/next/dist/bin" \
    "$runtime_project/apps/web/.next"
  : >"$runtime_project/node_modules/next/dist/bin/next"
  printf 'runtime-test-build\n' >"$runtime_project/apps/web/.next/BUILD_ID"
  printf 'APP_BASE_URL=http://172.18.209.21:3000\n' >"$runtime_project/.env.local"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$runtime_fake_node"
  chmod 600 "$runtime_project/.env.local"
  chmod 700 "$runtime_fake_node"

  runtime_ancestor_home="$temporary_directory/runtime-ancestor-home"
  mkdir -p \
    "$runtime_ancestor_home/node_modules/next/dist/bin" \
    "$runtime_ancestor_home/apps/web/.next"
  : >"$runtime_ancestor_home/node_modules/next/dist/bin/next"
  printf 'runtime-test-build\n' >"$runtime_ancestor_home/apps/web/.next/BUILD_ID"
  printf 'APP_BASE_URL=http://172.18.209.21:3000\n' \
    >"$runtime_ancestor_home/.env.local"
  chmod 600 "$runtime_ancestor_home/.env.local"
  if HOME="$runtime_ancestor_home" \
    bash "$SCHEDULE_ROOT/macos-runtime/deploy.sh" \
      --project-root "$runtime_ancestor_home" --node "$runtime_fake_node" --dry-run \
      >"$temporary_directory/runtime-ancestor.out" 2>&1; then
    printf 'runtime deploy accepted a project root containing its managed runtime\n' >&2
    exit 1
  fi

  runtime_empty_lock_home="$temporary_directory/runtime-empty-lock-home"
  runtime_empty_lock="$runtime_empty_lock_home/Library/Caches/AIWorklog/runtime-deploy.lock"
  runtime_lock_ready="$temporary_directory/runtime-lock-ready"
  mkdir -p "$(dirname "$runtime_empty_lock")"
  : >"$runtime_empty_lock"
  chmod 600 "$runtime_empty_lock"
  /usr/bin/lockf -k -t 0 "$runtime_empty_lock" /bin/bash -c \
    'printf ready >"$1"; sleep 2' lock-holder "$runtime_lock_ready" &
  runtime_lock_holder=$!
  for _attempt in {1..40}; do
    [[ -e "$runtime_lock_ready" ]] && break
    sleep 0.05
  done
  [[ -e "$runtime_lock_ready" ]] || {
    printf 'runtime deployment lock holder did not start\n' >&2
    exit 1
  }
  if HOME="$runtime_empty_lock_home" \
    bash "$SCHEDULE_ROOT/macos-runtime/deploy.sh" \
      --project-root "$runtime_project" --node "$runtime_fake_node" \
      >"$temporary_directory/runtime-empty-lock.out" 2>&1; then
    printf 'runtime deploy ignored an active kernel deployment lock\n' >&2
    exit 1
  fi
  wait "$runtime_lock_holder"
  grep -q '"phase":"deployment-lock","status":"failed"' \
    "$temporary_directory/runtime-empty-lock.out"
  [[ -f "$runtime_empty_lock" && ! -L "$runtime_empty_lock" ]] || {
    printf 'runtime deploy replaced its kernel lock file\n' >&2
    exit 1
  }

  runtime_nested_project="$temporary_directory/runtime nested project"
  runtime_nested_target="$temporary_directory/runtime nested target"
  runtime_nested_home="$temporary_directory/runtime-nested-home"
  mkdir -p \
    "$runtime_nested_project/node_modules" \
    "$runtime_nested_project/apps/web/.next" \
    "$runtime_nested_target/dist/bin" \
    "$runtime_nested_home"
  ln -s "$runtime_nested_target" "$runtime_nested_project/node_modules/next"
  : >"$runtime_nested_target/dist/bin/next"
  printf 'runtime-test-build\n' >"$runtime_nested_project/apps/web/.next/BUILD_ID"
  printf 'APP_BASE_URL=http://172.18.209.21:3000\n' \
    >"$runtime_nested_project/.env.local"
  chmod 600 "$runtime_nested_project/.env.local"
  if HOME="$runtime_nested_home" \
    bash "$SCHEDULE_ROOT/macos-runtime/deploy.sh" \
      --project-root "$runtime_nested_project" --node "$runtime_fake_node" --dry-run \
      >"$temporary_directory/runtime-nested-symlink.out" 2>&1; then
    printf 'runtime deploy accepted a required file through an escaping parent symlink\n' >&2
    exit 1
  fi

  runtime_symlink_home="$temporary_directory/runtime-symlink-home"
  runtime_symlink_target="$temporary_directory/runtime-symlink-target"
  mkdir -p "$runtime_symlink_home/Library/Application Support" "$runtime_symlink_target"
  ln -s "$runtime_symlink_target" \
    "$runtime_symlink_home/Library/Application Support/AIWorklog"
  if HOME="$runtime_symlink_home" \
    bash "$SCHEDULE_ROOT/macos-runtime/deploy.sh" \
      --project-root "$runtime_project" --node "$runtime_fake_node" --dry-run \
      >"$temporary_directory/runtime-symlink.out" 2>&1; then
    printf 'runtime deploy accepted a symlinked managed root\n' >&2
    exit 1
  fi

  runtime_destination_home="$temporary_directory/runtime-destination-home"
  runtime_destination_target="$temporary_directory/runtime-destination-target"
  mkdir -p \
    "$runtime_destination_home/Library/Application Support/AIWorklog" \
    "$runtime_destination_target"
  ln -s "$runtime_destination_target" \
    "$runtime_destination_home/Library/Application Support/AIWorklog/app"
  if HOME="$runtime_destination_home" \
    bash "$SCHEDULE_ROOT/macos-runtime/deploy.sh" \
      --project-root "$runtime_project" --node "$runtime_fake_node" --dry-run \
      >"$temporary_directory/runtime-destination-symlink.out" 2>&1; then
    printf 'runtime deploy accepted a symlinked destination\n' >&2
    exit 1
  fi

  grep -Fq '.app.stage.XXXXXX' "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
  grep -Fq 'launchctl disable' "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
  grep -Fq 'launchctl print-disabled' "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
  grep -Fq 'service_is_disabled' "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
  grep -Fq 'launchctl bootout' "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
  grep -Fq 'launchctl bootstrap' "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
  grep -Fq 'schedule.lock' "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
  grep -Fq 'worker-schedule.lock' "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
  grep -Fq 'runtime-deploy.lock' "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
  grep -Fq '/usr/bin/lockf -s -t 0' "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
  grep -Fq '/usr/bin/lockf -s -t 0' "$SCHEDULE_ROOT/macos/run.sh"
  grep -Fq '/usr/bin/lockf -s -t 0' "$SCHEDULE_ROOT/macos-worker/run.sh"
  grep -Fq 'reenable_disabled_services' "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
  grep -Fq 'rollback_ok' "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
  grep -Fq -- "--exclude '.data'" "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
  grep -Fq -- "--exclude '开发Promot.md'" "$SCHEDULE_ROOT/macos-runtime/deploy.sh"
fi

worker_root="$temporary_directory/worker root"
worker_fake_node="$temporary_directory/path with spaces/fake-worker-node"
worker_capture_path="$temporary_directory/path with spaces/worker-calls.log"
worker_canary='WORKER_SCHEDULE_SECRET_CANARY_DO_NOT_PRINT'
mkdir -p \
  "$worker_root/node_modules/tsx/dist" \
  "$worker_root/apps/worker/src" \
  "$temporary_directory/worker-home"
worker_root="$(cd "$worker_root" && pwd -P)"
: >"$worker_root/node_modules/tsx/dist/cli.mjs"
: >"$worker_root/apps/worker/src/index.ts"
printf 'MYSQL_PASSWORD=%s\n' "$worker_canary" >"$worker_root/.env.local"
chmod 600 "$worker_root/.env.local"

cat >"$worker_fake_node" <<'FAKE_WORKER_NODE'
#!/usr/bin/env bash
printf '%s|%s\n' "$PWD" "$*" >>"$WORKER_SCHEDULE_CAPTURE_PATH"
FAKE_WORKER_NODE
chmod 700 "$worker_fake_node"

worker_dry_output="$(HOME="$temporary_directory/worker-home" \
  WORKER_SCHEDULE_CAPTURE_PATH="$worker_capture_path" \
  bash "$SCHEDULE_ROOT/macos-worker/run.sh" \
    --project-root "$worker_root" --node "$worker_fake_node" --dry-run 2>&1)"
[[ "$worker_dry_output" == *'"status":"dry-run"'* ]] || {
  printf 'worker runner dry-run failed\n' >&2
  exit 1
}
[[ ! -e "$worker_capture_path" && "$worker_dry_output" != *"$worker_canary"* ]] || {
  printf 'worker dry-run executed work or exposed a secret\n' >&2
  exit 1
}

worker_validate_output="$(HOME="$temporary_directory/worker-home" \
  WORKER_SCHEDULE_CAPTURE_PATH="$worker_capture_path" \
  bash "$SCHEDULE_ROOT/macos-worker/run.sh" \
    --project-root "$worker_root" --node "$worker_fake_node" --validate-only 2>&1)"
[[ "$worker_validate_output" == *'"status":"ok"'* && ! -e "$worker_capture_path" ]] || {
  printf 'worker validate-only executed work or failed validation\n' >&2
  exit 1
}

worker_stale_lock="$temporary_directory/worker-home/Library/Caches/AIWorklog/worker-schedule.lock"
mkdir -p "$(dirname "$worker_stale_lock")"
printf 'pre-existing-lock-file\n' >"$worker_stale_lock"
chmod 600 "$worker_stale_lock"
worker_run_output="$(HOME="$temporary_directory/worker-home" \
  WORKER_SCHEDULE_CAPTURE_PATH="$worker_capture_path" \
  bash "$SCHEDULE_ROOT/macos-worker/run.sh" \
    --project-root "$worker_root" --node "$worker_fake_node" 2>&1)"
[[ "$worker_run_output" == *'"phase":"worker","status":"completed"'* ]] || {
  printf 'bounded worker runner did not complete\n' >&2
  exit 1
}
[[ "$worker_run_output" != *"$worker_canary"* \
  && -f "$worker_stale_lock" && ! -L "$worker_stale_lock" ]] || {
  printf 'worker runner exposed a secret or replaced its reusable lock file\n' >&2
  exit 1
}
expected_worker_call="$worker_root|$worker_root/node_modules/tsx/dist/cli.mjs $worker_root/apps/worker/src/index.ts"
actual_worker_call="$(cat "$worker_capture_path")"
[[ "$actual_worker_call" == "$expected_worker_call" ]] || {
  printf 'scheduled worker did not use the project cwd and bounded default arguments\n' >&2
  exit 1
}

: >"$worker_capture_path"
worker_lock_ready="$temporary_directory/worker-lock-ready"
/usr/bin/lockf -k -t 0 "$worker_stale_lock" /bin/bash -c \
  'printf ready >"$1"; sleep 2' lock-holder "$worker_lock_ready" &
worker_lock_holder=$!
for _attempt in {1..40}; do
  [[ -e "$worker_lock_ready" ]] && break
  sleep 0.05
done
[[ -e "$worker_lock_ready" ]] || {
  printf 'worker lock holder did not start\n' >&2
  exit 1
}
worker_lock_output="$(HOME="$temporary_directory/worker-home" \
  WORKER_SCHEDULE_CAPTURE_PATH="$worker_capture_path" \
  bash "$SCHEDULE_ROOT/macos-worker/run.sh" \
    --project-root "$worker_root" --node "$worker_fake_node" 2>&1)"
[[ "$worker_lock_output" == *'"phase":"lock","status":"skipped"'* \
  && ! -s "$worker_capture_path" ]] || {
  printf 'worker mutual-exclusion lock did not skip an overlapping run\n' >&2
  exit 1
}
wait "$worker_lock_holder"

if [[ "$(uname -s)" == "Darwin" ]]; then
  worker_install_output="$(HOME="$temporary_directory/worker-home" \
    bash "$SCHEDULE_ROOT/macos-worker/install.sh" \
      --project-root "$worker_root" --node "$worker_fake_node" --dry-run 2>&1)"
  [[ "$worker_install_output" == *'"status":"dry-run"'* ]] || {
    printf 'worker LaunchAgent installer dry-run failed\n' >&2
    exit 1
  }
  worker_uninstall_output="$(HOME="$temporary_directory/worker-home" \
    bash "$SCHEDULE_ROOT/macos-worker/uninstall.sh" --dry-run 2>&1)"
  [[ "$worker_uninstall_output" == *'"status":"dry-run"'* ]] || {
    printf 'worker LaunchAgent uninstaller dry-run failed\n' >&2
    exit 1
  }
fi

printf 'schedule static checks passed\n'
