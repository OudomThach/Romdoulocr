"""
Tiny single-threaded Tk GUI manager.

The whole app is a background service (tray + global hotkey). When it needs to
show something — the snip overlay, a compact result preview, settings — it opens
a lightweight Toplevel on ONE hidden root that lives on a dedicated GUI thread.

Why one root on one thread: Tk isn't thread-safe, so instead of spawning a fresh
Tk() per window (fragile across threads) we keep a single interpreter and post
work onto it through a queue drained by the Tk event loop. That lets many small
windows coexist safely and open instantly — the "lots of little windows, nothing
giant, always something running in the background" feel.
"""
from __future__ import annotations

import queue
import threading
import tkinter as tk
from collections.abc import Callable


class Gui:
    def __init__(self) -> None:
        self.root: tk.Tk | None = None
        self._q: queue.Queue[Callable[[], None]] = queue.Queue()
        self._ready = threading.Event()

    def start(self) -> None:
        threading.Thread(target=self._run, daemon=True).start()
        self._ready.wait(timeout=10)

    def _run(self) -> None:
        self.root = tk.Tk()
        self.root.withdraw()  # the root itself is never shown
        import dpi
        dpi.apply_tk_scaling(self.root)  # fonts render right on high-DPI displays
        self.root.after(40, self._drain)
        self._ready.set()
        self.root.mainloop()

    def _drain(self) -> None:
        try:
            while True:
                fn = self._q.get_nowait()
                try:
                    fn()
                except Exception:
                    pass
        except queue.Empty:
            pass
        if self.root is not None:
            self.root.after(40, self._drain)

    def post(self, fn: Callable[[], None]) -> None:
        """Run fn on the GUI thread (safe to call from any thread)."""
        self._q.put(fn)
