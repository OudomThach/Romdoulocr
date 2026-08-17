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
    plus a PER-ENGINE cap (JOBS_MAX_INFLIGHT_CLOUD / _VLLM / _LENS) and a
    process-wide backstop (JOBS_MAX_INFLIGHT) so ten parallel jobs can't
    stampede the single GPU behind the vLLM engine. All three slots are held
    only for the request itself, never across a retry sleep.
  * Every page's payload is spilled to `<job>/parts/NNNNNN.json` as it lands and
    the merge streams those files back one at a time, so OCR RESULTS never
    accumulate: an OCR page carries `crop_base64` per region, and a 300-page job
    held whole measured 350 MB RSS against 34 MB streamed.
    `_split_units` is the other memory peak: pypdf parses the source PDF in
    memory and was measured peaking at ~2.5x the file size (301 MB for a 120 MB
    PDF). It is NOT covered by `_INFLIGHT` or the per-job semaphore — 120
    simultaneous 20 MB submissions used to parse all 120 at once — so it has its
    own `_SPLITS` gate (JOBS_MAX_SPLITS). The gate is held in the BACKGROUND
    task, never in the request: POST /jobs still answers 202 in milliseconds and
    the split queues behind it.
  * Submission itself is bounded by JOBS_MAX_ACTIVE queued+running jobs; past
    that POST /jobs answers 429 + Retry-After. An Idempotency-Key replay of a
    job that already exists is answered BEFORE that check, so a client polling
    by resubmitting can never be locked out by its own backlog.
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
container restart doesn't lose the history, and anything older than
JOBS_TTL_HOURS is reaped. A job that ends `failed` or `cancelled` RELEASES its
Idempotency-Key, so the stable key a nightly pipeline sends can re-run the batch
instead of replaying the corpse forever.

Crash recovery
--------------
A job that was queued/running when the process died is RESUMED at startup, not
failed. It used to be failed, which threw away every page that had already
finished: one `docker restart` (or one OOM kill) partway through a 6000-page
batch cost hours of GPU time and forced the caller to resubmit from scratch.

Resume re-splits the upload (deterministic — same sources, same order, same unit
indices) and then SKIPS every page that already has a readable
`<job>/parts/NNNNNN.json`. Those pages are never re-sent to an engine; the
progress counters are rebuilt from the part files actually on disk rather than
from the pre-crash `done`, so a poll reflects reality. A part that will not
parse counts as NOT done and is redone — `_write_part` renames a temp file into
place, but a hard kill can still leave the rename durable ahead of the data on
some overlay/volume filesystems, and half a JSON object is exactly what that
looks like.

The bound is JOBS_MAX_RESUMES (default 3): a job that has already been resumed
that many times is failed for real. Without it, a job whose content kills the
process turns `restart: unless-stopped` into an infinite restart loop that never
makes progress and never lets the queue drain.

Resume needs the ORIGINAL upload, so nothing may delete `<job>/input/` while the
job is unfinished — the TTL reaper is restricted to terminal jobs for exactly
this reason (see _reap_once).

Reading the results
-------------------
GET /jobs/{job_id}/result serves the merged JSON unchanged by default. Two extra
shapes exist because every caller of a nested DocumentResult writes the same
flattening loop, and because a two-hour batch that holds all its output until
the last page is unusable in a pipeline:

  * `format=jsonl` / `format=csv` flatten to ONE ROW PER REGION. Both are
    generated by a generator over the merged file — the file is never parsed
    whole, because a 6000-page result is the same gigabytes the streaming merge
    exists to never hold.
  * `partial=true` serves the pages that have finished so far for a job that is
    still running, read from `<job>/parts/`. Terminal jobs are unaffected.

Observability
-------------
GET /metrics reports queue depth, per-engine request/failure/retry counts,
per-engine in-flight, and latency percentiles. Engine and page counters are
PROCESS-LIFETIME (a restart zeroes them); the job counts come from SQLite and
survive one. It is meant to be polled: it never touches an engine, keeps
latency in a bounded ring buffer, and caches the one SQL aggregate it needs.

Env:
  ADAPTER_TOKEN      optional shared secret; when set, X-Adapter-Token required
                     (everything except GET /health and OPTIONS)
  API_UPSTREAM       cloud engine base URL (default the Modal khparser API)
  VLLM_ADAPTER_URL   default http://vllm-adapter:8090
  LENS_ADAPTER_URL   default http://lens-adapter:8091
  JOBS_DB            default /data/jobs.db      JOBS_DIR   default /data/results
  JOBS_TTL_HOURS     default 72                 JOBS_MAX_ATTEMPTS   default 3
  JOBS_PAGE_TIMEOUT  default 600                JOBS_MAX_UPLOAD_MB  default 200
  JOBS_MAX_SPLITS    default 2                  JOBS_MAX_ACTIVE     default 50
  JOBS_MAX_RESUMES   default 3
  JOBS_MAX_INFLIGHT_CLOUD default 8   JOBS_MAX_INFLIGHT_VLLM default 6
  JOBS_MAX_INFLIGHT_LENS  default 3
  JOBS_MAX_INFLIGHT  global backstop across all engines; unset = the sum of the
                     per-engine limits above
  JOBS_METRICS_SAMPLES default 2000   JOBS_METRICS_CACHE   default 2
