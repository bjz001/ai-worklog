[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA "AIWorklog\collector.env"),
    [switch]$DryRun,
    [switch]$ValidateOnly,
    [switch]$QuarantineLegacy,
    [switch]$Status
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$ConfigKeys = @(
    "AI_WORKLOG_ACCOUNT_ID",
    "AI_WORKLOG_DEVICE_ID",
    "AI_WORKLOG_PROTOCOL_VERSION",
    "CODEX_SOURCE_INSTANCE_ID",
    "CODEX_SOURCE_PATH",
    "CLAUDE_CODE_SOURCE_INSTANCE_ID",
    "CLAUDE_CODE_SOURCE_PATH",
    "ZCODE_SOURCE_INSTANCE_ID",
    "ZCODE_SOURCE_PATH",
    "ZCODE_HOOK_SPOOL",
    "ZCODE_CONFIG_PATH",
    "DSH_SOURCE_INSTANCE_ID",
    "DSH_SOURCE_PATH",
    "DSH_HOME",
    "AI_WORKLOG_PATH_HMAC_KEY",
    "COLLECTOR_DB_PATH",
    "COLLECTOR_BLOB_ROOT",
    "AI_WORKLOG_SYNC_URL",
    "AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP",
    "AI_WORKLOG_DEVICE_TOKEN",
    "NODE_BINARY"
)

function Write-SafeEvent {
    param(
        [Parameter(Mandatory = $true)][string]$Phase,
        [Parameter(Mandatory = $true)][string]$Status,
        [bool]$Persist = $true
    )

    $record = [ordered]@{
        event = "ai-worklog-schedule"
        phase = $Phase
        status = $Status
        at = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    $line = $record | ConvertTo-Json -Compress
    if ($Persist) {
        $logDirectory = Join-Path $env:LOCALAPPDATA "AIWorklog\logs"
        [void](New-Item -ItemType Directory -Path $logDirectory -Force)
        $logPath = Join-Path $logDirectory "schedule.log"
        if ((Test-Path -LiteralPath $logPath -PathType Leaf) -and
            (Get-Item -LiteralPath $logPath).Length -gt 1048576) {
            Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
        }
        Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    }
    [Console]::Out.WriteLine($line)
}

function Resolve-IdentitySid {
    param([Parameter(Mandatory = $true)]$IdentityReference)

    if ($IdentityReference -is [System.Security.Principal.SecurityIdentifier]) {
        return $IdentityReference
    }
    if ($IdentityReference -is [System.Security.Principal.NTAccount]) {
        return $IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
    }
    $identityText = [string]$IdentityReference
    if ($identityText -match '^S-1-') {
        return [System.Security.Principal.SecurityIdentifier]::new($identityText)
    }
    $account = [System.Security.Principal.NTAccount]::new($identityText)
    return $account.Translate([System.Security.Principal.SecurityIdentifier])
}

function Assert-PrivateConfigFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $item.Length -gt 65536) {
        throw "Invalid configuration file"
    }

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $currentSid = $identity.User
    $acl = Get-Acl -LiteralPath $Path
    $ownerSid = Resolve-IdentitySid $acl.Owner
    if ($ownerSid.Value -ne $currentSid.Value) {
        throw "Invalid configuration owner"
    }

    $allowedSids = @(
        $currentSid.Value,
        "S-1-5-18",
        "S-1-5-32-544"
    )
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
            continue
        }
        $sensitiveMask = [int][Security.AccessControl.FileSystemRights]::ReadData
        $sensitiveMask = $sensitiveMask -bor [int][Security.AccessControl.FileSystemRights]::ReadAttributes
        $sensitiveMask = $sensitiveMask -bor [int][Security.AccessControl.FileSystemRights]::ReadExtendedAttributes
        $sensitiveMask = $sensitiveMask -bor [int][Security.AccessControl.FileSystemRights]::ReadPermissions
        $sensitiveMask = $sensitiveMask -bor [int][Security.AccessControl.FileSystemRights]::WriteData
        $sensitiveMask = $sensitiveMask -bor [int][Security.AccessControl.FileSystemRights]::AppendData
        $sensitiveMask = $sensitiveMask -bor [int][Security.AccessControl.FileSystemRights]::WriteAttributes
        $sensitiveMask = $sensitiveMask -bor [int][Security.AccessControl.FileSystemRights]::WriteExtendedAttributes
        $sensitiveMask = $sensitiveMask -bor [int][Security.AccessControl.FileSystemRights]::Delete
        $sensitiveMask = $sensitiveMask -bor [int][Security.AccessControl.FileSystemRights]::ChangePermissions
        $sensitiveMask = $sensitiveMask -bor [int][Security.AccessControl.FileSystemRights]::TakeOwnership
        $hasSensitiveAccess = ([int]$rule.FileSystemRights -band $sensitiveMask) -ne 0
        if (-not $hasSensitiveAccess) {
            continue
        }
        $ruleSid = Resolve-IdentitySid $rule.IdentityReference
        if ($allowedSids -notcontains $ruleSid.Value) {
            throw "Configuration permissions are too broad"
        }
    }
}

