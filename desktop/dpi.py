"""
Per-display DPI scaling for the native (Tk) windows.

main.py marks the process per-monitor-DPI-aware so the snip overlay maps 1:1 to
the physical pixels mss captures (accurate crops). The side effect is that Windows
no longer auto-scales our UI, so on 125/150/200% or 4K displays fixed-pixel windows
and point fonts would render tiny. We compensate by:
  * scaling window geometry ourselves (px()), and
  * setting Tk's scaling factor so point-based fonts render at the right size.
On a normal 100% (96 DPI) display scale()==1.0, so nothing changes — no regression.
"""
from __future__ import annotations

import ctypes

_cache: float | None = None


def scale() -> float:
    global _cache
    if _cache is None:
        dpi = 96
        try:
            dpi = int(ctypes.windll.user32.GetDpiForSystem())
        except Exception:
            try:
                dc = ctypes.windll.user32.GetDC(0)
                dpi = int(ctypes.windll.gdi32.GetDeviceCaps(dc, 88))  # LOGPIXELSX
                ctypes.windll.user32.ReleaseDC(0, dc)
            except Exception:
                dpi = 96
        _cache = max(1.0, min(dpi / 96.0, 4.0))
    return _cache


def px(n: float) -> int:
    """Scale a design pixel value to the current display."""
    return int(round(n * scale()))


def apply_tk_scaling(root) -> None:
    """Make point-based Tk fonts render at the correct physical size."""
    try:
        root.tk.call("tk", "scaling", scale() * 96.0 / 72.0)
    except Exception:
        pass
