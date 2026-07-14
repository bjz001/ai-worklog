[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA "AIWorklog\collector.env"),
    [switch]$DryRun,
    [switch]$ValidateOnly
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$ConfigKeys = @(
    "AI_WORKLOG_ACCOUNT_ID",
    "AI_WORKLOG_DEVICE_ID",
    "CODEX_SOURCE_INSTANCE_ID",
    "CODEX_SOURCE_PATH",
    "CLAUDE_CODE_SOURCE_INSTANCE_ID",
    "CLAUDE_CODE_SOURCE_PATH",
    "AI_WORKLOG_PATH_HMAC_KEY",
    "COLLECTOR_DB_PATH",
    "AI_WORKLOG_SYNC_URL",
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

function Assert-RequiredConfig {
    $requiredKeys = @(
        "AI_WORKLOG_ACCOUNT_ID",
        "AI_WORKLOG_DEVICE_ID",
        "CODEX_SOURCE_INSTANCE_ID",
        "CODEX_SOURCE_PATH",
        "CLAUDE_CODE_SOURCE_INSTANCE_ID",
        "CLAUDE_CODE_SOURCE_PATH",
        "AI_WORKLOG_SYNC_URL",
        "AI_WORKLOG_DEVICE_TOKEN"
    )
    foreach ($key in $requiredKeys) {
        $value = [Environment]::GetEnvironmentVariable($key, "Process")
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "Missing required configuration"
        }
    }
    $absolutePathPattern = '^(?:[A-Za-z]:[\\/]|\\\\)'
    $codexPathIsAbsolute = $env:CODEX_SOURCE_PATH -match $absolutePathPattern
    $claudeCodePathIsAbsolute = $env:CLAUDE_CODE_SOURCE_PATH -match $absolutePathPattern
    if (-not $codexPathIsAbsolute -or -not $claudeCodePathIsAbsolute) {
        throw "Source paths must be absolute"
    }
    $databasePathConfigured = -not [string]::IsNullOrWhiteSpace($env:COLLECTOR_DB_PATH)
    $databasePathIsAbsolute = $env:COLLECTOR_DB_PATH -match $absolutePathPattern
    if ($databasePathConfigured -and -not $databasePathIsAbsolute) {
        throw "Collector database path must be absolute"
    }
    if (-not (Test-Path -LiteralPath $env:CODEX_SOURCE_PATH)) {
        throw "Missing source path"
    }
    if (-not (Test-Path -LiteralPath $env:CLAUDE_CODE_SOURCE_PATH)) {
        throw "Missing source path"
    }
    $sameSourceInstance = $env:CODEX_SOURCE_INSTANCE_ID -eq $env:CLAUDE_CODE_SOURCE_INSTANCE_ID
    $sameSourcePath = $env:CODEX_SOURCE_PATH -ieq $env:CLAUDE_CODE_SOURCE_PATH
    if ($sameSourceInstance -or $sameSourcePath) {
        throw "Source identities and paths must be distinct"
    }
    $syncUri = [Uri]::new($env:AI_WORKLOG_SYNC_URL, [UriKind]::Absolute)
    $localHttp = $syncUri.Scheme -eq "http"
    if ($localHttp) {
        $localHttp = @("localhost", "127.0.0.1", "::1") -contains $syncUri.Host
    }
    $secureEndpoint = $syncUri.Scheme -eq "https" -or $localHttp
    $hasEmbeddedCredentials = -not [string]::IsNullOrEmpty($syncUri.UserInfo)
    if (-not $secureEndpoint -or $hasEmbeddedCredentials) {
        throw "Invalid sync endpoint"
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
        [Parameter(Mandatory = $true)][ValidateSet("prepare", "sync")][string]$Command,
        [Parameter(Mandatory = $true)][ValidateSet("prepare-codex", "prepare-claude-code", "sync")][string]$LogPhase,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$SourceType
    )

    if (@("", "CODEX", "CLAUDE_CODE") -notcontains $SourceType) {
        throw "Invalid collector source type"
    }
    if ([string]::IsNullOrEmpty($SourceType)) {
        [Environment]::SetEnvironmentVariable("AI_WORKLOG_SOURCE_TYPE", $null, "Process")
    } else {
        [Environment]::SetEnvironmentVariable("AI_WORKLOG_SOURCE_TYPE", $SourceType, "Process")
    }
    & $NodeBinary $TsxCli $CollectorCli $Command *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-SafeEvent -Phase $LogPhase -Status "ok"
        return $true
    }
    Write-SafeEvent -Phase $LogPhase -Status "failed"
    return $false
}

function Invoke-ScheduledCollector {
    Import-CollectorConfig $ConfigPath
    Assert-RequiredConfig
    $nodeBinary = Resolve-NodeBinary
    $projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
    $tsxCli = Join-Path $projectRoot "node_modules\tsx\dist\cli.mjs"
    $collectorCli = Join-Path $projectRoot "apps\collector\src\index.ts"
    if (-not (Test-Path -LiteralPath $tsxCli -PathType Leaf) -or
        -not (Test-Path -LiteralPath $collectorCli -PathType Leaf)) {
        throw "Collector runtime is unavailable"
    }

    if ($DryRun) {
        Write-SafeEvent -Phase "validation" -Status "dry-run" -Persist $false
        return 0
    }
    if ($ValidateOnly) {
        Write-SafeEvent -Phase "validation" -Status "ok" -Persist $false
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
        if (-not (Invoke-CollectorPhase -NodeBinary $nodeBinary -TsxCli $tsxCli -CollectorCli $collectorCli -Command "prepare" -LogPhase "prepare-codex" -SourceType "CODEX")) {
            $scheduleFailed = $true
        }
        if (-not (Invoke-CollectorPhase -NodeBinary $nodeBinary -TsxCli $tsxCli -CollectorCli $collectorCli -Command "prepare" -LogPhase "prepare-claude-code" -SourceType "CLAUDE_CODE")) {
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
