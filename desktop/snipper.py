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
from collections.abc import Callable
from tkinter import filedialog

import dpi
import formats
import mss
from PIL import Image, ImageTk

ACCENT = "#00e5ff"
INK = "#0b1220"


def _copy(win: tk.Misc, s: str) -> None:
    try:
        win.clipboard_clear()
        win.clipboard_append(s)
    except tk.TclError:
        pass


def _menubutton(parent, label: str, entries: list[tuple[str, object]], primary: bool = False):
    """A small dropdown button: [(item label, command), ...]."""
    bg, fg = (ACCENT, "#003") if primary else ("#1e293b", "white")
    mb = tk.Menubutton(parent, text=label, bg=bg, fg=fg, relief="flat",
                       font=("Segoe UI", 10, "bold" if primary else "normal"),
                       padx=13, pady=5, activebackground="#67e8f9" if primary else "#334155")
    menu = tk.Menu(mb, tearoff=0)
    for lbl, cmd in entries:
        menu.add_command(label=lbl, command=cmd)
    mb["menu"] = menu
    return mb


def _save_as(parent, default_ext: str, initialdir: str, initialfile: str,
             filetypes: list, content) -> None:
    p = filedialog.asksaveasfilename(parent=parent, defaultextension=default_ext,
                                     initialdir=initialdir, initialfile=initialfile,
                                     filetypes=filetypes)
    if not p:
        return
    mode, data = ("wb", content) if isinstance(content, bytes) else ("w", content)
    with open(p, mode, **({} if isinstance(content, bytes) else {"encoding": "utf-8"})) as fh:
        fh.write(data)


