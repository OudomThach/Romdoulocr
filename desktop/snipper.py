"""
Windows "snip → OCR" tool.

capture_and_select() freezes a full multi-monitor screenshot, throws up a dimmed
crosshair overlay, and returns the PNG bytes of the box the user drags (or None if
cancelled). show_result() shows the extracted text with a Copy button.

Both build their own short-lived Tk root so they can be called from a background
worker thread (the global-hotkey callback), keeping Tk off the process main thread
where pywebview/pystray live. The process is set DPI-aware in main.py so Tk widget
coordinates line up 1:1 with the physical pixels mss captures.
"""
from __future__ import annotations

import io
import tkinter as tk

import mss
from PIL import Image

ACCENT = "#00e5ff"  # matches the app's neon-cyan accent


def capture_and_select() -> bytes | None:
    """Freeze the screen, let the user drag a box, return the crop as PNG bytes."""
    with mss.mss() as sct:
        mon = sct.monitors[0]  # index 0 = bounding box of ALL monitors
        shot = sct.grab(mon)
        img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")

    left, top, width, height = mon["left"], mon["top"], mon["width"], mon["height"]
    result: dict[str, tuple[int, int, int, int] | None] = {"box": None}
    start = {"x": 0, "y": 0}
    rid = {"id": None}

    root = tk.Tk()
    root.overrideredirect(True)
    root.geometry(f"{width}x{height}+{left}+{top}")
    root.attributes("-topmost", True)
    try:
        root.attributes("-alpha", 0.35)
    except tk.TclError:
        pass
    root.configure(bg="black")

    canvas = tk.Canvas(root, bg="black", highlightthickness=0, cursor="crosshair")
    canvas.pack(fill="both", expand=True)
    canvas.create_text(
        width // 2, 24, fill="white",
        text="Drag to select an area to read  ·  Esc to cancel",
        font=("Segoe UI", 12, "bold"),
    )

    def on_down(e):
        start["x"], start["y"] = e.x, e.y
        if rid["id"]:
            canvas.delete(rid["id"])
        rid["id"] = canvas.create_rectangle(e.x, e.y, e.x, e.y, outline=ACCENT, width=2)

    def on_move(e):
        if rid["id"]:
            canvas.coords(rid["id"], start["x"], start["y"], e.x, e.y)

    def on_up(e):
        result["box"] = (start["x"], start["y"], e.x, e.y)
        root.quit()

    def cancel(_e=None):
        result["box"] = None
        root.quit()

    canvas.bind("<ButtonPress-1>", on_down)
    canvas.bind("<B1-Motion>", on_move)
    canvas.bind("<ButtonRelease-1>", on_up)
    root.bind("<Escape>", cancel)
    root.focus_force()
    root.mainloop()
    root.destroy()

    box = result["box"]
    if not box:
        return None
    x1, y1, x2, y2 = box
    if abs(x2 - x1) < 4 or abs(y2 - y1) < 4:
        return None
    crop = img.crop((min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)))
    buf = io.BytesIO()
    crop.save(buf, "PNG")
    return buf.getvalue()


def show_result(text: str, busy: bool = False) -> None:
    """Popup showing the OCR text with Copy / Close."""
    root = tk.Tk()
    root.title("Romdoul OCR — snip")
    root.geometry("580x440")
    root.attributes("-topmost", True)
    root.configure(bg="#0b1220")

    header = tk.Label(
        root, text="Snip result", bg="#0b1220", fg="white",
        font=("Segoe UI", 13, "bold"), anchor="w", padx=14, pady=10,
    )
    header.pack(fill="x")

    frame = tk.Frame(root, bg="#0b1220")
    frame.pack(fill="both", expand=True, padx=14)
    txt = tk.Text(
        frame, wrap="word", font=("Segoe UI", 12), bg="#0f172a", fg="#e2e8f0",
        insertbackground="white", relief="flat", padx=10, pady=10,
    )
    scroll = tk.Scrollbar(frame, command=txt.yview)
    txt.configure(yscrollcommand=scroll.set)
    scroll.pack(side="right", fill="y")
    txt.pack(side="left", fill="both", expand=True)
    txt.insert("1.0", text if text else "(no text found)")

    def copy():
        root.clipboard_clear()
        root.clipboard_append(txt.get("1.0", "end-1c"))
        copy_btn.config(text="Copied!")
        root.after(1200, lambda: copy_btn.config(text="Copy text"))

    bar = tk.Frame(root, bg="#0b1220")
    bar.pack(fill="x", padx=14, pady=12)
    copy_btn = tk.Button(
        bar, text="Copy text", command=copy, bg=ACCENT, fg="#003", relief="flat",
        font=("Segoe UI", 11, "bold"), padx=16, pady=6, activebackground="#67e8f9",
    )
    copy_btn.pack(side="right")
    tk.Button(
        bar, text="Close", command=root.destroy, bg="#1e293b", fg="white",
        relief="flat", font=("Segoe UI", 11), padx=16, pady=6,
    ).pack(side="right", padx=(0, 8))

    root.focus_force()
    root.mainloop()
