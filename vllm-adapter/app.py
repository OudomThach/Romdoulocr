"""
vLLM backend adapter.

The Khmer Document Parser SPA speaks one API contract (the Modal "khparser"
API): one-shot multipart uploads to /parse-pdf, /ocr-image, /parse-table that
return DocumentResult / OcrImageResponse / TableResult.

The local vLLM OCR service (surya screenshot_app, a Flask app backed by the
surya-vllm server) speaks a DIFFERENT contract: a stateful two-step flow —
POST /upload (saves the file server-side, returns a file_path), then
POST /process {file_path, page, mode} per page.

This adapter bridges the two: it accepts the SPA's contract and drives the
Flask app under the hood, reshaping responses back into the SPA's types so the
existing tabs / bounding-box viewer keep working unchanged.

Nothing here touches the default (Modal) path — the SPA only routes to this
service when the user flips the backend toggle to "vLLM" (-> /api-vllm).
"""

from __future__ import annotations

import hmac
import os
import re
from typing import Any

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from preprocess import preprocess_for_surya

# Base URL of the Flask vLLM OCR app. On the shared surya compose network the
# container is reachable by name; override via env for other topologies.
FLASK_URL = os.environ.get("SURYA_FLASK_URL", "http://surya-container-vllm:8501").rstrip("/")

# Option-B save: when a request carries `save=true`, the extraction is stored in
# the metadata service (Data management) with artifacts generated server-side.
# Requires the caller to present the metadata API key.
METADATA_API_KEY = os.environ.get("METADATA_API_KEY", "").strip()
METADATA_SAVE_URL = os.environ.get("METADATA_SAVE_URL", "http://metadata-service:8095/api/v1/capture-ocr").rstrip("/")

# Model inference can be slow; give the upstream plenty of headroom.
TIMEOUT = httpx.Timeout(connect=15.0, read=600.0, write=600.0, pool=600.0)

app = FastAPI(title="khparser → vLLM adapter", version="1.0.0")

# Shared-secret gate. When ADAPTER_TOKEN is set (public deployment behind a
# Tailscale Funnel), every request must carry a matching `X-Adapter-Token`
# header or gets 401 — so a naked GPU endpoint on the internet can't be abused
# even if someone finds the funnel URL. Left UNSET for the home/nginx
# deployment (same private network), where no gate is needed.
ADAPTER_TOKEN = os.environ.get("ADAPTER_TOKEN", "").strip()


@app.middleware("http")
async def _require_token(request: Request, call_next):
    # /health is exempt: it's non-sensitive, and the Docker healthcheck +
    # public status probes hit it without the token.
    exempt = request.method == "OPTIONS" or request.url.path.rstrip("/") == "/health"
    if ADAPTER_TOKEN and not exempt:
        # Constant-time compare to avoid leaking the token via timing.
        supplied = request.headers.get("x-adapter-token", "")
        if not hmac.compare_digest(supplied, ADAPTER_TOKEN):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


# CORS: only relevant if a browser ever calls the adapter cross-origin. In the
# secure setup the caller is a same-origin Netlify Function (server-side), so
# this is belt-and-suspenders; the token above is the real gate.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _raw_base64(s: str | None) -> str | None:
    """The SPA prepends `data:image/png;base64,` to image fields itself (the
    Modal API returns RAW base64). Flask returns a full data URL, so strip the
    `data:...;base64,` prefix to avoid a double prefix that breaks the <img>."""
    if s and s.startswith("data:") and "," in s:
        return s.split(",", 1)[1]
    return s


def _rect_to_points(bbox: list[float]) -> list[list[float]]:
    """[x0,y0,x1,y1] axis-aligned rect -> 4 corner points (SPA BoundingBox)."""
    x0, y0, x1, y1 = (float(v) for v in bbox[:4])
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


# Surya's layout vocabulary (CamelCase) -> the DocLayNet labels the SPA renders.
# The SPA switches on region_type to format each block (headings, lists, tables,
# captions, figures); without this mapping every block falls through to a plain
# paragraph, which is the "different output format" the user saw. Keys are the
# Surya label lowercased with all non-letters stripped (see _map_label).
LABEL_MAP = {
    "text": "text",
    "sectionheader": "section-header",
    "subsectionheader": "heading",
    "partheader": "title",
    "pageheader": "caption",
    "pagefooter": "footnote",
    "footnote": "footnote",
    "caption": "caption",
    "tablecaption": "caption",
    "table": "table",
    "tableofcontents": "list-item",
    "equation": "text",
    "picture": "picture",
    "figure": "figure",
    "diagram": "figure",
    "form": "text",
    "code": "text",
    "chemicalblock": "text",
    "listgroup": "list-item",
    "listitem": "list-item",
    "reference": "text",
    "title": "title",
}


