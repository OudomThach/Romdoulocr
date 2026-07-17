"""
Settings window (Tk): screenshot hotkey, snipper backend, and the home server URL.

Runs in its own worker thread (own Tk root), same as the snipper, so it never
touches the process main thread. Saves via config.save and calls on_saved so the
controller can re-register the global hotkey immediately.
"""
from __future__ import annotations

import tkinter as tk
from tkinter import messagebox, ttk
from typing import Callable

import config as cfg_mod

ACCENT = "#00e5ff"
BACKENDS = [("Google Lens", "lens"), ("Surya (default)", "default"), ("vLLM", "vllm")]


def open_settings(cfg: cfg_mod.Config, on_saved: Callable[[cfg_mod.Config], None]) -> None:
    root = tk.Tk()
    root.title("Romdoul OCR — Settings")
    root.geometry("460x360")
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
    tk.Label(root, text="e.g.  ctrl+shift+s   ·   ctrl+alt+o   ·   print screen",
             bg="#0b1220", fg="#475569", font=("Segoe UI", 9), anchor="w"
             ).pack(fill="x", padx=18, pady=(2, 0))

    label("Snipper OCR engine")
    backend_var = tk.StringVar(value=_label_for(cfg.backend))
    ttk.Combobox(root, textvariable=backend_var, state="readonly",
                 values=[b[0] for b in BACKENDS]).pack(fill="x", padx=18)

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
    root.mainloop()


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
