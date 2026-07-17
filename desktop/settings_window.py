"""
Settings window (Tk): screenshot hotkey, snipper backend, and the home server URL.

Runs in its own worker thread (own Tk root), same as the snipper, so it never
touches the process main thread. Saves via config.save and calls on_saved so the
controller can re-register the global hotkey immediately.
"""
from __future__ import annotations

import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from typing import Callable

import config as cfg_mod
import dpi

ACCENT = "#00e5ff"
BACKENDS = [("Google Lens", "lens"), ("Surya (default)", "default"), ("vLLM", "vllm")]


def open_settings(parent, cfg: cfg_mod.Config, on_saved: Callable[[cfg_mod.Config], None]) -> None:
    root = tk.Toplevel(parent)
    root.title("Romdoul OCR — Settings")
    root.geometry(f"{dpi.px(480)}x{dpi.px(480)}")
    root.configure(bg="#0b1220")
    root.attributes("-topmost", True)

    def label(text: str):
        tk.Label(root, text=text, bg="#0b1220", fg="#94a3b8",
                 font=("Segoe UI", 10, "bold"), anchor="w").pack(fill="x", padx=18, pady=(14, 2))

    label("Screenshot hotkey")
    hotkey_var = tk.StringVar(value=cfg.hotkey)
    tk.Entry(root, textvariable=hotkey_var, font=("Consolas", 12),
             bg="#0f172a", fg="white", insertbackground="white", relief="flat"
             ).pack(fill="x", padx=18, ipady=5)
    tk.Label(root, text="e.g.  print screen   ·   ctrl+shift+s   ·   ctrl+alt+o",
             bg="#0b1220", fg="#475569", font=("Segoe UI", 9), anchor="w"
             ).pack(fill="x", padx=18, pady=(2, 0))
    # One-tap presets for common keys, incl. the default Windows screenshot key.
    presets = tk.Frame(root, bg="#0b1220")
    presets.pack(fill="x", padx=18, pady=(6, 0))
    for combo in ("print screen", "ctrl+shift+s", "ctrl+alt+s"):
        tk.Button(presets, text=combo, command=lambda c=combo: hotkey_var.set(c),
                  bg="#1e293b", fg="#cbd5e1", relief="flat", font=("Consolas", 9),
                  padx=8, pady=2).pack(side="left", padx=(0, 6))

    label("Snipper OCR engine")
    backend_var = tk.StringVar(value=_label_for(cfg.backend))
    ttk.Combobox(root, textvariable=backend_var, state="readonly",
                 values=[b[0] for b in BACKENDS]).pack(fill="x", padx=18)

    label("Auto-save screenshots to (optional)")
    save_row = tk.Frame(root, bg="#0b1220")
    save_row.pack(fill="x", padx=18)
    save_var = tk.StringVar(value=cfg.save_dir)
    tk.Entry(save_row, textvariable=save_var, font=("Consolas", 10),
             bg="#0f172a", fg="white", insertbackground="white", relief="flat"
             ).pack(side="left", fill="x", expand=True, ipady=5)

    def browse():
        d = filedialog.askdirectory(parent=root, title="Choose a folder for screenshots")
        if d:
            save_var.set(d)

    tk.Button(save_row, text="Browse…", command=browse, bg="#1e293b", fg="white",
              relief="flat", font=("Segoe UI", 10), padx=10).pack(side="left", padx=(8, 0))

    save_text_var = tk.BooleanVar(value=cfg.save_text)
    tk.Checkbutton(root, text="Also save the recognized text (.txt) next to each image",
                   variable=save_text_var, bg="#0b1220", fg="#cbd5e1",
                   selectcolor="#0f172a", activebackground="#0b1220",
                   activeforeground="white", font=("Segoe UI", 9), anchor="w"
                   ).pack(fill="x", padx=16, pady=(6, 0))

    label("Home server URL (Tailscale Funnel or LAN)")
    base_var = tk.StringVar(value=cfg.funnel_base)
    tk.Entry(root, textvariable=base_var, font=("Consolas", 10),
             bg="#0f172a", fg="white", insertbackground="white", relief="flat"
             ).pack(fill="x", padx=18, ipady=5)

    def save():
        new = cfg_mod.Config(
            hotkey=hotkey_var.get().strip() or "ctrl+shift+s",
            backend=_value_for(backend_var.get()),
            funnel_base=base_var.get().strip() or cfg.funnel_base,
            port=cfg.port,
            open_app_on_start=cfg.open_app_on_start,
            save_dir=save_var.get().strip(),
            save_text=save_text_var.get(),
        )
        try:
            import keyboard  # validate the combo before committing
            keyboard.parse_hotkey(new.hotkey)
        except Exception:
            messagebox.showerror("Invalid hotkey", f"'{new.hotkey}' isn't a valid hotkey.")
            return
        cfg_mod.save(new)
        on_saved(new)
        root.destroy()

    bar = tk.Frame(root, bg="#0b1220")
    bar.pack(side="bottom", fill="x", padx=18, pady=16)
    tk.Button(bar, text="Save", command=save, bg=ACCENT, fg="#003", relief="flat",
              font=("Segoe UI", 11, "bold"), padx=20, pady=6).pack(side="right")
    tk.Button(bar, text="Cancel", command=root.destroy, bg="#1e293b", fg="white",
              relief="flat", font=("Segoe UI", 11), padx=18, pady=6
              ).pack(side="right", padx=(0, 8))

    root.focus_force()


def _label_for(value: str) -> str:
    for name, val in BACKENDS:
        if val == value:
            return name
    return BACKENDS[0][0]


def _value_for(label: str) -> str:
    for name, val in BACKENDS:
        if name == label:
            return val
    return "lens"