def _map_label(label: str) -> str:
    key = re.sub(r"[^a-z]", "", (label or "").lower())
    return LABEL_MAP.get(key, "text")


def _inline_md(node: Any) -> str:
    """Recursively convert a block's inner HTML to markdown, preserving the
    inline structure surya-ocr-2 emits (bold/italic/super/sub/code/breaks).
    Flattening with get_text() would drop all of this."""
    from bs4 import NavigableString, Tag

    if isinstance(node, NavigableString):
        return str(node)
    if not isinstance(node, Tag):
        return ""

    inner = "".join(_inline_md(c) for c in node.children)
    name = (node.name or "").lower()
    s = inner.strip()
    if name in ("b", "strong"):
        return f"**{s}**" if s else ""
    if name in ("i", "em"):
        return f"*{s}*" if s else ""
    if name == "sup":
        return f"^{s}^" if s else ""
    if name == "sub":
        return f"~{s}~" if s else ""
    if name == "code":
        return f"`{s}`" if s else ""
    if name == "br":
        return "\n"
    if name == "li":
        # No leading "- ": the SPA adds bullets per line for list-item regions.
        return f"{s}\n" if s else ""
    if name in ("p", "div"):
        return f"{inner.strip()}\n\n"
    if re.fullmatch(r"h[1-6]", name or ""):
        # Heading level is applied by the SPA via region_type; keep just text.
        return s
    return inner


def _block_to_markdown(div: Any) -> str:
    md = "".join(_inline_md(c) for c in div.children)
    return re.sub(r"\n{3,}", "\n\n", md).strip()


def _cell_lines(td: Any) -> list[str]:
    """Split a table cell into its visual lines. surya-ocr-2 sometimes lumps
    several body rows into one <tr>, stacking values inside a cell via <br> or
    newlines (e.g. a cell holding "180\\n150\\n30"). We return those as separate
    lines so the row can be expanded back into one row per line."""
    for br in td.find_all("br"):
        br.replace_with("\n")
    return [ln.strip() for ln in td.get_text("\n").split("\n") if ln.strip()]


def _table_grid(table_tag: Any) -> list[list[str]]:
    """Flatten an HTML <table> to a list of physical rows. Rows whose cells hold
    multiple stacked lines are EXPANDED into one row per line (index-aligned),
    so a lumped multi-value row becomes the split layout the SPA renders. Tables
    whose cells are already atomic (one line each) pass through unchanged."""
    out_rows: list[list[str]] = []
    for tr in table_tag.find_all("tr"):
        tds = tr.find_all(["th", "td"])
        if not tds:
            continue
        lines = [_cell_lines(td) for td in tds]
        n = max((len(c) for c in lines), default=1)
        if n <= 1:
            out_rows.append([" ".join(c) for c in lines])
        else:
            for k in range(n):
                out_rows.append([c[k] if k < len(c) else "" for c in lines])
    return out_rows


def _html_table_to_pipe(table_tag: Any) -> str:
    """Convert an HTML <table> into a markdown pipe table (with row expansion).

    The SPA parses `table` regions' text as a pipe table (parsePipeTable) to
    render real tables and export to xlsx/csv. surya-ocr-2 emits tables as HTML,
    so we reshape here instead of flattening to a wall of text.
    """
    rows = _table_grid(table_tag)
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]

    def esc(s: str) -> str:
        return s.replace("|", "\\|")

    out = ["| " + " | ".join(esc(c) for c in rows[0]) + " |"]
    out.append("| " + " | ".join("---" for _ in range(width)) + " |")
    for r in rows[1:]:
        out.append("| " + " | ".join(esc(c) for c in r) + " |")
    return "\n".join(out)


def _avg_block_confidence(blocks: list[dict[str, Any]]) -> float:
    vals = [
        float(b["confidence"])
        for b in blocks
        if isinstance(b, dict) and b.get("confidence") is not None
    ]
    return round(sum(vals) / len(vals), 4) if vals else 0.0