function Import-CollectorConfig {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Missing configuration file"
    }
    Assert-PrivateConfigFile $Path
    foreach ($key in $ConfigKeys) {
        [Environment]::SetEnvironmentVariable($key, $null, "Process")
    }
    [Environment]::SetEnvironmentVariable("AI_WORKLOG_SOURCE_TYPE", $null, "Process")
    [Environment]::SetEnvironmentVariable("NODE_EXTRA_CA_CERTS", $null, "Process")
    [Environment]::SetEnvironmentVariable("NODE_TLS_REJECT_UNAUTHORIZED", $null, "Process")
    [Environment]::SetEnvironmentVariable("NODE_OPTIONS", $null, "Process")
    [Environment]::SetEnvironmentVariable("NODE_PATH", $null, "Process")

    $seenKeys = @{}
    foreach ($rawLine in [IO.File]::ReadAllLines($Path)) {
        $line = $rawLine.TrimEnd("`r")
        if ([string]::IsNullOrWhiteSpace($line) -or $line -match '^\s*#') {
            continue
        }
        if ($line -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') {
            throw "Invalid configuration line"
        }
        $key = $Matches[1]
        $value = $Matches[2]
        if ($ConfigKeys -notcontains $key -or $value.Length -gt 8192) {
            throw "Unsupported configuration value"
        }
        if ($seenKeys.ContainsKey($key)) {
            throw "Duplicate configuration key"
        }
        $seenKeys[$key] = $true
        if ($value.Length -ge 2) {
            $doubleQuoted = $value[0] -eq '"' -and $value[$value.Length - 1] -eq '"'
            $singleQuoted = $value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"
            if ($doubleQuoted -or $singleQuoted) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
}

function Test-PrivateIPv4 {
    param([Parameter(Mandatory = $true)][string]$HostName)

    $address = $null
    if (-not [Net.IPAddress]::TryParse($HostName, [ref]$address) -or
        $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        return $false
    }
    $octets = $address.GetAddressBytes()
    return $octets[0] -eq 10 -or
        ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168)
}

