[CmdletBinding()]
param([switch]$DryRun)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$TaskName = "AI Worklog Nightly Sync"

function Write-SafeUninstallEvent {
    param([Parameter(Mandatory = $true)][string]$Status)
    [ordered]@{
        event = "ai-worklog-uninstall"
        status = $Status
    } | ConvertTo-Json -Compress | Write-Output
}

try {
    if ($DryRun) {
        Write-SafeUninstallEvent "dry-run"
        exit 0
    }
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $task) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Write-SafeUninstallEvent "uninstalled"
} catch {
    $failure = Write-SafeUninstallEvent "failed"
    [Console]::Error.WriteLine($failure)
    exit 1
}
