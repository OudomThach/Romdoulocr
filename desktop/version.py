"""App version + update endpoints for the 'Check for updates' feature."""
from __future__ import annotations

VERSION = "1.0.1"
REPO = "OudomThach/Romdoulocr"
RELEASES_PAGE = f"https://github.com/{REPO}/releases"
RELEASES_API = f"https://api.github.com/repos/{REPO}/releases/latest"


def _parse(v: str) -> tuple:
    v = (v or "").strip().lstrip("vV")
    parts = []
    for chunk in v.split("."):
        num = "".join(ch for ch in chunk if ch.isdigit())
        parts.append(int(num) if num else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def is_newer(candidate: str, current: str) -> bool:
    """True if `candidate` (e.g. a release tag 'v1.0.1') is newer than `current`."""
    return _parse(candidate) > _parse(current)
