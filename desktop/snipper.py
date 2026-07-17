"""
Screen-snip overlay + compact result preview, as Toplevels on the shared GUI root
(see gui.py). Nothing here blocks — the overlay reports its crop through a
callback, and the preview is a small always-on-top popup, so you can keep snipping
and stack several little previews instead of one giant window.

The process is set DPI-aware in main.py so Tk widget coords line up 1:1 with the
physical pixels mss captures.
"""
from __future__ import annotations

import io
import os
import tkinter as tk
from tkinter import filedialog
from typing import Callable

import mss
from PIL import Image, ImageTk

ACCENT = "#00e5ff"


def open_overlay(root: tk.Tk, on_result: Callable[[bytes | None], None]) -> None:
    """Freeze the screen, let the user drag a box, call on_result(png|None)."""
    with mss.mss() as sct:
        mon = sct.monitors[0]  # bounding box of ALL monitors
        shot = sct.grab(mon)
        img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")

    left, top, width, height = mon["left"], mon["top"], mon["width"], mon["height"]
    st = {"x": 0, "y": 0, "rid": None, "done": False}

    win = tk.Toplevel(root)
    win.overrideredirect(True)
    win.geometry(f"{width}x{height}+{left}+{top}")
    win.attributes("-topmost", True)
    try:
        win.attributes("-alpha", 0.35)
    except tk.TclError:
        pass
    win.configure(bg="black")
    canvas = tk.Canvas(win, bg="black", highlightthickness=0, cursor="crosshair")
    canvas.pack(fill="both", expand=True)
    canvas.create_text(width // 2, 22, fill="white",
                       text="Drag to select an area to read  ·  Esc to cancel",
                       font=("Segoe UI", 12, "bold"))

    def finish(box):
        if st["done"]:
            return
        st["done"] = True
        win.destroy()
        if not box:
            on_result(None)
            return
        x1, y1, x2, y2 = box
        if abs(x2 - x1) < 4 or abs(y2 - y1) < 4:
            on_result(None)
            return
        crop = img.crop((min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)))
        buf = io.BytesIO()
        crop.save(buf, "PNG")
        on_result(buf.getvalue())

    def on_down(e):
        st["x"], st["y"] = e.x, e.y
        if st["rid"]:
            canvas.delete(st["rid"])
        st["rid"] = canvas.create_rectangle(e.x, e.y, e.x, e.y, outline=ACCENT, width=2)

    def on_move(e):
        if st["rid"]:
            canvas.coords(st["rid"], st["x"], st["y"], e.x, e.y)

    canvas.bind("<ButtonPress-1>", on_down)
    canvas.bind("<B1-Motion>", on_move)
    canvas.bind("<ButtonRelease-1>", lambda e: finish((st["x"], st["y"], e.x, e.y)))
    win.bind("<Escape>", lambda e: finish(None))
    win.focus_force()


def open_preview(root: tk.Tk, image_png: bytes | None, text: str, save_dir: str = "") -> None:
    """Compact, always-on-top preview: thumbnail + OCR text + Copy/Save. Auto-copies
    the text so it's on the clipboard the instant it appears."""
    win = tk.Toplevel(root)
    win.title("Romdoul OCR")
    win.configure(bg="#0b1220")
    win.attributes("-topmost", True)

    W, H = 400, 470
    sw, sh = win.winfo_screenwidth(), win.winfo_screenheight()
    win.geometry(f"{W}x{H}+{max(0, sw - W - 24)}+{max(0, sh - H - 72)}")

    tk.Label(win, text="Snip result", bg="#0b1220", fg="white",
             font=("Segoe UI", 12, "bold"), anchor="w").pack(fill="x", padx=12, pady=(10, 6))

    # Thumbnail preview of the captured region.
    if image_png:
        try:
            im = Image.open(io.BytesIO(image_png))
            im.thumbnail((376, 150))
            photo = ImageTk.PhotoImage(im)
            thumb = tk.Label(win, image=photo, bg="#0f172a", bd=0)
            thumb.image = photo  # keep a ref so it isn't GC'd
            thumb.pack(padx=12, pady=(0, 8))
        except Exception:
            pass

    frame = tk.Frame(win, bg="#0b1220")
    frame.pack(fill="both", expand=True, padx=12)
    txt = tk.Text(frame, wrap="word", font=("Segoe UI", 11), bg="#0f172a",
                  fg="#e2e8f0", insertbackground="white", relief="flat",
                  height=7, padx=8, pady=8)
    scroll = tk.Scrollbar(frame, command=txt.yview)
    txt.configure(yscrollcommand=scroll.set)
    scroll.pack(side="right", fill="y")
    txt.pack(side="left", fill="both", expand=True)
    txt.insert("1.0", text or "(no text found)")

    # Auto-copy for the fast "snip → paste" flow.
    try:
        win.clipboard_clear()
        win.clipboard_append(text or "")
    except tk.TclError:
        pass

    initial_dir = save_dir if (save_dir and os.path.isdir(save_dir)) else os.path.expanduser("~")

    def copy():
        win.clipboard_clear()
        win.clipboard_append(txt.get("1.0", "end-1c"))
        copy_btn.config(text="Copied!")
        win.after(1100, lambda: copy_btn.config(text="Copy"))

    def save_image():
        if not image_png:
            return
        p = filedialog.asksaveasfilename(parent=win, title="Save screenshot",
                                         defaultextension=".png", initialdir=initial_dir,
                                         initialfile="romdoul-snip.png",
                                         filetypes=[("PNG image", "*.png")])
        if p:
            with open(p, "wb") as fh:
                fh.write(image_png)

    def save_text():
        p = filedialog.asksaveasfilename(parent=win, title="Save text",
                                         defaultextension=".txt", initialdir=initial_dir,
                                         initialfile="romdoul-snip.txt",
                                         filetypes=[("Text", "*.txt")])
        if p:
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(txt.get("1.0", "end-1c"))

    bar = tk.Frame(win, bg="#0b1220")
    bar.pack(fill="x", padx=12, pady=10)
    copy_btn = tk.Button(bar, text="Copy", command=copy, bg=ACCENT, fg="#003",
                         relief="flat", font=("Segoe UI", 10, "bold"), padx=14, pady=5,
                         activebackground="#67e8f9")
    copy_btn.pack(side="right")

    def ghost(label, cmd):
        return tk.Button(bar, text=label, command=cmd, bg="#1e293b", fg="white",
                         relief="flat", font=("Segoe UI", 10), padx=12, pady=5,
                         activebackground="#334155")

    ghost("Close", win.destroy).pack(side="right", padx=(0, 6))
    ghost("Save txt", save_text).pack(side="right", padx=(0, 6))
    if image_png:
        ghost("Save img", save_image).pack(side="right", padx=(0, 6))

    win.focus_force()