"""

from __future__ import annotations

import asyncio
import csv
import hmac
import io
import json
import logging
import math
import mimetypes
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import ExitStack, asynccontextmanager, nullcontext, suppress
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import FastAPI, File, Header, Query, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
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

# In-flight engine requests, PER ENGINE, across all jobs. Per-job concurrency
# alone doesn't protect the GPU: 10 jobs x 8 pages = 80 parallel requests to one
# engine.
#
# This used to be one shared counter for all three engines, which was wrong in
# both directions. A cloud batch and a vLLM batch competed for the same slots, so
# a 6000-page Modal job could hold every slot and leave the local GPU idle (and
# vice versa) even though the two engines share no resource whatsoever. And the
# single number could not be right for all three at once: it oversubscribed the
# GPU, which runs vLLM with --max-num-seqs 6 and simply queues anything past
# that, while under-driving Modal, which is elastic.
#
# The defaults come from what each engine actually is:
#   cloud 8  — Modal autoscales; 8 is a courtesy ceiling on our own fan-out, not
#              a limit of the engine. p90 27.7s means going wider mostly buys
#              more cold starts.
#   vllm  6  — EXACTLY --max-num-seqs. Past this the requests are not parallel,
#              they are queued inside vLLM where this service cannot see them,
#              which inflates every measured latency and starves nothing usefully.
#   lens  3  — an unofficial Google endpoint. Being gentle with it is the whole
#              policy.
ENGINE_INFLIGHT_DEFAULTS = {"cloud": 8, "vllm": 6, "lens": 3}
MAX_INFLIGHT_PER_ENGINE = {
    name: max(1, int(os.environ.get(f"JOBS_MAX_INFLIGHT_{name.upper()}", str(default))))
    for name, default in ENGINE_INFLIGHT_DEFAULTS.items()
}

# Global backstop across ALL engines, so the process still has one number
# bounding total fan-out (sockets, and the RAM of every in-flight payload).
#
# Left UNSET it is the sum of the per-engine limits, which makes the per-engine
# caps the operative ones — the point of splitting them. Set explicitly it is a
# hard ceiling below them, which is what an existing deployment that only knows
# about JOBS_MAX_INFLIGHT must keep getting: silently promoting its 8 to 17
# because the variable names changed would be a capacity change nobody asked for.
_GLOBAL_INFLIGHT_ENV = os.environ.get("JOBS_MAX_INFLIGHT", "").strip()
MAX_INFLIGHT = (
    max(1, int(_GLOBAL_INFLIGHT_ENV)) if _GLOBAL_INFLIGHT_ENV else sum(MAX_INFLIGHT_PER_ENGINE.values())
)

# Concurrent _split_units calls, process-wide. pypdf holds the whole source PDF
# in memory (~2.5x the file size), and the split is the one phase no other
# semaphore covers: every accepted job starts one immediately, so 120 queued
# 20 MB PDFs used to be 120 simultaneous parses (~6 GB) with nothing in the way.
# Deliberately small and separate from MAX_INFLIGHT — a split blocking an engine
# slot would idle the GPU for no reason.
MAX_SPLITS = max(1, int(os.environ.get("JOBS_MAX_SPLITS", "2")))

# Ceiling on queued+running jobs before POST /jobs sheds load with a 429. The
# queue was previously unbounded, so a client in a resubmit loop could pile up
# disk, SQLite rows and background tasks without limit; the engines are the
# bottleneck anyway, so a 429 at the door is more honest than a queue depth of
# 4000 that reports "queued" for a day.
MAX_ACTIVE = max(1, int(os.environ.get("JOBS_MAX_ACTIVE", "50")))
# Advertised in Retry-After. Not tuned to anything — a batch job takes minutes,
# so any small number is a polite "come back shortly", not a promise.
BACKPRESSURE_RETRY_AFTER = max(1, int(os.environ.get("JOBS_BACKPRESSURE_RETRY_AFTER", "30")))

# How many times one job may be resumed across process restarts before it is
# failed for real. This is the poison-pill bound: a job whose content OOMs or
# crashes the process would otherwise resume forever under
# `restart: unless-stopped`, burning the same GPU time on every loop.
MAX_RESUMES = max(0, int(os.environ.get("JOBS_MAX_RESUMES", "3")))

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
# The same set as a SQL literal, built once so the reaper's IN (...) can never
# drift out of step with TERMINAL above.
_TERMINAL_SQL = "(" + ", ".join(f"'{s}'" for s in sorted(TERMINAL)) + ")"

# Live background jobs, so DELETE can actually stop the work instead of only
# hiding it. Populated on submit, popped when the task settles.
_TASKS: dict[str, asyncio.Task[None]] = {}
_INFLIGHT = asyncio.Semaphore(MAX_INFLIGHT)
_INFLIGHT_ENGINE = {name: asyncio.Semaphore(n) for name, n in MAX_INFLIGHT_PER_ENGINE.items()}
_SPLITS = asyncio.Semaphore(MAX_SPLITS)


# --------------------------------------------------------------------------- #
# Metrics
#
# There was no way to answer "how deep is the queue", "which engine is failing"
# or "what does a page cost right now" without reading the container log, which
# is not an answer a dashboard can poll.
#
# The counters are mutated only from the event loop (the engine call sites) and
# read only by GET /metrics on the same loop, so no lock is needed — the moment
# any of them move to a worker thread that stops being true. The one exception is
# _JOB_COUNTS_CACHE, which IS written from a worker thread; a lost update there
# costs one redundant query and nothing else.
# --------------------------------------------------------------------------- #
# Latency samples kept per engine. Bounded on purpose: this service is expected
# to run for days across tens of thousands of pages, and an unbounded list of
# floats is a slow leak that only shows up in the workload it was added for.
LATENCY_SAMPLES = max(100, int(os.environ.get("JOBS_METRICS_SAMPLES", "2000")))
# How long the SQLite job-count aggregate may be reused. /metrics is designed to
# be polled every few seconds by several dashboards at once; without this, each
# poll walks 72h of rows via the jobs_status index for numbers that cannot have
# changed meaningfully in between.
METRICS_CACHE_S = float(os.environ.get("JOBS_METRICS_CACHE", "2"))


class _EngineStats:
    """Process-lifetime counters for one engine.

    `requests` counts ATTEMPTS, not pages: a page that takes three tries is three
    requests, which is what "how much am I actually asking of this engine" means.
    `retries` is the number of attempts that were replays of a previous one, so
    requests - retries is the number of pages attempted.
    """

    __slots__ = ("requests", "failures", "retries", "in_flight", "latency")

    def __init__(self) -> None:
        self.requests = 0
        self.failures = 0
        self.retries = 0
        self.in_flight = 0
        self.latency: deque[float] = deque(maxlen=LATENCY_SAMPLES)


_ENGINE_STATS: dict[str, _EngineStats] = {name: _EngineStats() for name in ENGINES}
# Pages, not attempts: what a caller sees in `progress`. Process-lifetime, so a
# restart zeroes them while the per-job counters in SQLite do not — /metrics says
# so in its own payload rather than leaving an operator to discover it.
_PAGE_STATS = {"done": 0, "failed": 0}
_STARTED_AT = time.time()
_JOB_COUNTS_CACHE: tuple[float, dict[str, int]] = (0.0, {})


def _percentile(sorted_values: list[float], q: float) -> float:
    """Nearest-rank percentile. A few thousand samples do not justify
    interpolating, and nearest-rank never invents a latency nothing measured."""
    if not sorted_values:
        return 0.0
    rank = max(1, min(len(sorted_values), int(math.ceil(q * len(sorted_values)))))
    return sorted_values[rank - 1]


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
    error       TEXT,
    -- How many times this job has been picked back up after a process death.
    -- Lives in the row, not in memory, because the whole point is that it
    -- survives the restart it is counting.
    resumes     INTEGER NOT NULL DEFAULT 0
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
    # CREATE TABLE IF NOT EXISTS is a no-op against the live /data volume, which
    # already holds a jobs table without `resumes`. Without this the first resume
    # sweep dies on "no such column" and every in-flight job hangs at `running`
    # forever — the failure mode the whole feature exists to remove.
    try:
        conn.execute("ALTER TABLE jobs ADD COLUMN resumes INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError:
        pass  # already there
    try:
        # `done` as of the last restart. _recover_interrupted compares against it
        # to tell a job that is stuck from one that is merely long-running, so
        # ordinary restarts stop counting against the resume bound.
        conn.execute("ALTER TABLE jobs ADD COLUMN resume_mark INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError:
        pass  # already there
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


def _recover_interrupted() -> tuple[list[sqlite3.Row], int]:
    """Pick up jobs whose worker died with the process. Returns (to_resume, gave_up).

    This used to fail every queued/running row outright, which discarded every
    page that had already been OCR'd — the expensive part. The rows are re-queued
    instead; _run_job then skips the pages whose part files are already on disk.

    The resume counter is bumped HERE, before any work restarts, so a job that
    kills the process is charged for the attempt even if it dies again
    immediately. Charging it on success instead is what would let a poison pill
    loop forever: it never reaches success.

    But it is charged ONLY to jobs that made no progress since their last
    resume. Bumping every in-flight row on every start conflated "this input
    kills the service" with "the service restarted for unrelated reasons" — and
    on this host the latter is routine, because ops/keepalive.ps1 force-recreates
    the container whenever it judges the backend unhealthy. A healthy multi-hour
    batch was therefore failed by four ordinary restarts, blaming its own input,
    stranding every page it had already finished. A job that is genuinely
    poisonous never advances `done`, so it still hits the bound and still stops.
    """
    now = time.time()
    _exec(
        "UPDATE jobs SET resumes = resumes + 1 WHERE status IN ('queued','running') "
        "AND done <= resume_mark"
    )
    # Snapshot progress so the NEXT restart can tell whether this attempt got
    # anywhere. Reset the counter for jobs that did advance: they are making
    # progress across restarts, which is the behaviour we want to encourage.
    _exec(
        "UPDATE jobs SET resumes = 0 WHERE status IN ('queued','running') AND done > resume_mark"
    )
    _exec("UPDATE jobs SET resume_mark = done WHERE status IN ('queued','running')")
    gave_up = _exec(
        "UPDATE jobs SET status='failed', finished_at=?, error=? "
        "WHERE status IN ('queued','running') AND resumes > ?",
        (
            now,
            f"The job service restarted {MAX_RESUMES + 1} times while this job was in flight "
            f"(JOBS_MAX_RESUMES={MAX_RESUMES}). It is not being retried again — the input may be "
            "what is killing the service. Resubmit it, or split it into smaller batches.",
            MAX_RESUMES,
        ),
    )
    # Back to 'queued' so _run_job's `AND status='queued'` claim works unchanged,
    # and so a DELETE landing before the worker's first tick still wins the race.
    rows = _query_all("SELECT * FROM jobs WHERE status IN ('queued','running')")
    _exec("UPDATE jobs SET status='queued', finished_at=NULL, error=NULL WHERE status IN ('queued','running')")
    return list(rows), gave_up


def _adopt_finished_result(job_id: str) -> tuple[str, str | None] | None:
    """Return the terminal (status, error) for a job whose result is already on
    disk, or None if there is nothing to adopt.

    Only a COMPLETE result counts. A merge killed halfway leaves a truncated
    file, and adopting that would ship a silently short document — worse than
    redoing the work — so the file must parse and its page/entry count must match
    what the row says. `total` is 0 only before the split finishes, and a job that
    never got that far has no result to adopt either way.
    """
    path = _result_path(job_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return None  # truncated by the same kill — redo it properly

    row = _query_one("SELECT total, failed FROM jobs WHERE job_id=?", (job_id,))
    expected = int(row["total"]) if row and row["total"] else 0
    if not expected:
        return None

    if isinstance(doc, list):
        count = len(doc)
        failures = sum(1 for e in doc if isinstance(e, dict) and e.get("error"))
    elif isinstance(doc, dict):
        pages = doc.get("pages") or []
        count = len(pages)
        failures = len(doc.get("failures") or [])
    else:
        return None
    if count != expected:
        return None

    log.info("job %s: adopting the result already on disk (%d entries)", job_id, count)
    if failures >= expected:
        return "failed", f"All {expected} pages failed; see `failures` in the result."
    if failures:
        return "partial", f"{failures} of {expected} pages failed; see `failures` in the result."
    return "succeeded", None


def _restore_sources(job_id: str, filenames: list[str]) -> list[dict[str, str]]:
    """Rebuild the `sources` list a resumed job needs from `<job>/input/`.

    create_job writes each upload as `NNNN_<safe name>`, so a lexical sort
    restores submission order — which matters more than it looks: the unit index
    a part file is keyed by is just a running counter over the sources in that
    order, so getting it wrong would silently pair page 4's OCR with page 40.
    The display name comes from the recorded `filenames` (the on-disk name is
    sanitised and prefixed), falling back to the file itself if the row and the
    directory ever disagree.
    """
    in_dir = os.path.join(_job_dir(job_id), "input")
    try:
        entries = sorted(e for e in os.listdir(in_dir) if os.path.isfile(os.path.join(in_dir, e)))
    except OSError:
        return []
    sources: list[dict[str, str]] = []
    for i, entry in enumerate(entries):
        name = filenames[i] if i < len(filenames) else entry.split("_", 1)[-1]
        sources.append({"path": os.path.join(in_dir, entry), "name": name})
    return sources


def _completed_parts(job_id: str, total: int) -> set[int]:
    """Indices whose spilled payload is present AND parses.

    Parsing rather than stat()ing is the point: a page that was mid-spill when
    the process was killed must count as NOT done, or the merge emits a failure
    placeholder for a page nobody will ever retry. _write_part renames a temp
    file into place so a torn part should be impossible, but "should be" is not
    a guarantee across a Docker volume after SIGKILL, and re-OCRing one page is
    far cheaper than shipping a hole in the document.

    Reads one part at a time and drops it: the parts are the same crop_base64
    blobs the spill exists to keep out of RAM, and a 6000-page job would
    otherwise be several GB before the first page is even re-sent.
    """
    done: set[int] = set()
    for index in range(total):
        if _read_part(job_id, index) is not None:
            done.add(index)
    return done


def _active_count() -> int:
    """Queued + running jobs — the number MAX_ACTIVE caps. Indexed by
    jobs_status, so this stays a cheap probe even with 72h of rows behind it."""
    row = _query_one("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')")
    return int(row["n"]) if row else 0


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
    return datetime.fromtimestamp(float(ts), tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _error(
    code: str, message: str, status: int, headers: dict[str, str] | None = None, **extra: Any
) -> JSONResponse:
    """The API-wide error envelope (same shape nginx emits for 429/413/502/504),
    so a pipeline can branch on a stable `code` instead of matching prose.

    `headers` exists for Retry-After: a 429 that only carries the delay in the
    JSON body forces every generic HTTP client (and every retrying proxy in
    front of us) to parse it, when the header is the thing they already honour.
    """
    err: dict[str, Any] = {"code": code, "message": message}
    err.update(extra)
    return JSONResponse({"error": err, "detail": message}, status_code=status, headers=headers)


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


def _record(stats: _EngineStats | None, started: float, ok: bool) -> None:
    """Close out one engine attempt: its latency and, if it failed, the count.

    A non-2xx IS a failure here even when the page later succeeds on a retry —
    "which engine is failing" is a question about the engine, and hiding the
    first two 503s of a page that eventually worked is exactly how a warming or
    flapping engine stays invisible until it stops recovering.
    """
    if stats is None:  # an engine name outside ENGINES cannot reach here today
        return
    stats.latency.append((time.monotonic() - started) * 1000.0)
    if not ok:
        stats.failures += 1


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
        fh = open(unit["path"], "rb")  # noqa: SIM115
    except OSError as exc:
        # No engine was contacted, so this deliberately records no metrics: it is
        # a local fault and counting it against the engine's failure rate would
        # send an operator looking at a healthy GPU.
        return None, {"code": "bad_request", "message": f"page file is unreadable: {exc}", "status": None}, False, None

    # Timed and counted around the POST only. The retry sleep, the spill and the
    # semaphore waits are all excluded, so `latency_ms` is what the engine costs
    # rather than what this service's queueing does to it — the two need to stay
    # separable or "the GPU is slow" and "we are over-subscribed" look identical.
    stats = _ENGINE_STATS.get(engine)
    started = time.monotonic()
    if stats is not None:
        stats.requests += 1
        stats.in_flight += 1
    try:
        response = await client.post(
            url,
            params=params,
            files={field: (unit["name"], fh, unit["content_type"])},
            headers=_engine_headers(engine),
        )
    except httpx.TimeoutException as exc:
        _record(stats, started, ok=False)
        return None, {"code": "engine_timeout", "message": f"engine timed out: {exc}", "status": None}, True, None
    except httpx.RequestError as exc:
        _record(stats, started, ok=False)
        return None, {"code": "engine_unreachable", "message": f"could not reach {url}: {exc}", "status": None}, True, None
    finally:
        fh.close()
        if stats is not None:
            stats.in_flight -= 1
    _record(stats, started, ok=response.status_code < 300)

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

    The backoff sleep happens with ALL THREE semaphores released. Sleeping while
    holding them starves the whole service: with the shipped defaults, eight
    pages waiting out a `Retry-After: 120` occupy every process-wide in-flight
    slot for ~4 minutes, during which every other job makes zero engine calls
    while the GPU sits idle. Modal answering 429 under load is precisely the
    condition this batch service exists to survive.

    The spill happens INSIDE the slots, which is what bounds this service's
    memory. Released first, the payload — a megabyte of crop_base64 — would sit
    in RAM in a queue behind the disk while the freed slot starts the next page:
    measured on 600 pages of ~1 MB crops, spilling outside the slots peaked at
    +389 MB RSS, inside them at +42 MB. Writing under the slot is backpressure,
    not waste.
    """
    failure: dict[str, Any] = {"code": "engine_unreachable", "message": "no attempt was made", "status": None}
    engine_sem = _INFLIGHT_ENGINE.get(engine)
    stats = _ENGINE_STATS.get(engine)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if attempt > 1 and stats is not None:
            stats.retries += 1
        # ENGINE cap first, then the global backstop, then the per-job cap.
        # Order matters and the obvious one is wrong: taking the global slot first
        # means a task that then blocks on its narrow engine cap sits on a global
        # slot while waiting. One 60-page vLLM job spawns a task per pending page,
        # those tasks take every global slot, and a cloud job — which shares no
        # hardware with vLLM — is stuck behind a queue for an engine it is not
        # even using. Measured 12.15s of blocking, scaling with the vLLM job's
        # pending-task count rather than with vLLM actually being busy; the vLLM
        # cap was never even reached. Acquiring the engine slot first means a task
        # only ever waits while holding capacity belonging to its OWN engine.
        # The order is still fixed for every caller, which is what keeps the
        # nesting deadlock-free.
        async with engine_sem if engine_sem is not None else nullcontext(), _INFLIGHT, sem:
            payload, failure, retryable, retry_after = await _attempt_once(
                client, engine, mode, params, unit
            )
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
        with open(os.path.join(_parts_dir(job_id), f"{index:06d}.json"), encoding="utf-8") as fh:
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
    with open(path, encoding="utf-8", newline="") as fh:
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
    with open(path, encoding="utf-8", newline="\n") as fh:
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
# Reading a result back: streaming, and flat
#
# The merged document is DocumentResult -> pages[] -> regions[] -> lines[].
# Every consumer of it writes the same three nested loops before it can do
# anything, so `format=jsonl` and `format=csv` do that loop here, once.
#
# All of it STREAMS. json.load on the merged file would undo the entire point of
# the streaming merge: the same 6000-page result the merge never held would be
# held here instead, for the convenience of a caller who asked for the flat
# version precisely because they cannot fit the nested one.
# --------------------------------------------------------------------------- #
FLAT_COLUMNS = (
    "job_id", "file", "page", "region_index", "region_type",
    "text", "confidence", "x0", "y0", "x1", "y1",
)

