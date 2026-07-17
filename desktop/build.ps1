# Build the portable Romdoul OCR .exe (Windows).
#
#   1. Refresh webui/ from the latest built web app (optional but recommended).
#   2. Install deps.
#   3. PyInstaller -> out\RomdoulOCR\RomdoulOCR.exe (a portable folder).
#
# Run from the desktop/ folder:  powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host '== Refreshing webui/ from the running container (if present) ==' -ForegroundColor Cyan
try {
  docker cp khmer-parser-ui:/usr/share/nginx/html/. webui/ 2>$null
  Write-Host '   webui/ refreshed from khmer-parser-ui' -ForegroundColor DarkGray
} catch {
  Write-Host '   container not running - using existing webui/ snapshot' -ForegroundColor DarkYellow
}

Write-Host '== Installing Python deps ==' -ForegroundColor Cyan
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

Write-Host '== Generating app icon ==' -ForegroundColor Cyan
python make_icon.py

Write-Host '== Building the single-file .exe ==' -ForegroundColor Cyan
python -m PyInstaller RomdoulOCR.spec --noconfirm --distpath out --workpath build

Write-Host ''
Write-Host 'DONE.' -ForegroundColor Green
Write-Host 'Portable app:  out\RomdoulOCR.exe  (one file, with the app icon)' -ForegroundColor Green
Write-Host 'Just send that single .exe to another PC - nothing else needed.' -ForegroundColor Green
