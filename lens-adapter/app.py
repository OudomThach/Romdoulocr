"""
Google Lens adapter for the Romdoul OCR SPA.

Wraps the (unofficial, free) Google Lens OCR endpoint via `chrome-lens-py` and
exposes the SAME khparser API contract the SPA already speaks (/ocr-image,
/parse-pdf, /parse-pdf-translated, /parse-table, /health) — so the frontend
just points a new backend at it, exactly like the vLLM adapter.

Lens gives us plain OCR text (with line breaks), per-word NORMALIZED geometry
(center_x/center_y/width/height), and a translation. We reshape that into the
SPA's DocumentResult / OcrImageResponse / TableResult, grouping words into
lines for the bounding-box overlays.

NOTE: Google Lens is an unofficial endpoint; use is subject to Google's ToS
(same disclaimer as the chrome-lens-py library). Intended for personal
benchmarking. A shared-secret gate (ADAPTER_TOKEN) mirrors the vLLM adapter.
"""

from __future__ import annotations

import hmac
import io
import json
import logging
import os
import tempfile
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from chrome_lens_py import LensAPI
from fastapi import FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image

app = FastAPI(title="Google Lens → khparser adapter", version="1.0.0")

ADAPTER_TOKEN = os.environ.get("ADAPTER_TOKEN", "").strip()
# Default OCR language hint; Lens auto-detects, so 'km' (Khmer) is a safe bias.
DEFAULT_LANG = os.environ.get("LENS_OCR_LANG", "km")

_lens = LensAPI()


