import {
  DeviceEnrollmentSchema,
  type DeviceEnrollment,
  type DevicePlatform
} from "@ai-worklog/contracts";

export interface DeviceSetupInstructions {
  configPath: string;
  configureCommand: string;
  validateCommand: string;
  installCommand: string;
}

export type DeviceSetupMode = "INITIAL" | "ROTATE";

const asciiUrlPattern = /^[\u0021-\u007e]+$/u;
const dnsLabelPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;

function safeAsciiHostname(hostname: string): boolean {
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    !asciiUrlPattern.test(hostname)
  ) {
    return false;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const address = hostname.slice(1, -1);
    return (
      address.length > 1 &&
      address.length <= 45 &&
      address.includes(":") &&
      /^[0-9A-Fa-f:.]+$/u.test(address)
    );
  }
  return hostname
    .split(".")
    .every((label) => dnsLabelPattern.test(label));
}

export function bashSingleQuotedLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function powerShellSingleQuotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function privateHttpHost(hostname: string): boolean {
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) {
    return true;
  }
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  return octets[0] === 10 ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function validatedEnrollment(value: DeviceEnrollment): DeviceEnrollment {
  const parsed = DeviceEnrollmentSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid device enrollment");
  if (!asciiUrlPattern.test(parsed.data.syncUrl)) {
    throw new Error("Invalid device enrollment");
  }
  const url = new URL(parsed.data.syncUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/api/v1/sync/batches" ||
    url.search ||
    url.hash ||
    !safeAsciiHostname(url.hostname) ||
    (url.protocol === "http:" && !privateHttpHost(url.hostname))
  ) {
    throw new Error("Invalid device enrollment");
  }
  return { ...parsed.data, syncUrl: url.toString() };
}

