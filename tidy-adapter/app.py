"""
Transform-to-tidy adapter for the Romdoul OCR SPA.

Reshapes an OCR-extracted Markdown table into "tidy data" (Hadley Wickham: each
variable a column, each observation a row, each value a cell). Ported from the
reference repo `fullstack_pdf2md_transform2tidy`, which uses a THREE-PROMPT
pipeline rather than a single call:

    profile(df)                     ← deterministic: describe the raw table as JSON
      → PROMPT 1  diagnose          ← LLM: find the structural problems
      → PROMPT 2  strategy          ← LLM: plan the fix (headers / rows / unpivot)
      → PROMPT 3  generate code     ← LLM: write pandas code that does it
    execute(code, df)               ← deterministic (sandboxed): run the code → tidy df

If any stage fails (LLM error, unparseable output, unsafe/erroring code) it falls
back to a single-pass "reshape it directly" prompt so the user always gets a
result. The generated code runs with a restricted builtins namespace, a blocked-
construct scan, and a wall-clock timeout — the input is user-supplied and the
code is model-generated, so this is defense-in-depth, not a full sandbox.

Provider is chosen by TIDY_MODEL: a "gemini-*" name → Google Gemini API
(GEMINI_API_KEY / GOOGLE_API_KEY); anything else → Anthropic (ANTHROPIC_API_KEY).

Mirrors the vllm/lens adapter sidecar pattern (nginx reaches it by container name
at /api-tidy/*, ADAPTER_TOKEN shared-secret gate, CORS). The tidy Markdown + CSV
are built here in Python so they match the SPA's table shapes exactly.

Env:
  TIDY_MODEL          (default gemini-2.5-flash)
  GEMINI_API_KEY / GOOGLE_API_KEY   (for gemini-* models)
  ANTHROPIC_API_KEY   (for claude-* models)
  ADAPTER_TOKEN       (optional shared secret; when set, X-Adapter-Token required)
  TIDY_MAX_TOKENS     (default 16000)   TIDY_EXEC_TIMEOUT (default 20 s)
"""

from __future__ import annotations

import builtins as _bi
import hmac
import json
import os
import re
import threading
from typing import Any

import httpx
import numpy as np
import pandas as pd
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from anthropic import Anthropic

app = FastAPI(title="Transform-to-tidy adapter (3-step pipeline)", version="2.0.0")

ADAPTER_TOKEN = os.environ.get("ADAPTER_TOKEN", "").strip()
MODEL = os.environ.get("TIDY_MODEL", "gemini-2.5-flash").strip() or "gemini-2.5-flash"
PROVIDER = "gemini" if MODEL.lower().startswith("gemini") else "anthropic"
MAX_TOKENS = int(os.environ.get("TIDY_MAX_TOKENS", "16000"))
MAX_MARKDOWN_CHARS = int(os.environ.get("TIDY_MAX_CHARS", "200000"))
EXEC_TIMEOUT = int(os.environ.get("TIDY_EXEC_TIMEOUT", "20"))

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "").strip() or os.environ.get("GOOGLE_API_KEY", "").strip()
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
HAS_KEY = bool(GEMINI_KEY) if PROVIDER == "gemini" else bool(ANTHROPIC_KEY)
_client = Anthropic() if (PROVIDER == "anthropic" and ANTHROPIC_KEY) else None


