<#
  Romdoul OCR keep-alive watchdog.

  Runs on a schedule (Task Scheduler). Each run it makes sure the stack that
  serves the public Netlify site is up:

    1. Docker Desktop is running (starts it and waits if not).
    2. The Surya GPU containers are revived (they exit 255 after sleep and do
       NOT auto-restart -- this is why vLLM "can't be accessed"). Done FIRST
       because the main SPA declares the surya network as external.
    3. The compose stacks are up (docker compose up -d -- idempotent).
    4. The Tailscale Funnel is serving the SPA port (re-runs it if it dropped).
    5. A per-backend health check is logged so you can see what is down.

  Windows PowerShell 5.1 compatible. ASCII only (avoids encoding surprises).
  Safe to run repeatedly.
#>

param(
    [string]$ProjectDir = "C:\Users\USER\work\ocrapi_backup",
    # Host port the SPA/nginx container is published on (matches PORT in .env)
    # and the port exposed by the Tailscale Funnel.
    [int]$FunnelPort = 8181
)

$ErrorActionPreference = "Continue"
$LogFile = Join-Path $PSScriptRoot "keepalive.log"

function Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $LogFile -Value $line -Encoding utf8
}

# Trim the log so it cannot grow forever.
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 1MB)) {
    $tail = Get-Content $LogFile -Tail 500
    Set-Content -Path $LogFile -Value $tail -Encoding utf8
}

Log "--- keepalive run ---"

# 1. Ensure Docker is responding; start Docker Desktop if not. ----------------
function Test-Docker {
    docker info 1>$null 2>$null
    return ($LASTEXITCODE -eq 0)
}

if (-not (Test-Docker)) {
    Log "Docker not responding - starting Docker Desktop"
    $dd = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dd) {
        Start-Process $dd
    } else {
        Log "Docker Desktop.exe not found at $dd - check the install path"
    }
    for ($i = 0; $i -lt 24; $i++) {   # wait up to ~2 minutes
        Start-Sleep -Seconds 5
        if (Test-Docker) { break }
    }
}

if (-not (Test-Docker)) {
    Log "Docker still down after wait - aborting this run"
    return
}

if (-not (Test-Path $ProjectDir)) {
    Log "ProjectDir not found: $ProjectDir - aborting"
    return
}
Set-Location $ProjectDir

# 2. Revive the Surya GPU containers FIRST. --------------------------------------
# They do NOT auto-restart after reboot/sleep (they exit 255), which is why vLLM
# "can't be accessed" even though the PC is on. This runs before the main SPA
# stack because docker-compose.yml declares the surya network as EXTERNAL -- the
# SPA container will not start unless that network already exists, and reviving
# these containers keeps it alive. ~2 min model load on a cold start. A missing
# container is skipped (the GPU stack simply is not set up on this machine).
$suryaNames = @("surya-container-vllm", "surya-vllm")
foreach ($name in $suryaNames) {
    $found = docker ps -a --filter ('name=^{0}$' -f $name) --format '{{.Names}}' 2>$null
    if ($found) {
        docker start $name 1>$null 2>$null
        Log ("docker start {0} (exit {1})" -f $name, $LASTEXITCODE)
    } else {
        Log ("GPU container {0} not found - skipping" -f $name)
    }
}

# 3. Bring up the compose stacks (main FIRST -- it creates the network the
#    tidy/lens adapters attach to). Only stacks whose files exist are started. --
$composeFiles = @(
    "docker-compose.yml",                 # SPA + nginx (needs the surya network)
    "docker-compose.tidy-adapter.yml",    # transform-to-tidy
    "docker-compose.lens-adapter.yml",    # Google Lens backend
    "docker-compose.vllm-adapter.yml"     # vLLM adapter (needs the surya network)
)
foreach ($f in $composeFiles) {
    if (Test-Path $f) {
        docker compose -f $f up -d 1>$null 2>$null
        Log ("compose up {0} (exit {1})" -f $f, $LASTEXITCODE)
    }
}

# 4. Ensure the Tailscale Funnel is serving the SPA port. ----------------------
$ts = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
if (-not (Test-Path $ts)) {
    $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($cmd) { $ts = $cmd.Source }
}
if (Test-Path $ts) {
    $status = (& $ts funnel status 2>$null | Out-String)
    if ($status -notmatch [string]$FunnelPort) {
        & $ts funnel --bg $FunnelPort 1>$null 2>$null
        Log "funnel (re)started on port $FunnelPort"
    } else {
        Log "funnel already serving $FunnelPort"
    }
} else {
    Log "tailscale.exe not found - funnel not checked"
}

# 5. Per-backend liveness check, through nginx exactly as the browser hits it,
#    so a down backend shows up in the log. "api" is the normal/Default cloud OCR
#    (nginx -> Modal): the watchdog can't restart Modal itself (it's not our
#    deployment), but this confirms the proxy path to it is working.
$checks = [ordered]@{
    "SPA"  = "http://localhost:$FunnelPort/"
    "api"  = "http://localhost:$FunnelPort/api/health"
    "tidy" = "http://localhost:$FunnelPort/api-tidy/health"
    "vllm" = "http://localhost:$FunnelPort/api-vllm/health"
    "lens" = "http://localhost:$FunnelPort/api-lens/health"
}
foreach ($name in $checks.Keys) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 $checks[$name]
        Log ("check {0}: HTTP {1}" -f $name, $r.StatusCode)
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code) {
            Log ("check {0}: HTTP {1}" -f $name, $code)
        } else {
            Log ("check {0}: UNREACHABLE - {1}" -f $name, $_.Exception.Message)
        }
    }
}

Log "--- done ---"