# Structural JSON bytes. Scanning for these with a compiled regex rather than a
# Python byte loop is what makes this usable on a gigabyte: the interesting
# characters are rare and the gaps between them are huge (one `crop_base64`
# value is a megabyte of base64 with no structure in it at all), so the scan
# runs in C and Python only sees the boundaries. A per-byte loop measured two
# orders of magnitude slower.
_JSON_STRUCT_RE = re.compile(rb'["\\{}\[\]]')


def _iter_array_items(path: str, key: str | None, chunk_size: int = 1 << 20) -> Iterator[bytes]:
    """Yield the raw bytes of each element of one JSON array inside `path`.

    `key` selects an array-valued member of the top-level object (`"pages"`);
    None means the file itself is the array. Only ONE element is ever in memory,
    which for this file means one page — the same bound the merge writes under.

    Elements must be objects, arrays or strings (never bare numbers): everything
    this service writes is one of those, and recognising a scalar element needs a
    real tokeniser for no gain.

    Byte-level rather than character-level on purpose. UTF-8 continuation bytes
    are all >= 0x80, so no multi-byte character can contain an ASCII `{`, `"` or
    `\\` — the scan cannot be fooled by Khmer text, and there are no partial
    code points to stitch across chunk boundaries.
    """
    with open(path, "rb") as fh:
        # _seek_array reads from the same handle and hands back whatever it had
        # already buffered past the opening `[`. Returned, not stashed on the
        # function: Starlette iterates a sync StreamingResponse body in a
        # threadpool, so two callers really do run this concurrently.
        buf = _seek_array(fh, key, chunk_size)
        if buf is None:
            return
        pos = 0

        depth = 0
        in_str = False
        esc_pending = False  # the escaped byte fell in the next chunk
        item: bytearray | None = None

        while True:
            if pos >= len(buf):
                buf = fh.read(chunk_size)
                pos = 0
                if not buf:
                    return  # truncated file: stop rather than yield half an element
                if esc_pending:
                    if item is not None:
                        item += buf[0:1]
                    pos = 1
                    esc_pending = False
                    continue

            match = _JSON_STRUCT_RE.search(buf, pos)
            if match is None:
                if item is not None:
                    item += buf[pos:]
                pos = len(buf)
                continue

            i = match.start()
            if item is not None:
                item += buf[pos:i]
            pos = i + 1
            char = buf[i : i + 1]

            if in_str:
                if item is not None:
                    item += char
                if char == b"\\":
                    if pos < len(buf):
                        if item is not None:
                            item += buf[pos : pos + 1]
                        pos += 1
                    else:
                        esc_pending = True
                elif char == b'"':
                    in_str = False
                    if depth == 0 and item is not None:
                        yield bytes(item)
                        item = None
            elif char == b'"':
                in_str = True
                if depth == 0 and item is None:
                    item = bytearray()
                item += char
            elif char in b"{[":
                if depth == 0 and item is None:
                    item = bytearray()
                item += char
                depth += 1
            elif char in b"}]":
                if depth == 0:
                    return  # the array's own closing bracket
                item += char  # type: ignore[operator] — depth>0 implies item is set
                depth -= 1
                if depth == 0 and item is not None:
                    yield bytes(item)
                    item = None
            # anything else between elements (commas, whitespace) is dropped