# --------------------------------------------------------------------------- #
# Prompts (3-step pipeline) — ported from the reference repo's intent
# --------------------------------------------------------------------------- #
PROMPT_1_DIAGNOSE = """You are a data-quality auditor. You are given a JSON PROFILE of a raw table that was extracted from a document by OCR — its shape, each column (name, position, how many cells are filled, sample values, how numeric it looks), a preview of the first rows, and candidate problem rows.

Identify the STRUCTURAL problems that stop this table from being "tidy" (Hadley Wickham: one variable per column, one observation per row). Look specifically for:
1. hierarchical / multi-level headers — a real header split across the first data row(s), or group labels spanning several columns.
2. section-header rows — a label sitting on its own row with no data, whose value belongs on the rows beneath it.
3. aggregate / total / subtotal rows — rows that summarise the detail rows and would cause double-counting.
4. wide / matrix layout — several columns that are really VALUES of a single variable (e.g. one column per year), which should be unpivoted into rows.

Respond with ONLY a JSON object:
{
  "multi_level_header": {"present": bool, "detail": "..."},
  "section_header_rows": [{"row_index": int, "label": "...", "meaning": "..."}],
  "aggregate_rows": [{"row_index": int, "reason": "..."}],
  "wide_columns": {"present": bool, "value_columns": ["column names that are values of one variable"], "variable_meaning": "what those columns represent, e.g. year"},
  "identifier_columns": ["columns that identify each observation"],
  "summary": "one or two sentences"
}
Base every claim on the profile. If a problem is absent, use an empty list or present:false."""

PROMPT_2_STRATEGY = """You are a data-remediation planner. You are given a raw table PROFILE and a DIAGNOSIS of its structural problems. Produce a concrete plan to turn the raw table into ONE tidy table (one variable per column, one observation per row).

Respond with ONLY a JSON object:
{
  "header_flattening": "how to build the final headers (forward-fill a multi-level header, promote row N, or keep as-is)",
  "implicit_variables": [{"new_column": "...", "source": "section headers / repeated label", "method": "forward-fill / extract"}],
  "row_filters": [{"drop": "what to remove (totals, empty rows, leftover header rows)", "recognise_by": "keyword / mostly-empty / position"}],
  "unpivot": {"needed": bool, "id_vars": ["kept columns"], "value_vars": ["columns to melt"], "var_name": "name for the former-header column", "value_name": "name for the value column"},
  "final_columns": ["ordered columns of the tidy table"],
  "steps": ["ordered human-readable steps"]
}
Rules: drop totals BEFORE unpivoting so nothing is double-counted; forward-fill values that only appear in section-header rows so no information is lost; never drop real data."""

PROMPT_3_CODEGEN = """You are a Python/pandas engineer. Write clean, runnable pandas code that transforms a raw DataFrame `df_raw` into a tidy DataFrame, following the given STRATEGY. You are also given the raw column names and a data sample.

Define EXACTLY this function and nothing else:

def clean(df_raw):
    log = []
    df = df_raw.copy()
    # ... your transformation, appending a short note to log for each step ...
    return df, log

Hard rules:
- `pd` (pandas), `np` (numpy) and `re` are ALREADY available. Do NOT write any import statements.
- Do NOT read files, use the network, or touch attributes that start with underscores.
- Every cell in df_raw is a STRING (OCR text). Use pd.to_numeric(x, errors="coerce") only where you need arithmetic; otherwise keep the original text.
- Resolve multi-level headers by forward-filling group labels (.ffill()) — never hardcode a fixed row/cell index.
- Push section-header / repeated labels DOWN into their own column (forward-fill) BEFORE dropping those rows.
- Drop total/subtotal/aggregate rows and fully-empty rows. Recognise totals by case-insensitive keyword match (include Khmer "សរុប" and "រួម"), NOT by a fixed row number.
- If the strategy says to unpivot, use pd.melt with the given id_vars / value_vars / var_name / value_name.
- Give the result meaningful column names and clean cells.
Output ONLY the function code — no explanation, no markdown fences."""

# Single-pass fallback prompt (the original direct reshape).
SYSTEM_SINGLE = """You convert messy OCR-extracted tables into "tidy data" (Hadley Wickham: each variable a column, each observation a row, each value a single cell).

You are given ONE Markdown table. Reshape it into a single tidy table:
- UNPIVOT wide / matrix tables (columns that are repeated measures of one variable) into rows with an identifier column, a variable column, and a value column.
- Keep genuine identifier columns as their own columns.
- Drop total/subtotal rows; forward-fill section-header labels into their own column before dropping them.
- Preserve the ORIGINAL cell text verbatim (including Khmer). Do NOT translate, reformat numbers, or invent values.

Return ONLY a JSON object: `columns` (header names), `rows` (each an array of cell strings, one per column), and `notes` (one or two sentences on what you changed)."""


