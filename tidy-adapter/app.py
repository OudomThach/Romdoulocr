"""
Transform-to-tidy adapter for the Romdoul OCR SPA.

Takes a Markdown table (as extracted by any of the OCR backends) and reshapes it
into "tidy data" — Hadley Wickham's principles: each variable a column, each
observation a row, each value a cell — using the Anthropic Messages API. Wide /
matrix tables get unpivoted (melted) into long format; obvious OCR noise is
cleaned WITHOUT inventing data. Non-Latin text (Khmer, etc.) is preserved verbatim.

This mirrors the vllm-adapter / lens-adapter sidecar pattern: a small FastAPI app
on the SPA's Docker network that nginx reaches by container name (/api-tidy/*),
with the same ADAPTER_TOKEN shared-secret gate so it can be exposed via the
Tailscale Funnel safely.

The model returns ONLY {columns, rows, notes} (structured outputs). We build the
tidy Markdown + CSV here in Python so they exactly match the SPA's table shapes.

Env:
  ANTHROPIC_API_KEY  (required for /tidy; /health still answers without it)
  TIDY_MODEL         (default claude-opus-4-8)
  ADAPTER_TOKEN      (optional shared secret; when set, X-Adapter-Token required)
"""

from __future__ import annotations

import hmac
import json
import os
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from anthropic import Anthropic

app = FastAPI(title="Transform-to-tidy adapter", version="1.1.0")

ADAPTER_TOKEN = os.environ.get("ADAPTER_TOKEN", "").strip()
# TIDY_MODEL picks BOTH the model and the provider: a "gemini-*" name routes to
# Google's Gemini API (key = GEMINI_API_KEY / GOOGLE_API_KEY); anything else
# routes to Anthropic (key = ANTHROPIC_API_KEY). Default is Gemini 2.5 Flash
# (fast + cheap); set e.g. TIDY_MODEL=claude-sonnet-5 to use Claude instead.
MODEL = os.environ.get("TIDY_MODEL", "gemini-2.5-flash").strip() or "gemini-2.5-flash"
PROVIDER = "gemini" if MODEL.lower().startswith("gemini") else "anthropic"
MAX_TOKENS = int(os.environ.get("TIDY_MAX_TOKENS", "16000"))
# Guard against a runaway request body (a table is small; this is generous).
MAX_MARKDOWN_CHARS = int(os.environ.get("TIDY_MAX_CHARS", "200000"))

GEMINI_KEY = (os.environ.get("GEMINI_API_KEY", "").strip() or os.environ.get("GOOGLE_API_KEY", "").strip())
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
HAS_KEY = bool(GEMINI_KEY) if PROVIDER == "gemini" else bool(ANTHROPIC_KEY)
# Anthropic SDK client only when that provider is active + keyed.
_client = Anthropic() if (PROVIDER == "anthropic" and ANTHROPIC_KEY) else None


SYSTEM = """You convert messy OCR-extracted tables into "tidy data", following Hadley Wickham's principles:
1. Each variable forms a column.
2. Each observation forms a row.
3. Each value is a single cell.

You are given ONE Markdown table (usually produced by OCR, so it may have merged
or multi-row headers, a wide/matrix layout, or stray characters).

Reshape it into a single tidy table:
- UNPIVOT wide / matrix tables. When several columns are repeated measures of the
  same variable (years, months, categories, etc. spread across columns), melt them
  into rows: keep the identifier column(s), and add a column naming the former
  header (the "variable") plus a column holding its value.
- Keep genuine identifier columns (names, labels, ids, dates) as their own columns.
- If the table is already tidy, keep its structure and only clean obvious noise.
- Preserve the ORIGINAL cell text verbatim, including non-Latin scripts (Khmer,
  etc.). Do NOT translate, reformat numbers, or invent values. Leave a cell empty
  when the source is empty or unreadable.
- Give every column a short, clear header; infer a reasonable name if the source
  header is missing or garbled.

Return the tidy table via the required JSON shape: `columns` (header names in
order), `rows` (each an array of cell strings, one per column), and `notes` (one
or two sentences on what you changed). Do not add any commentary outside the JSON."""

