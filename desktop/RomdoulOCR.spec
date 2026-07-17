# PyInstaller spec for the portable Romdoul OCR desktop app.
# Build:  python -m PyInstaller RomdoulOCR.spec --noconfirm --distpath out --workpath build
# Output: out/RomdoulOCR.exe  (ONE self-contained file — open the folder, see the app icon)

from PyInstaller.utils.hooks import collect_all

# Bundle the built web UI + the app icon so everything ships in the one .exe.
datas = [('webui', 'webui'), ('assets/icon.ico', 'assets')]
binaries = []
hiddenimports = ['clr']

# These packages ship data files / native DLLs (WebView2 loader, pystray win32
# backend, PIL plugins) that PyInstaller misses without collect_all.
for pkg in ('webview', 'pystray', 'PIL', 'mss', 'keyboard'):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

try:
    d, b, h = collect_all('pythonnet')
    datas += d
    binaries += b
    hiddenimports += h
except Exception:
    pass

# Be explicit about the Windows webview backends so they aren't tree-shaken.
hiddenimports += [
    'webview.platforms.winforms',
    'webview.platforms.edgechromium',
    'pystray._win32',
]

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

# ONE-FILE build: binaries + data folded into a single RomdoulOCR.exe, so the
# distributed folder contains just the app (with its icon) — nothing else to see.
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='RomdoulOCR',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    runtime_tmpdir=None,
    console=False,           # no console window (it's a GUI/tray app)
    disable_windowed_traceback=False,
    icon='assets/icon.ico',
)