# --------------------------------------------------------------------------- #
# LLM plumbing (provider-agnostic)
# --------------------------------------------------------------------------- #
def _gemini(system: str, user: str, json_mode: bool) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={GEMINI_KEY}"
    gen: dict[str, Any] = {"maxOutputTokens": MAX_TOKENS, "temperature": 0, "thinkingConfig": {"thinkingBudget": 0}}
    if json_mode:
        gen["responseMimeType"] = "application/json"
    body = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": gen,
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
    return "".join(p.get("text", "") for p in parts)


def _anthropic(system: str, user: str, json_mode: bool) -> str:
    sys = system + ("\n\nRespond with ONLY a single valid JSON object — no prose, no code fences." if json_mode else "")
    resp = _client.messages.create(  # type: ignore[union-attr]
        model=MODEL, max_tokens=MAX_TOKENS, system=sys,
        messages=[{"role": "user", "content": user}],
    )
    if getattr(resp, "stop_reason", None) == "refusal":
        raise RuntimeError("refusal")
    return _response_text(resp)


def _llm(system: str, user: str, json_mode: bool) -> str:
    return _gemini(system, user, json_mode) if PROVIDER == "gemini" else _anthropic(system, user, json_mode)


def _response_text(resp: Any) -> str:
    parts = []
    for block in getattr(resp, "content", []) or []:
        if getattr(block, "type", None) == "text":
            parts.append(getattr(block, "text", "") or "")
    return "".join(parts)


def _extract_json(text: str) -> Any:
    s = (text or "").strip()
    if s.startswith("```"):
        nl = s.find("\n")
        s = (s[nl + 1 :] if nl != -1 else s[3:])
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    s = s.strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        a, b = s.find("{"), s.rfind("}")
        if a != -1 and b != -1 and b > a:
            return json.loads(s[a : b + 1])
        raise


def _parse_or_text(text: str) -> Any:
    try:
        return _extract_json(text)
    except Exception:  # noqa: BLE001
        return {"raw": text[:2000]}


