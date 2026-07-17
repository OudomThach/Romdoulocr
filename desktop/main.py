"""
Romdoul OCR — portable Windows app. Entry point / background controller.

Two modes in one executable:
  * default            → the controller: starts the local server, shows a tray
                         icon, registers the global screenshot hotkey, and (by
                         default) opens the main app window.
  * --appwindow --url  → just the pywebview app window, run as a child process so
                         closing it doesn't kill the controller.

The controller keeps the tray + hotkey alive in the background even when the app
window is closed, so the "snip anywhere" hotkey always works — like a real
Windows utility.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading

import config as config_mod


# --------------------------------------------------------------------------- #
# Paths / DPI
# --------------------------------------------------------------------------- #
def resource_path(rel: str) -> str:
    """Path to a bundled resource, working both in dev and inside PyInstaller."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


def set_dpi_aware() -> None:
    """So Tk widget coords match the physical pixels mss captures (per-monitor v2)."""
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# App window (child process)
# --------------------------------------------------------------------------- #
def spawn_app_window(url: str) -> None:
    if getattr(sys, "frozen", False):
        args = [sys.executable, "--appwindow", "--url", url]
    else:
        args = [sys.executable, os.path.abspath(__file__), "--appwindow", "--url", url]
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    try:
        subprocess.Popen(args, creationflags=flags)
    except Exception:
        import webbrowser
        webbrowser.open(url)


# --------------------------------------------------------------------------- #
# Snip flow (worker thread)
# --------------------------------------------------------------------------- #
_snip_lock = threading.Lock()

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif")


def _autosave(cfg: config_mod.Config, png: bytes) -> None:
    """Drop the screenshot into the user's chosen folder, if they set one."""
    if not cfg.save_dir:
        return
    try:
        from datetime import datetime
        os.makedirs(cfg.save_dir, exist_ok=True)
        name = "romdoul-snip-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".png"
        with open(os.path.join(cfg.save_dir, name), "wb") as fh:
            fh.write(png)
    except Exception:
        pass


def run_snip(cfg: config_mod.Config, server_url: str) -> None:
    if not _snip_lock.acquire(blocking=False):
        return  # a snip is already in progress
    try:
        import snipper
        png = snipper.capture_and_select()
        if not png:
            return
        _autosave(cfg, png)
        try:
            import ocr
            text = ocr.ocr_image(png, server_url, cfg.prefix())
        except Exception as exc:  # network / backend down
            text = f"[OCR failed]\n\n{exc}\n\nCheck your internet / that the PC is on."
        snipper.show_result(text, image_png=png, save_dir=cfg.save_dir)
    finally:
        _snip_lock.release()


def read_file_flow(cfg: config_mod.Config, server_url: str) -> None:
    """Tray 'Read a file…' — OCR an image file directly, or open PDFs in the app."""
    import tkinter as tk
    from tkinter import filedialog

    picker = tk.Tk()
    picker.withdraw()
    picker.attributes("-topmost", True)
    path = filedialog.askopenfilename(
        parent=picker, title="Read an image or PDF",
        filetypes=[("Images & PDF", "*.png *.jpg *.jpeg *.webp *.bmp *.tif *.tiff *.pdf"),
                   ("All files", "*.*")],
    )
    picker.destroy()
    if not path:
        return
    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        # Multi-page PDFs use the full app flow (page select, tables, translate).
        spawn_app_window(server_url)
        return
    if ext not in IMAGE_EXTS:
        return
    with open(path, "rb") as fh:
        data = fh.read()
    import snipper
    try:
        import ocr
        text = ocr.ocr_image(data, server_url, cfg.prefix())
    except Exception as exc:
        text = f"[OCR failed]\n\n{exc}"
    snipper.show_result(text, image_png=data, save_dir=cfg.save_dir)


# --------------------------------------------------------------------------- #
# Tray icon
# --------------------------------------------------------------------------- #
def _tray_image():
    from PIL import Image, ImageDraw
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([4, 4, 60, 60], radius=14, fill=(11, 18, 32, 255),
                        outline=(0, 229, 255, 255), width=3)
    d.text((22, 18), "R", fill=(0, 229, 255, 255))
    return img


def main() -> None:
    set_dpi_aware()
    cfg = config_mod.load()

    # Start the local static + proxy server.
    import server
    srv = server.LocalServer(resource_path("webui"), cfg.funnel_base, cfg.backend, cfg.port)
    server_url = srv.start()

    # Global screenshot hotkey (re-registerable when settings change).
    import keyboard
    hotkey_ref: dict[str, object] = {"handle": None}

    def register_hotkey(combo: str):
        if hotkey_ref["handle"] is not None:
            try:
                keyboard.remove_hotkey(hotkey_ref["handle"])
            except Exception:
                pass
        hotkey_ref["handle"] = keyboard.add_hotkey(
            combo, lambda: threading.Thread(
                target=run_snip, args=(cfg_state["cfg"], server_url), daemon=True
            ).start()
        )

    cfg_state = {"cfg": cfg}
    try:
        register_hotkey(cfg.hotkey)
    except Exception:
        pass

    # Tray icon + menu.
    import pystray

    def on_open(_i=None, _item=None):
        spawn_app_window(server_url)

    def on_snip(_i=None, _item=None):
        threading.Thread(target=run_snip, args=(cfg_state["cfg"], server_url), daemon=True).start()

    def on_read_file(_i=None, _item=None):
        threading.Thread(target=read_file_flow, args=(cfg_state["cfg"], server_url), daemon=True).start()

    def on_settings(_i=None, _item=None):
        def _open():
            import settings_window

            def saved(new_cfg: config_mod.Config):
                cfg_state["cfg"] = new_cfg
                srv.backend = new_cfg.backend  # snipper prefix updates immediately
                try:
                    register_hotkey(new_cfg.hotkey)
                except Exception:
                    pass

            settings_window.open_settings(cfg_state["cfg"], saved)

        threading.Thread(target=_open, daemon=True).start()

    def on_quit(icon, _item=None):
        try:
            srv.stop()
        except Exception:
            pass
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem("Open Romdoul OCR", on_open, default=True),
        pystray.MenuItem(f"Snip & read  ({cfg.hotkey})", on_snip),
        pystray.MenuItem("Read image / PDF file…", on_read_file),
        pystray.MenuItem("Settings…", on_settings),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", on_quit),
    )
    icon = pystray.Icon("RomdoulOCR", _tray_image(), "Romdoul OCR", menu)

    if cfg.open_app_on_start:
        threading.Timer(0.6, lambda: spawn_app_window(server_url)).start()

    icon.run()  # blocks the main thread until Quit


if __name__ == "__main__":
    if "--appwindow" in sys.argv:
        url = "http://127.0.0.1:8000/"
        if "--url" in sys.argv:
            url = sys.argv[sys.argv.index("--url") + 1]
        import appwindow
        appwindow.run(url)
    else:
        main()
