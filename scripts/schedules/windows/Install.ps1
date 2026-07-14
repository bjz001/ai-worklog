[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA "AIWorklog\collector.env"),
    [switch]$DryRun
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$TaskName = "AI Worklog Nightly Sync"

function Write-SafeInstallEvent {
    param([Parameter(Mandatory = $true)][string]$Status)
    [ordered]@{
        event = "ai-worklog-install"
        status = $Status
    } | ConvertTo-Json -Compress | Write-Output
}

function Quote-TaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value -match '["\r\n]') {
        throw "Unsafe task argument"
    }
    return '"' + $Value + '"'
}

try {
    $runner = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "Run.ps1")).Path
    $resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
    $powerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) {
        throw "Windows PowerShell is unavailable"
    }

    $validationArguments = @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-File", $runner,
        "-ConfigPath", $resolvedConfig, "-ValidateOnly"
    )
    & $powerShellPath $validationArguments *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Configuration validation failed"
    }
    if ($DryRun) {
        Write-SafeInstallEvent "dry-run"
        exit 0
    }

    $actionArguments = @(
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        (Quote-TaskArgument $runner),
        "-ConfigPath",
        (Quote-TaskArgument $resolvedConfig)
    ) -join " "
    $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $actionArguments
    $startAt = [DateTime]::Today.AddHours(23).AddMinutes(30)
    $trigger = New-ScheduledTaskTrigger -Daily -At $startAt
    $settingsArguments = @{
        StartWhenAvailable = $true
        MultipleInstances = "IgnoreNew"
        ExecutionTimeLimit = (New-TimeSpan -Hours 1)
    }
    $settings = New-ScheduledTaskSettingsSet @settingsArguments
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principalArguments = @{
        UserId = $identity.Name
        LogonType = "Interactive"
        RunLevel = "Limited"
    }
    $principal = New-ScheduledTaskPrincipal @principalArguments
    $taskArguments = @{
        Action = $action
        Trigger = $trigger
        Settings = $settings
        Principal = $principal
        Description = "Collect and sync AI worklog metadata every day at 23:30 local time."
    }
    $task = New-ScheduledTask @taskArguments
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
    Write-SafeInstallEvent "installed"
} catch {
    $failure = Write-SafeInstallEvent "failed"
    [Console]::Error.WriteLine($failure)
    exit 1
}