def _seek_array(fh: Any, key: str | None, chunk_size: int) -> bytes | None:
    """Read up to the `[` that opens the wanted array; return the bytes after it.

    None means the array is not there. An EMPTY bytes result is not the same
    thing — it means the `[` happened to land on a chunk boundary — so callers
    must test `is None`.

    Deliberately a plain byte loop: it only ever runs over the handful of scalar
    members the merge writes before `"pages"`, so the regex fast path above buys
    nothing here and the string/depth bookkeeping is easier to read straight.

    A key is recognised as a string that COMPLETES at depth 1 and is followed by
    a colon, which is what stops OCR text containing the literal `"pages":` from
    being mistaken for the member — that text is a value, and a value is never
    followed by a colon.
    """
    want = key.encode("utf-8") if key is not None else None
    depth = 0
    in_str = False
    esc = False
    token = bytearray()
    pending_key: bytes | None = None
    awaiting_colon = False
    buf = b""
    pos = 0
    while True:
        if pos >= len(buf):
            buf = fh.read(chunk_size)
            pos = 0
            if not buf:
                return None
        char = buf[pos : pos + 1]
        pos += 1
        if in_str:
            if esc:
                esc = False
            elif char == b"\\":
                esc = True
            elif char == b'"':
                in_str = False
                if depth == 1 and want is not None:
                    pending_key = bytes(token)
                    awaiting_colon = True
            else:
                token += char
            continue
        if char in b" \t\r\n":
            continue
        if awaiting_colon:
            awaiting_colon = False
            if char != b":":
                pending_key = None
        if char == b'"':
            in_str = True
            token = bytearray()
        elif char == b"[":
            if (want is None and depth == 0) or (want is not None and depth == 1 and pending_key == want):
                return buf[pos:]
            depth += 1
            pending_key = None
        elif char == b"{":
            depth += 1
            pending_key = None
        elif char in b"]}":
            depth -= 1
            if depth < 0:
                return None
            pending_key = None
        elif char == b",":
            pending_key = None