def _bbox_key(bbox: list[float]) -> tuple[int, int, int, int]:
    return tuple(int(round(float(v))) for v in bbox[:4])  # type: ignore[return-value]


def _regions_from_page(html: str, blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Build SPA LayoutRegion[] from a Flask page.

    The page `html` is a sequence of
        <div data-bbox="x0 y0 x1 y1" data-label="LABEL">…content…</div>
    blocks (see _assemble_page_html in screenshot_app.py). That gives us
    per-region bbox + label + text. We pull per-region confidence from the
    parallel `blocks` canvas array, matched by bbox.
    """
    conf_by_box: dict[tuple[int, int, int, int], float] = {}
    for b in blocks or []:
        if isinstance(b, dict) and b.get("bbox") and b.get("confidence") is not None:
            conf_by_box[_bbox_key(b["bbox"])] = float(b["confidence"])

    soup = BeautifulSoup(html or "", "html.parser")
    regions: list[dict[str, Any]] = []
    for div in soup.select("div[data-bbox]"):
        raw = (div.get("data-bbox") or "").split()
        if len(raw) != 4:
            continue
        try:
            rect = [float(v) for v in raw]
        except ValueError:
            continue
        raw_label = div.get("data-label") or "Text"

        # Reshape content per block type so the SPA renders it natively:
        #  - any block containing an HTML table -> markdown pipe table ('table')
        #  - list groups -> newline-separated so the SPA emits one bullet per line
        #  - everything else -> flattened text, typed via the label map
        table_tag = div.find("table")
        if table_tag is not None:
            label = "table"
            text = _html_table_to_pipe(table_tag) or div.get_text(" ", strip=True)
        else:
            label = _map_label(raw_label)
            # Convert inline HTML -> markdown so bold/italic/breaks survive.
            text = _block_to_markdown(div) or div.get_text(" ", strip=True)
            # The SPA already emphasizes these block types (heading marks /
            # italics) via region_type, so strip redundant inline bold to avoid
            # malformed nesting like "*...**bold**...*" (triple asterisks).
            if label in ("title", "section-header", "heading", "caption", "footnote"):
                text = text.replace("**", "")

        conf = conf_by_box.get(_bbox_key(rect), 1.0)
        bbox = {"points": _rect_to_points(rect), "confidence": conf}
        regions.append(
            {
                "bbox": bbox,
                "region_type": label,
                "lines": [{"bbox": bbox, "text": text, "confidence": conf}],
                "text": text,
                "confidence": conf,
                "khmer_text": None,
                "english_text": None,
                "crop_base64": None,
            }
        )
    return regions


def _parse_html_table(html: str) -> dict[str, Any] | None:
    """Parse surya-ocr-2's full-page <table> (which DOES carry cell text) into
    populated TableResult cells. The dedicated table-structure model
    (table_rec) only returns the grid geometry with empty text, which is why
    the Parse Table tab showed blank cells. Cell coords are approximated by
    subdividing the table's bbox (the HTML table has no per-cell coordinates)."""
    soup = BeautifulSoup(html or "", "html.parser")
    table = soup.find("table")
    if table is None:
        return None

    # Enclosing block's bbox, for approximate per-cell overlay coordinates.
    tb = [0.0, 0.0, 0.0, 0.0]
    parent = table.find_parent(lambda t: getattr(t, "name", None) == "div" and t.has_attr("data-bbox"))
    if parent:
        raw = (parent.get("data-bbox") or "").split()
        if len(raw) == 4:
            try:
                tb = [float(v) for v in raw]
            except ValueError:
                pass

    grid = _table_grid(table)
    num_rows = len(grid)
    num_cols = max((len(r) for r in grid), default=0)
    x0, y0, x1, y1 = tb
    cw = (x1 - x0) / num_cols if num_cols else 0.0
    rh = (y1 - y0) / num_rows if num_rows else 0.0

    cells: list[dict[str, Any]] = []
    for i, row in enumerate(grid):
        for j, txt in enumerate(row):
            rect = [x0 + cw * j, y0 + rh * i, x0 + cw * (j + 1), y0 + rh * (i + 1)]
            cells.append(
                {
                    "row": i,
                    "col": j,
                    "text": txt,
                    "bbox": {"points": _rect_to_points(rect), "confidence": 1.0},
                    "confidence": 1.0,
                }
            )
    return {
        "cells": cells,
        "num_rows": num_rows,
        "num_cols": num_cols,
        "structured_text": _html_table_to_pipe(table),
    }


async def _upload(
    client: httpx.AsyncClient,
    file: UploadFile,
    data: bytes | None = None,
    content_type: str | None = None,
) -> dict[str, Any]:
    if data is None:
        data = await file.read()
    files = {
        "file": (file.filename or "upload", data, content_type or file.content_type or "application/octet-stream")
    }
    r = await client.post(f"{FLASK_URL}/upload", files=files)
    r.raise_for_status()
    return r.json()


async def _upload_preprocessed(
    client: httpx.AsyncClient, file: UploadFile, *, do_deskew: bool = True
) -> dict[str, Any]:
    """Upload an image after Surya-specific preprocessing (upscale / deskew /
    enhance). Best-effort: any failure falls back to the original bytes so OCR
    never breaks because preprocessing hiccuped. PDFs are passed through raw
    (they're rasterized server-side; PIL can't open them as images).

    `do_deskew=False` for document mode: deskew rotates+expands the image, which
    would shift it out of alignment with the box overlays the SPA draws on the
    original page. Upscale/grayscale/sharpen are aspect-preserving, so they stay
    box-safe and remain enabled."""
    raw = await file.read()
    name = (file.filename or "").lower()
    is_pdf = name.endswith(".pdf") or (file.content_type or "").lower() == "application/pdf"
    if is_pdf:
        return await _upload(client, file, data=raw)
    try:
        prepped = preprocess_for_surya(raw, do_deskew=do_deskew)
        return await _upload(client, file, data=prepped, content_type="image/png")
    except Exception:  # noqa: BLE001 — never let preprocessing break OCR
        return await _upload(client, file, data=raw)


async def _process(
    client: httpx.AsyncClient, file_path: str, page: int, mode: str, dpi: int | None = None
) -> dict[str, Any]:
    payload: dict[str, Any] = {"file_path": file_path, "page": page, "mode": mode}
    if dpi:
        # Flask clamps to [MIN_RENDER_DPI, MAX_RENDER_DPI]; higher DPI on PDFs
        # helps surya-ocr-2 resolve dense tables into proper rows. Ignored for
        # already-rasterized images (loaded at native size).
        payload["dpi"] = int(dpi)
    r = await client.post(f"{FLASK_URL}/process", json=payload)
    r.raise_for_status()
    return r.json()


async def _maybe_save(
    *,
    save: bool,
    x_api_key: str | None,
    filename: str,
    full_text: str,
    result: Any,
    num_pages: int = 1,
) -> None:
    """Option B: save the extraction into Data management (capture-ocr) with
    server-side artifacts. Requires the metadata API key from the caller."""
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
        logger = __import__("logging").getLogger("vllm-adapter")
        logger.exception("save=true capture failed")


# --------------------------------------------------------------------------- #
# Routes — the SPA (khparser) contract
# --------------------------------------------------------------------------- #
@app.get("/health")
async def health() -> JSONResponse:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            r = await client.get(f"{FLASK_URL}/_stcore/health")
        ok = r.status_code == 200
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            {"status": "error", "models_loaded": False, "message": f"vLLM backend unreachable: {exc}"},
            status_code=503,
        )
    return JSONResponse(
        {
            "status": "ok" if ok else "degraded",
            "models_loaded": ok,
            "message": "Local vLLM backend",
        }
    )


