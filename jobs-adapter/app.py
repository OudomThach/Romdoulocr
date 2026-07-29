"""
Asynchronous batch job service for the Romdoul OCR API.

The rest of the API is synchronous: you upload, you hold the connection open,
you get one document back. That breaks down for bulk work — a data engineer
processing 10k documents has to orchestrate every page by hand, and a single
big PDF can outlive the gateway ceiling (~26s via Netlify, ~300s via the
funnel) even though the engine would have finished it eventually.

This adapter turns that into a job API: POST once, get a `job_id` back in
202 immediately, poll for progress, fetch the merged result when it's done.

How the work actually runs
--------------------------
  * The upload is persisted to disk and the request returns — OCR NEVER runs
    inside the request.
  * A PDF is split with pypdf into single-page PDFs and sent ONE PAGE PER
    REQUEST. That is the pattern the whole system is tuned for (see the SPA's
    per-page loop) and it keeps every engine call far inside any timeout.
  * Pages run concurrently under an asyncio.Semaphore bounded by `concurrency`,
    plus a process-wide cap (JOBS_MAX_INFLIGHT) so ten parallel jobs can't
    stampede the single GPU behind the vLLM engine. Both slots are held only
    for the request itself, never across a retry sleep.
  * Every page's payload is spilled to `<job>/parts/NNNNNN.json` as it lands and
    the merge streams those files back one at a time, so OCR RESULTS never
    accumulate: an OCR page carries `crop_base64` per region, and a 300-page job
    held whole measured 350 MB RSS against 34 MB streamed.
    The honest exception is `_split_units`: pypdf parses the source PDF in memory
    and was measured peaking at ~2.5x the file size (301 MB for a 120 MB PDF).
    That is once per job, and it is NOT covered by `_INFLIGHT` or the per-job
    semaphore, so N concurrent submissions of large PDFs multiply it. If that
    ever bites, cap it at the door (submission backpressure) rather than here.
  * Results are merged back IN PAGE ORDER with page_number renumbered 1..N,
    mirroring how vllm-adapter merges multi-file documents.
  * The engines are called DIRECTLY by container name / Modal URL — NOT through
    nginx — so batch traffic is not charged against the public 120 req/min
    rate limit. The shared X-Adapter-Token is sent to the local adapters
    ourselves, since nginx (which normally injects it) is out of the path.

Failure model
-------------
A page that fails is NOT allowed to kill the job. Each page gets up to
JOBS_MAX_ATTEMPTS tries on 502/503/504/timeouts with exponential backoff (429
waits out Retry-After instead); if it still fails, the error is recorded
against that page, the remaining pages keep going, and the job finishes as
"partial". The merged document keeps a PLACEHOLDER page for every failed page
so page_number stays aligned with the source document — a caller can diff
`failures` against the pages and re-run only what's missing.

State lives in SQLite (JOBS_DB) and results as JSON files (JOBS_DIR), so a
container restart doesn't lose the history. Jobs that were in flight when the
process died are marked failed at startup rather than hanging forever, and
anything older than JOBS_TTL_HOURS is reaped. A job that ends `failed` or
`cancelled` RELEASES its Idempotency-Key, so the stable key a nightly pipeline
sends can re-run the batch instead of replaying the corpse forever.

Env:
  ADAPTER_TOKEN      optional shared secret; when set, X-Adapter-Token required
                     (everything except GET /health and OPTIONS)
  API_UPSTREAM       cloud engine base URL (default the Modal khparser API)
  VLLM_ADAPTER_URL   default http://vllm-adapter:8090
  LENS_ADAPTER_URL   default http://lens-adapter:8091
  JOBS_DB            default /data/jobs.db      JOBS_DIR   default /data/results
  JOBS_TTL_HOURS     default 72                 JOBS_MAX_INFLIGHT   default 8
  JOBS_MAX_ATTEMPTS  default 3                  JOBS_PAGE_TIMEOUT   default 600
  JOBS_MAX_UPLOAD_MB default 200
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import mimetypes
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from contextlib import ExitStack, asynccontextmanager, suppress
from datetime import datetime, timezone
from typing import Any, AsyncIterator

import httpx
from fastapi import FastAPI, File, Header, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pypdf import PdfReader, PdfWriter

log = logging.getLogger("jobs-adapter")

ADAPTER_TOKEN = os.environ.get("ADAPTER_TOKEN", "").strip()

# Engine base URLs. `cloud` is the same upstream nginx proxies /api/ to; the two
# local adapters are reached by CONTAINER NAME over the shared Docker network
# (the host-port hop via Docker Desktop's WSL2 forwarder goes stale on sleep —
# see the /api-vllm/ comment in nginx.conf).
ENGINES = {
    "cloud": os.environ.get("API_UPSTREAM", "https://rinabuoy13--khparser-api.modal.run").rstrip("/"),
    "vllm": os.environ.get("VLLM_ADAPTER_URL", "http://vllm-adapter:8090").rstrip("/"),
    "lens": os.environ.get("LENS_ADAPTER_URL", "http://lens-adapter:8091").rstrip("/"),
}
# Only the local sidecars share our ADAPTER_TOKEN. The cloud engine is a public
# Modal URL that would just ignore (or trip over) an unknown auth header.
LOCAL_ENGINES = frozenset({"vllm", "lens"})

# mode -> (engine path, multipart field name). The field name is NOT uniform
# across the contract: /parse-pdf* take `files` (plural, repeatable) while
# /ocr-image and /parse-table take `file` (singular). Sending the wrong one is
# a silent 422 from the engine, so it is table-driven here.
MODES: dict[str, tuple[str, str]] = {
    "parse-pdf": ("/parse-pdf", "files"),
    "parse-pdf-translated": ("/parse-pdf-translated", "files"),
    "ocr-image": ("/ocr-image", "file"),
    "parse-table": ("/parse-table", "file"),
}
# Modes whose merged result is a DocumentResult; the others merge to a list.
DOC_MODES = frozenset({"parse-pdf", "parse-pdf-translated"})

# Which engine params are meaningful for which mode (docs/API.md §3). Unknown
# params are dropped by FastAPI upstream, but forwarding only what applies keeps
# the engine-side request log honest and makes typos visible here instead.
PARAM_SCOPE: dict[str, frozenset[str]] = {
    "use_ctc": frozenset(MODES),
    "dpi": frozenset(MODES),
    "detect_layout": frozenset({"parse-pdf", "parse-pdf-translated"}),
    "detect_lines": frozenset({"parse-pdf", "parse-pdf-translated"}),
    "source_lang": frozenset({"parse-pdf-translated"}),
    "target_lang": frozenset({"parse-pdf-translated"}),
    "row_tolerance": frozenset({"parse-table"}),
}

JOBS_DB = os.environ.get("JOBS_DB", "/data/jobs.db")
JOBS_DIR = os.environ.get("JOBS_DIR", "/data/results")
JOBS_TTL_HOURS = float(os.environ.get("JOBS_TTL_HOURS", "72"))
REAP_INTERVAL_S = float(os.environ.get("JOBS_REAP_INTERVAL", "900"))

MAX_CONCURRENCY = 8
DEFAULT_CONCURRENCY = 3
# Process-wide ceiling on in-flight engine requests, across ALL jobs. Per-job
# concurrency alone doesn't protect the GPU: 10 jobs x 8 pages = 80 parallel
# requests to one engine. Raise it only if the engine is genuinely horizontal.
MAX_INFLIGHT = max(1, int(os.environ.get("JOBS_MAX_INFLIGHT", "8")))

MAX_ATTEMPTS = max(1, int(os.environ.get("JOBS_MAX_ATTEMPTS", "3")))
BACKOFF_BASE_S = float(os.environ.get("JOBS_BACKOFF_BASE", "2"))
BACKOFF_MAX_S = float(os.environ.get("JOBS_BACKOFF_MAX", "60"))
# Cap on an honoured Retry-After: a broken upstream can advertise an hour, and a
# batch worker asleep for an hour looks exactly like a hung job.
RETRY_AFTER_MAX_S = float(os.environ.get("JOBS_RETRY_AFTER_MAX", "120"))
# Retried statuses. 500 is deliberately absent — the engines return 500 for
# input they cannot parse, and replaying that just burns GPU time three times.
RETRY_STATUS = frozenset({429, 502, 503, 504})

PAGE_TIMEOUT_S = float(os.environ.get("JOBS_PAGE_TIMEOUT", "600"))
MAX_UPLOAD_BYTES = int(float(os.environ.get("JOBS_MAX_UPLOAD_MB", "200")) * 1024 * 1024)
UPLOAD_CHUNK = 1 << 20

TERMINAL = frozenset({"succeeded", "partial", "failed", "cancelled"})

# Live background jobs, so DELETE can actually stop the work instead of only
# hiding it. Populated on submit, popped when the task settles.
_TASKS: dict[str, asyncio.Task[None]] = {}
_INFLIGHT = asyncio.Semaphore(MAX_INFLIGHT)


# --------------------------------------------------------------------------- #
# SQLite (single connection + lock; every call is dispatched to a worker thread
# from async code, so the event loop never blocks on the file)
# --------------------------------------------------------------------------- #
SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id      TEXT PRIMARY KEY,
    idem_key    TEXT,
    status      TEXT NOT NULL,
    engine      TEXT NOT NULL,
    mode        TEXT NOT NULL,
    concurrency INTEGER NOT NULL,
    params      TEXT NOT NULL,
    filenames   TEXT NOT NULL,
    total       INTEGER NOT NULL DEFAULT 0,
    done        INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL,
    started_at  REAL,
    finished_at REAL,
    error       TEXT
);
-- Unique on the idempotency key: this index IS the idempotency guarantee — two
-- concurrent retries carrying the same key can't both insert. Partial (WHERE
-- NOT NULL) so it only indexes keyed jobs; SQLite already treats NULLs as
-- distinct, so unkeyed jobs never collide either way.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idem_key ON jobs(idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_created_at ON jobs(created_at);
-- /health groups by status on every probe (and nginx allows the health zone
-- 600 req/min), which is a full table scan once 72h of batch rows have piled up.
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
"""