TIDY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "columns": {"type": "array", "items": {"type": "string"}},
        "rows": {
            "type": "array",
            "items": {"type": "array", "items": {"type": "string"}},
        },
        "notes": {"type": "string"},
    },
    "required": ["columns", "rows", "notes"],
    "additionalProperties": False,
}

# Gemini's responseSchema is an OpenAPI subset — it rejects additionalProperties.
GEMINI_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "columns": {"type": "array", "items": {"type": "string"}},
        "rows": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}},
        "notes": {"type": "string"},
    },
    "required": ["columns", "rows", "notes"],
    "propertyOrdering": ["columns", "rows", "notes"],
}


def _gemini_run(system: str, user_text: str) -> tuple[str, str]:
    """Call Gemini generateContent with JSON structured output. Returns the raw
    JSON text and the model name. Thinking is disabled (thinkingBudget 0) — this
    is a deterministic reshape, so it keeps latency + token use down."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={GEMINI_KEY}"
    body = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": GEMINI_SCHEMA,
            "maxOutputTokens": MAX_TOKENS,
            "temperature": 0,
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    with httpx.Client(timeout=120.0) as client:
        r = client.post(url, json=body)
    if r.status_code != 200:
        raise RuntimeError(f"Gemini HTTP {r.status_code}: {r.text[:300]}")
    data = r.json()
    cands = data.get("candidates") or []
    if not cands:
        reason = (data.get("promptFeedback") or {}).get("blockReason")
        raise RuntimeError(f"Gemini returned no candidates{f' (blocked: {reason})' if reason else ''}")
    parts = (cands[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts)
    return text, MODEL


def _anthropic_run(system: str, user_text: str) -> tuple[str, str]:
    resp = _client.messages.create(  # type: ignore[union-attr]
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=system,
        messages=[{"role": "user", "content": user_text}],
        output_config={"format": {"type": "json_schema", "schema": TIDY_SCHEMA}},
    )
    if getattr(resp, "stop_reason", None) == "refusal":
        raise RuntimeError("refusal")
    return _response_text(resp), getattr(resp, "model", MODEL)


@app.middleware("http")
async def _require_token(request: Request, call_next):
    exempt = request.method == "OPTIONS" or request.url.path.rstrip("/") == "/health"
    if ADAPTER_TOKEN and not exempt:
        if not hmac.compare_digest(request.headers.get("x-adapter-token", ""), ADAPTER_TOKEN):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class TidyRequest(BaseModel):
    markdown: str
    instructions: str | None = None


# --------------------------------------------------------------------------- #
# Tidy table -> Markdown / CSV (built here so they match the SPA's shapes)
# --------------------------------------------------------------------------- #
def _md_cell(v: str) -> str:
    return (v or "").replace("|", "\\|").replace("\r\n", " ").replace("\n", " ").strip()


def _tidy_markdown(columns: list[str], rows: list[list[str]]) -> str:
    cols = columns or ["Value"]
    header = "| " + " | ".join(_md_cell(c) for c in cols) + " |"
    divider = "| " + " | ".join("---" for _ in cols) + " |"
    lines = [header, divider]
    for r in rows:
        # Pad / trim each row to the column count so the table stays rectangular.
        cells = list(r) + [""] * (len(cols) - len(r))
        lines.append("| " + " | ".join(_md_cell(c) for c in cells[: len(cols)]) + " |")
    return "\n".join(lines) + "\n"


def _csv_escape(v: str) -> str:
    v = v or ""
    if any(ch in v for ch in ('"', ",", "\r", "\n")):
        return '"' + v.replace('"', '""') + '"'
    return v


def _tidy_csv(columns: list[str], rows: list[list[str]]) -> str:
    cols = columns or ["Value"]
    out = [",".join(_csv_escape(c) for c in cols)]
    for r in rows:
        cells = list(r) + [""] * (len(cols) - len(r))
        out.append(",".join(_csv_escape(c) for c in cells[: len(cols)]))
    return "\r\n".join(out) + "\r\n"


def _response_text(resp: Any) -> str:
    parts = []
    for block in getattr(resp, "content", []) or []:
        if getattr(block, "type", None) == "text":
            parts.append(getattr(block, "text", "") or "")
    return "".join(parts)


def _extract_json(text: str) -> dict[str, Any]:
    """Structured outputs returns clean JSON, but strip code fences / surrounding
    prose defensively so a stray wrapper doesn't break parsing."""
    s = (text or "").strip()
    if s.startswith("```"):
        s = s.strip("`")
        # Drop a leading language tag like ```json
        nl = s.find("\n")
        if nl != -1 and " " not in s[:nl]:
            s = s[nl + 1 :]
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        a, b = s.find("{"), s.rfind("}")
        if a != -1 and b != -1 and b > a:
            return json.loads(s[a : b + 1])
        raise