# --------------------------------------------------------------------------- #
# Markdown <-> DataFrame + tidy Markdown/CSV
# --------------------------------------------------------------------------- #
def _split_row(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    cells = re.split(r"(?<!\\)\|", s)
    return [c.replace("\\|", "|").replace("<br>", "\n").strip() for c in cells]


def _parse_pipe_table(md: str) -> tuple[list[str], list[list[str]]]:
    lines = md.replace("\r\n", "\n").split("\n")
    rows = [_split_row(ln) for ln in lines if "|" in ln and ln.strip()]
    rows = [r for r in rows if not (any(c for c in r) and all(re.fullmatch(r"[-:=\s]*", c or "") for c in r))]
    rows = [r for r in rows if any(c.strip() for c in r)]
    if not rows:
        return [], []
    return rows[0], rows[1:]


def _dedupe_columns(header: list[str], width: int) -> list[str]:
    out: list[str] = []
    seen: dict[str, int] = {}
    for i in range(width):
        name = (header[i] if i < len(header) else "").strip() or f"col_{i + 1}"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 0
        out.append(name)
    return out


def _build_df(markdown: str) -> pd.DataFrame:
    header, body = _parse_pipe_table(markdown)
    if not header and not body:
        raise RuntimeError("no table found in the input")
    width = max([len(header)] + [len(r) for r in body]) if (header or body) else 0
    if width == 0:
        raise RuntimeError("empty table")
    cols = _dedupe_columns(header, width)

    def pad(r: list[str]) -> list[str]:
        return list(r) + [""] * (width - len(r))

    rows = [pad(r)[:width] for r in body]
    df = pd.DataFrame(rows, columns=cols)
    return df.astype(str) if not df.empty else df


def _md_cell(v: str) -> str:
    return (v or "").replace("|", "\\|").replace("\r\n", " ").replace("\n", " ").strip()


def _tidy_markdown(columns: list[str], rows: list[list[str]]) -> str:
    cols = columns or ["Value"]
    lines = [
        "| " + " | ".join(_md_cell(c) for c in cols) + " |",
        "| " + " | ".join("---" for _ in cols) + " |",
    ]
    for r in rows:
        cells = (list(r) + [""] * len(cols))[: len(cols)]
        lines.append("| " + " | ".join(_md_cell(c) for c in cells) + " |")
    return "\n".join(lines) + "\n"


def _csv_escape(v: str) -> str:
    v = v or ""
    return '"' + v.replace('"', '""') + '"' if any(ch in v for ch in ('"', ",", "\r", "\n")) else v


def _tidy_csv(columns: list[str], rows: list[list[str]]) -> str:
    cols = columns or ["Value"]
    out = [",".join(_csv_escape(c) for c in cols)]
    for r in rows:
        cells = (list(r) + [""] * len(cols))[: len(cols)]
        out.append(",".join(_csv_escape(c) for c in cells))
    return "\r\n".join(out) + "\r\n"


def _as_str_matrix(rows: Any) -> list[list[str]]:
    out: list[list[str]] = []
    for r in rows or []:
        if isinstance(r, list):
            out.append(["" if c is None else str(c) for c in r])
        else:
            out.append(["" if r is None else str(r)])
    return out


# --------------------------------------------------------------------------- #
# Deterministic profiling
# --------------------------------------------------------------------------- #
_TOTAL_KW = ["total", "subtotal", "sub-total", "grand total", "sum", "average", "avg", "mean", "overall", "សរុប", "រួម"]


def _truncate(s: str, n: int = 80) -> str:
    return s if len(s) <= n else s[:n] + "…"


def _looks_number(s: str) -> bool:
    t = re.sub(r"[,\s%$៛]", "", s.strip())
    if not t:
        return False
    try:
        float(t)
        return True
    except ValueError:
        return False


def _profile(df: pd.DataFrame) -> dict[str, Any]:
    values = df.values.tolist()
    nrows, ncols = len(values), (len(df.columns))
    cols_meta = []
    for ci, name in enumerate(df.columns):
        col = [str(row[ci]) if ci < len(row) and row[ci] is not None else "" for row in values]
        nonempty = [c for c in col if c.strip()]
        uniq: list[str] = []
        seen: set[str] = set()
        for c in nonempty:
            t = _truncate(c)
            if t not in seen:
                seen.add(t)
                uniq.append(t)
            if len(uniq) >= 8:
                break
        numlike = sum(1 for c in nonempty if _looks_number(c))
        cols_meta.append({
            "name": str(name),
            "position": ci,
            "n_nonempty": len(nonempty),
            "n_empty": nrows - len(nonempty),
            "looks_numeric": round(numlike / len(nonempty), 2) if nonempty else 0.0,
            "sample_values": uniq,
        })
    total_rows, section_rows, empty_rows = [], [], []
    for ri, row in enumerate(values):
        cells = [str(c) if c is not None else "" for c in row]
        nonempty = [c for c in cells if c.strip()]
        if not nonempty:
            empty_rows.append(ri)
            continue
        joined = " ".join(cells).lower()
        if any(kw in joined for kw in _TOTAL_KW):
            total_rows.append(ri)
        if len(nonempty) == 1 and ncols > 1:
            section_rows.append(ri)
    return {
        "shape": [nrows, ncols],
        "columns": cols_meta,
        "row_preview": [[_truncate(str(c) if c is not None else "") for c in row] for row in values[:20]],
        "candidate_total_rows": total_rows[:50],
        "candidate_section_header_rows": section_rows[:50],
        "empty_rows": empty_rows[:50],
    }


# --------------------------------------------------------------------------- #
# Sandboxed execution of the generated cleaning code
# --------------------------------------------------------------------------- #
_SAFE_BUILTIN_NAMES = [
    "abs", "all", "any", "bool", "dict", "divmod", "enumerate", "filter", "float", "format", "frozenset",
    "getattr", "hasattr", "int", "isinstance", "issubclass", "len", "list", "map", "max", "min", "next",
    "print", "range", "repr", "reversed", "round", "set", "slice", "sorted", "str", "sum", "tuple", "type",
    "zip", "Exception", "ValueError", "KeyError", "TypeError", "IndexError", "AttributeError", "ZeroDivisionError",
]
SAFE_BUILTINS = {n: getattr(_bi, n) for n in _SAFE_BUILTIN_NAMES if hasattr(_bi, n)}

# Reject obviously dangerous constructs. Short names use \b so a column value like
# "kilos." (contains "os.") or "close(" doesn't false-positive.
_BLOCKED_RE = re.compile(
    r"__|\bimport\b|\bexec\s*\(|\beval\s*\(|\bcompile\s*\(|\bopen\s*\(|\bsubprocess\b|\bos\s*\.|\bsys\s*\.|"
    r"\bsocket\b|\bshutil\b|\bpathlib\b|\brequests\b|\burllib\b|\bpickle\b|\binput\s*\(|\bglobals\s*\(|"
    r"\blocals\s*\(|\bsetattr\s*\(|\bdelattr\s*\(|\bvars\s*\("
)


def _clean_code(text: str) -> str:
    s = (text or "").strip()
    if s.startswith("```"):
        nl = s.find("\n")
        s = s[nl + 1 :] if nl != -1 else s[3:]
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    return s.strip()


def _run_with_timeout(fn: Any, timeout: int) -> Any:
    box: dict[str, Any] = {}

    def target() -> None:
        try:
            box["value"] = fn()
        except Exception as exc:  # noqa: BLE001
            box["error"] = exc

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        raise TimeoutError(f"cleaning code exceeded {timeout}s")
    if "error" in box:
        raise box["error"]
    return box.get("value")


def _execute(code: str, df_raw: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    if "def clean" not in code:
        raise RuntimeError("generated code has no clean() function")
    m = _BLOCKED_RE.search(code)
    if m:
        raise RuntimeError(f"generated code used a blocked construct: {m.group(0)!r}")
    ns: dict[str, Any] = {"__builtins__": SAFE_BUILTINS, "pd": pd, "np": np, "re": re}
    exec(compile(code, "<tidy-clean>", "exec"), ns)  # noqa: S102 — restricted namespace + blocklist + timeout
    fn = ns.get("clean")
    if not callable(fn):
        raise RuntimeError("generated code did not define a callable clean()")
    out = _run_with_timeout(lambda: fn(df_raw.copy()), EXEC_TIMEOUT)
    if isinstance(out, tuple) and len(out) == 2:
        df, log = out
    else:
        df, log = out, []
    if not isinstance(df, pd.DataFrame):
        df = pd.DataFrame(df)
    log = [str(x) for x in log] if isinstance(log, (list, tuple)) else ([str(log)] if log else [])
    return df, log


def _cell(v: Any) -> str:
    try:
        if v is None or (np.isscalar(v) and pd.isna(v)):
            return ""
    except (TypeError, ValueError):
        pass
    return str(v)


def _df_to_table(df: pd.DataFrame) -> tuple[list[str], list[list[str]]]:
    try:
        df = df.reset_index(drop=True)
    except Exception:  # noqa: BLE001
        pass
    cols = []
    for c in df.columns:
        if isinstance(c, tuple):
            cols.append(" ".join(str(x) for x in c if str(x)).strip())
        else:
            cols.append(str(c))
    rows = [[_cell(v) for v in row] for row in df.values.tolist()]
    return cols, rows


# --------------------------------------------------------------------------- #
# The 3-step pipeline + single-pass fallback
# --------------------------------------------------------------------------- #
def _pipeline(df_raw: pd.DataFrame, instructions: str) -> tuple[list[str], list[list[str]], str, dict[str, Any]]:
    profile = _profile(df_raw)
    note = f"\n\nUser note: {instructions}" if instructions else ""
    pj = json.dumps(profile, ensure_ascii=False)

    diagnosis = _parse_or_text(_llm(PROMPT_1_DIAGNOSE, f"PROFILE:\n{pj}{note}", json_mode=True))
    strategy = _parse_or_text(
        _llm(PROMPT_2_STRATEGY, f"PROFILE:\n{pj}\n\nDIAGNOSIS:\n{json.dumps(diagnosis, ensure_ascii=False)}", json_mode=True)
    )
    code = _clean_code(
        _llm(
            PROMPT_3_CODEGEN,
            f"STRATEGY:\n{json.dumps(strategy, ensure_ascii=False)}\n\n"
            f"RAW COLUMNS:\n{json.dumps([str(c) for c in df_raw.columns], ensure_ascii=False)}\n\n"
            f"DATA SAMPLE (first rows, as arrays):\n{json.dumps(profile['row_preview'], ensure_ascii=False)}{note}",
            json_mode=False,
        )
    )

    df_tidy, log = _execute(code, df_raw)
    columns, rows = _df_to_table(df_tidy)
    if not rows:
        raise RuntimeError("cleaning code produced an empty table")

    steps = strategy.get("steps") if isinstance(strategy, dict) else None
    notes = "; ".join(log[:6]) if log else (steps[0] if isinstance(steps, list) and steps else "reshaped to tidy format")
    extras = {"method": "pipeline", "diagnosis": diagnosis, "strategy": strategy, "code": code, "log": log}
    return columns, rows, notes, extras


def _single_shot(markdown: str, instructions: str) -> tuple[list[str], list[list[str]], str]:
    user = f"Transform this table into tidy data:\n\n{markdown}"
    if instructions:
        user += f"\n\nAdditional instructions: {instructions}"
    data = _extract_json(_llm(SYSTEM_SINGLE, user, json_mode=True))
    columns = [("" if c is None else str(c)) for c in (data.get("columns") or [])]
    rows = _as_str_matrix(data.get("rows"))
    return columns, rows, str(data.get("notes") or "")


# --------------------------------------------------------------------------- #
# Middleware / request model
# --------------------------------------------------------------------------- #
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
# Endpoints
# --------------------------------------------------------------------------- #
@app.get("/health")
async def health() -> JSONResponse:
    keyname = "GEMINI_API_KEY" if PROVIDER == "gemini" else "ANTHROPIC_API_KEY"
    return JSONResponse({
        "status": "ok",
        "ready": HAS_KEY,
        "provider": PROVIDER,
        "model": MODEL,
        "pipeline": "3-step",
        "message": f"tidy backend ({PROVIDER})" if HAS_KEY else f"{keyname} not set",
    })


# Sync def → FastAPI runs it in a worker thread, so the blocking LLM calls and the
# thread-timed exec don't stall the event loop.
@app.post("/tidy")
def tidy(req: TidyRequest) -> JSONResponse:
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
    instructions = (req.instructions or "").strip()

    method = "pipeline"
    extras: dict[str, Any] = {}
    try:
        df_raw = _build_df(markdown)
        columns, rows, notes, extras = _pipeline(df_raw, instructions)
    except Exception as pipe_err:  # noqa: BLE001 — any failure → single-pass fallback
        try:
            columns, rows, notes = _single_shot(markdown, instructions)
        except RuntimeError as exc:
            if str(exc) == "refusal":
                return JSONResponse({"detail": "The model declined to transform this input."}, status_code=422)
            return JSONResponse({"detail": f"Tidy failed: {exc}"}, status_code=502)
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"detail": f"Tidy failed: {exc}"}, status_code=502)
        method = "single"
        reason = str(pipe_err)[:200]
        extras = {"fallback_reason": reason}
        notes = f"{notes}  (3-step pipeline fell back to single-pass: {reason[:120]})".strip()

    if not columns and rows:
        columns = [f"Column {i + 1}" for i in range(max(len(r) for r in rows))]

    resp: dict[str, Any] = {
        "columns": columns,
        "rows": rows,
        "tidy_markdown": _tidy_markdown(columns, rows),
        "tidy_csv": _tidy_csv(columns, rows),
        "notes": notes,
        "model": MODEL,
        "method": method,
    }
    for k in ("diagnosis", "strategy", "code", "log", "fallback_reason"):
        if k in extras:
            resp[k] = extras[k]
    return JSONResponse(resp)