function Assert-RequiredConfig {
    param([switch]$LocalOnly)

    $requiredKeys = @(
        "AI_WORKLOG_ACCOUNT_ID",
        "AI_WORKLOG_DEVICE_ID",
        "AI_WORKLOG_SYNC_URL",
        "AI_WORKLOG_DEVICE_TOKEN"
    )
    if (-not $LocalOnly) {
        foreach ($key in $requiredKeys) {
            $value = [Environment]::GetEnvironmentVariable($key, "Process")
            if ([string]::IsNullOrWhiteSpace($value)) {
                throw "Missing required configuration"
            }
        }
    }
    if (-not $LocalOnly) {
        $protocolVersion = $env:AI_WORKLOG_PROTOCOL_VERSION
        if ([string]::IsNullOrWhiteSpace($protocolVersion)) {
            $protocolVersion = "1"
            [Environment]::SetEnvironmentVariable(
                "AI_WORKLOG_PROTOCOL_VERSION", $protocolVersion, "Process"
            )
        }
        if ($protocolVersion -ne "1") {
            throw "Invalid collector protocol version"
        }
    }
    $absolutePathPattern = '^(?:[A-Za-z]:[\\/]|\\\\)'
    $pathKeys = @(
        "CODEX_SOURCE_PATH", "CLAUDE_CODE_SOURCE_PATH", "ZCODE_SOURCE_PATH",
        "ZCODE_HOOK_SPOOL", "ZCODE_CONFIG_PATH", "DSH_SOURCE_PATH", "DSH_HOME",
        "COLLECTOR_DB_PATH", "COLLECTOR_BLOB_ROOT"
    )
    foreach ($pathKey in $pathKeys) {
        $pathValue = [Environment]::GetEnvironmentVariable($pathKey, "Process")
        if (-not [string]::IsNullOrWhiteSpace($pathValue) -and
            $pathValue -notmatch $absolutePathPattern) {
            throw "Collector paths must be absolute"
        }
    }
    if (-not $LocalOnly) {
        $syncUri = [Uri]::new($env:AI_WORKLOG_SYNC_URL, [UriKind]::Absolute)
        $insecureLanSetting = $env:AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP
        if ([string]::IsNullOrWhiteSpace($insecureLanSetting)) {
            $insecureLanSetting = "false"
        }
        if (@("true", "false") -notcontains $insecureLanSetting.ToLowerInvariant()) {
            throw "Invalid private-LAN HTTP setting"
        }
        $localHttp = $syncUri.Scheme -eq "http" -and
            (@("localhost", "127.0.0.1", "::1") -contains $syncUri.Host)
        $privateLanHttp = $syncUri.Scheme -eq "http" -and
            $insecureLanSetting.ToLowerInvariant() -eq "true" -and
            (Test-PrivateIPv4 $syncUri.Host)
        $secureEndpoint = $syncUri.Scheme -eq "https" -or $localHttp -or $privateLanHttp
        $hasEmbeddedCredentials = -not [string]::IsNullOrEmpty($syncUri.UserInfo)
        if (-not $secureEndpoint -or $hasEmbeddedCredentials) {
            throw "Invalid sync endpoint"
        }
    }
}

function Resolve-NodeBinary {
    if (-not [string]::IsNullOrWhiteSpace($env:NODE_BINARY)) {
        if ($env:NODE_BINARY -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)' -or
            -not (Test-Path -LiteralPath $env:NODE_BINARY -PathType Leaf)) {
            throw "Invalid Node binary"
        }
        return (Resolve-Path -LiteralPath $env:NODE_BINARY).Path
    }
    $node = Get-Command node.exe -CommandType Application -ErrorAction Stop
    return $node.Source
}

function Invoke-CollectorPhase {
    param(
        [Parameter(Mandatory = $true)][string]$NodeBinary,
        [Parameter(Mandatory = $true)][string]$TsxCli,
        [Parameter(Mandatory = $true)][string]$CollectorCli,
        [Parameter(Mandatory = $true)][ValidateSet("prepare", "sync", "quarantine-legacy", "status")][string]$Command,
        [Parameter(Mandatory = $true)][ValidateSet("prepare-prompts", "sync", "quarantine-legacy", "status")][string]$LogPhase,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$SourceType
    )

    if (@("", "CODEX", "CLAUDE_CODE", "ZCODE", "DSH") -notcontains $SourceType) {
        throw "Invalid collector source type"
    }
    if ([string]::IsNullOrEmpty($SourceType)) {
        [Environment]::SetEnvironmentVariable("AI_WORKLOG_SOURCE_TYPE", $null, "Process")
    } else {
        [Environment]::SetEnvironmentVariable("AI_WORKLOG_SOURCE_TYPE", $SourceType, "Process")
    }
    $collectorOutput = @()
    if (@("quarantine-legacy", "status") -contains $Command) {
        $collectorOutput = & $NodeBinary $TsxCli $CollectorCli $Command 2> $null
    } else {
        & $NodeBinary $TsxCli $CollectorCli $Command *> $null
    }
    if ($LASTEXITCODE -eq 0) {
        if (@("quarantine-legacy", "status") -contains $Command) {
            foreach ($line in $collectorOutput) {
                [Console]::Out.WriteLine([string]$line)
            }
        }
        Write-SafeEvent -Phase $LogPhase -Status "ok"
        return $true
    }
    Write-SafeEvent -Phase $LogPhase -Status "failed"
    return $false
}