def _as_str_matrix(rows: Any) -> list[list[str]]:
    out: list[list[str]] = []
    for r in rows or []:
        if isinstance(r, list):
            out.append(["" if c is None else str(c) for c in r])
        else:
            out.append([("" if r is None else str(r))])
    return out


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@app.get("/health")
async def health() -> JSONResponse:
    keyname = "GEMINI_API_KEY" if PROVIDER == "gemini" else "ANTHROPIC_API_KEY"
    return JSONResponse(
        {
            "status": "ok",
            "ready": HAS_KEY,
            "provider": PROVIDER,
            "model": MODEL,
            "message": f"tidy backend ({PROVIDER})" if HAS_KEY else f"{keyname} not set",
        }
    )


@app.post("/tidy")
async def tidy(req: TidyRequest) -> JSONResponse:
    if not HAS_KEY:
        keyname = "GEMINI_API_KEY" if PROVIDER == "gemini" else "ANTHROPIC_API_KEY"
        return JSONResponse(
            {"detail": f"Tidy transform is not configured ({keyname} is not set on the adapter)."},
            status_code=503,
        )

    markdown = (req.markdown or "").strip()
    if not markdown:
        return JSONResponse({"detail": "No markdown table provided."}, status_code=400)
    if len(markdown) > MAX_MARKDOWN_CHARS:
        return JSONResponse({"detail": "Table is too large to transform."}, status_code=413)

    user_text = f"Transform this table into tidy data:\n\n{markdown}"
    if req.instructions and req.instructions.strip():
        user_text += f"\n\nAdditional instructions: {req.instructions.strip()}"

    try:
        text, model_used = _gemini_run(SYSTEM, user_text) if PROVIDER == "gemini" else _anthropic_run(SYSTEM, user_text)
    except RuntimeError as exc:
        if str(exc) == "refusal":
            return JSONResponse({"detail": "The model declined to transform this input."}, status_code=422)
        return JSONResponse({"detail": f"{PROVIDER} request failed: {exc}"}, status_code=502)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"detail": f"{PROVIDER} request failed: {exc}"}, status_code=502)

    try:
        data = _extract_json(text)
    except (json.JSONDecodeError, ValueError):
        return JSONResponse(
            {"detail": "Could not parse the tidy result (the model may have been cut off — try a smaller selection)."},
            status_code=502,
        )

    columns = [("" if c is None else str(c)) for c in (data.get("columns") or [])]
    rows = _as_str_matrix(data.get("rows"))
    notes = str(data.get("notes") or "")
    if not columns and rows:
        columns = [f"Column {i + 1}" for i in range(max(len(r) for r in rows))]

    return JSONResponse(
        {
            "columns": columns,
            "rows": rows,
            "tidy_markdown": _tidy_markdown(columns, rows),
            "tidy_csv": _tidy_csv(columns, rows),
            "notes": notes,
            "model": model_used,
        }
    )
