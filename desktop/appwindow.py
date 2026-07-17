"""
The main application window — the full Romdoul OCR web UI in a native frame.

Launched as its OWN process (main.py re-runs the exe with --appwindow --url ...)
so pywebview owns that process's main thread and closing the window never kills
the background controller (tray + hotkey + server). Falls back to the default
browser if the WebView2 runtime is somehow unavailable.
"""
from __future__ import annotations

import sys
import webbrowser


def run(url: str) -> None:
    try:
        import webview
    except Exception:
        webbrowser.open(url)
        return
    try:
        webview.create_window(
            "Romdoul OCR", url, width=1280, height=860, min_size=(900, 640),
        )
        webview.start()  # blocks until the window is closed
    except Exception:
        webbrowser.open(url)


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/"
    run(target)