def open_overlay(root: tk.Tk, on_result: Callable[[bytes | None], None]) -> None:
    """Freeze the screen behind a dimmed backdrop, let the user drag a crisp
    selection box (with a live size chip), and call on_result(png|None).

    The whole screen is shown DIMMED (so you keep context) while the selection
    rectangle, corner ticks, size chip and hint pill stay bright and crisp — the
    modern snip look. Cheap: the dim image is built once; dragging only moves
    canvas shapes, no per-frame image work."""
    with mss.mss() as sct:
        mon = sct.monitors[0]  # bounding box of ALL monitors
        shot = sct.grab(mon)
        img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")

    left, top, width, height = mon["left"], mon["top"], mon["width"], mon["height"]

    st: dict = {"x": 0, "y": 0, "done": False, "active": False}

    win = tk.Toplevel(root)
    win.overrideredirect(True)
    win.geometry(f"{width}x{height}+{left}+{top}")
    win.attributes("-topmost", True)
    win.configure(bg="black", cursor="crosshair")
    canvas = tk.Canvas(win, bg="black", highlightthickness=0, cursor="crosshair")
    canvas.pack(fill="both", expand=True)

    # Show the screen at FULL, normal brightness (no dim) — just a crisp selection
    # box drawn on top. The frozen shot keeps the picture steady while you drag.
    photo = ImageTk.PhotoImage(img)
    canvas.create_image(0, 0, anchor="nw", image=photo)
    canvas._bg_ref = photo  # keep a ref so it isn't GC'd

    # Hint pill, centered near the top of the primary monitor. Sizes scale with
    # the display DPI so it reads the same on 100% and 200%/4K screens.
    mid = width // 2
    canvas.create_rectangle(mid - dpi.px(190), dpi.px(20), mid + dpi.px(190), dpi.px(58),
                            fill=INK, outline=ACCENT, width=1)
    canvas.create_text(mid, dpi.px(39), fill="#e2e8f0",
                       text="Drag to select   ·   Esc to cancel",
                       font=("Segoe UI", 12, "bold"))

    line_w = max(2, dpi.px(2))
    rect = canvas.create_rectangle(0, 0, 0, 0, outline=ACCENT, width=line_w, state="hidden")
    chip_bg = canvas.create_rectangle(0, 0, 0, 0, fill=ACCENT, outline="", state="hidden")
    chip_tx = canvas.create_text(0, 0, anchor="w", fill="#003", state="hidden",
                                 font=("Segoe UI", 10, "bold"))
    ticks = [canvas.create_line(0, 0, 0, 0, fill=ACCENT, width=max(2, dpi.px(3)), state="hidden")
             for _ in range(8)]

    def finish(box):
        if st["done"]:
            return
        st["done"] = True
        win.destroy()
        if not box:
            on_result(None)
            return
        x1, y1, x2, y2 = box
        a, b, c, d = min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)
        if c - a < 4 or d - b < 4:
            on_result(None)
            return
        crop = img.crop((a, b, c, d))
        buf = io.BytesIO()
        crop.save(buf, "PNG")
        on_result(buf.getvalue())

    def draw(x2, y2):
        a, b = min(st["x"], x2), min(st["y"], y2)
        c, d = max(st["x"], x2), max(st["y"], y2)
        canvas.coords(rect, a, b, c, d)
        canvas.itemconfig(rect, state="normal")
        # corner ticks (L-shaped), scaled to the display
        t = dpi.px(14)
        segs = [(a, b, a + t, b), (a, b, a, b + t), (c, b, c - t, b), (c, b, c, b + t),
                (a, d, a + t, d), (a, d, a, d - t), (c, d, c - t, d), (c, d, c, d - t)]
        for line, (x0, y0, x1_, y1_) in zip(ticks, segs, strict=False):
            canvas.coords(line, x0, y0, x1_, y1_)
            canvas.itemconfig(line, state="normal")
        # size chip above the selection (or below if near the top)
        label = f"{c - a} × {d - b}"
        cw = len(label) * dpi.px(9) + dpi.px(16)
        ch = dpi.px(22)
        cy = b - ch - dpi.px(4) if b > dpi.px(30) else d + dpi.px(6)
        canvas.coords(chip_bg, a, cy, a + cw, cy + ch)
        canvas.coords(chip_tx, a + dpi.px(8), cy + ch // 2)
        canvas.itemconfig(chip_bg, state="normal")
        canvas.itemconfig(chip_tx, text=label, state="normal")

    def on_down(e):
        st["x"], st["y"], st["active"] = e.x, e.y, True

    def on_move(e):
        if st["active"]:
            draw(e.x, e.y)

    def on_up(e):
        if st["active"]:
            finish((st["x"], st["y"], e.x, e.y))

    canvas.bind("<ButtonPress-1>", on_down)
    canvas.bind("<B1-Motion>", on_move)
    canvas.bind("<ButtonRelease-1>", on_up)
    win.bind("<Escape>", lambda e: finish(None))
    win.focus_force()


def open_preview(root: tk.Tk, image_png: bytes | None, text: str, save_dir: str = "",
                 backend: str = "") -> None:
    """Compact, always-on-top preview: thumbnail + OCR text + Copy▾/Save▾ (plain /
    markdown / json). Auto-copies plain text so it's on the clipboard instantly."""
    win = tk.Toplevel(root)
    win.title("Romdoul OCR")
    win.configure(bg="#0b1220")
    win.attributes("-topmost", True)

    W, H = dpi.px(400), dpi.px(470)
    sw, sh = win.winfo_screenwidth(), win.winfo_screenheight()
    win.geometry(f"{W}x{H}+{max(0, sw - W - dpi.px(24))}+{max(0, sh - H - dpi.px(72))}")

    tk.Label(win, text="Snip result", bg="#0b1220", fg="white",
             font=("Segoe UI", 12, "bold"), anchor="w").pack(fill="x", padx=12, pady=(10, 6))

    # Thumbnail preview of the captured region.
    if image_png:
        try:
            im = Image.open(io.BytesIO(image_png))
            im.thumbnail((dpi.px(376), dpi.px(150)))
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

    def cur() -> str:
        return txt.get("1.0", "end-1c")

    def flash():
        copy_btn.config(text="Copied!")
        win.after(1100, lambda: copy_btn.config(text="Copy"))

    bar = tk.Frame(win, bg="#0b1220")
    bar.pack(fill="x", padx=12, pady=10)

    # Primary Copy = plain text (one click); the caret holds the other formats.
    _menubutton(bar, "▾", [
        ("Copy as Markdown", lambda: (_copy(win, formats.markdown(cur())), flash())),
        ("Copy as JSON", lambda: (_copy(win, formats.as_json(cur(), backend)), flash())),
    ]).pack(side="right")
    copy_btn = tk.Button(bar, text="Copy", command=lambda: (_copy(win, formats.plain(cur())), flash()),
                         bg=ACCENT, fg="#003", relief="flat", font=("Segoe UI", 10, "bold"),
                         padx=14, pady=5, activebackground="#67e8f9")
    copy_btn.pack(side="right", padx=(0, 2))

    save_entries = [
        ("Text (.txt)", lambda: _save_as(win, ".txt", initial_dir, "romdoul-snip.txt",
                                         [("Text", "*.txt")], formats.plain(cur()))),
        ("Markdown (.md)", lambda: _save_as(win, ".md", initial_dir, "romdoul-snip.md",
                                            [("Markdown", "*.md")], formats.markdown(cur()))),
        ("JSON (.json)", lambda: _save_as(win, ".json", initial_dir, "romdoul-snip.json",
                                          [("JSON", "*.json")], formats.as_json(cur(), backend))),
    ]
    if image_png:
        save_entries.append(("Image (.png)", lambda: _save_as(
            win, ".png", initial_dir, "romdoul-snip.png", [("PNG image", "*.png")], image_png)))
    _menubutton(bar, "Save ▾", save_entries).pack(side="right", padx=(0, 6))

    tk.Button(bar, text="Close", command=win.destroy, bg="#1e293b", fg="white",
              relief="flat", font=("Segoe UI", 10), padx=12, pady=5,
              activebackground="#334155").pack(side="right", padx=(0, 6))

    win.focus_force()


def open_batch(root: tk.Tk, items: list[dict], save_dir: str = "", backend: str = "") -> None:
    """Results window for a batch: all texts, with Copy-all / Save-all in any format."""
    win = tk.Toplevel(root)
    win.title(f"Romdoul OCR — {len(items)} files")
    win.configure(bg="#0b1220")
    win.attributes("-topmost", True)
    W, H = dpi.px(560), dpi.px(600)
    sw, sh = win.winfo_screenwidth(), win.winfo_screenheight()
    win.geometry(f"{W}x{H}+{max(0, (sw - W) // 2)}+{max(0, (sh - H) // 2)}")

    tk.Label(win, text=f"Batch results · {len(items)} files", bg="#0b1220", fg="white",
             font=("Segoe UI", 13, "bold"), anchor="w").pack(fill="x", padx=14, pady=(12, 8))

    frame = tk.Frame(win, bg="#0b1220")
    frame.pack(fill="both", expand=True, padx=14)
    txt = tk.Text(frame, wrap="word", font=("Segoe UI", 11), bg="#0f172a", fg="#e2e8f0",
                  relief="flat", padx=10, pady=10)
    scroll = tk.Scrollbar(frame, command=txt.yview)
    txt.configure(yscrollcommand=scroll.set)
    scroll.pack(side="right", fill="y")
    txt.pack(side="left", fill="both", expand=True)
    txt.insert("1.0", formats.batch_plain(items))
    txt.configure(state="disabled")

    initial_dir = save_dir if (save_dir and os.path.isdir(save_dir)) else os.path.expanduser("~")

    def save_all(kind: str):
        from tkinter import filedialog
        d = filedialog.askdirectory(parent=win, title="Save all results to a folder",
                                    initialdir=initial_dir)
        if not d:
            return
        ext = formats.EXT[kind]
        renderer = {"plain": formats.plain, "markdown": formats.markdown,
                    "json": lambda t: formats.as_json(t, backend)}[kind]
        for it in items:
            stem = os.path.splitext(os.path.basename(it["name"]))[0]
            with open(os.path.join(d, stem + ext), "w", encoding="utf-8") as fh:
                fh.write(renderer(it["text"]))
        combined = {"plain": formats.batch_plain, "markdown": formats.batch_markdown,
                    "json": lambda x: formats.batch_json(x, backend)}[kind](items)
        with open(os.path.join(d, "_all" + ext), "w", encoding="utf-8") as fh:
            fh.write(combined)

    bar = tk.Frame(win, bg="#0b1220")
    bar.pack(fill="x", padx=14, pady=12)
    _menubutton(bar, "▾", [
        ("Copy all as Markdown", lambda: _copy(win, formats.batch_markdown(items))),
        ("Copy all as JSON", lambda: _copy(win, formats.batch_json(items, backend))),
    ]).pack(side="right")
    tk.Button(bar, text="Copy all", command=lambda: _copy(win, formats.batch_plain(items)),
              bg=ACCENT, fg="#003", relief="flat", font=("Segoe UI", 10, "bold"),
              padx=14, pady=5, activebackground="#67e8f9").pack(side="right", padx=(0, 2))
    _menubutton(bar, "Save all ▾", [
        ("Text files (.txt)", lambda: save_all("plain")),
        ("Markdown (.md)", lambda: save_all("markdown")),
        ("JSON (.json)", lambda: save_all("json")),
    ]).pack(side="right", padx=(0, 6))
    tk.Button(bar, text="Close", command=win.destroy, bg="#1e293b", fg="white",
              relief="flat", font=("Segoe UI", 10), padx=12, pady=5,
              activebackground="#334155").pack(side="right", padx=(0, 6))

    win.focus_force()
