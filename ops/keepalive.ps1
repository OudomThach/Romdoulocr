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
    [int]$FunnelPort = 8181,
    # Send a tiny real image through the Modal OCR endpoint to keep that
    # container warm (see section 6). Pass -WarmOcr:$false to disable.
    [bool]$WarmOcr = $true,
    # Minimum seconds between warm-ups. The watchdog runs more often than this
    # (fast failure detection) but must not hammer the upstream Modal account.
    [int]$WarmMinGapSec = 240
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
    "docker-compose.vllm-adapter.yml",    # vLLM adapter (needs the surya network)
    "docker-compose.jobs-adapter.yml",    # async batch jobs
    "docker-compose.status-adapter.yml"   # aggregate engine status
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

# 4b. Probe the funnel END-TO-END, from the public internet inward. ------------
# `tailscale funnel status` only proves the local config still lists the port. If
# Tailscale's ingress breaks, a cert expires, or an ACL changes, every local check
# above stays green while the public site is dead — the exact blind spot that made
# earlier outages so confusing. Probe a LOCAL adapter (lens) rather than /api, so a
# failure isolates the funnel instead of blaming the Modal cloud.
if (Test-Path $ts) {
    $publicOk = $false
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 `
             "https://apt-server-desktop.tail806605.ts.net/api-lens/health"
        $publicOk = ($r.StatusCode -eq 200)
        Log ("funnel end-to-end: HTTP {0}" -f $r.StatusCode)
    } catch {
        Log ("funnel end-to-end FAILED: {0}" -f $_.Exception.Message)
    }
    if (-not $publicOk) {
        # Re-arm ingress. Cheap and idempotent; only runs when the public path is
        # actually broken, so it will not disturb a healthy funnel.
        & $ts funnel --bg $FunnelPort 1>$null 2>$null
        Log "funnel re-armed after failed end-to-end probe"
    }
}

# 5. SELF-HEAL the host-port forward, then log per-backend health. ------------
# THE root cause of the outage this was built for: a container can be "healthy"
# internally while Docker Desktop's WSL2 host-port forward for the SPA port has
# gone stale (after sleep/idle). nginx is then unreachable from the host AND the
# Tailscale funnel, so the whole site looks dead even though every container is
# Up. `docker compose up -d` does NOT fix this -- nothing looks wrong to compose.
# The cure is to restart the SPA container, which re-establishes the forward.
# We probe "/" (served by nginx directly, no cloud dependency): a CONNECTION
# error there means the forward is stale, so restart once and re-check.
function Test-Spa {
    try {
        $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 12 ("http://127.0.0.1:{0}/" -f $FunnelPort)
        return $true
    } catch {
        # A real HTTP status (4xx/5xx) still proves the port forward works.
        if ($_.Exception.Response) { return $true }
        return $false
    }
}

if (-not (Test-Spa)) {
    Log "SPA unreachable on host port $FunnelPort (stale WSL2 port-forward?) - restarting khmer-parser-ui"
    docker restart khmer-parser-ui 1>$null 2>$null
    Start-Sleep -Seconds 6
    if (Test-Spa) {
        Log "SPA recovered after restarting khmer-parser-ui"
    } else {
        Log "SPA STILL unreachable after restart - Docker Desktop itself may need a restart"
    }
}

# Informational: per-backend liveness through nginx, exactly as the browser hits
# it. "api" is the Modal cloud (can be slow on a cold start; a timeout here is
# usually just Modal waking, not an outage).
$checks = [ordered]@{
    "SPA"    = "http://127.0.0.1:$FunnelPort/"
    "api"    = "http://127.0.0.1:$FunnelPort/api/health"
    "tidy"   = "http://127.0.0.1:$FunnelPort/api-tidy/health"
    "vllm"   = "http://127.0.0.1:$FunnelPort/api-vllm/health"
    "lens"   = "http://127.0.0.1:$FunnelPort/api-lens/health"
    "jobs"   = "http://127.0.0.1:$FunnelPort/api-jobs/health"
    "status" = "http://127.0.0.1:$FunnelPort/api-status/health"
}
function Invoke-Probe($url, $timeoutSec) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec $timeoutSec $url
        return @{ ok = ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400); detail = "HTTP $($r.StatusCode)" }
    } catch {
        if ($_.Exception.Response) {
            return @{ ok = $false; detail = "HTTP " + [int]$_.Exception.Response.StatusCode }
        }
        return @{ ok = $false; detail = "UNREACHABLE - " + $_.Exception.Message }
    }
}

# Force a backend back to a good state. `compose up -d` alone is NOT enough here:
# a container can be "Up (healthy)" while its Docker network binding has gone
# stale, so it answers 502 through nginx and compose sees nothing wrong.
# --force-recreate rebuilds the container and its network attachment.
function Repair-Backend($name) {
    switch ($name) {
        "SPA"  {
            docker restart khmer-parser-ui 1>$null 2>$null
            return "restarted khmer-parser-ui"
        }
        "tidy" {
            docker compose -f docker-compose.tidy-adapter.yml up -d --force-recreate 1>$null 2>$null
            return "force-recreated tidy-adapter"
        }
        "lens" {
            docker compose -f docker-compose.lens-adapter.yml up -d --force-recreate 1>$null 2>$null
            return "force-recreated lens-adapter"
        }
        "vllm" {
            # The GPU engine is the usual culprit; the adapter is just its proxy.
            docker start surya-vllm 1>$null 2>$null
            docker compose -f docker-compose.vllm-adapter.yml up -d --force-recreate 1>$null 2>$null
            return "started surya-vllm + force-recreated vllm-adapter"
        }
        "jobs" {
            docker compose -f docker-compose.jobs-adapter.yml up -d --force-recreate 1>$null 2>$null
            return "force-recreated jobs-adapter"
        }
        "status" {
            docker compose -f docker-compose.status-adapter.yml up -d --force-recreate 1>$null 2>$null
            return "force-recreated status-adapter"
        }
        default { return $null }
    }
}

foreach ($name in $checks.Keys) {
    # Default (Modal cloud) scales to zero when idle and takes ~20s to wake.
    # Give it a long timeout so this probe COMPLETES each run. The local
    # adapters answer in milliseconds, so a short timeout is fine for them.
    $to  = if ($name -eq "api") { 45 } else { 15 }
    $res = Invoke-Probe $checks[$name] $to
    if ($res.ok) { Log ("check {0}: {1}" -f $name, $res.detail); continue }

    # Anti-flap: one quick retry before doing anything disruptive, so a single
    # blip under load never triggers a needless container recreate.
    Start-Sleep -Seconds 3
    $res = Invoke-Probe $checks[$name] $to
    if ($res.ok) { Log ("check {0}: {1} (recovered on retry)" -f $name, $res.detail); continue }

    # Modal is someone else's cloud deployment -- there is nothing local to fix.
    if ($name -eq "api") {
        Log ("check api: {0} - upstream Modal is cloud-side, no local repair" -f $res.detail)
        continue
    }

    Log ("check {0}: {1} -> REPAIRING" -f $name, $res.detail)
    $what = Repair-Backend $name
    if ($what) {
        Log ("repair {0}: {1}" -f $name, $what)
        Start-Sleep -Seconds 10
        $after = Invoke-Probe $checks[$name] $to
        if ($after.ok) {
            Log ("check {0}: {1} (RECOVERED after repair)" -f $name, $after.detail)
        } else {
            # vLLM legitimately needs ~2 min to load its model after a restart,
            # so "still failing" right here often clears by the next run.
            Log ("check {0}: STILL FAILING after repair - {1}" -f $name, $after.detail)
        }
    }
}

# 6. Keep the Modal OCR container warm. ---------------------------------------
# /health and /ocr-image are SEPARATE Modal functions with SEPARATE containers.
# Measured: /health answers in ~0.9s (kept warm by the probe above) while
# /api/ocr-image still took ~22s from cold. So probing /health does NOT prevent
# the ~22-second stall a user hits on their first real scan -- and a 22s hang is
# what reads as "the site is broken" (and can surface as HTTP 0 / Network error
# if a phone or flaky Wi-Fi drops the connection while waiting).
# Sending a tiny real image through the OCR path keeps that container warm too.
# NOTE: this is a real request to the upstream Modal API each run (~288/day).
# Pass -WarmOcr:$false to turn it off.
if ($WarmOcr) {
    $warmPng = Join-Path $PSScriptRoot "warm.png"
    if (-not (Test-Path $warmPng)) {
        try {
            Add-Type -AssemblyName System.Drawing
            $bmp  = New-Object System.Drawing.Bitmap 240, 80
            $g    = [System.Drawing.Graphics]::FromImage($bmp)
            $g.Clear([System.Drawing.Color]::White)
            $font = New-Object System.Drawing.Font "Arial", 24
            $g.DrawString("warm", $font, [System.Drawing.Brushes]::Black, 12, 20)
            $g.Dispose()
            $bmp.Save($warmPng, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            Log "created warm-up image: $warmPng"
        } catch {
            Log ("could not create warm-up image: {0}" -f $_.Exception.Message)
        }
    }
    # The watchdog itself runs often (every ~2 min) so a broken backend is caught
    # quickly, but warming hits the upstream Modal account for real -- so rate
    # limit the warm-up to at most once per WarmMinGapSec regardless of cadence.
    $stamp  = Join-Path $PSScriptRoot ".lastwarm"
    $warmDue = $true
    if (Test-Path $stamp) {
        try {
            $last = [datetime]((Get-Content $stamp -Raw).Trim())
            if (((Get-Date) - $last).TotalSeconds -lt $WarmMinGapSec) { $warmDue = $false }
        } catch { $warmDue = $true }
    }

    if (-not $warmDue) {
        Log "warm ocr: skipped (warmed recently)"
    } elseif (Test-Path $warmPng) {
        $t0   = Get-Date
        $url  = "http://127.0.0.1:{0}/api/ocr-image" -f $FunnelPort
        $code = & curl.exe -s -o NUL -w "%{http_code}" -m 90 -F ("file=@{0}" -f $warmPng) $url 2>$null
        $ms   = [int]((Get-Date) - $t0).TotalMilliseconds
        Log ("warm ocr: HTTP {0} in {1}ms" -f $code, $ms)
        (Get-Date).ToString("o") | Set-Content -Path $stamp -Encoding ascii
    }
}

Log "--- done ---"