@app.middleware("http")
async def _require_token(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    exempt = request.method == "OPTIONS" or request.url.path.rstrip("/") == "/health"
    if ADAPTER_TOKEN and not exempt and not hmac.compare_digest(request.headers.get("x-adapter-token", ""), ADAPTER_TOKEN):
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# --------------------------------------------------------------------------- #
# Lens → SPA shape helpers
# --------------------------------------------------------------------------- #
def _rect_to_points(x0: float, y0: float, x1: float, y1: float) -> list[list[float]]:
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def _word_rect(geo: dict[str, Any], w: int, h: int) -> tuple[float, float, float, float]:
    """Normalized center box -> pixel [x0,y0,x1,y1]."""
    cx, cy = float(geo.get("center_x", 0)), float(geo.get("center_y", 0))
    ww, hh = float(geo.get("width", 0)), float(geo.get("height", 0))
    return (
        (cx - ww / 2) * w,
        (cy - hh / 2) * h,
        (cx + ww / 2) * w,
        (cy + hh / 2) * h,
    )


def _regions_from_words(word_data: list[dict], w: int, h: int) -> list[dict]:
    """Group words into lines by vertical proximity, one region per line."""
    words = [x for x in (word_data or []) if x.get("geometry")]
    if not words:
        return []
    rects = [(_word_rect(x["geometry"], w, h), x.get("word", "")) for x in words]
    heights = sorted((r[3] - r[1]) for r, _ in rects)
    med_h = heights[len(heights) // 2] or (h * 0.02)
    tol = med_h * 0.6

    # Preserve reading order (word_data is already ordered); start a new line
    # when the vertical center jumps by more than the tolerance.
    lines: list[list[tuple[tuple[float, float, float, float], str]]] = []
    cur: list[tuple[tuple[float, float, float, float], str]] = []
    last_cy: float | None = None
    for rect, word in rects:
        cy = (rect[1] + rect[3]) / 2
        if last_cy is not None and abs(cy - last_cy) > tol:
            if cur:
                lines.append(cur)
            cur = []
        cur.append((rect, word))
        last_cy = cy
    if cur:
        lines.append(cur)

    regions: list[dict] = []
    for line in lines:
        xs0 = min(r[0] for r, _ in line)
        ys0 = min(r[1] for r, _ in line)
        xs1 = max(r[2] for r, _ in line)
        ys1 = max(r[3] for r, _ in line)
        text = " ".join(word for _, word in line).strip()
        if not text:
            continue
        bbox = {"points": _rect_to_points(xs0, ys0, xs1, ys1), "confidence": 1.0}
        regions.append(
            {
                "bbox": bbox,
                "region_type": "text",
                "lines": [{"bbox": bbox, "text": text, "confidence": 1.0}],
                "text": text,
                "confidence": 1.0,
            }
        )
    return regions


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    return s[len(s) // 2] if s else 0.0


def _pixel_words(word_data: list[dict], w: int, h: int) -> list[dict]:
    out = []
    for x in word_data or []:
        g = x.get("geometry")
        if not g:
            continue
        x0, y0, x1, y1 = _word_rect(g, w, h)
        out.append({"t": x.get("word", ""), "x0": x0, "y0": y0, "x1": x1, "y1": y1, "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2})
    return out


def _column_bounds(words: list[dict], w: int) -> list[float]:
    """Detect vertical column-separator x-positions from horizontal whitespace.
    Words wider than ~45% of the page (spanning titles) are excluded so they
    don't merge real columns. Returns the x boundaries between columns."""
    narrow = [z for z in words if (z["x1"] - z["x0"]) < w * 0.45] or words
    W = int(w) + 2
    cover = [0] * (W + 1)
    for z in narrow:
        a = max(0, int(z["x0"]))
        b = min(W, int(z["x1"]))
        for xi in range(a, b + 1):
            cover[xi] += 1
    # Covered segments, then merge those separated by a gap smaller than the
    # column-gap threshold (real column gaps are wider than inter-word spaces).
    segs: list[list[int]] = []
    x = 0
    while x <= W:
        if cover[x] > 0:
            start = x
            while x <= W and cover[x] > 0:
                x += 1
            segs.append([start, x - 1])
        else:
            x += 1
    min_gap = max(8, int(w * 0.012))
    merged: list[list[int]] = []
    for s in segs:
        if merged and s[0] - merged[-1][1] < min_gap:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    return [(merged[k][1] + merged[k + 1][0]) / 2 for k in range(len(merged) - 1)]


def _col_of(cx: float, bounds: list[float]) -> int:
    c = 0
    for b in bounds:
        if cx > b:
            c += 1
        else:
            break
    return c


def _grid_from_words(word_data: list[dict], w: int, h: int) -> tuple[int, int, list[dict], str]:
    """Reconstruct a table grid from Lens word geometry: rows by vertical
    proximity, columns by horizontal whitespace gaps."""
    words = _pixel_words(word_data, w, h)
    if not words:
        return 0, 0, [], ""
    tol = (_median([z["y1"] - z["y0"] for z in words]) or h * 0.02) * 0.6
    # Rows: cluster by center_y.
    ws = sorted(words, key=lambda z: z["cy"])
    rows: list[list[dict]] = []
    cur: list[dict] = []
    base: float | None = None
    for wd in ws:
        if base is None or wd["cy"] - base <= tol:
            cur.append(wd)
            base = wd["cy"] if base is None else base
        else:
            rows.append(cur)
            cur = [wd]
            base = wd["cy"]
    if cur:
        rows.append(cur)

    bounds = _column_bounds(words, w)
    ncols = len(bounds) + 1
    grid: dict[tuple[int, int], list[dict]] = {}
    for ri, row in enumerate(rows):
        for wd in row:
            grid.setdefault((ri, _col_of(wd["cx"], bounds)), []).append(wd)

    cells: list[dict] = []
    matrix = [["" for _ in range(ncols)] for _ in range(len(rows))]
    for (ri, ci), cws in grid.items():
        cws.sort(key=lambda z: z["cx"])
        text = " ".join(z["t"] for z in cws).strip()
        if not text:
            continue
        x0 = min(z["x0"] for z in cws)
        y0 = min(z["y0"] for z in cws)
        x1 = max(z["x1"] for z in cws)
        y1 = max(z["y1"] for z in cws)
        matrix[ri][ci] = text
        cells.append(
            {
                "row": ri,
                "col": ci,
                "text": text,
                "bbox": {"points": _rect_to_points(x0, y0, x1, y1), "confidence": 1.0},
                "confidence": 1.0,
            }
        )
    structured = "\n".join("\t".join(r) for r in matrix)
    return len(rows), ncols, cells, structured


# Option-B save: `save=true` stores the extraction in Data management
# (capture-ocr) with server-side artifacts. Requires the metadata API key.
METADATA_API_KEY = os.environ.get("METADATA_API_KEY", "").strip()
METADATA_SAVE_URL = os.environ.get("METADATA_SAVE_URL", "http://metadata-service:8095/api/v1/capture-ocr").rstrip("/")


async def _maybe_save(*, save: bool, x_api_key: str | None, filename: str, full_text: str, result: Any, num_pages: int = 1) -> None:
    if not save:
        return
    if not METADATA_API_KEY or not x_api_key or not hmac.compare_digest(x_api_key, METADATA_API_KEY):
        raise HTTPException(status_code=401, detail="save=true requires a valid X-API-Key")
    body = {
        "document_name": filename,
        "full_text": full_text or "",
        "result": result if isinstance(result, dict) else {},
        "num_pages": int(num_pages or 1),
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            r = await client.post(
                METADATA_SAVE_URL,
                json=body,
                headers={"X-API-Key": METADATA_API_KEY, "X-Adapter-Token": ADAPTER_TOKEN or ""},
            )
            r.raise_for_status()
    except Exception:  # noqa: BLE001 — saving is best-effort; never fail OCR
        logging.getLogger("lens-adapter").exception("save=true capture failed")


async def _lens_ocr(data: bytes, lang: str) -> dict[str, Any]:
    """Run Google Lens on raw image bytes; return the lens result dict + dims."""
    with Image.open(io.BytesIO(data)) as im:
        w, h = im.size
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
        tf.write(data)
        path = tf.name
    try:
        res = await _lens.process_image(image_path=path, ocr_language=lang, target_translation_language="en")
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    res["_w"], res["_h"] = w, h
    return res


def _page_from_lens(res: dict[str, Any], page_number: int) -> dict[str, Any]:
    w, h = res.get("_w", 0), res.get("_h", 0)
    return {
        "page_number": page_number,
        "width": w,
        "height": h,
        "regions": _regions_from_words(res.get("word_data") or [], w, h),
    }


# --------------------------------------------------------------------------- #
# Endpoints (khparser contract)
# --------------------------------------------------------------------------- #
@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "models_loaded": True, "message": "Google Lens backend"})


@app.post("/ocr-image")
async def ocr_image(
    request: Request,
    file: UploadFile = File(...),
    dpi: int | None = Query(None),
    save: bool = Query(False),
) -> JSONResponse:
    x_api_key: str | None = request.headers.get("x-api-key")
    try:
        res = await _lens_ocr(await file.read(), DEFAULT_LANG)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"detail": f"Google Lens error: {exc}"}, status_code=502)
    await _maybe_save(save=save, x_api_key=x_api_key, filename=file.filename or "upload",
                      full_text=str(res.get("ocr_text") or ""), result=res)
    return JSONResponse(
        {"text": res.get("ocr_text") or "", "confidence": 0.0, "filename": file.filename, "decoder": "google-lens"}
    )


async def _document(files: list[UploadFile], translate: bool) -> JSONResponse:
    pages, texts, translations = [], [], []
    for i, f in enumerate(files):
        try:
            res = await _lens_ocr(await f.read(), DEFAULT_LANG)
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"detail": f"Google Lens error: {exc}"}, status_code=502)
        pages.append(_page_from_lens(res, i + 1))
        texts.append(res.get("ocr_text") or "")
        if translate:
            translations.append(res.get("translated_text") or "")
    return JSONResponse(
        {
            "filename": files[0].filename if files else "",
            "num_pages": len(pages),
            "pages": pages,
            "full_text": "\n\n".join(t for t in texts if t) or None,
            "translated_text": ("\n\n".join(t for t in translations if t) or None) if translate else None,
            "table_crops": [],
            "figure_crops": [],
            "image_crops": [],
        }
    )


