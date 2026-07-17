# Romdoul OCR — Portable Windows app

A standalone, double-click Windows build of Romdoul OCR **plus a Windows-Snip-style
screenshot → OCR tool** with a configurable global hotkey. It reuses the exact web
UI you already ship — it does **not** touch or change the website build.

## What it does

- Runs the full Romdoul OCR app in a native window (via WebView2, built into Windows 11).
- **Global hotkey** (default `Ctrl+Shift+S`, changeable in Settings) → drag a box
  anywhere on screen → it OCRs that region → shows the text with **Copy**.
- Lives in the **system tray**: *Open app · Snip & read · Settings · Quit*.
- Defaults to **Google Lens**; you can switch engines in the app or in Settings.

## How OCR works (important)

The `.exe` is self-contained, but the **OCR engine is not inside it** — it calls
your backends through the home machine, exactly like the website:

```
app / snipper → local proxy (127.0.0.1) → Tailscale Funnel → home nginx → adapter
```

So it needs **internet** (for Google Lens) or the **home PC reachable** (for
Surya / vLLM). The adapter token stays server-side — nothing secret is in the app.
Point *Settings → Home server URL* at a LAN IP when you're on the same network for
lower latency. (Truly offline OCR would need a bundled engine like Tesseract — not
included yet.)

## Run from source (dev)

```powershell
cd desktop
python -m pip install -r requirements.txt
python main.py
```

## Build the portable .exe

```powershell
cd desktop
powershell -ExecutionPolicy Bypass -File build.ps1
```

Output: **`out\RomdoulOCR\RomdoulOCR.exe`**. Zip the whole `out\RomdoulOCR\`
folder and hand it to any Windows PC — they just run the `.exe`, no install.
(Windows 11 already has the WebView2 runtime; on older machines it auto-installs.)

## Update the bundled UI

`build.ps1` re-copies the latest UI from the running `khmer-parser-ui` container.
To refresh manually:

```powershell
docker cp khmer-parser-ui:/usr/share/nginx/html/. webui/
```

## Files

| File | Role |
|------|------|
| `main.py` | Controller: tray, global hotkey, launches the app window |
| `server.py` | Local static server + reverse-proxy to the funnel + Lens-default seed |
| `snipper.py` | Screen capture + drag-select overlay + result window |
| `ocr.py` | Upload a crop → backend → text |
| `settings_window.py` | Hotkey / engine / server URL settings |
| `appwindow.py` | The pywebview app window (child process) |
| `config.py` | Settings persisted to `%APPDATA%\RomdoulOCR\config.json` |
| `webui/` | The bundled built web app (copied from the container) |
