"""
'Check for updates' — asks GitHub for the latest published Release and compares
its tag to this build's VERSION.

Works with NO embedded token: it hits the public releases API. If the repo is
private (or has no releases, or we're offline), the API call fails and the caller
falls back to simply opening the releases page in the browser — so the button is
always useful, it just can't auto-compare for a private repo.

To make auto-update work: publish a GitHub Release (tag e.g. v1.0.1) and attach
the zipped `out/RomdoulOCR` folder as an asset.
"""
from __future__ import annotations

import requests

import version


def check(current: str = version.VERSION) -> dict:
    try:
        r = requests.get(version.RELEASES_API, timeout=10,
                         headers={"Accept": "application/vnd.github+json"})
    except Exception as exc:  # offline / DNS / timeout
        return {"status": "error", "error": str(exc)}
    if r.status_code != 200:
        # 404 = private repo (no token) or no releases yet.
        return {"status": "error", "error": f"HTTP {r.status_code}"}
    try:
        data = r.json()
    except ValueError:
        return {"status": "error", "error": "bad response"}

    tag = (data.get("tag_name") or "").strip()
    assets = data.get("assets") or []
    url = assets[0].get("browser_download_url") if assets else data.get("html_url")
    if tag and version.is_newer(tag, current):
        return {"status": "update", "latest": tag, "url": url or version.RELEASES_PAGE}
    return {"status": "current", "latest": tag or current}