def _bbox_extent(bbox: Any) -> tuple[float | None, float | None, float | None, float | None]:
    """(x0, y0, x1, y1) from a BoundingBox's four corner points.

    The contract is 4 arbitrary corners, not an axis-aligned rectangle — a
    rotated scan really does come back rotated — so this is the bounding box OF
    the polygon. Anything unparseable becomes None rather than 0: a real region
    can legitimately sit at x=0, and a pipeline filtering on coordinates must be
    able to tell "at the edge" from "we don't know"."""
    points = bbox.get("points") if isinstance(bbox, dict) else None
    xs: list[float] = []
    ys: list[float] = []
    for point in points or []:
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            try:
                xs.append(float(point[0]))
                ys.append(float(point[1]))
            except (TypeError, ValueError):
                continue
    if not xs:
        return None, None, None, None
    return min(xs), min(ys), max(xs), max(ys)


def _flat_rows(job_id: str, item: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """One row per region for a merged page (or per entry, for the list modes).

    A page with NO regions still emits exactly one row — a failure placeholder,
    a blank page, or an ocr-image/parse-table entry that has no region structure
    at all. Emitting nothing would make a failed page indistinguishable from a
    page that was never in the document, and "which pages am I missing" is the
    first question anyone asks of a 6000-page batch. `region_type` carries
    `error` or `empty` there so the row is filterable instead of merely present.
    """
    file_name = item.get("source_file") or item.get("filename") or ""
    page_number = item.get("page_number")
    regions = item.get("regions")

    if isinstance(regions, list) and regions:
        for index, region in enumerate(regions):
            if not isinstance(region, dict):
                continue
            x0, y0, x1, y1 = _bbox_extent(region.get("bbox"))
            yield {
                "job_id": job_id,
                "file": file_name,
                "page": page_number,
                "region_index": index,
                "region_type": region.get("region_type") or "",
                "text": region.get("text") or "",
                "confidence": region.get("confidence"),
                "x0": x0, "y0": y0, "x1": x1, "y1": y1,
            }
        return

    error = item.get("error")
    # ocr-image returns {text, confidence}; parse-table returns
    # {structured_text, cells}. Neither has regions, so the entry IS the row.
    text = item.get("text") or item.get("structured_text") or ""
    region_type = ("error" if error else "empty") if "regions" in item else ("error" if error else "page")
    yield {
        "job_id": job_id,
        "file": file_name,
        "page": page_number,
        "region_index": 0,
        "region_type": region_type,
        "text": str(error) if error else text,
        "confidence": item.get("confidence"),
        "x0": None, "y0": None, "x1": None, "y1": None,
    }


def _iter_result_items(path: str) -> Iterator[dict[str, Any]]:
    """Stream the merged result's pages (DOC_MODES) or entries (the list modes).

    The first non-whitespace byte decides which: `_merge_document` writes an
    object with a `pages` member, `_merge_list` writes a bare array.
    """
    try:
        with open(path, "rb") as fh:
            head = fh.read(64).lstrip()
    except OSError:
        return
    key = None if head.startswith(b"[") else "pages"
    for raw in _iter_array_items(path, key):
        try:
            item = json.loads(raw)
        except ValueError:  # a page we cannot parse must not abort the other 5999
            log.warning("result %s: skipping an unparseable element (%d bytes)", path, len(raw))
            continue
        if isinstance(item, dict):
            yield item


def _iter_partial_items(job_id: str) -> Iterator[dict[str, Any]]:
    """Stream the pages that have finished so far for a job still running.

    Reads `<job>/parts/NNNNNN.json` — the same spill files the merge will later
    consume — one at a time, in index order. Anything that does not parse is
    SKIPPED rather than reported: a part being renamed into place right now is
    the normal case here, not corruption, and it will be there on the next poll.

    Page numbers are UNIT indices (part 000004 -> page 5). For the ordinary
    split-per-page job that is exactly the number the merged result will carry;
    for a PDF pypdf could not split (one unit, many pages) the merged document
    will renumber past it. The job is unfinished — its numbering is not final
    either way, and saying so is better than pretending.

    If the parts directory has already been swept (the job finished between the
    status read and here), fall back to the merged result rather than reporting
    an empty document.
    """
    parts = _parts_dir(job_id)
    try:
        names = sorted(n for n in os.listdir(parts) if n.endswith(".json") and not n.endswith(".tmp.json"))
    except OSError:
        result = _result_path(job_id)
        if os.path.exists(result):
            yield from _iter_result_items(result)
        return

    for name in names:
        try:
            index = int(name[:-5])
        except ValueError:
            continue
        payload = _read_part(job_id, index)
        if not isinstance(payload, dict):
            continue
        pages = payload.get("pages")
        if isinstance(pages, list) and pages:
            for offset, page in enumerate(pages):
                if not isinstance(page, dict):
                    continue
                page["page_number"] = index + 1 + offset
                page.setdefault("source_file", payload.get("filename") or "")
                yield page
        else:
            payload.setdefault("page_number", index + 1)
            payload.setdefault("source_file", payload.get("filename") or "")
            yield payload


def _stream_jsonl(job_id: str, items: Iterator[dict[str, Any]]) -> Iterator[bytes]:
    """One JSON object per line, one line per region.

    Loads straight into `pandas.read_json(..., lines=True)` or DuckDB's
    read_json_auto. `ensure_ascii=False` for the same reason the rest of this
    service uses it: escaping Khmer to \\uXXXX triples the bytes for no benefit.
    """
    for item in items:
        for row in _flat_rows(job_id, item):
            yield (json.dumps(row, ensure_ascii=False) + "\n").encode("utf-8")


def _stream_csv(job_id: str, items: Iterator[dict[str, Any]]) -> Iterator[bytes]:
    """The same rows as CSV, with a UTF-8 BOM.

    The BOM is not decoration. Excel ignores the charset on a double-clicked
    .csv and guesses the local codepage, which mojibakes Khmer — the SPA learned
    this the hard way and prefixes the same BOM (see CSV_BOM in
    documentExport.ts). Every sane reader (pandas, DuckDB, csv) strips it.

    csv.writer is doing real work here: OCR text contains commas, quotes and
    newlines constantly, and RFC 4180 quoting of a multi-line cell is not
    something to hand-roll a second time.
    """
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")

    def drain() -> bytes:
        value = buf.getvalue()
        buf.seek(0)
        buf.truncate(0)
        return value.encode("utf-8")

    yield b"\xef\xbb\xbf"
    writer.writerow(FLAT_COLUMNS)
    yield drain()
    for item in items:
        for row in _flat_rows(job_id, item):
            writer.writerow(["" if row[c] is None else row[c] for c in FLAT_COLUMNS])
            yield drain()


def _stream_partial_json(job_id: str, status: str, row: sqlite3.Row) -> Iterator[bytes]:
    """The finished pages as a JSON document, assembled on the wire.

    `full_text` is null, not "": assembling it means a second pass over every
    part file, and a caller who asked for a job that is still running has to
    branch on `partial` anyway. `complete: false` is there so a payload that gets
    written to a file and read back later cannot be mistaken for a final result.
    """
    yield ('{"job_id": ' + json.dumps(job_id)).encode("utf-8")
    yield (', "status": ' + json.dumps(status) + ', "partial": true, "complete": false').encode("utf-8")
    yield (
        ', "engine": ' + json.dumps(str(row["engine"]))
        + ', "mode": ' + json.dumps(str(row["mode"]))
    ).encode("utf-8")
    yield b', "pages": ['
    count = 0
    for item in _iter_partial_items(job_id):
        yield (b", " if count else b"") + json.dumps(item, ensure_ascii=False).encode("utf-8")
        count += 1
    yield (f'], "num_pages": {count}, "full_text": null'
           ', "note": "Pages that had finished when this was requested. Poll the job and '
           'refetch without partial=true for the merged result."}').encode()


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

        # A job whose result.json already exists finished its work; only the
        # terminal status write was lost. _run_job ends
        # merge -> rmtree(parts) -> _finish, so a kill inside that window leaves
        # a COMPLETE result next to a row still reading 'running'. Resuming from
        # `parts/` there is doubly wrong: the parts were just deleted, so every
        # page gets re-OCR'd, AND the re-merge overwrites the good result — with
        # failure placeholders if the engine happens to be cold on restart, which
        # is exactly what a host reboot looks like. The OCR output would be
        # unrecoverable. Adopt the finished result instead of redoing the job.
        adopted = await asyncio.to_thread(_adopt_finished_result, job_id)
        if adopted is not None:
            status, error = adopted
            await _finish(job_id, status, error=error)
            return

        # The ONLY gate on pypdf's ~2.5x-file-size peak. Held here, in the
        # background task, so submission stays instant: an over-cap job waits in
        # this queue, not in the caller's POST.
        async with _SPLITS:
            units = await asyncio.to_thread(_split_units, job_id, sources)
        if not units:
            await _finish(job_id, "failed", error="The upload contained no readable pages.")
            return
        await asyncio.to_thread(_exec, "UPDATE jobs SET total=? WHERE job_id=?", (len(units), job_id))

        # Pages already OCR'd before a crash. On a first run this is empty (the
        # parts directory does not exist yet); on a resume it is the whole point.
        finished = await asyncio.to_thread(_completed_parts, job_id, len(units))
        pending = [i for i in range(len(units)) if i not in finished]

        failures: list[dict[str, Any] | None] = [None] * len(units)
        sem = asyncio.Semaphore(concurrency)
        # Seeded from DISK, not from the row's pre-crash `done`. The old counter
        # counted pages this process never saw finish and did not count a page
        # whose spill landed after the last progress write, so a resumed job
        # reported a number that matched neither the work left nor the result.
        done = len(finished)
        failed = 0
        progress_lock = asyncio.Lock()
        if finished:
            log.info("job %s: resuming with %d/%d page(s) already done", job_id, done, len(units))
            await asyncio.to_thread(
                _exec, "UPDATE jobs SET done=?, failed=0 WHERE job_id=?", (done, job_id)
            )

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
                    _PAGE_STATS["done"] += 1
                    if failure is not None:
                        failed += 1
                        _PAGE_STATS["failed"] += 1
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

            # Only `pending`. A page with a readable part file is never handed to
            # an engine again — not re-validated, not re-sent — because not
            # re-spending GPU time on finished work is the entire reason resume
            # exists.
            # return_exceptions: a page's local fault belongs in `failures`, not
            # in an abort that kills its siblings mid-request and tears the httpx
            # client down under them.
            outcomes = await asyncio.gather(*(run_one(i) for i in pending), return_exceptions=True)

        aborted = 0
        for index, outcome in zip(pending, outcomes, strict=True):
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
    # The delete list is snapshotted BEFORE anything below is failed, so a job
    # this sweep stops is only removed by the NEXT sweep. Two reasons, and the
    # first is the important one:
    #   * `<job>/input/` is the source a resume re-splits from. Deleting it under
    #     a job that is not terminal turns a survivable restart into a batch that
    #     can never be picked up again — the reaper itself would be what loses
    #     the work. Restricting the delete to TERMINAL rows is the invariant
    #     resume depends on: an unfinished job always still has its upload.
    #   * the cancel below is awaited with a timeout, and the merge runs in an
    #     uncancellable worker thread. Deleting the directory in the same breath
    #     as a cancel that may have timed out is the exact race the comments in
    #     DELETE warn about; a full sweep interval of slack removes it.
    rows = await asyncio.to_thread(
        _query_all,
        "SELECT job_id FROM jobs WHERE created_at < ? AND status IN " + _TERMINAL_SQL,
        (cutoff,),
    )

    # A job still queued/running past the TTL is stuck, not slow. Stop it and
    # give it a terminal status; the sweep after this one collects it.
    stale = await asyncio.to_thread(
        _query_all,
        "SELECT job_id FROM jobs WHERE created_at < ? AND status IN ('queued','running')",
        (cutoff,),
    )
    for row in stale:
        job_id = str(row["job_id"])
        task = _TASKS.pop(job_id, None)
        if task is not None:
            task.cancel()
            await asyncio.wait({task}, timeout=5)
        await asyncio.to_thread(
            _exec,
            "UPDATE jobs SET status='failed', finished_at=?, error=?, idem_key=NULL "
            "WHERE job_id=? AND status IN ('queued','running')",
            (
                time.time(),
                f"The job was still unfinished {JOBS_TTL_HOURS:.0f}h after submission and was stopped.",
                job_id,
            ),
        )

    for row in rows:
        job_id = str(row["job_id"])
        # Terminal, but a worker can still be unwinding (the merge thread is
        # uncancellable); stop it before deleting the files out from under it.
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
    if stale:
        log.warning("stopped %d job(s) still unfinished after %.0fh", len(stale), JOBS_TTL_HOURS)
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
def _resume(row: sqlite3.Row) -> bool:
    """Re-arm one interrupted job's worker. False if it cannot be resumed.

    The upload is the only thing resume cannot reconstruct — everything else
    (engine, mode, params, concurrency) is in the row and the finished pages are
    in `<job>/parts/`. If `<job>/input/` is gone the job is dead for good, so say
    so instead of leaving it queued with nothing to run.
    """
    job_id = str(row["job_id"])
    try:
        filenames = json.loads(row["filenames"] or "[]")
        params = json.loads(row["params"] or "{}")
    except ValueError:
        filenames, params = [], {}
    sources = _restore_sources(job_id, list(filenames))
    if not sources:
        _exec(
            "UPDATE jobs SET status='failed', finished_at=?, error=?, idem_key=NULL "
            "WHERE job_id=? AND status='queued'",
            (time.time(), "The uploaded source files are gone, so this job cannot be resumed. Resubmit it.", job_id),
        )
        return False
    _TASKS[job_id] = asyncio.create_task(
        _run_job(job_id, str(row["engine"]), str(row["mode"]), int(row["concurrency"]), params, sources)
    )
    return True


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    _db_init()
    interrupted, gave_up = _recover_interrupted()
    if gave_up:
        log.error("gave up on %d job(s) after %d resume(s); see the job `error`", gave_up, MAX_RESUMES)
    for row in interrupted:
        if _resume(row):
            log.warning("resuming job %s (resume %d/%d)", row["job_id"], row["resumes"], MAX_RESUMES)
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
async def _require_token(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    # /health is exempt: it's non-sensitive, and the Docker healthcheck + the
    # public status probes hit it without the token.
    exempt = request.method == "OPTIONS" or request.url.path.rstrip("/") == "/health"
    if ADAPTER_TOKEN and not exempt and not hmac.compare_digest(request.headers.get("x-adapter-token", ""), ADAPTER_TOKEN):
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


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
        # Additive: a caller watching a long batch can see that a restart was
        # survived (and how close the job is to the MAX_RESUMES give-up point)
        # instead of only seeing the clock stand still.
        "resumes": int(row["resumes"] or 0),
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
            # So an operator (or the watchdog) can see a 429 coming instead of
            # only learning about the cap from a rejected submit.
            "max_active": MAX_ACTIVE,
            "engines": sorted(ENGINES),
        }
    )


