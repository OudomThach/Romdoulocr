"""
Send a snipped image to the OCR backend and pull the plain text out.

Goes through the local proxy server (127.0.0.1) which forwards to the home nginx,
so this needs no adapter token and uses whichever backend prefix is configured
(default /api-lens). Mirrors how src/lib/api.ts calls POST /ocr-image and how
normalizeOcrResponse() picks the text.
"""
from __future__ import annotations

from typing import Any

import requests


def ocr_image(png_bytes: bytes, server_url: str, prefix: str, use_ctc: bool = True) -> str:
    url = f"{server_url.rstrip('/')}{prefix}/ocr-image?use_ctc={'true' if use_ctc else 'false'}"
    files = {"file": ("region.png", png_bytes, "image/png")}
    resp = requests.post(url, files=files, timeout=180)
    resp.raise_for_status()
    try:
        data = resp.json()
    except ValueError:
        return resp.text.strip()
    return _pick_text(data).strip()


def _pick_text(data: Any) -> str:
    if isinstance(data, str):
        return data
    if not isinstance(data, dict):
        return ""
    # Common single-image shapes.
    for key in ("text", "full_text", "fullText", "ocr_text"):
        v = data.get(key)
        if isinstance(v, str) and v.strip():
            return v
    # Document-style shape: pages[].regions[].text
    pages = data.get("pages")
    if isinstance(pages, list):
        lines: list[str] = []
        for page in pages:
            for region in (page or {}).get("regions", []) or []:
                t = (region or {}).get("text")
                if isinstance(t, str) and t.strip():
                    lines.append(t.strip())
        if lines:
            return "\n".join(lines)
    # Flat regions[].text
    regions = data.get("regions")
    if isinstance(regions, list):
        lines = [(r or {}).get("text", "").strip() for r in regions]
        lines = [ln for ln in lines if ln]
        if lines:
            return "\n".join(lines)
    return ""