@app.post("/ocr-image")
async def ocr_image(
    request: Request,
    file: UploadFile = File(...),
    dpi: int | None = Query(None),
    save: bool = Query(False),
) -> JSONResponse:
    x_api_key: str | None = request.headers.get("x-api-key")
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        # Surya-specific preprocessing (upscale low-res / deskew / enhance) so the
        # model meets its bare-minimum input quality on old/blurry/small scans.
        up = await _upload_preprocessed(client, file)
        # Layout-guided OCR FIRST. `block_ocr` detects layout regions and OCRs
        # each one — faster and far more robust on real document pages than
        # whole-image recognition (`full_page`), which feeds the entire page to
        # the model as ONE sequence and on a dense scan can run for minutes and
        # still return nothing (the 88s / 0-chars case). Fall back to full_page
        # only when layout finds no blocks (e.g. a bare single-line crop), where
        # block_ocr returns empty but whole-image recognition succeeds.
        res = await _process(client, up["file_path"], 0, "block_ocr", dpi)
        if not (res.get("text") or "").strip():
            res = await _process(client, up["file_path"], 0, "full_page", dpi)
    await _maybe_save(save=save, x_api_key=x_api_key, filename=file.filename or "upload",
                      full_text=res.get("text") or "", result=res)
    return JSONResponse(
        {
            "text": res.get("text") or "",
            "confidence": _avg_block_confidence(res.get("blocks") or []),
            "filename": file.filename,
            "decoder": "vllm",
        }
    )