def _job_counts() -> dict[str, int]:
    """Queued/running/succeeded/... straight from SQLite, briefly cached.

    GROUP BY status rides the jobs_status index, but /metrics is built to be
    polled by several dashboards at once and 72h of batch rows is a lot of index
    to walk every couple of seconds for numbers that move in minutes.
    """
    global _JOB_COUNTS_CACHE
    cached_at, cached = _JOB_COUNTS_CACHE
    now = time.monotonic()
    if cached and now - cached_at < METRICS_CACHE_S:
        return cached
    counts = _status_counts()
    _JOB_COUNTS_CACHE = (now, counts)
    return counts


@app.get("/metrics")
async def metrics() -> JSONResponse:
    """Everything needed to operate this service, as plain JSON.

    JSON rather than Prometheus text on purpose: nothing in this repo scrapes,
    and the consumers are a human with curl and the status page. A scraper can
    be pointed at this shape trivially; the reverse is not true.

    CHEAP BY CONSTRUCTION — it is meant to be polled. It never touches an engine
    (that is what /v1/status is for), the latency samples live in a bounded ring
    buffer, and the one SQL aggregate it needs is index-backed and cached for
    METRICS_CACHE_S. Nothing here blocks the event loop.
    """
    try:
        counts = await asyncio.to_thread(_job_counts)
    except Exception as exc:  # noqa: BLE001 — the job store is the only real outage
        return _error("engine_unreachable", f"job store unavailable: {exc}", 503)

    engines: dict[str, Any] = {}
    for name, stats in _ENGINE_STATS.items():
        samples = sorted(stats.latency)
        engines[name] = {
            "requests": stats.requests,
            "failures": stats.failures,
            "retries": stats.retries,
            "in_flight": stats.in_flight,
            "max_in_flight": MAX_INFLIGHT_PER_ENGINE.get(name, MAX_INFLIGHT),
            "latency_ms": {
                "p50": round(_percentile(samples, 0.50), 1),
                "p95": round(_percentile(samples, 0.95), 1),
                "max": round(samples[-1], 1) if samples else 0.0,
                "samples": len(samples),
            },
        }

    return JSONResponse(
        {
            "jobs": {
                "queued": counts.get("queued", 0),
                "running": counts.get("running", 0),
                "succeeded": counts.get("succeeded", 0),
                "partial": counts.get("partial", 0),
                "failed": counts.get("failed", 0),
                "cancelled": counts.get("cancelled", 0),
            },
            "pages": {"done": _PAGE_STATS["done"], "failed": _PAGE_STATS["failed"]},
            "engines": engines,
            "limits": {"max_in_flight": MAX_INFLIGHT, "max_active": MAX_ACTIVE, "max_splits": MAX_SPLITS},
            "uptime_s": round(time.time() - _STARTED_AT, 1),
            "since": _iso(_STARTED_AT),
            # Stated in the payload, not only in the docs: an operator diffing two
            # polls across a restart would otherwise read the reset as a fleet of
            # requests disappearing. `jobs` comes from SQLite and does survive.
            "note": (
                "`engines` and `pages` are process-lifetime counters and reset when this service "
                f"restarts (last start {_iso(_STARTED_AT)}); `jobs` comes from SQLite and survives. "
                f"Job counts may be up to {METRICS_CACHE_S:.0f}s stale. `requests` counts engine "
                "attempts, so a page retried twice is 3 requests, 1 of which is not a retry."
            ),
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

    # Backpressure, and deliberately BELOW the replay above. A client that polls
    # by resubmitting its Idempotency-Key is the client most likely to fill this
    # queue, and answering its replays with 429 would lock it out of the status
    # of the very jobs holding the slots — it could neither advance nor observe.
    # A replay creates no new work, so there is nothing to shed.
    active = await asyncio.to_thread(_active_count)
    if active >= MAX_ACTIVE:
        return _error(
            "rate_limited",
            f"{active} jobs are already queued or running (limit {MAX_ACTIVE}). "
            "Wait for some to finish, or poll the jobs you have already submitted.",
            429,
            headers={"Retry-After": str(BACKPRESSURE_RETRY_AFTER)},
            retry_after=BACKPRESSURE_RETRY_AFTER,
        )

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
        "resumes": 0,
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


FORMATS = frozenset({"json", "jsonl", "csv"})
# A partial body is a snapshot of a job that is still moving. `X-Job-Partial`
# lets a client (or a proxy log) tell it apart from a final result it may have
# written to the same file, and no-store keeps a CDN or the funnel from serving
# one poll's snapshot to the next poll.
_PARTIAL_HEADERS = {"X-Job-Partial": "true", "Cache-Control": "no-store"}


@app.get("/jobs/{job_id}/result")
async def get_result(
    job_id: str,
    fmt: str = Query("json", alias="format"),
    partial: bool = Query(False),
):
    """The merged result.

    `format=json` (the default) is byte-for-byte what it always was — the merged
    file, streamed from disk. `format=jsonl` and `format=csv` flatten it to one
    row per region so a pipeline does not have to; both are generated, never
    buffered, so a gigabyte result costs the same memory as a small one.

    `partial=true` serves the pages that have finished for a job that is still
    RUNNING, which otherwise 409s until the last page lands. A two-hour batch
    holding all of its output until the end cannot be used in a pipeline that
    wants to start loading now. It is ignored for a terminal job: the merged
    result is strictly better than the parts it was built from, and the terminal
    behaviour is what existing callers depend on.
    """
    fmt = (fmt or "json").strip().lower()
    if fmt not in FORMATS:
        return _error("bad_request", f"Unknown format {fmt!r}. Use one of: {', '.join(sorted(FORMATS))}.", 400)

    row = await _load(job_id)
    if row is None:
        return _error("job_not_found", f"No job {job_id!r}. It may have been deleted or reaped.", 404)

    status = str(row["status"])
    path = _result_path(job_id)
    if status not in TERMINAL:
        if partial:
            # No 409, and no `total` check: zero finished pages is a truthful
            # answer to "what do you have so far", and a caller polling this on a
            # queued job wants an empty document, not an error to special-case.
            if fmt == "json":
                return StreamingResponse(
                    _stream_partial_json(job_id, status, row),
                    media_type="application/json",
                    headers=_PARTIAL_HEADERS,
                )
            items = _iter_partial_items(job_id)
            if fmt == "jsonl":
                return StreamingResponse(
                    _stream_jsonl(job_id, items), media_type="application/x-ndjson", headers=_PARTIAL_HEADERS
                )
            return StreamingResponse(
                _stream_csv(job_id, items), media_type="text/csv; charset=utf-8", headers=_PARTIAL_HEADERS
            )
        return _error(
            "job_not_finished",
            f"Job is {status} ({row['done']}/{row['total']} pages). Poll the job until it reports a final status, "
            "or pass partial=true for the pages that have finished so far.",
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
    if fmt == "jsonl":
        return StreamingResponse(
            _stream_jsonl(job_id, _iter_result_items(path)), media_type="application/x-ndjson"
        )
    if fmt == "csv":
        return StreamingResponse(
            _stream_csv(job_id, _iter_result_items(path)), media_type="text/csv; charset=utf-8"
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
