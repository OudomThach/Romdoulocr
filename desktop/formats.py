"""
Turn OCR results into the formats users actually paste into things:
plain text, Markdown, or JSON — for a single snip or a whole batch.

Kept dependency-free and pure so it's trivially testable and reused by every
window (single preview, batch results, auto-save).
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import List, TypedDict


class Item(TypedDict):
    name: str
    text: str


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ---- single result -------------------------------------------------------- #
def plain(text: str) -> str:
    return text or ""


def markdown(text: str) -> str:
    # OCR text is already plain/Markdown-ish (table endpoints return pipe tables);
    # pass it through so a paste into a Markdown doc just works.
    return text or ""


def as_json(text: str, backend: str = "", source: str = "") -> str:
    return json.dumps(
        {
            "text": text or "",
            "backend": backend,
            "source": source,
            "chars": len(text or ""),
            "captured_at": _now(),
        },
        ensure_ascii=False,
        indent=2,
    )


# ---- batch ---------------------------------------------------------------- #
def batch_plain(items: List[Item]) -> str:
    return "\n\n".join(f"── {it['name']} ──\n{it['text']}" for it in items)


def batch_markdown(items: List[Item]) -> str:
    return "\n\n".join(f"## {it['name']}\n\n{it['text']}" for it in items)


def batch_json(items: List[Item], backend: str = "") -> str:
    return json.dumps(
        {
            "backend": backend,
            "count": len(items),
            "captured_at": _now(),
            "results": [
                {"file": it["name"], "text": it["text"], "chars": len(it["text"])}
                for it in items
            ],
        },
        ensure_ascii=False,
        indent=2,
    )


# ---- extension helper ----------------------------------------------------- #
EXT = {"plain": ".txt", "markdown": ".md", "json": ".json"}