async def _document_from_file(
    client: httpx.AsyncClient, file: UploadFile, dpi: int | None = None
) -> dict[str, Any]:
    # Preprocess image inputs (upscale/grayscale/sharpen) but NOT deskew — see
    # _upload_preprocessed; document boxes must stay aligned to the source page.
    # PDFs pass through raw (rasterized server-side at the requested DPI).
    up = await _upload_preprocessed(client, file, do_deskew=False)
    page_count = int(up.get("page_count") or 1)
    pages: list[dict[str, Any]] = []
    text_parts: list[str] = []
    for page_num in range(page_count):
        res = await _process(client, up["file_path"], page_num, "full_page", dpi)
        regions = _regions_from_page(res.get("html") or "", res.get("blocks") or [])
        pages.append(
            {
                "page_number": page_num + 1,
                "width": int(res.get("width") or 0),
                "height": int(res.get("height") or 0),
                "regions": regions,
            }
        )
        if res.get("text"):
            text_parts.append(res["text"])
    return {
        "filename": up.get("name") or file.filename,
        "num_pages": page_count,
        "pages": pages,
        "full_text": "\n\n".join(text_parts) if text_parts else None,
        "translated_text": None,
        "table_crops": [],
        "figure_crops": [],
        "image_crops": [],
    }


@app.post("/parse-pdf")
async def parse_pdf(
    request: Request,
    files: list[UploadFile] = File(...),
    dpi: int | None = Query(None),
    save: bool = Query(False),
) -> JSONResponse:
    x_api_key: str | None = request.headers.get("x-api-key")
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        docs = [await _document_from_file(client, f, dpi) for f in files]
    if len(docs) == 1:
        result = docs[0]
    else:
        # Multiple files: merge into a single document, renumbering pages.
        merged = docs[0]
        offset = len(merged["pages"])
        for doc in docs[1:]:
            for p in doc["pages"]:
                p["page_number"] += offset
                merged["pages"].append(p)
            offset += len(doc["pages"])
            if doc.get("full_text"):
                merged["full_text"] = (merged.get("full_text") or "") + "\n\n" + doc["full_text"]
        merged["num_pages"] = len(merged["pages"])
        result = merged
    await _maybe_save(save=save, x_api_key=x_api_key, filename=str(result.get("filename") or "document"),
                      full_text=str(result.get("full_text") or ""), result=result,
                      num_pages=int(result.get("num_pages") or 1))
    return JSONResponse(result)


@app.post("/parse-pdf-translated")
async def parse_pdf_translated(
    files: list[UploadFile] = File(...), dpi: int | None = Query(None)
) -> JSONResponse:
    # The vLLM OCR backend has no translation step. We return the parsed
    # document with translated_text left null so the tab still renders OCR
    # output (translation simply unavailable on this backend).
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        doc = await _document_from_file(client, files[0], dpi)
    return JSONResponse(doc)


def _cells_from_table(result: dict[str, Any]) -> tuple[list[dict[str, Any]], int, int]:
    rows = result.get("rows") or []
    cols = result.get("cols") or result.get("columns") or []
    cells_in = result.get("cells") or []
    cells: list[dict[str, Any]] = []
    for c in cells_in:
        if not isinstance(c, dict):
            continue
        row = c.get("row_id", c.get("row", 0))
        col = c.get("col_id", c.get("col", 0))
        text = c.get("text")
        if text is None and c.get("text_lines"):
            text = " ".join(
                tl.get("text", "") for tl in c["text_lines"] if isinstance(tl, dict)
            )
        bbox_raw = c.get("bbox") or c.get("cell_bbox") or [0, 0, 0, 0]
        conf = c.get("confidence")
        cells.append(
            {
                "row": int(row or 0),
                "col": int(col or 0),
                "text": text or "",
                "bbox": {"points": _rect_to_points(bbox_raw), "confidence": float(conf) if conf is not None else 1.0},
                "confidence": float(conf) if conf is not None else 1.0,
            }
        )
    num_rows = len(rows) if rows else (max((c["row"] for c in cells), default=-1) + 1)
    num_cols = len(cols) if cols else (max((c["col"] for c in cells), default=-1) + 1)
    return cells, num_rows, num_cols


