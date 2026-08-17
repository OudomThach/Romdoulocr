"""
Persistent settings for the Romdoul OCR portable desktop app.

Stored as JSON in %APPDATA%/RomdoulOCR/config.json so it survives across runs and
lives next to the user's profile (not inside the portable folder, so an updated
.exe keeps the user's hotkey/backend choices).
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass

# The home machine, reachable from anywhere via the Tailscale Funnel. nginx there
# serves /api, /api-vllm, /api-lens, /api-tidy and injects the adapter token, so
# the desktop app never needs the secret token client-side (same as the website).
DEFAULT_FUNNEL_BASE = "https://apt-server-desktop.tail806605.ts.net"

# Backend id -> the URL prefix nginx routes (matches src/lib/backend.ts).
BACKEND_PREFIX = {
    "lens": "/api-lens",
    "vllm": "/api-vllm",
    "default": "/api",
}


def _config_dir() -> str:
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(base, "RomdoulOCR")


def _config_path() -> str:
    return os.path.join(_config_dir(), "config.json")


@dataclass
class Config:
    # Global screenshot hotkey, in the `keyboard` library's syntax.
    hotkey: str = "ctrl+shift+s"
    # Which OCR engine the snipper uses. "lens" is the portable default because
    # it works from any machine with internet (the GPU engines need the home PC).
    backend: str = "lens"
    # Base URL of the home nginx (via Funnel). Change to a LAN IP when on the
    # same network as the PC for lower latency.
    funnel_base: str = DEFAULT_FUNNEL_BASE
    # Local static+proxy server port. 0 = pick a free port automatically.
    port: int = 0
    # Open the big app window automatically on launch. Default False = start as a
    # quiet background service (tray + hotkey); open the full window on demand.
    open_app_on_start: bool = False
    # Folder to auto-save every screenshot PNG into. Empty = don't auto-save
    # (the user can still Save… manually from the result window).
    save_dir: str = ""
    # When save_dir is set, also drop the OCR text as a .txt next to each image.
    save_text: bool = True

    def prefix(self) -> str:
        return BACKEND_PREFIX.get(self.backend, "/api-lens")


def load() -> Config:
    try:
        # utf-8-sig tolerates a BOM (e.g. a config hand-edited in Notepad/PowerShell).
        with open(_config_path(), encoding="utf-8-sig") as fh:
            data = json.load(fh)
        cfg = Config()
        for k, v in data.items():
            if hasattr(cfg, k) and v is not None:
                setattr(cfg, k, v)
        return cfg
    except (OSError, ValueError):
        return Config()


def save(cfg: Config) -> None:
    os.makedirs(_config_dir(), exist_ok=True)
    with open(_config_path(), "w", encoding="utf-8") as fh:
        json.dump(asdict(cfg), fh, indent=2)