function macSetup(
  enrollment: DeviceEnrollment,
  mode: DeviceSetupMode
): DeviceSetupInstructions {
  const insecureLan = enrollment.syncUrl.startsWith("http://");
  const configPath = "~/.config/ai-worklog/collector.env";
  const localSetup = mode === "ROTATE"
    ? `CODEX_SOURCE_INSTANCE_ID=${bashSingleQuotedLiteral(`${enrollment.deviceId}-codex`)}
CODEX_SOURCE_PATH="$HOME/.codex/sessions"
CLAUDE_CODE_SOURCE_INSTANCE_ID=${bashSingleQuotedLiteral(`${enrollment.deviceId}-claude-code`)}
CLAUDE_CODE_SOURCE_PATH="$HOME/.claude/projects"
COLLECTOR_DB_PATH="$HOME/.ai-worklog/collector.sqlite"
NODE_BINARY="$(command -v node)"
AI_WORKLOG_PATH_HMAC_KEY=""
CONFIG_IS_SAFE=true
if [ -L "$CONFIG" ] || { [ -e "$CONFIG" ] && [ ! -f "$CONFIG" ]; }; then
  printf '%s\\n' '现有配置文件类型无效，已停止写入。' >&2
  CONFIG_IS_SAFE=false
fi
if [ "$CONFIG_IS_SAFE" = true ] && [ -f "$CONFIG" ] && [ "$(wc -c < "$CONFIG")" -gt 65536 ]; then
  printf '%s\\n' '现有配置文件过大，已停止写入。' >&2
  CONFIG_IS_SAFE=false
fi
if [ "$CONFIG_IS_SAFE" = true ] && [ -f "$CONFIG" ] && ! chmod 600 "$CONFIG"; then
  printf '%s\\n' '无法收紧现有配置权限，已停止写入。' >&2
  CONFIG_IS_SAFE=false
fi
if [ "$CONFIG_IS_SAFE" != true ]; then
  exit 1
fi
read_preserved_value() {
  local wanted_key="$1"
  local line value first last
  [ "$CONFIG_IS_SAFE" = true ] && [ -f "$CONFIG" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="\${line%$'\\r'}"
    case "$line" in
      "$wanted_key="*)
        value="\${line#*=}"
        if [ "\${#value}" -ge 2 ]; then
          first="\${value:0:1}"
          last="\${value: -1}"
          if { [ "$first" = '"' ] && [ "$last" = '"' ]; } ||
             { [ "$first" = "'" ] && [ "$last" = "'" ]; }; then
            value="\${value:1:\${#value}-2}"
          fi
        fi
        printf '%s' "$value"
        return 0
        ;;
    esac
  done < "$CONFIG"
  return 1
}
PRESERVED_VALUE="$(read_preserved_value "CODEX_SOURCE_INSTANCE_ID" || true)"
[ -z "$PRESERVED_VALUE" ] || CODEX_SOURCE_INSTANCE_ID="$PRESERVED_VALUE"
PRESERVED_VALUE="$(read_preserved_value "CODEX_SOURCE_PATH" || true)"
[ -z "$PRESERVED_VALUE" ] || CODEX_SOURCE_PATH="$PRESERVED_VALUE"
PRESERVED_VALUE="$(read_preserved_value "CLAUDE_CODE_SOURCE_INSTANCE_ID" || true)"
[ -z "$PRESERVED_VALUE" ] || CLAUDE_CODE_SOURCE_INSTANCE_ID="$PRESERVED_VALUE"
PRESERVED_VALUE="$(read_preserved_value "CLAUDE_CODE_SOURCE_PATH" || true)"
[ -z "$PRESERVED_VALUE" ] || CLAUDE_CODE_SOURCE_PATH="$PRESERVED_VALUE"
PRESERVED_VALUE="$(read_preserved_value "COLLECTOR_DB_PATH" || true)"
[ -z "$PRESERVED_VALUE" ] || COLLECTOR_DB_PATH="$PRESERVED_VALUE"
PRESERVED_VALUE="$(read_preserved_value "NODE_BINARY" || true)"
[ -z "$PRESERVED_VALUE" ] || NODE_BINARY="$PRESERVED_VALUE"
PRESERVED_VALUE="$(read_preserved_value "AI_WORKLOG_PATH_HMAC_KEY" || true)"
[ -z "$PRESERVED_VALUE" ] || AI_WORKLOG_PATH_HMAC_KEY="$PRESERVED_VALUE"
if [ -z "$AI_WORKLOG_PATH_HMAC_KEY" ]; then
  AI_WORKLOG_PATH_HMAC_KEY="$(openssl rand -hex 32)"
fi
mkdir -p "$CODEX_SOURCE_PATH" "$CLAUDE_CODE_SOURCE_PATH"`
    : `mkdir -p "$HOME/.codex/sessions"
mkdir -p "$HOME/.claude/projects"
AI_WORKLOG_PATH_HMAC_KEY="$(openssl rand -hex 32)"
NODE_BINARY="$(command -v node)"
CONFIG_IS_SAFE=true
if [ -L "$CONFIG" ] || { [ -e "$CONFIG" ] && [ ! -f "$CONFIG" ]; }; then
  printf '%s\\n' '现有配置文件类型无效，已停止写入。' >&2
  CONFIG_IS_SAFE=false
fi
if [ "$CONFIG_IS_SAFE" = true ] && [ -f "$CONFIG" ] && [ "$(wc -c < "$CONFIG")" -gt 65536 ]; then
  printf '%s\\n' '现有配置文件过大，已停止写入。' >&2
  CONFIG_IS_SAFE=false
fi
if [ "$CONFIG_IS_SAFE" = true ] && [ -f "$CONFIG" ] && ! chmod 600 "$CONFIG"; then
  printf '%s\\n' '无法收紧现有配置权限，已停止写入。' >&2
  CONFIG_IS_SAFE=false
fi
if [ "$CONFIG_IS_SAFE" != true ]; then
  exit 1
fi`;
  const localLines = mode === "ROTATE"
    ? `  printf '%s\\n' "CODEX_SOURCE_INSTANCE_ID=$CODEX_SOURCE_INSTANCE_ID"
  printf '%s\\n' "CODEX_SOURCE_PATH=$CODEX_SOURCE_PATH"
  printf '%s\\n' "CLAUDE_CODE_SOURCE_INSTANCE_ID=$CLAUDE_CODE_SOURCE_INSTANCE_ID"
  printf '%s\\n' "CLAUDE_CODE_SOURCE_PATH=$CLAUDE_CODE_SOURCE_PATH"
  printf '%s\\n' "AI_WORKLOG_PATH_HMAC_KEY=$AI_WORKLOG_PATH_HMAC_KEY"
  printf '%s\\n' "COLLECTOR_DB_PATH=$COLLECTOR_DB_PATH"`
    : `  printf '%s\\n' ${bashSingleQuotedLiteral(`CODEX_SOURCE_INSTANCE_ID=${enrollment.deviceId}-codex`)}
  printf '%s\\n' "CODEX_SOURCE_PATH=$HOME/.codex/sessions"
  printf '%s\\n' ${bashSingleQuotedLiteral(`CLAUDE_CODE_SOURCE_INSTANCE_ID=${enrollment.deviceId}-claude-code`)}
  printf '%s\\n' "CLAUDE_CODE_SOURCE_PATH=$HOME/.claude/projects"
  printf '%s\\n' "AI_WORKLOG_PATH_HMAC_KEY=$AI_WORKLOG_PATH_HMAC_KEY"
  printf '%s\\n' "COLLECTOR_DB_PATH=$HOME/.ai-worklog/collector.sqlite"`;
  return {
    configPath,
    configureCommand: `(
set -e
printf '设备 Token：'
IFS= read -r -s AI_WORKLOG_DEVICE_TOKEN
printf '\\n'
if ! printf '%s' "$AI_WORKLOG_DEVICE_TOKEN" | LC_ALL=C grep -Eq '^[a-f0-9]{64}$'; then
  printf '%s\\n' '设备 Token 格式无效，已停止写入。' >&2
  exit 1
fi
CONFIG_DIRECTORY="$HOME/.config/ai-worklog"
DATA_DIRECTORY="$HOME/.ai-worklog"
CONFIG="$CONFIG_DIRECTORY/collector.env"
TEMP_CONFIG=""
cleanup_temp_config() {
  if [ -n "$TEMP_CONFIG" ]; then
    rm -f "$TEMP_CONFIG" 2>/dev/null || true
  fi
}
trap cleanup_temp_config EXIT
trap 'exit 1' HUP INT TERM
umask 077
if [ -L "$CONFIG_DIRECTORY" ] || { [ -e "$CONFIG_DIRECTORY" ] && [ ! -d "$CONFIG_DIRECTORY" ]; }; then
  printf '%s\\n' '配置目录类型无效，已停止写入。' >&2
  exit 1
fi
if [ -L "$DATA_DIRECTORY" ] || { [ -e "$DATA_DIRECTORY" ] && [ ! -d "$DATA_DIRECTORY" ]; }; then
  printf '%s\\n' '数据目录类型无效，已停止写入。' >&2
  exit 1
fi
mkdir -p "$CONFIG_DIRECTORY" "$DATA_DIRECTORY"
chmod 700 "$CONFIG_DIRECTORY" "$DATA_DIRECTORY"
${localSetup}
TEMP_CONFIG="$(mktemp "$CONFIG_DIRECTORY/.collector.env.XXXXXX")"
chmod 600 "$TEMP_CONFIG"
{
  printf '%s\\n' ${bashSingleQuotedLiteral(`AI_WORKLOG_ACCOUNT_ID=${enrollment.accountId}`)}
  printf '%s\\n' ${bashSingleQuotedLiteral(`AI_WORKLOG_DEVICE_ID=${enrollment.deviceId}`)}
${localLines}
  printf '%s\\n' ${bashSingleQuotedLiteral(`AI_WORKLOG_SYNC_URL=${enrollment.syncUrl}`)}
  printf '%s\\n' ${bashSingleQuotedLiteral(`AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP=${insecureLan}`)}
  printf '%s\\n' "AI_WORKLOG_DEVICE_TOKEN=$AI_WORKLOG_DEVICE_TOKEN"
  printf '%s\\n' "NODE_BINARY=$NODE_BINARY"
} > "$TEMP_CONFIG"
chmod 600 "$TEMP_CONFIG"
mv -f "$TEMP_CONFIG" "$CONFIG"
TEMP_CONFIG=""
trap - EXIT HUP INT TERM
echo '配置已写入 ~/.config/ai-worklog/collector.env'
)`,
    validateCommand: `CONFIG="$HOME/.config/ai-worklog/collector.env"
bash scripts/schedules/macos/run.sh --config "$CONFIG" --dry-run
bash scripts/schedules/macos/run.sh --config "$CONFIG"`,
    installCommand: `CONFIG="$HOME/.config/ai-worklog/collector.env"
bash scripts/schedules/macos/install.sh --config "$CONFIG" --dry-run
bash scripts/schedules/macos/install.sh --config "$CONFIG"`
  };
}

