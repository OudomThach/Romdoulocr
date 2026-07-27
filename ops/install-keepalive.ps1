<#
  One-click installer for the Romdoul OCR keep-alive watchdog.

  HOW TO RUN: right-click this file -> "Run with PowerShell", then approve the
  UAC (Administrator) prompt. That's it.

  It will, as Administrator:
    1. Stop the PC from sleeping (powercfg, while on AC power).
    2. Register the "RomdoulKeepAlive" scheduled task (runs at logon AND every
       2 minutes) so the watchdog keeps the stack alive automatically.
    3. Run the watchdog once now to bring everything up.

  Re-running is safe (idempotent). ASCII / Windows PowerShell 5.1 compatible.
#>

$ErrorActionPreference = "Stop"
$here     = Split-Path -Parent $PSCommandPath
$watchdog = Join-Path $here "keepalive.ps1"

# 1. Self-elevate to Administrator if needed (triggers a UAC prompt). ----------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Requesting Administrator rights (approve the UAC prompt)..."
    Start-Process powershell.exe -Verb RunAs -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"{0}"' -f $PSCommandPath)
    )
    exit
}

Write-Host "== Romdoul keep-alive installer (Administrator) =="

if (-not (Test-Path $watchdog)) {
    Write-Host "[error] keepalive.ps1 not found next to this installer at: $watchdog"
    Write-Host "Press Enter to close."
    [void][System.Console]::ReadLine()
    exit 1
}

# 2. Stop the PC from sleeping (desktop / AC power). ---------------------------
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host "[ok] Sleep and hibernate disabled on AC power (the #1 cause of the site going down)."

# 3. Register the scheduled task (at logon + every 5 minutes). -----------------
$arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $watchdog
$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg
$atLogon = New-ScheduledTaskTrigger -AtLogOn
# Every 2 minutes: a broken backend is detected and repaired fast. The Modal
# warm-up inside the watchdog is separately rate-limited, so a tight cadence
# does not mean more load on the upstream API.
$everyN  = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName "RomdoulKeepAlive" -Action $action -Trigger $atLogon, $everyN -RunLevel Highest -Force -Description "Keep Romdoul OCR docker + tailscale funnel up" | Out-Null
Write-Host "[ok] Scheduled task 'RomdoulKeepAlive' registered (runs at logon and every 2 minutes)."

# 4. Run the watchdog once now. ------------------------------------------------
Write-Host "[..] Running the watchdog once to bring everything up now."
Write-Host "     (A cold start can take a couple of minutes -- Docker + the GPU model.)"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdog
Write-Host ""
Write-Host "[ok] All set. Log: $(Join-Path $here 'keepalive.log')"
Write-Host ""
Write-Host "Press Enter to close."
[void][System.Console]::ReadLine()