function Invoke-ScheduledCollector {
    Import-CollectorConfig $ConfigPath
    $localOperation = $QuarantineLegacy -or $Status
    Assert-RequiredConfig -LocalOnly:$localOperation
    $nodeBinary = Resolve-NodeBinary
    $projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
    $tsxCli = Join-Path $projectRoot "node_modules\tsx\dist\cli.mjs"
    $collectorCli = Join-Path $projectRoot "apps\collector\src\index.ts"
    if (-not (Test-Path -LiteralPath $tsxCli -PathType Leaf) -or
        -not (Test-Path -LiteralPath $collectorCli -PathType Leaf)) {
        throw "Collector runtime is unavailable"
    }

    if ($DryRun) {
        if ($QuarantineLegacy -or $Status) {
            throw "Local operation cannot be combined with DryRun"
        }
        Write-SafeEvent -Phase "validation" -Status "dry-run" -Persist $false
        return 0
    }
    if ($ValidateOnly) {
        if ($QuarantineLegacy -or $Status) {
            throw "Local operation cannot be combined with ValidateOnly"
        }
        Write-SafeEvent -Phase "validation" -Status "ok" -Persist $false
        return 0
    }

    if ($QuarantineLegacy) {
        Write-SafeEvent -Phase "quarantine-legacy" -Status "started"
        if (-not (Invoke-CollectorPhase -NodeBinary $nodeBinary -TsxCli $tsxCli -CollectorCli $collectorCli -Command "quarantine-legacy" -LogPhase "quarantine-legacy" -SourceType "")) {
            return 1
        }
        Write-SafeEvent -Phase "quarantine-legacy" -Status "completed"
        return 0
    }

    if ($Status) {
        Write-SafeEvent -Phase "status" -Status "started"
        if (-not (Invoke-CollectorPhase -NodeBinary $nodeBinary -TsxCli $tsxCli -CollectorCli $collectorCli -Command "status" -LogPhase "status" -SourceType "")) {
            return 1
        }
        Write-SafeEvent -Phase "status" -Status "completed"
        return 0
    }

    $mutex = [System.Threading.Mutex]::new($false, "Local\AIWorklogCollectorNightly")
    $hasLock = $false
    try {
        try {
            $hasLock = $mutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            $hasLock = $true
        }
        if (-not $hasLock) {
            Write-SafeEvent -Phase "lock" -Status "skipped"
            return 0
        }

        Write-SafeEvent -Phase "schedule" -Status "started"
        $scheduleFailed = $false
        if (-not (Invoke-CollectorPhase -NodeBinary $nodeBinary -TsxCli $tsxCli -CollectorCli $collectorCli -Command "prepare" -LogPhase "prepare-prompts" -SourceType "")) {
            $scheduleFailed = $true
        }
        if (-not (Invoke-CollectorPhase -NodeBinary $nodeBinary -TsxCli $tsxCli -CollectorCli $collectorCli -Command "sync" -LogPhase "sync" -SourceType "")) {
            $scheduleFailed = $true
        }
        if ($scheduleFailed) {
            Write-SafeEvent -Phase "schedule" -Status "partial"
            return 1
        }
        Write-SafeEvent -Phase "schedule" -Status "completed"
        return 0
    } finally {
        if ($hasLock) {
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}

try {
    $exitCode = Invoke-ScheduledCollector
} catch {
    Write-SafeEvent -Phase "configuration" -Status "failed" -Persist (-not ($DryRun -or $ValidateOnly))
    $exitCode = 1
}
exit $exitCode
