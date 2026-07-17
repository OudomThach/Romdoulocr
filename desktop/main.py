"""
Romdoul OCR — portable Windows app. Entry point / background controller.

Two modes in one executable:
  * default            → a quiet BACKGROUND SERVICE: local server + system-tray
                         icon + global screenshot hotkey. No giant window on
                         launch; you snip anywhere or open the app on demand.
  * --appwindow --url  → the full app in a pywebview window, run as a child
                         process so closing it never kills the background service.

All on-screen UI (snip overlay, the compact result preview, settings) are small
Toplevels on one hidden Tk root managed by gui.Gui — so many little windows can
coexist and open instantly instead of one big blocking window.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading

import config as config_mod

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif")


# --------------------------------------------------------------------------- #
# Paths / DPI
# --------------------------------------------------------------------------- #
def resource_path(rel: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


def set_dpi_aware() -> None:
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
# Snip / file OCR flows (open small windows on the GUI thread)
# --------------------------------------------------------------------------- #
_overlay_active = threading.Event()


def _autosave_pair(cfg: config_mod.Config, png: bytes, text: str) -> None:
    """Auto-save a snip: PNG (+ matching .txt when save_text) into save_dir."""
    if not cfg.save_dir:
        return
    try:
        from datetime import datetime
        os.makedirs(cfg.save_dir, exist_ok=True)
        stem = "romdoul-snip-" + datetime.now().strftime("%Y%m%d-%H%M%S")
        with open(os.path.join(cfg.save_dir, stem + ".png"), "wb") as fh:
            fh.write(png)
        if cfg.save_text:
            with open(os.path.join(cfg.save_dir, stem + ".txt"), "w", encoding="utf-8") as fh:
                fh.write(text or "")
    except Exception:
        pass


def _autosave_text_named(cfg: config_mod.Config, stem: str, text: str) -> None:
    if not (cfg.save_dir and cfg.save_text):
        return
    try:
        os.makedirs(cfg.save_dir, exist_ok=True)
        with open(os.path.join(cfg.save_dir, stem + ".txt"), "w", encoding="utf-8") as fh:
            fh.write(text or "")
    except Exception:
        pass


def _ocr_then_preview(gui, cfg, server_url, png: bytes) -> None:
    """Runs on a worker thread: OCR the crop, then post a preview to the GUI."""
    try:
        import ocr
        text = ocr.ocr_image(png, server_url, cfg.prefix())
    except Exception as exc:
        text = f"[OCR failed]\n\n{exc}\n\nCheck your internet / that the PC is on."
    _autosave_pair(cfg, png, text)
    import snipper
    gui.post(lambda: snipper.open_preview(gui.root, png, text, cfg.save_dir, cfg.backend))


def _batch_ocr(gui, cfg, server_url, images: list) -> None:
    """OCR many image files, auto-save each .txt, then show one batch window."""
    import ocr
    import snipper
    items = []
    for path in images:
        try:
            with open(path, "rb") as fh:
                data = fh.read()
            text = ocr.ocr_image(data, server_url, cfg.prefix())
        except Exception as exc:
            text = f"[OCR failed] {exc}"
        name = os.path.basename(path)
        items.append({"name": name, "text": text})
        _autosave_text_named(cfg, os.path.splitext(name)[0], text)
    gui.post(lambda: snipper.open_batch(gui.root, items, cfg.save_dir, cfg.backend))


def trigger_snip(gui, get_cfg, server_url) -> None:
    if _overlay_active.is_set():
        return  # one overlay at a time
    _overlay_active.set()

    def on_capture(png):
        _overlay_active.clear()
        if not png:
            return
        cfg = get_cfg()
        threading.Thread(target=_ocr_then_preview, args=(gui, cfg, server_url, png),
                         daemon=True).start()

    import snipper
    gui.post(lambda: snipper.open_overlay(gui.root, on_capture))


def trigger_read_file(gui, get_cfg, server_url) -> None:
    def pick():
        from tkinter import filedialog
        paths = filedialog.askopenfilenames(
            parent=gui.root, title="Read images or a PDF (pick one or many)",
            filetypes=[("Images & PDF", "*.png *.jpg *.jpeg *.webp *.bmp *.tif *.tiff *.pdf"),
                       ("All files", "*.*")],
        )
        if not paths:
            return
        paths = list(paths)
        pdfs = [p for p in paths if p.lower().endswith(".pdf")]
        images = [p for p in paths if os.path.splitext(p)[1].lower() in IMAGE_EXTS]
        if pdfs:
            spawn_app_window(server_url)  # PDFs use the full multi-page app flow
        if not images:
            return
        cfg = get_cfg()
        if len(images) == 1:
            with open(images[0], "rb") as fh:
                data = fh.read()
            threading.Thread(target=_ocr_then_preview, args=(gui, cfg, server_url, data),
                             daemon=True).start()
        else:
            threading.Thread(target=_batch_ocr, args=(gui, cfg, server_url, images),
                             daemon=True).start()

    gui.post(pick)


# --------------------------------------------------------------------------- #
# Tray
# --------------------------------------------------------------------------- #
def _tray_image():
    from PIL import Image, ImageDraw
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([4, 4, 60, 60], radius=14, fill=(11, 18, 32, 255),
                        outline=(0, 229, 255, 255), width=3)
    d.text((24, 18), "R", fill=(0, 229, 255, 255))
    return img


def main() -> None:
    set_dpi_aware()
    cfg = config_mod.load()

    import server
    srv = server.LocalServer(resource_path("webui"), cfg.funnel_base, cfg.backend, cfg.port)
    server_url = srv.start()

    import gui as gui_mod
    gui = gui_mod.Gui()
    gui.start()

    cfg_state = {"cfg": cfg}
    get_cfg = lambda: cfg_state["cfg"]  # noqa: E731

    import keyboard
    hotkey_ref = {"handle": None}

    def register_hotkey(combo: str):
        if hotkey_ref["handle"] is not None:
            try:
                keyboard.remove_hotkey(hotkey_ref["handle"])
            except Exception:
                pass
        hotkey_ref["handle"] = keyboard.add_hotkey(
            combo, lambda: trigger_snip(gui, get_cfg, server_url)
        )

    try:
        register_hotkey(cfg.hotkey)
    except Exception:
        pass

    import pystray

    def on_open(*_):
        spawn_app_window(server_url)

    def on_snip(*_):
        trigger_snip(gui, get_cfg, server_url)

    def on_read(*_):
        trigger_read_file(gui, get_cfg, server_url)

    def on_settings(*_):
        def saved(new_cfg: config_mod.Config):
            cfg_state["cfg"] = new_cfg
            srv.backend = new_cfg.backend
            try:
                register_hotkey(new_cfg.hotkey)
            except Exception:
                pass

        import settings_window
        gui.post(lambda: settings_window.open_settings(gui.root, get_cfg(), saved))

    def on_update(*_):
        def work():
            import updater
            import version
            res = updater.check(version.VERSION)

            def show():
                from tkinter import messagebox
                import webbrowser
                parent = gui.root
                if res["status"] == "update":
                    if messagebox.askyesno(
                        "Update available",
                        f"Version {res['latest']} is available (you have {version.VERSION}).\n\n"
                        "Download it now?", parent=parent):
                        webbrowser.open(res["url"])
                elif res["status"] == "current":
                    messagebox.showinfo(
                        "Romdoul OCR",
                        f"You're on the latest version ({version.VERSION}).", parent=parent)
                else:
                    if messagebox.askyesno(
                        "Check for updates",
                        f"Couldn't check automatically ({res.get('error', '')}).\n\n"
                        "Open the GitHub releases page?", parent=parent):
                        webbrowser.open(version.RELEASES_PAGE)

            gui.post(show)

        threading.Thread(target=work, daemon=True).start()

    def on_quit(icon, *_):
        try:
            srv.stop()
        except Exception:
            pass
        icon.stop()

    import version
    menu = pystray.Menu(
        pystray.MenuItem(f"Romdoul OCR  v{version.VERSION}", None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Open Romdoul OCR", on_open, default=True),
        pystray.MenuItem(f"Snip & read  ({cfg.hotkey})", on_snip),
        pystray.MenuItem("Read image / PDF file…", on_read),
        pystray.MenuItem("Settings…", on_settings),
        pystray.MenuItem("Check for updates…", on_update),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", on_quit),
    )
    icon = pystray.Icon("RomdoulOCR", _tray_image(), "Romdoul OCR", menu)

    def setup(ic):
        ic.visible = True
        try:
            ic.notify(f"Running in the tray. Press {get_cfg().hotkey} to snip.", "Romdoul OCR")
        except Exception:
            pass
        if get_cfg().open_app_on_start:
            spawn_app_window(server_url)

    icon.run(setup=setup)  # blocks the main thread until Quit


if __name__ == "__main__":
    if "--appwindow" in sys.argv:
        url = "http://127.0.0.1:8000/"
        if "--url" in sys.argv:
            url = sys.argv[sys.argv.index("--url") + 1]
        import appwindow
        appwindow.run(url)
    else:
        main()