@app.post("/parse-table")
async def parse_table(
    request: Request,
    file: UploadFile = File(...),
    dpi: int | None = Query(None),
    save: bool = Query(False),
) -> JSONResponse:
    x_api_key: str | None = request.headers.get("x-api-key")
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        # do_deskew=False: table cell bboxes are drawn over the ORIGINAL page by
        # the SPA (Compare docx cell boxes) — deskew rotates+expands the image,
        # which would shift every cell box off the source page. Upscale/gray/
        # sharpen are aspect-preserving and stay on.
        up = await _upload_preprocessed(client, file, do_deskew=False)
        # Full-page OCR — surya-ocr-2 returns a real table as an HTML <table> WITH
        # text (the structure-only table_rec model returns EMPTY cell text, so we
        # don't use it here).
        res = await _process(client, up["file_path"], 0, "full_page", dpi)
        parsed = _parse_html_table(res.get("html") or "")
        if parsed is not None and save:
            # Table results carry their content in structured_text, not text —
            # send that so capture-ocr generates markdown/csv from the grid.
            await _maybe_save(save=save, x_api_key=x_api_key, filename=file.filename or "table",
                              full_text=str(parsed.get("structured_text") or ""), result=parsed)

        parsed = _parse_html_table(res.get("html") or "")
        if parsed is None:
            # No table on the page. Match the cloud (khparser) API, which ALWAYS
            # returns the text: fall back to the full-page text as a single-column
            # grid (one row per line) instead of an empty 0×0 "no table" result,
            # so Table mode still yields content on prose pages.
            full_text = res.get("text") or ""
            lines = [ln.rstrip() for ln in full_text.split("\n")]
            while lines and not lines[-1].strip():
                lines.pop()
            zero_bbox = {"points": _rect_to_points([0.0, 0.0, 0.0, 0.0]), "confidence": 1.0}
            cells = [
                {"row": i, "col": 0, "text": ln, "bbox": zero_bbox, "confidence": 1.0}
                for i, ln in enumerate(lines)
            ]
            parsed = {
                "cells": cells,
                "num_rows": len(cells),
                "num_cols": 1 if cells else 0,
                "structured_text": full_text,
            }

    return JSONResponse(
        {
            "filename": up.get("name") or file.filename,
            "num_rows": parsed["num_rows"],
            "num_cols": parsed["num_cols"],
            "cells": parsed["cells"],
            "structured_text": parsed["structured_text"],
            "width": int(res.get("width") or 0),
            "height": int(res.get("height") or 0),
            "debug_image": _raw_base64(res.get("image_base64")),
        }
    )


@app.exception_handler(httpx.HTTPStatusError)
async def _upstream_error(_request: Request, exc: httpx.HTTPStatusError) -> JSONResponse:
    detail = "Upstream vLLM backend error"
    try:
        body = exc.response.json()
        detail = body.get("error") or body.get("detail") or detail
    except Exception:  # noqa: BLE001
        detail = exc.response.text or detail
    # The GPU engine is cold (model loading, ~2 min) when Flask answers 500
    # with this Surya message. Surface it as 503 so the app's badge reads
    # "waking up" instead of a hard failure.
    if exc.response.status_code == 500 and ("not reachable" in str(detail) or "SURYA_INFERENCE_URL" in str(detail) or "unreachable" in str(detail)):
        return JSONResponse(
            {"detail": "Surya OCR 2 is waking up on the GPU (~2 min) — retry shortly.", "models_loaded": False},
            status_code=503,
        )
    return JSONResponse({"detail": detail}, status_code=exc.response.status_code)


@app.exception_handler(httpx.RequestError)
async def _connect_error(_request: Request, exc: httpx.RequestError) -> JSONResponse:
    return JSONResponse(
        {"detail": f"Could not reach vLLM backend at {FLASK_URL}: {exc}"},
        status_code=503,
    )
