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

Output: **`out\RomdoulOCR.exe`** — **one single file** with the app icon. Send
just that `.exe` to any Windows PC and double-click it, no install and nothing
else to copy. (Windows 11 already has the WebView2 runtime; older machines
auto-install it.) First launch takes a few seconds while it unpacks.

## Updates ("Check for updates" in the tray)

The tray shows the version and has **Check for updates…**. It asks GitHub for the
latest **Release** and, if newer than the running build, offers to download it.

Because the repo is **private**, the public API can't read it without a token
(which we never embed), so on a private repo the check gracefully falls back to
**opening the releases page** in your browser. To enable real auto-compare:

1. Bump `VERSION` in `desktop/version.py` before building.
2. Build (`build.ps1`), zip `out\RomdoulOCR\`.
3. On GitHub → **Releases → Draft a new release**, tag it `v1.0.1` (matching the
   bumped version), attach the zip, publish.

Either make the repo/releases public for others to auto-update, or (private) the
owner just uses the "open releases page" fallback while signed in.

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