_DB_LOCK = threading.Lock()
_DB: sqlite3.Connection | None = None


def _db() -> sqlite3.Connection:
    if _DB is None:  # pragma: no cover — lifespan always initialises first
        raise RuntimeError("job database is not initialised")
    return _DB


def _db_init() -> None:
    global _DB
    os.makedirs(os.path.dirname(JOBS_DB) or ".", exist_ok=True)
    os.makedirs(JOBS_DIR, exist_ok=True)
    conn = sqlite3.connect(JOBS_DB, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # WAL so a reader (GET /jobs) never blocks the writer (progress updates);
    # busy_timeout so a momentary lock is waited out instead of raising.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.executescript(SCHEMA)
    conn.commit()
    _DB = conn


def _exec(sql: str, params: tuple[Any, ...] = ()) -> int:
    """Run a write. Returns rowcount — 0 means the row is gone (job deleted).

    The rollback is not optional: pysqlite issues an implicit BEGIN for a write,
    so a statement that raises (disk full, constraint) leaves this shared
    connection holding the write lock until the NEXT successful commit. An idle
    service then keeps /data/jobs.db locked indefinitely — the WAL can't
    checkpoint and any host-side sqlite3 read-write hangs with "database is
    locked".
    """
    with _DB_LOCK:
        try:
            cur = _db().execute(sql, params)
        except Exception:
            _db().rollback()
            raise
        _db().commit()
        return cur.rowcount


def _query_all(sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
    with _DB_LOCK:
        return _db().execute(sql, params).fetchall()


def _query_one(sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
    with _DB_LOCK:
        return _db().execute(sql, params).fetchone()


def _insert_job(row: dict[str, Any]) -> bool:
    """Insert a new job. Returns False when the idempotency key already exists
    (the UNIQUE index is what makes two concurrent retries collapse to one job)."""
    cols = ", ".join(row)
    marks = ", ".join("?" for _ in row)
    with _DB_LOCK:
        try:
            _db().execute(f"INSERT INTO jobs ({cols}) VALUES ({marks})", tuple(row.values()))
        except sqlite3.IntegrityError:
            # Rollback, not just `return False`: the failed INSERT already opened
            # a transaction, and this is the NORMAL path (two concurrent retries
            # with one Idempotency-Key). Without it the service sits on the
            # write lock forever — see _exec.
            _db().rollback()
            return False
        _db().commit()
    return True


def _replayable(key: str) -> sqlite3.Row | None:
    """The job an Idempotency-Key currently owns, or None if the key is free.

    A key whose job ended `failed` or `cancelled` is RELEASED here rather than
    replayed. Replaying it is what poisoned a stable key permanently: a nightly
    pipeline that sends `nightly-2026-07-29`, gets interrupted by a restart
    (which fails the job) and retries would be handed the dead job_id forever,
    with no way to ever re-run that batch. Releasing the key instead of nulling
    it in _finish keeps ONE mechanism and also unpoisons rows written by earlier
    versions of this service.
    """
    row = _query_one("SELECT * FROM jobs WHERE idem_key=?", (key,))
    if row is None:
        return None
    if str(row["status"]) in ("failed", "cancelled"):
        _exec(
            "UPDATE jobs SET idem_key=NULL WHERE job_id=? AND status IN ('failed','cancelled')",
            (str(row["job_id"]),),
        )
        return None
    return row


def _recover_interrupted() -> int:
    """Jobs that were queued/running when the process died have no worker any
    more — their asyncio task went with the process. Left alone they'd poll as
    "running" forever, so fail them loudly with an actionable message.

    "Resubmit it" is only honest because a failed job releases its
    Idempotency-Key (see _replayable) — otherwise the resubmit the caller is
    told to send would just replay this same dead row."""
    return _exec(
        "UPDATE jobs SET status='failed', finished_at=?, error=? "
        "WHERE status IN ('queued','running')",
        (time.time(), "The job service restarted while this job was in flight. Resubmit it."),
    )


def _status_counts() -> dict[str, int]:
    rows = _query_all("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")
    return {str(r["status"]): int(r["n"]) for r in rows}


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
class _TooLarge(Exception):
    """The upload passed MAX_UPLOAD_BYTES mid-stream. Raised while writing so we
    stop reading a runaway body instead of buffering it all first."""


def _iso(ts: float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(float(ts), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _error(code: str, message: str, status: int, **extra: Any) -> JSONResponse:
    """The API-wide error envelope (same shape nginx emits for 429/413/502/504),
    so a pipeline can branch on a stable `code` instead of matching prose."""
    err: dict[str, Any] = {"code": code, "message": message}
    err.update(extra)
    return JSONResponse({"error": err, "detail": message}, status_code=status)


_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def _valid_id(job_id: str) -> bool:
    """Job ids are uuid4 hex. Validating before touching the filesystem means a
    path-traversal id ("..") can never reach os.path.join below."""
    return bool(_ID_RE.match(job_id or ""))


def _safe_name(name: str) -> str:
    base = os.path.basename((name or "").replace("\\", "/")).strip()
    base = re.sub(r"[^A-Za-z0-9._-]", "_", base)[:120].lstrip(".")
    return base or "upload"


def _job_dir(job_id: str) -> str:
    return os.path.join(JOBS_DIR, job_id)


def _result_path(job_id: str) -> str:
    return os.path.join(_job_dir(job_id), "result.json")


def _rmtree(path: str) -> None:
    shutil.rmtree(path, ignore_errors=True)


def _ctype(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def _is_pdf(path: str, name: str) -> bool:
    """Sniff the magic bytes rather than trusting the extension — pipeline
    uploads routinely arrive as `blob` or with no suffix at all."""
    try:
        with open(path, "rb") as fh:
            if fh.read(5) == b"%PDF-":
                return True
    except OSError:
        pass
    return name.lower().endswith(".pdf")


def _document_text(doc: dict[str, Any]) -> str:
    """GOTCHA: `full_text` can be an EMPTY STRING even when the regions carry
    text (the cloud engine does this on some layouts). Always fall back to
    joining the per-region text instead of trusting full_text."""
    txt = (doc.get("full_text") or "").strip()
    if txt:
        return txt
    parts: list[str] = []
    for page in doc.get("pages") or []:
        for region in page.get("regions") or []:
            t = (region.get("text") or "").strip()
            if t:
                parts.append(t)
    return "\n\n".join(parts)


# --------------------------------------------------------------------------- #
# Splitting the upload into per-page work units
# --------------------------------------------------------------------------- #
def _split_units(job_id: str, sources: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Turn the uploaded files into one work unit per PAGE.

    Blocking (pypdf + disk), so callers run it in a worker thread. Single-page
    PDFs are written to `<job>/pages/NNNNNN.pdf` rather than held in memory: a
    500-page scan would otherwise sit in RAM for the life of the job.
    """
    pages_dir = os.path.join(_job_dir(job_id), "pages")
    os.makedirs(pages_dir, exist_ok=True)
    units: list[dict[str, Any]] = []

    for src in sources:
        path, name = src["path"], src["name"]
        if not _is_pdf(path, name):
            units.append(
                {"path": path, "name": name, "source": name, "source_page": 1, "content_type": _ctype(name)}
            )
            continue

        stem = _safe_name(os.path.splitext(name)[0]) or "page"
        # Where this file's units start, so a mid-split failure can roll back to
        # the whole-file fallback instead of leaving half the pages queued TWICE.
        mark = len(units)
        try:
            with open(path, "rb") as fh:
                reader = PdfReader(fh)
                if reader.is_encrypted:
                    # Scanners routinely emit "owner-locked" PDFs with an EMPTY
                    # user password; that case decrypts fine and is worth trying
                    # before giving up on the file.
                    reader.decrypt("")
                for i in range(len(reader.pages)):
                    out = os.path.join(pages_dir, f"{len(units):06d}.pdf")
                    writer = PdfWriter()
                    writer.add_page(reader.pages[i])
                    with open(out, "wb") as ofh:
                        writer.write(ofh)
                    units.append(
                        {
                            "path": out,
                            "name": f"{stem}_p{i + 1}.pdf",
                            "source": name,
                            "source_page": i + 1,
                            "content_type": "application/pdf",
                        }
                    )
        except Exception as exc:  # noqa: BLE001 — a broken PDF must not kill the job
            # Password-protected or structurally corrupt: hand the WHOLE file to
            # the engine as a single unit instead of failing outright. The
            # engines rasterize PDFs themselves, so this often still succeeds —
            # it just loses per-page progress and concurrency for that file.
            log.warning("job %s: could not split %s (%s); sending whole file", job_id, name, exc)
            del units[mark:]
            units.append(
                {
                    "path": path,
                    "name": name,
                    "source": name,
                    "source_page": 1,
                    "content_type": "application/pdf",
                    "unsplit": True,
                }
            )
    return units


# --------------------------------------------------------------------------- #
# Engine calls
# --------------------------------------------------------------------------- #
def _engine_headers(engine: str) -> dict[str, str]:
    # nginx injects X-Adapter-Token on /api-*; we bypass nginx on purpose (rate
    # limits), so we have to send it ourselves or the sidecars answer 401.
    if ADAPTER_TOKEN and engine in LOCAL_ENGINES:
        return {"X-Adapter-Token": ADAPTER_TOKEN}
    return {}


def _classify(status: int) -> str:
    """Map an engine HTTP status onto the API-wide error codes. Order matters:
    the specific 5xx cases have to be tested before the generic `>= 500`."""
    if status == 429:
        return "rate_limited"
    if status == 504:
        return "engine_timeout"
    if status == 503:
        return "engine_not_ready"
    if status == 413:
        return "payload_too_large"
    if status == 422:
        return "input_declined"
    if status == 500:
        # NOT engine_unreachable. The engines answer 500 for input they cannot
        # parse (which is why 500 is absent from RETRY_STATUS), so this is the
        # single most common page failure there is. Reporting a bad scan as an
        # infrastructure outage makes a pipeline re-queue it against every
        # engine forever, or page an operator about a healthy GPU. `engine_error`
        # is the code clients/python/romdoul.py already maps 500 to.
        return "engine_error"
    if status >= 500:
        return "engine_unreachable"
    return "bad_request"


def _retry_after(response: httpx.Response) -> float | None:
    """Honour Retry-After (seconds form) on any retryable status — a 503 from a
    warming engine carries it as often as a 429 does, and the upstream's own
    estimate beats our fixed 2s/4s ladder. An HTTP-date is ignored in favour of
    the normal backoff — parsing it buys nothing here."""
    raw = (response.headers.get("retry-after") or "").strip()
    if not raw:
        return None
    try:
        return max(0.0, min(float(raw), RETRY_AFTER_MAX_S))
    except ValueError:
        return None


async def _attempt_once(
    client: httpx.AsyncClient,
    engine: str,
    mode: str,
    params: dict[str, str],
    unit: dict[str, Any],
) -> tuple[Any | None, dict[str, Any] | None, bool, float | None]:
    """ONE POST to the engine: no retry loop, no sleeping.

    Returns (payload, failure, retryable, retry_after). Split out from
    _process_unit so the caller can hold the concurrency slots across the
    request ONLY, and drop them before waiting out a backoff.
    """
    path, field = MODES[mode]
    url = ENGINES[engine] + path
    # Opened per attempt on purpose. httpx streams the multipart body straight
    # off this handle in 64 KB chunks, so the `unsplit` fallback (a PDF pypdf
    # could not split — 150 MB is not unusual for a scan) never lands in RAM;
    # and a handle kept from the previous attempt is at EOF, which would
    # silently POST zero bytes on the retry.
    try:
        fh = open(unit["path"], "rb")
    except OSError as exc:
        return None, {"code": "bad_request", "message": f"page file is unreadable: {exc}", "status": None}, False, None

    try:
        response = await client.post(
            url,
            params=params,
            files={field: (unit["name"], fh, unit["content_type"])},
            headers=_engine_headers(engine),
        )
    except httpx.TimeoutException as exc:
        return None, {"code": "engine_timeout", "message": f"engine timed out: {exc}", "status": None}, True, None
    except httpx.RequestError as exc:
        return None, {"code": "engine_unreachable", "message": f"could not reach {url}: {exc}", "status": None}, True, None
    finally:
        fh.close()

    if response.status_code < 300:
        try:
            return response.json(), None, False, None
        except ValueError:
            if mode == "ocr-image":
                # /ocr-image may answer with a bare text body — the SPA has the
                # same rawFallback path in src/lib/api.ts.
                payload = {"text": response.text, "confidence": 0.0, "filename": unit["name"], "decoder": None}
                return payload, None, False, None
            failure = {
                "code": "bad_request",
                "message": f"engine returned non-JSON ({len(response.content)} bytes)",
                "status": response.status_code,
            }
            return None, failure, False, None

    failure = {
        "code": _classify(response.status_code),
        "message": _engine_message(response),
        "status": response.status_code,
    }
    # 4xx / 500: the same bytes will fail again.
    retryable = response.status_code in RETRY_STATUS
    return None, failure, retryable, _retry_after(response) if retryable else None


async def _process_unit(
    client: httpx.AsyncClient,
    engine: str,
    mode: str,
    params: dict[str, str],
    unit: dict[str, Any],
    sem: asyncio.Semaphore,
    job_id: str,
    index: int,
) -> dict[str, Any] | None:
    """Run ONE page against the engine, with retries, and spill its payload.

    Returns None on success (the payload is on disk as part `index`) or the
    failure once the attempts are exhausted. It never raises for engine-side
    problems: a dead page must not take the other 9,999 with it.

    The backoff sleep happens with BOTH semaphores released. Sleeping while
    holding them starves the whole service: with the shipped defaults, eight
    pages waiting out a `Retry-After: 120` occupy all eight process-wide
    in-flight slots for ~4 minutes, during which every other job makes zero
    engine calls while the GPU sits idle. Modal answering 429 under load is
    precisely the condition this batch service exists to survive.

    The spill happens INSIDE the slots, which is what bounds this service's
    memory. Released first, the payload — a megabyte of crop_base64 — would sit
    in RAM in a queue behind the disk while the freed slot starts the next page:
    measured on 600 pages of ~1 MB crops, spilling outside the slots peaked at
    +389 MB RSS, inside them at +42 MB. Writing under the slot is backpressure,
    not waste.
    """
    failure: dict[str, Any] = {"code": "engine_unreachable", "message": "no attempt was made", "status": None}
    for attempt in range(1, MAX_ATTEMPTS + 1):
        # Global cap first, then the per-job cap. Always this order — a
        # consistent acquisition order is what keeps two nested semaphores
        # deadlock-free.
        async with _INFLIGHT, sem:
            payload, failure, retryable, retry_after = await _attempt_once(client, engine, mode, params, unit)
            if failure is None:
                await asyncio.to_thread(_write_part, job_id, index, payload)
                return None
        if not retryable or attempt == MAX_ATTEMPTS:
            break
        await asyncio.sleep(
            retry_after if retry_after is not None else min(BACKOFF_BASE_S * 2 ** (attempt - 1), BACKOFF_MAX_S)
        )

    failure["attempts"] = min(attempt, MAX_ATTEMPTS)
    return failure


def _engine_message(response: httpx.Response) -> str:
    """Pull the human part out of an engine error — every service in this stack
    answers with {"detail": ...} (and nginx adds an {"error":{...}} envelope)."""
    try:
        body = response.json()
    except ValueError:
        return (response.text or f"HTTP {response.status_code}")[:300]
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])[:300]
        if body.get("detail"):
            return str(body["detail"])[:300]
    return f"HTTP {response.status_code}"


# --------------------------------------------------------------------------- #
# Merging
# --------------------------------------------------------------------------- #
def _failure_page(unit: dict[str, Any], page_number: int, failure: dict[str, Any]) -> dict[str, Any]:
    """A placeholder page for a page that never came back. Keeping it in `pages`
    is what lets page_number stay aligned with the source document — drop it and
    every later page silently shifts up by one."""
    return {
        "page_number": page_number,
        "width": 0,
        "height": 0,
        "regions": [],
        "source_file": unit["source"],
        "source_page": unit["source_page"],
        "error": failure.get("message"),
        "error_code": failure.get("code"),
    }


def _parts_dir(job_id: str) -> str:
    return os.path.join(_job_dir(job_id), "parts")


def _write_part(job_id: str, index: int, payload: Any) -> None:
    """Spill ONE page's engine payload to disk.

    This is what keeps the job's memory flat. Holding every payload in a
    `results[]` list until the merge measured 350 MB RSS for 300 pages (each
    region carries `crop_base64`), and the documented target workload is 10k
    documents — the same list would be ~10 GB and OOM-kill the container
    mid-batch.
    """
    path = os.path.join(_parts_dir(job_id), f"{index:06d}.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    os.replace(tmp, path)


def _read_part(job_id: str, index: int) -> Any | None:
    """The spilled payload for one page, or None if it never landed (the page
    failed, or the spill itself did). Callers treat None exactly like a failed
    page, which is what it is."""
    try:
        with open(os.path.join(_parts_dir(job_id), f"{index:06d}.json"), "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _write_json_string(out: Any, path: str) -> None:
    """Emit a file's contents as a JSON string literal, in chunks.

    Chunking is safe: text mode reads whole code points and JSON escapes are
    per-code-point, so no escape sequence can straddle a boundary. `newline=""`
    on both ends stops universal-newline translation from rewriting CRLF inside
    OCR text.
    """
    out.write('"')
    with open(path, "r", encoding="utf-8", newline="") as fh:
        while True:
            chunk = fh.read(1 << 16)
            if not chunk:
                break
            out.write(json.dumps(chunk, ensure_ascii=False)[1:-1])
    out.write('"')


def _write_json_array(out: Any, path: str) -> None:
    """Emit a JSON-lines spill file as a JSON array, one element at a time.
    Crops are base64 blobs; collecting them into a Python list first is exactly
    the memory blow-up the spill exists to avoid."""
    out.write("[")
    first = True
    with open(path, "r", encoding="utf-8", newline="\n") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                continue
            if not first:
                out.write(", ")
            out.write(line)
            first = False
    out.write("]")


def _merge_document(
    job_id: str,
    engine: str,
    mode: str,
    units: list[dict[str, Any]],
    failures: list[dict[str, Any] | None],
) -> None:
    """Stream the per-page part files into one merged DocumentResult on disk,
    renumbering page_number 1..N in submission order (same approach as
    vllm-adapter's multi-file merge).

    Never holds more than a single page: pages and crops go from the part file
    straight to the output, and the text spills through `<job>/merge/*` so even
    `full_text` is never assembled in RAM. Key order differs from a dict dump
    (`num_pages` follows `pages`, because it isn't known until they are all
    written) — irrelevant to a JSON consumer, and the price of not buffering.
    """
    out_path = _result_path(job_id)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    work = os.path.join(_job_dir(job_id), "merge")
    _rmtree(work)
    os.makedirs(work, exist_ok=True)
    text_path = os.path.join(work, "text.txt")
    trans_path = os.path.join(work, "translated.txt")
    crop_paths = {key: os.path.join(work, f"{key}.jsonl") for key in ("table_crops", "figure_crops", "image_crops")}

    sources = [u["source"] for u in units]
    errors: list[dict[str, Any]] = []
    num_pages = 0
    tmp = f"{out_path}.tmp"

    with open(tmp, "w", encoding="utf-8") as out:
        out.write("{" + f'"filename": {json.dumps(sources[0] if sources else "", ensure_ascii=False)}')
        # Job metadata beyond the DocumentResult contract. Additive keys only —
        # existing clients ignore them, batch clients need them to retry pages.
        out.write(f', "job_id": {json.dumps(job_id)}')
        out.write(f', "engine": {json.dumps(engine)}, "mode": {json.dumps(mode)}')
        out.write(f', "source_files": {json.dumps(list(dict.fromkeys(sources)), ensure_ascii=False)}')
        out.write(', "pages": [')

        with ExitStack() as spill:
            text_out = spill.enter_context(open(text_path, "w", encoding="utf-8", newline=""))
            trans_out = spill.enter_context(open(trans_path, "w", encoding="utf-8", newline=""))
            crop_outs = {
                key: spill.enter_context(open(path, "w", encoding="utf-8", newline="\n"))
                for key, path in crop_paths.items()
            }
            wrote_text = False
            wrote_trans = False

            for i, unit in enumerate(units):
                doc = _read_part(job_id, i)
                if not isinstance(doc, dict):
                    failure = failures[i] or {"code": "engine_unreachable", "message": "page did not complete"}
                    num_pages += 1
                    if num_pages > 1:
                        out.write(", ")
                    out.write(json.dumps(_failure_page(unit, num_pages, failure), ensure_ascii=False))
                    errors.append(
                        {
                            **failure,
                            "page_number": num_pages,
                            "source_file": unit["source"],
                            "source_page": unit["source_page"],
                        }
                    )
                    continue

                doc_pages = doc.get("pages") or []
                if not doc_pages:
                    # The engine answered 200 but produced nothing for this page.
                    # Keep a blank page so the numbering still lines up.
                    num_pages += 1
                    if num_pages > 1:
                        out.write(", ")
                    blank = {
                        "page_number": num_pages,
                        "width": 0,
                        "height": 0,
                        "regions": [],
                        "source_file": unit["source"],
                        "source_page": unit["source_page"],
                    }
                    out.write(json.dumps(blank, ensure_ascii=False))
                for page in doc_pages:
                    num_pages += 1
                    if num_pages > 1:
                        out.write(", ")
                    # Mutated in place rather than copied: `doc` was just parsed
                    # from our own spill file, so nobody else holds a reference —
                    # and a copy would double the peak for a page of crops.
                    page["page_number"] = num_pages
                    page["source_file"] = unit["source"]
                    page["source_page"] = unit["source_page"]
                    out.write(json.dumps(page, ensure_ascii=False))

                text = _document_text(doc)
                if text:
                    text_out.write(("\n\n" if wrote_text else "") + text)
                    wrote_text = True
                translated = (doc.get("translated_text") or "").strip()
                if translated:
                    trans_out.write(("\n\n" if wrote_trans else "") + translated)
                    wrote_trans = True
                for key, sink in crop_outs.items():
                    value = doc.get(key)
                    if isinstance(value, list):
                        for item in value:
                            sink.write(json.dumps(item, ensure_ascii=False) + "\n")
                del doc  # release this page before the next one is read

        out.write(f'], "num_pages": {num_pages}')
        # An EMPTY STRING, never null. The DocumentResult contract types
        # full_text as a string and callers do `result.full_text.trim()`; a job
        # whose pages were merely blank must not throw where the synchronous
        # /parse-pdf path returns "".
        out.write(', "full_text": ')
        _write_json_string(out, text_path)
        out.write(', "translated_text": ')
        if mode == "parse-pdf-translated" and os.path.getsize(trans_path) > 0:
            _write_json_string(out, trans_path)
        else:
            out.write("null")
        for key, path in crop_paths.items():
            out.write(f', "{key}": ')
            _write_json_array(out, path)
        out.write(f', "failures": {json.dumps(errors, ensure_ascii=False)}')
        out.write("}")

    # Atomic swap: a poller that hits /result the instant the job flips to
    # "succeeded" must never read a half-written file.
    os.replace(tmp, out_path)
    _rmtree(work)


def _merge_list(job_id: str, units: list[dict[str, Any]], failures: list[dict[str, Any] | None]) -> None:
    """ocr-image / parse-table merge to a LIST, one entry per page, in order.
    Failed pages keep their slot (carrying `error`) so index N is always page N.
    Streamed from the part files for the same reason as _merge_document."""
    out_path = _result_path(job_id)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = f"{out_path}.tmp"
    with open(tmp, "w", encoding="utf-8") as out:
        out.write("[")
        for i, unit in enumerate(units):
            base = {
                "page_number": i + 1,
                "source_file": unit["source"],
                "source_page": unit["source_page"],
            }
            payload = _read_part(job_id, i)
            if isinstance(payload, dict):
                entry: dict[str, Any] = {**base, **payload}
            elif payload is not None:
                entry = {**base, "result": payload}
            else:
                failure = failures[i] or {"code": "engine_unreachable", "message": "page did not complete"}
                entry = {**base, "error": failure.get("message"), "error_code": failure.get("code")}
            if i:
                out.write(", ")
            out.write(json.dumps(entry, ensure_ascii=False))
        out.write("]")
    os.replace(tmp, out_path)


# --------------------------------------------------------------------------- #
# The background worker
# --------------------------------------------------------------------------- #
async def _run_job(
    job_id: str,
    engine: str,
    mode: str,
    concurrency: int,
    params: dict[str, str],
    sources: list[dict[str, str]],
) -> None:
    try:
        claimed = await asyncio.to_thread(
            _exec,
            "UPDATE jobs SET status='running', started_at=? WHERE job_id=? AND status='queued'",
            (time.time(), job_id),
        )
        if claimed == 0:
            # DELETEd (or cancelled) between the 202 and the first tick of this
            # task. Nothing to do — and nothing to clean up, the endpoint already
            # removed the files. The status guard is what stops this UPDATE from
            # resurrecting a cancelled row as "running".
            return

        units = await asyncio.to_thread(_split_units, job_id, sources)
        if not units:
            await _finish(job_id, "failed", error="The upload contained no readable pages.")
            return
        await asyncio.to_thread(_exec, "UPDATE jobs SET total=? WHERE job_id=?", (len(units), job_id))

        failures: list[dict[str, Any] | None] = [None] * len(units)
        sem = asyncio.Semaphore(concurrency)
        done = 0
        failed = 0
        progress_lock = asyncio.Lock()

        timeout = httpx.Timeout(connect=15.0, read=PAGE_TIMEOUT_S, write=PAGE_TIMEOUT_S, pool=PAGE_TIMEOUT_S)
        limits = httpx.Limits(max_connections=concurrency + 2, max_keepalive_connections=concurrency + 2)

        async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:

            async def run_one(index: int) -> None:
                nonlocal done, failed
                failure: dict[str, Any] | None
                try:
                    # The semaphores live inside _process_unit so they are held
                    # for the request and its spill, and NOT across retry sleeps.
                    failure = await _process_unit(client, engine, mode, params, units[index], sem, job_id, index)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 — one bad page, not a dead job
                    # _process_unit already swallows engine-side failures, so this
                    # is a LOCAL fault (page file vanished, the spill write hit a
                    # full disk). Record it like any other page failure and carry
                    # on: the other pages' GPU time is already spent.
                    log.exception("job %s: page %d raised", job_id, index + 1)
                    failure = {
                        "code": "bad_request",
                        "message": f"page could not be prepared: {exc}",
                        "status": None,
                        "attempts": 0,
                    }
                failures[index] = failure
                async with progress_lock:
                    done += 1
                    if failure is not None:
                        failed += 1
                    try:
                        await asyncio.to_thread(
                            _exec, "UPDATE jobs SET done=?, failed=? WHERE job_id=?", (done, failed, job_id)
                        )
                    except Exception:  # noqa: BLE001 — bookkeeping, not the work
                        # A counter that lags is harmless; letting this escape is
                        # not. It used to propagate through gather into the outer
                        # handler and mark the WHOLE job failed — a full /data
                        # volume threw away six pages that had all succeeded and
                        # answered /result with 409.
                        log.warning("job %s: progress update failed at page %d", job_id, index + 1, exc_info=True)

            # return_exceptions: a page's local fault belongs in `failures`, not
            # in an abort that kills its siblings mid-request and tears the httpx
            # client down under them.
            outcomes = await asyncio.gather(
                *(run_one(i) for i in range(len(units))), return_exceptions=True
            )

        aborted = 0
        for index, outcome in enumerate(outcomes):
            if isinstance(outcome, BaseException) and failures[index] is None:
                log.error("job %s: page %d aborted", job_id, index + 1, exc_info=outcome)
                failures[index] = {
                    "code": "bad_request",
                    "message": "the page task did not complete",
                    "status": None,
                    "attempts": 0,
                }
                failed += 1
                aborted += 1

        # A page killed by a hard fault never reached the in-loop progress write, so
        # without this the row keeps failed=0 while the job finishes `partial` — a
        # poll payload that contradicts itself and makes a client think every page
        # succeeded. Only write when there is something to correct, so the normal
        # path costs nothing.
        if aborted:
            try:
                await asyncio.to_thread(
                    _exec, "UPDATE jobs SET done=?, failed=? WHERE job_id=?", (done, failed, job_id)
                )
            except Exception:  # noqa: BLE001 — never let bookkeeping sink a finished job
                log.warning("job %s: final progress reconcile failed", job_id, exc_info=True)

        if mode in DOC_MODES:
            await asyncio.to_thread(_merge_document, job_id, engine, mode, units, failures)
        else:
            await asyncio.to_thread(_merge_list, job_id, units, failures)
        # The parts are pure duplication once merged, and for a big batch they
        # are the same hundreds of MB as the result itself.
        await asyncio.to_thread(_rmtree, _parts_dir(job_id))

        total = len(units)
        if failed == 0:
            await _finish(job_id, "succeeded")
        elif failed < total:
            await _finish(
                job_id,
                "partial",
                error=f"{failed} of {total} pages failed; see `failures` in the result.",
            )
        else:
            await _finish(job_id, "failed", error=f"All {total} pages failed; see `failures` in the result.")

    except asyncio.CancelledError:
        # DELETE cancelled us (or the process is shutting down). The caller owns
        # the row from here — it tombstones it `cancelled` and removes the files;
        # writing anything here would just resurrect an orphan directory.
        raise
    except Exception:  # noqa: BLE001 — the worker must never die silently
        log.exception("job %s failed", job_id)
        # Deliberately generic. The raw str(exc) used to go out over the API —
        # "Job failed: database or disk is full" handed a caller the internal
        # state of this service's store, which it can neither act on nor should
        # see. The log has the traceback.
        await _finish(job_id, "failed", error="The job could not be completed; see the service log.")
    finally:
        _TASKS.pop(job_id, None)


async def _finish(job_id: str, status: str, error: str | None = None) -> None:
    """Write the terminal state, but only over a job that is still in flight.

    The status guard matters as much as the row check: DELETE now leaves a
    `cancelled` tombstone instead of removing the row, and a worker unwinding a
    moment later must not flip that back to "succeeded". rows == 0 therefore
    means the job was reaped or cancelled out from under us — either way nothing
    owns the directory this worker may have just re-created."""
    rows = await asyncio.to_thread(
        _exec,
        "UPDATE jobs SET status=?, finished_at=?, error=? WHERE job_id=? AND status IN ('queued','running')",
        (status, time.time(), error, job_id),
    )
    if rows == 0:
        await asyncio.to_thread(_rmtree, _job_dir(job_id))


# --------------------------------------------------------------------------- #
# Reaper
# --------------------------------------------------------------------------- #
async def _reap_once() -> int:
    cutoff = time.time() - JOBS_TTL_HOURS * 3600
    rows = await asyncio.to_thread(_query_all, "SELECT job_id FROM jobs WHERE created_at < ?", (cutoff,))
    for row in rows:
        job_id = str(row["job_id"])
        # A job still running past the TTL is stuck; stop it before deleting the
        # files out from under it.
        task = _TASKS.pop(job_id, None)
        if task is not None:
            task.cancel()
            # Wait for it to unwind before the rmtree below, exactly as DELETE
            # does. Cancelling without awaiting can land while the worker is
            # inside the uncancellable merge thread, which then re-creates the
            # directory after we removed it — and since _run_job re-raises
            # CancelledError, _finish never runs to clean it up. The result is a
            # directory with no row, which the reaper (row-driven) never revisits.
            await asyncio.wait({task}, timeout=5)
        await asyncio.to_thread(_exec, "DELETE FROM jobs WHERE job_id=?", (job_id,))
        await asyncio.to_thread(_rmtree, _job_dir(job_id))
    return len(rows)


async def _reaper_loop() -> None:
    while True:
        try:
            reaped = await _reap_once()
            if reaped:
                log.info("reaped %d job(s) older than %.0fh", reaped, JOBS_TTL_HOURS)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — a bad sweep must not kill the loop
            log.exception("job reaper sweep failed")
        await asyncio.sleep(REAP_INTERVAL_S)


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    _db_init()
    recovered = _recover_interrupted()
    if recovered:
        log.warning("marked %d interrupted job(s) as failed after restart", recovered)
    reaper = asyncio.create_task(_reaper_loop())
    try:
        yield
    finally:
        reaper.cancel()
        with suppress(asyncio.CancelledError):
            await reaper
        for task in list(_TASKS.values()):
            task.cancel()
        if _DB is not None:
            with _DB_LOCK:
                _DB.close()


app = FastAPI(title="Async batch job service (khparser)", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def _require_token(request: Request, call_next):
    # /health is exempt: it's non-sensitive, and the Docker healthcheck + the
    # public status probes hit it without the token.
    exempt = request.method == "OPTIONS" or request.url.path.rstrip("/") == "/health"
    if ADAPTER_TOKEN and not exempt:
        # Constant-time compare to avoid leaking the token via timing.
        if not hmac.compare_digest(request.headers.get("x-adapter-token", ""), ADAPTER_TOKEN):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


class _UploadCap:
    """Reject an over-cap body BEFORE Starlette spools it to disk.

    Raw ASGI, not @app.middleware("http"), because only this layer can replace
    `receive` — and the cap is worthless anywhere else. FastAPI resolves
    `files: list[UploadFile]` before the endpoint runs, so the size check inside
    create_job only ever sees an upload that has ALREADY been written to the
    container filesystem in full: an 800 MB POST cost 839 MB of disk before
    answering 413. One mistaken request on the LAN fills the Docker VM's disk
    and takes down every container on the host, this service's SQLite store
    included. Nothing else guards it — port 8093 is published raw, with none of
    nginx's `client_max_body_size` in front of it.

    It sits OUTSIDE the token check (add_middleware inserts at the front, so the
    last one added is the outermost) and that is the right way round: the disk
    is worth protecting from an unauthenticated caller too, and the only thing
    the 413 discloses is a limit the error message states anyway.

    Content-Length covers every normal client; the byte counter covers a chunked
    body, where the only way to stop is to hang up mid-stream (an http.disconnect
    handed to the parser, after our 413 is already on the wire). The count is of
    WIRE bytes, so multipart framing counts against the cap — a body within a
    few hundred bytes of the limit may be refused, which is the same rounding
    nginx applies.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        for name, value in scope.get("headers") or ():
            if name == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    break
                if declared > MAX_UPLOAD_BYTES:
                    await self._reject(send)
                    return
                break

        state = {"read": 0, "aborted": False}

        async def capped_receive() -> dict[str, Any]:
            if state["aborted"]:
                return {"type": "http.disconnect"}
            message = await receive()
            if message.get("type") == "http.request":
                state["read"] += len(message.get("body") or b"")
                if state["read"] > MAX_UPLOAD_BYTES:
                    state["aborted"] = True
                    await self._reject(send)
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: dict[str, Any]) -> None:
            # Our 413 is already sent; anything the app still tries to write
            # would be a second response on the same request.
            if not state["aborted"]:
                await send(message)

        try:
            await self.app(scope, capped_receive, guarded_send)
        except Exception:
            # The disconnect we faked surfaces downstream as ClientDisconnect.
            # That is the abort working, not an error worth a 500 — and the
            # client already has its 413.
            if not state["aborted"]:
                raise

    @staticmethod
    async def _reject(send: Any) -> None:
        body = json.dumps(
            {
                "error": {
                    "code": "payload_too_large",
                    "message": f"Upload exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB. "
                    "Split the batch into several jobs.",
                },
                "detail": "Payload too large",
            }
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                    (b"connection", b"close"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


app.add_middleware(_UploadCap)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(RequestValidationError)
async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """FastAPI's own 422 body doesn't match this API's error envelope, which
    would make a batch client's error handling branch on the endpoint. Restate
    it as {"error":{"code":"bad_request",...},"detail":...}."""
    parts: list[str] = []
    for err in exc.errors()[:3]:
        loc = ".".join(str(x) for x in err.get("loc", ()) if x not in ("body", "query"))
        msg = str(err.get("msg") or "invalid value")
        parts.append(f"{loc}: {msg}" if loc else msg)
    return _error("bad_request", "; ".join(parts) or "Invalid request", 400)


def _payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "job_id": row["job_id"],
        "status": row["status"],
        "progress": {"done": int(row["done"]), "total": int(row["total"]), "failed": int(row["failed"])},
        "created_at": _iso(row["created_at"]),
        "started_at": _iso(row["started_at"]),
        "finished_at": _iso(row["finished_at"]),
        "engine": row["engine"],
        "mode": row["mode"],
        "concurrency": int(row["concurrency"]),
        "files": json.loads(row["filenames"] or "[]"),
        "error": row["error"],
    }


async def _load(job_id: str) -> sqlite3.Row | None:
    if not _valid_id(job_id):
        return None
    return await asyncio.to_thread(_query_one, "SELECT * FROM jobs WHERE job_id=?", (job_id,))


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@app.get("/health")
async def health() -> JSONResponse:
    """Mirrors the other adapters' shape (status / models_loaded / message) so
    the existing health tooling keeps working, plus the queue depth.

    `models_loaded` is always true: this service holds no models, it is ready
    the moment the process is up. It also must answer 200 while busy — every
    DB touch goes through a worker thread, so a saturated queue never blocks
    the event loop and never makes the health probe (or the watchdog) think
    the container is dead.
    """
    try:
        counts = await asyncio.to_thread(_status_counts)
    except Exception as exc:  # noqa: BLE001 — a broken DB is the one real outage here
        return JSONResponse(
            {"status": "error", "models_loaded": False, "message": f"job store unavailable: {exc}",
             "queued": 0, "running": 0},
            status_code=503,
        )
    return JSONResponse(
        {
            "status": "ok",
            "models_loaded": True,
            "message": "Async batch job service",
            "queued": counts.get("queued", 0),
            "running": counts.get("running", 0),
            "engines": sorted(ENGINES),
        }
    )


@app.post("/jobs", status_code=202)
async def create_job(
    files: list[UploadFile] = File(...),
    engine: str = Query("cloud"),
    mode: str = Query("parse-pdf"),
    concurrency: int = Query(DEFAULT_CONCURRENCY),
    target_lang: str | None = Query(None),
    source_lang: str | None = Query(None),
    use_ctc: bool | None = Query(None),
    detect_layout: bool | None = Query(None),
    detect_lines: bool | None = Query(None),
    dpi: int | None = Query(None),
    row_tolerance: int | None = Query(None),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> JSONResponse:
    """Accept the upload, persist it, return 202 immediately. OCR happens in the
    background — this handler never waits on an engine."""
    engine = (engine or "").strip().lower()
    mode = (mode or "").strip().lower()
    if engine not in ENGINES:
        return _error("bad_request", f"Unknown engine {engine!r}. Use one of: {', '.join(sorted(ENGINES))}.", 400)
    if mode not in MODES:
        return _error("bad_request", f"Unknown mode {mode!r}. Use one of: {', '.join(sorted(MODES))}.", 400)
    # Clamped, not rejected: a pipeline asking for 32 wants "as fast as you can",
    # and failing its submit over a tuning knob helps nobody.
    concurrency = max(1, min(MAX_CONCURRENCY, int(concurrency)))

    key = (idempotency_key or "").strip() or None
    if key and len(key) > 255:
        return _error("bad_request", "Idempotency-Key must be 255 characters or fewer.", 400)

    # Fast path: a retry of an already-accepted submit must NOT create a second
    # job. Starlette has already parsed the multipart by now, but we skip
    # writing any of it to disk.
    if key:
        existing = await asyncio.to_thread(_replayable, key)
        if existing is not None:
            return JSONResponse(_payload(existing), status_code=202, headers={"X-Idempotency-Replay": "HIT"})

    raw_params: dict[str, Any] = {
        "use_ctc": use_ctc,
        "detect_layout": detect_layout,
        "detect_lines": detect_lines,
        "source_lang": source_lang,
        "target_lang": target_lang,
        "dpi": dpi,
        "row_tolerance": row_tolerance,
    }
    params: dict[str, str] = {}
    for name, value in raw_params.items():
        if value is None or mode not in PARAM_SCOPE[name]:
            continue
        params[name] = ("true" if value else "false") if isinstance(value, bool) else str(value)

    job_id = uuid.uuid4().hex
    in_dir = os.path.join(_job_dir(job_id), "input")
    os.makedirs(in_dir, exist_ok=True)

    sources: list[dict[str, str]] = []
    total_bytes = 0
    try:
        for upload in files:
            original = upload.filename or f"upload-{len(sources) + 1}"
            dest = os.path.join(in_dir, f"{len(sources):04d}_{_safe_name(original)}")
            size = 0
            with open(dest, "wb") as fh:
                while True:
                    chunk = await upload.read(UPLOAD_CHUNK)
                    if not chunk:
                        break
                    size += len(chunk)
                    total_bytes += len(chunk)
                    if total_bytes > MAX_UPLOAD_BYTES:
                        raise _TooLarge()
                    fh.write(chunk)
            if size == 0:
                os.unlink(dest)  # empty part (a stray form field) — nothing to OCR
                continue
            sources.append({"path": dest, "name": original})
    except _TooLarge:
        await asyncio.to_thread(_rmtree, _job_dir(job_id))
        return _error(
            "payload_too_large",
            f"Upload exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB. Split the batch into several jobs.",
            413,
        )
    except OSError as exc:
        await asyncio.to_thread(_rmtree, _job_dir(job_id))
        return _error("bad_request", f"Could not store the upload: {exc}", 400)

    if not sources:
        await asyncio.to_thread(_rmtree, _job_dir(job_id))
        return _error("bad_request", "No non-empty files were uploaded (field name is `files`).", 400)

    now = time.time()
    row = {
        "job_id": job_id,
        "idem_key": key,
        "status": "queued",
        "engine": engine,
        "mode": mode,
        "concurrency": concurrency,
        "params": json.dumps(params, ensure_ascii=False),
        "filenames": json.dumps([s["name"] for s in sources], ensure_ascii=False),
        # A FLOOR, replaced with the real page count once the split finishes.
        # Splitting a 500-page scan takes a while, and reporting 0/0 in the
        # meantime is indistinguishable from a job that is stuck.
        "total": len(sources),
        "done": 0,
        "failed": 0,
        "created_at": now,
    }
    inserted = await asyncio.to_thread(_insert_job, row)
    existing = await asyncio.to_thread(_replayable, key) if (not inserted and key) else None
    if not inserted and key and existing is None:
        # The colliding row was a dead job and _replayable has just released its
        # key. Take the key over rather than telling a keyed client to "retry the
        # submit" — the retry it is being asked for is this one.
        inserted = await asyncio.to_thread(_insert_job, row)
    if not inserted:
        # Lost the race against a concurrent retry carrying the same key — that
        # other request owns the job, so drop ours and report theirs.
        await asyncio.to_thread(_rmtree, _job_dir(job_id))
        if existing is None:
            return _error("bad_request", "The job could not be recorded (id conflict). Retry the submit.", 409)
        return JSONResponse(_payload(existing), status_code=202, headers={"X-Idempotency-Replay": "HIT"})

    # Built from what we just wrote rather than re-read: the worker below can
    # flip the row to "running" before a second query would return, and a 202
    # that says anything other than "queued" is confusing.
    body = {
        "job_id": job_id,
        "status": "queued",
        "progress": {"done": 0, "total": len(sources), "failed": 0},
        "created_at": _iso(now),
        "started_at": None,
        "finished_at": None,
        "engine": engine,
        "mode": mode,
        "concurrency": concurrency,
        "files": [s["name"] for s in sources],
        "error": None,
    }
    _TASKS[job_id] = asyncio.create_task(_run_job(job_id, engine, mode, concurrency, params, sources))
    return JSONResponse(body, status_code=202, headers={"X-Idempotency-Replay": "MISS" if key else "BYPASS"})


@app.get("/jobs")
async def list_jobs(limit: int = Query(20), offset: int = Query(0)) -> JSONResponse:
    limit = max(1, min(100, int(limit)))
    offset = max(0, int(offset))
    rows = await asyncio.to_thread(
        _query_all, "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?", (limit, offset)
    )
    total_row = await asyncio.to_thread(_query_one, "SELECT COUNT(*) AS n FROM jobs")
    return JSONResponse(
        {
            "jobs": [_payload(r) for r in rows],
            "limit": limit,
            "offset": offset,
            "total": int(total_row["n"]) if total_row else 0,
        }
    )


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> JSONResponse:
    row = await _load(job_id)
    if row is None:
        return _error("job_not_found", f"No job {job_id!r}. It may have been deleted or reaped.", 404)
    return JSONResponse(_payload(row))


@app.get("/jobs/{job_id}/result")
async def get_result(job_id: str):
    row = await _load(job_id)
    if row is None:
        return _error("job_not_found", f"No job {job_id!r}. It may have been deleted or reaped.", 404)

    status = str(row["status"])
    path = _result_path(job_id)
    if status not in TERMINAL:
        return _error(
            "job_not_finished",
            f"Job is {status} ({row['done']}/{row['total']} pages). Poll the job until it reports a final status.",
            409,
            retry_after=5,
        )
    if not os.path.exists(path):
        # Terminal but empty: it failed before any page produced output, or it
        # was cancelled. There is nothing to serve, and no amount of polling
        # will change that.
        return _error(
            "job_not_finished",
            f"Job {status} without producing a result: {row['error'] or 'no output'}",
            409,
        )
    # Streamed from disk — a merged 10k-page document should not be loaded into
    # this process just to be copied out again. No `filename=`: that would add
    # Content-Disposition: attachment and turn an API read into a download.
    return FileResponse(path, media_type="application/json")


@app.delete("/jobs/{job_id}")
async def delete_job(job_id: str) -> JSONResponse:
    row = await _load(job_id)
    if row is None:
        return _error("job_not_found", f"No job {job_id!r}. It may have been deleted or reaped.", 404)

    previous = str(row["status"])
    task = _TASKS.pop(job_id, None)
    if task is not None:
        # Cancellation lands on the awaited engine call, so in-flight pages stop
        # within one request instead of running the batch to completion. Give it
        # a moment to unwind BEFORE deleting the files: a worker still mid-write
        # would otherwise re-create the directory we are about to remove.
        task.cancel()
        # asyncio.wait (not await task / wait_for) on purpose: it reports the
        # task settling without re-raising its CancelledError into THIS request.
        await asyncio.wait({task}, timeout=5)
    if previous in TERMINAL:
        # Deleting a finished job means what it always did: the row goes too, so
        # a pipeline that tidies up after fetching its result doesn't leave a
        # growing pile of rows in GET /jobs.
        await asyncio.to_thread(_exec, "DELETE FROM jobs WHERE job_id=?", (job_id,))
    else:
        # Cancelling one still in flight leaves a TOMBSTONE. "cancelled" is a
        # terminal status this service advertises but never used to write,
        # because the row went with the files — so a poller mid-job got a 404 and
        # could not tell "I cancelled this" from "reaped" or "never existed". The
        # TTL reaper drops it like any other row. The key is released so the same
        # Idempotency-Key can submit again, and `deleted` still means what it
        # says: the upload and any partial result are gone.
        await asyncio.to_thread(
            _exec,
            "UPDATE jobs SET status='cancelled', finished_at=?, error=?, idem_key=NULL WHERE job_id=?",
            (time.time(), "Cancelled by DELETE; the upload and any partial result were removed.", job_id),
        )
    await asyncio.to_thread(_rmtree, _job_dir(job_id))
    return JSONResponse({"job_id": job_id, "status": "cancelled", "deleted": True, "previous_status": previous})