function windowsSetup(
  enrollment: DeviceEnrollment,
  mode: DeviceSetupMode
): DeviceSetupInstructions {
  const insecureLan = enrollment.syncUrl.startsWith("http://");
  const configPath = "%LOCALAPPDATA%\\AIWorklog\\collector.env";
  const localSetup = mode === "ROTATE"
    ? `$DefaultCodexPath = Join-Path $HOME '.codex\\sessions'
  $DefaultClaudePath = Join-Path $HOME '.claude\\projects'
  $DefaultCollectorDbPath = Join-Path $DataDirectory 'collector.sqlite'
  $DefaultNodeBinary = (Get-Command node -ErrorAction Stop).Source
  $PreserveKeys = @(
    'AI_WORKLOG_PATH_HMAC_KEY',
    'CODEX_SOURCE_INSTANCE_ID',
    'CODEX_SOURCE_PATH',
    'CLAUDE_CODE_SOURCE_INSTANCE_ID',
    'CLAUDE_CODE_SOURCE_PATH',
    'COLLECTOR_DB_PATH',
    'NODE_BINARY'
  )
  $PreservedValues = @{}
  if (Test-Path -LiteralPath $Config) {
    $ConfigItem = Get-Item -LiteralPath $Config
    if ($ConfigItem.PSIsContainer -or
        ($ConfigItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $ConfigItem.Length -gt 65536) {
      throw 'Invalid existing configuration file'
    }
    foreach ($RawLine in [IO.File]::ReadAllLines($Config)) {
      $Line = $RawLine.TrimEnd([char]13)
      if ($Line -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') {
        continue
      }
      $Key = $Matches[1]
      if ($PreserveKeys -notcontains $Key -or $PreservedValues.ContainsKey($Key)) {
        continue
      }
      $Value = $Matches[2]
      if ($Value.Length -ge 2 -and
          (($Value[0] -eq [char]34 -and $Value[$Value.Length - 1] -eq [char]34) -or
           ($Value[0] -eq [char]39 -and $Value[$Value.Length - 1] -eq [char]39))) {
        $Value = $Value.Substring(1, $Value.Length - 2)
      }
      $PreservedValues[$Key] = $Value
    }
  }
  $CodexSourceInstanceId = if ($PreservedValues.ContainsKey('CODEX_SOURCE_INSTANCE_ID') -and
      -not [string]::IsNullOrWhiteSpace($PreservedValues['CODEX_SOURCE_INSTANCE_ID'])) {
    [string]$PreservedValues['CODEX_SOURCE_INSTANCE_ID']
  } else { ${powerShellSingleQuotedLiteral(`${enrollment.deviceId}-codex`)} }
  $CodexPath = if ($PreservedValues.ContainsKey('CODEX_SOURCE_PATH') -and
      -not [string]::IsNullOrWhiteSpace($PreservedValues['CODEX_SOURCE_PATH'])) {
    [string]$PreservedValues['CODEX_SOURCE_PATH']
  } else { $DefaultCodexPath }
  $ClaudeSourceInstanceId = if ($PreservedValues.ContainsKey('CLAUDE_CODE_SOURCE_INSTANCE_ID') -and
      -not [string]::IsNullOrWhiteSpace($PreservedValues['CLAUDE_CODE_SOURCE_INSTANCE_ID'])) {
    [string]$PreservedValues['CLAUDE_CODE_SOURCE_INSTANCE_ID']
  } else { ${powerShellSingleQuotedLiteral(`${enrollment.deviceId}-claude-code`)} }
  $ClaudePath = if ($PreservedValues.ContainsKey('CLAUDE_CODE_SOURCE_PATH') -and
      -not [string]::IsNullOrWhiteSpace($PreservedValues['CLAUDE_CODE_SOURCE_PATH'])) {
    [string]$PreservedValues['CLAUDE_CODE_SOURCE_PATH']
  } else { $DefaultClaudePath }
  $CollectorDbPath = if ($PreservedValues.ContainsKey('COLLECTOR_DB_PATH') -and
      -not [string]::IsNullOrWhiteSpace($PreservedValues['COLLECTOR_DB_PATH'])) {
    [string]$PreservedValues['COLLECTOR_DB_PATH']
  } else { $DefaultCollectorDbPath }
  $NodeBinary = if ($PreservedValues.ContainsKey('NODE_BINARY') -and
      -not [string]::IsNullOrWhiteSpace($PreservedValues['NODE_BINARY'])) {
    [string]$PreservedValues['NODE_BINARY']
  } else { $DefaultNodeBinary }
  $HmacKey = if ($PreservedValues.ContainsKey('AI_WORKLOG_PATH_HMAC_KEY') -and
      -not [string]::IsNullOrWhiteSpace($PreservedValues['AI_WORKLOG_PATH_HMAC_KEY'])) {
    [string]$PreservedValues['AI_WORKLOG_PATH_HMAC_KEY']
  } else { $null }
  if ([string]::IsNullOrWhiteSpace($HmacKey)) {
    $Random = [Security.Cryptography.RandomNumberGenerator]::Create()
    $Bytes = New-Object byte[] 32
    $Random.GetBytes($Bytes)
    $Random.Dispose()
    $HmacKey = -join ($Bytes | ForEach-Object { $_.ToString("x2") })
  }`
    : `$CodexPath = Join-Path $HOME '.codex\\sessions'
  $ClaudePath = Join-Path $HOME '.claude\\projects'
  $NodeBinary = (Get-Command node -ErrorAction Stop).Source
  $Random = [Security.Cryptography.RandomNumberGenerator]::Create()
  $Bytes = New-Object byte[] 32
  $Random.GetBytes($Bytes)
  $Random.Dispose()
  $HmacKey = -join ($Bytes | ForEach-Object { $_.ToString("x2") })`;
  const localLines = mode === "ROTATE"
    ? `    "CODEX_SOURCE_INSTANCE_ID=$CodexSourceInstanceId",
    "CODEX_SOURCE_PATH=$CodexPath",
    "CLAUDE_CODE_SOURCE_INSTANCE_ID=$ClaudeSourceInstanceId",
    "CLAUDE_CODE_SOURCE_PATH=$ClaudePath",
    "AI_WORKLOG_PATH_HMAC_KEY=$HmacKey",
    "COLLECTOR_DB_PATH=$CollectorDbPath",`
    : `    ${powerShellSingleQuotedLiteral(`CODEX_SOURCE_INSTANCE_ID=${enrollment.deviceId}-codex`)},
    "CODEX_SOURCE_PATH=$CodexPath",
    ${powerShellSingleQuotedLiteral(`CLAUDE_CODE_SOURCE_INSTANCE_ID=${enrollment.deviceId}-claude-code`)},
    "CLAUDE_CODE_SOURCE_PATH=$ClaudePath",
    "AI_WORKLOG_PATH_HMAC_KEY=$HmacKey",
    "COLLECTOR_DB_PATH=$(Join-Path $DataDirectory 'collector.sqlite')",`;
  return {
    configPath,
    configureCommand: `$SecureToken = Read-Host '设备 Token' -AsSecureString
[IntPtr]$TokenPointer = [IntPtr]::Zero
$TempConfig = $null
try {
  $TokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureToken)
  $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($TokenPointer)
  if ($Token -notmatch '^[a-f0-9]{64}$') {
    throw '设备 Token 格式无效，已停止写入。'
  }
  $Config = Join-Path $env:LOCALAPPDATA 'AIWorklog\\collector.env'
  $DataDirectory = Join-Path $env:LOCALAPPDATA 'AIWorklog'
  ${localSetup}
  New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path $CodexPath, $ClaudePath -Force | Out-Null
  $TempConfig = Join-Path $DataDirectory ([IO.Path]::GetRandomFileName())
  New-Item -ItemType File -Path $TempConfig -Force | Out-Null
  $CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  icacls $TempConfig /inheritance:r | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to remove inherited config permissions'
  }
  icacls $TempConfig /grant:r "*$($CurrentSid):(F)" "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to grant private config permissions'
  }
  $Lines = @(
    ${powerShellSingleQuotedLiteral(`AI_WORKLOG_ACCOUNT_ID=${enrollment.accountId}`)},
    ${powerShellSingleQuotedLiteral(`AI_WORKLOG_DEVICE_ID=${enrollment.deviceId}`)},
${localLines}
    ${powerShellSingleQuotedLiteral(`AI_WORKLOG_SYNC_URL=${enrollment.syncUrl}`)},
    ${powerShellSingleQuotedLiteral(`AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP=${insecureLan}`)},
    "AI_WORKLOG_DEVICE_TOKEN=$Token",
    "NODE_BINARY=$NodeBinary"
  )
  [IO.File]::WriteAllLines($TempConfig, $Lines, [Text.UTF8Encoding]::new($false))
  if (-not ('AIWorklog.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace AIWorklog {
  public static class NativeMethods {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool MoveFileEx(
      string existingFile,
      string replacementFile,
      uint flags
    );
  }
}
'@
  }
  $Moved = [AIWorklog.NativeMethods]::MoveFileEx($TempConfig, $Config, [uint32]9)
  if (-not $Moved) {
    $MoveError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw [ComponentModel.Win32Exception]::new($MoveError)
  }
  $TempConfig = $null
  Write-Host "配置已写入 $Config"
} finally {
  if ($TempConfig -and [IO.File]::Exists($TempConfig)) {
    Remove-Item -LiteralPath $TempConfig -Force -ErrorAction SilentlyContinue
  }
  if ($TokenPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($TokenPointer)
  }
  Remove-Variable Token, SecureToken, HmacKey, Lines, Bytes -ErrorAction SilentlyContinue
}`,
    validateCommand: `$Config = Join-Path $env:LOCALAPPDATA "AIWorklog\\collector.env"
& ".\\scripts\\schedules\\windows\\Run.ps1" -ConfigPath $Config -DryRun
& ".\\scripts\\schedules\\windows\\Run.ps1" -ConfigPath $Config`,
    installCommand: `$Config = Join-Path $env:LOCALAPPDATA "AIWorklog\\collector.env"
& ".\\scripts\\schedules\\windows\\Install.ps1" -ConfigPath $Config -DryRun
& ".\\scripts\\schedules\\windows\\Install.ps1" -ConfigPath $Config`
  };
}

export function buildDeviceSetup(
  platform: DevicePlatform,
  enrollmentValue: DeviceEnrollment,
  mode: DeviceSetupMode = "INITIAL"
): DeviceSetupInstructions {
  const enrollment = validatedEnrollment(enrollmentValue);
  return platform === "MACOS"
    ? macSetup(enrollment, mode)
    : windowsSetup(enrollment, mode);
}