@app.post("/parse-pdf")
async def parse_pdf(
    request: Request,
    files: list[UploadFile] = File(...),
    dpi: int | None = Query(None),
    save: bool = Query(False),
) -> JSONResponse:
    x_api_key: str | None = request.headers.get("x-api-key")
    response = await _document(files, translate=False)
    if save and response.status_code == 200:
        doc = json.loads(response.body)
        await _maybe_save(save=True, x_api_key=x_api_key, filename=str(doc.get("filename") or "document"),
                          full_text=str(doc.get("full_text") or ""), result=doc,
                          num_pages=int(doc.get("num_pages") or 1))
    return response


@app.post("/parse-pdf-translated")
async def parse_pdf_translated(
    files: list[UploadFile] = File(...),
    dpi: int | None = Query(None),
    source_lang: str | None = Query(None),
    target_lang: str | None = Query(None),
) -> JSONResponse:
    return await _document(files, translate=True)


@app.post("/parse-table")
async def parse_table(
    request: Request,
    file: UploadFile = File(...),
    dpi: int | None = Query(None),
    save: bool = Query(False),
) -> JSONResponse:
    """Reconstruct a multi-column grid from Lens word geometry (rows by vertical
    proximity, columns by horizontal whitespace gaps). Best-effort — Lens has no
    native table model. Falls back to a single-column line list when no columns
    are detected (e.g. prose)."""
    x_api_key: str | None = request.headers.get("x-api-key")
    try:
        res = await _lens_ocr(await file.read(), DEFAULT_LANG)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"detail": f"Google Lens error: {exc}"}, status_code=502)

    w, h = res.get("_w", 0), res.get("_h", 0)
    num_rows, num_cols, cells, structured = _grid_from_words(res.get("word_data") or [], w, h)

    # Fallback: no real columns → one line per row (previous behavior).
    if num_cols <= 1:
        lines = [ln for ln in (res.get("ocr_text") or "").split("\n") if ln.strip()]
        cells = [
            {"row": i, "col": 0, "text": ln, "bbox": {"points": [[0, 0], [0, 0], [0, 0], [0, 0]], "confidence": 1.0}, "confidence": 1.0}
            for i, ln in enumerate(lines)
        ]
        num_rows, num_cols, structured = len(lines), (1 if lines else 0), "\n".join(lines)

    await _maybe_save(save=save, x_api_key=x_api_key, filename=file.filename or "table",
                      full_text=structured or "", result={"structured_text": structured, "num_rows": num_rows})

    return JSONResponse(
        {
            "filename": file.filename,
            "num_rows": num_rows,
            "num_cols": num_cols,
            "cells": cells,
            "structured_text": structured,
            "debug_image": None,
        }
    )
