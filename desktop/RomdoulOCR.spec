# PyInstaller spec for the portable Romdoul OCR desktop app.
# Build:  python -m PyInstaller RomdoulOCR.spec --noconfirm --distpath out --workpath build
# Output: out/RomdoulOCR/RomdoulOCR.exe  (a self-contained portable folder)

from PyInstaller.utils.hooks import collect_all

# Bundle the built web UI so the app is fully self-contained.
datas = [('webui', 'webui')]
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

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='RomdoulOCR',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,           # no console window (it's a GUI/tray app)
    disable_windowed_traceback=False,
    icon='assets/icon.ico' if __import__('os').path.exists('assets/icon.ico') else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='RomdoulOCR',
)
