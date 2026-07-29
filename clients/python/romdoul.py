"""
Official Python client for the Romdoul OCR API.

One module, stdlib + `requests`. Drop it next to your script or `pip install
requests` and copy it into your package — there is deliberately nothing else to
install, because the people who need this are usually inside a data pipeline
where adding a dependency is a change-request.

What it buys you over hand-rolled `requests` calls:

  * the multipart field names are exact ("file" singular for /ocr-image and
    /parse-table, "files" plural for /parse-pdf*) — the single most common
    integration mistake, and the API answers a wrong name with an opaque 422;
  * retries that respect `Retry-After` on 429 and back off with jitter on
    502/503/504 and connection/read timeouts, and NEVER retry a 4xx you caused;
  * an `Idempotency-Key` per request derived from the request itself, so a retry
    of a call that actually landed is replayed by nginx for free instead of
    re-spending GPU time;
  * `parse_document_pages()` — split a PDF locally, OCR the pages concurrently,
    merge back into one DocumentResult. This is what everybody writes by hand
    and gets subtly wrong (page numbering, partial failures, key reuse);
  * `text_of()` — the `full_text`-can-be-an-empty-string gotcha handled once.

Engines (all speak the identical contract, only the URL prefix differs):
    "cloud" -> /api        Modal cloud GPU. Best Khmer quality, real translation.
    "vllm"  -> /api-vllm   Surya OCR 2 on the home GPU. No translation.
    "lens"  -> /api-lens   Google Lens. Free. Confidence is always a flat 0.0,
                           /parse-table is reconstructed from word geometry
                           (best-effort, no table model), and translation is
                           hardwired to English — `target_lang=` is ignored.

Quickstart:

    from romdoul import RomdoulClient
    c = RomdoulClient()                      # cloud engine, direct funnel base
    print(c.health())
    print(c.ocr_image("scan.png")["text"])
    doc = c.parse_document_pages("report.pdf", concurrency=4)
    print(c.text_of(doc))

Everything raises `RomdoulError` on failure; branch on `err.code`, never on
`err.message` (prose changes, codes do not).
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import mimetypes
import os
import random
import threading
import time
import uuid
import warnings
import weakref
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Iterable, Iterator, Sequence

import requests
from requests.adapters import HTTPAdapter

__all__ = ["RomdoulClient", "RomdoulError", "DEFAULT_BASE_URL", "ENGINE_PREFIXES"]
__version__ = "1.0.0"


# The Tailscale funnel, not Netlify: Netlify's proxy cuts a request off at ~26 s
# and a full page of Khmer regularly takes longer. The funnel allows ~300 s,
# which is why it is the default for a server-to-server client.
DEFAULT_BASE_URL = "https://apt-server-desktop.tail806605.ts.net/v1"

ENGINE_PREFIXES: dict[str, str] = {
    "cloud": "/api",
    "vllm": "/api-vllm",
    "lens": "/api-lens",
}

# Fixed namespace so a derived Idempotency-Key is stable across processes,
# machines and client versions — that is the whole point of deriving it.
_IDEM_NAMESPACE = uuid.UUID("1f0d5c8e-9b3a-4f6d-8a21-6c0b7e4d9a35")

_PDF_MAGIC = b"%PDF"

# Fallback codes for a response that did NOT carry the structured envelope
# (a bare FastAPI {"detail": ...} from an adapter, or a plain 404). The
# envelope's own `code` always wins when present.
#   NOTE 422 maps to bad_request, not input_declined: on the OCR endpoints a 422
#   is FastAPI request validation (almost always a wrong multipart field name),
#   whereas `input_declined` is what the batch job service reports for a page the
#   engine rejected as unparseable. Different problem, different fix.
_STATUS_CODES: dict[int, str] = {
    400: "bad_request",
    401: "unauthorized",
    403: "unauthorized",
    404: "not_found",
    413: "payload_too_large",
    422: "bad_request",
    429: "rate_limited",
    500: "engine_error",
    502: "engine_unreachable",
    503: "engine_not_ready",
    504: "engine_timeout",
}

# Statuses worth another attempt: a throttle and the three gateway/engine states
# that clear on their own. Everything else in 4xx is the caller's fault and
# retrying only burns rate-limit budget. 500 is deliberately NOT here — the
# engines return it for "this file will not parse", which fails identically
# every time; three retries would just triple the wait before the real error.
_RETRY_STATUSES = frozenset({429, 502, 503, 504})

# A Retry-After longer than this is a per-day quota, not a burst; sleeping it
# out would hang a batch job for hours, so we sleep the cap and try once more.
_MAX_RETRY_AFTER_SLEEP = 120.0


class RomdoulError(Exception):
    """Any failed API call.

    Attributes:
        status:      HTTP status, or 0 for a transport failure (DNS, refused
                     connection, read timeout) where no response ever arrived.
        code:        stable machine-readable identifier — branch on this.
                     From the API: rate_limited | payload_too_large |
                     engine_unreachable | engine_timeout | engine_not_ready |
                     bad_request (input_declined is in the same vocabulary but is
                     reported per failed page by the batch job service, not by
                     the synchronous endpoints). Synthesised by this client
                     when the response had no envelope: unauthorized |
                     not_found | engine_error | http_error | network_error |
                     bad_response.
        message:     human-readable; for logs and humans, never for control flow.
        retry_after: seconds the server asked us to wait (429 only), else None.
        body:        parsed response body, when there was one.
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        retry_after: float | None = None,
        body: Any = None,
    ) -> None:
        super().__init__(f"[{code}] {message}" if status == 0 else f"HTTP {status} [{code}] {message}")
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after
        self.body = body


# --------------------------------------------------------------------------- #
# File inputs
# --------------------------------------------------------------------------- #
# The upload's NAME is not cosmetic: the adapters branch on it. vllm-adapter's
# _upload_preprocessed dispatches on `name.endswith(".pdf") or content_type ==
# "application/pdf"`, so a PNG announced as document.pdf skips image
# preprocessing and is handed to PDFium, which answers
# `500 [engine_error] Failed to load document (PDFium: Data format error)`.
# A default name is therefore a CLAIM ABOUT THE BYTES; when nobody named the
# payload, the bytes are the only honest source for that claim.
_MAGIC_TYPES: tuple[tuple[bytes, str, str], ...] = (
    (b"%PDF", ".pdf", "application/pdf"),
    (b"\x89PNG\r\n\x1a\n", ".png", "image/png"),
    (b"\xff\xd8\xff", ".jpg", "image/jpeg"),
    (b"II*\x00", ".tif", "image/tiff"),
    (b"MM\x00*", ".tif", "image/tiff"),
    (b"GIF87a", ".gif", "image/gif"),
    (b"GIF89a", ".gif", "image/gif"),
    (b"BM", ".bmp", "image/bmp"),
)


def _sniff_type(data: bytes) -> tuple[str, str] | None:
    """(extension, content_type) from the leading magic bytes, or None."""
    for magic, ext, ctype in _MAGIC_TYPES:
        if data.startswith(magic):
            return ext, ctype
    # WEBP hides behind a RIFF container header, so it needs the offset check.
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp", "image/webp"
    return None


def _as_part(src: Any, *, filename: str | None = None, default_name: str = "upload.bin") -> tuple[str, bytes, str]:
    """Normalise a path / bytes / open file into (filename, data, content_type).

    We materialise bytes rather than streaming the file handle because every
    request may be retried, and a handle that has already been read to EOF
    silently uploads zero bytes on the second attempt. Documents here are one
    page or one image; holding them in memory is not the constraint.

    Naming precedence, most trusted first: an explicit `filename=`, the name the
    source already carries (a path, or a file object's `.name`), then the magic
    bytes, and only then `default_name`. `default_name` is a guess about content
    we could not identify — it must never override what the payload itself says.
    """
    name = filename
    if isinstance(src, (bytes, bytearray, memoryview)):
        data = bytes(src)
    elif isinstance(src, (str, os.PathLike)):
        path = os.fspath(src)
        name = name or os.path.basename(path) or None
        with open(path, "rb") as fh:
            data = fh.read()
    elif hasattr(src, "read"):
        raw = src.read()
        if isinstance(raw, str):
            raise TypeError("file object must be opened in binary mode ('rb'), not text mode")
        data = bytes(raw)
        name = name or os.path.basename(getattr(src, "name", "") or "") or None
    else:
        raise TypeError(f"expected a path, bytes or a binary file object, got {type(src).__name__}")

    if name:
        return name, data, mimetypes.guess_type(name)[0] or "application/octet-stream"

    sniffed = _sniff_type(data)
    if sniffed is not None:
        # Named from the bytes, so the content type comes from the bytes too
        # rather than from a second guess through the extension table (which is
        # registry-driven on Windows and has been seen to return None).
        ext, ctype = sniffed
        return f"{os.path.splitext(default_name)[0] or 'upload'}{ext}", data, ctype
    return default_name, data, mimetypes.guess_type(default_name)[0] or "application/octet-stream"


def _derive_idempotency_key(prefix: str, path: str, params: dict[str, Any], parts: Sequence[tuple[str, tuple[str, bytes, str]]]) -> str:
    """Content-addressed Idempotency-Key: same engine + endpoint + query + bytes
    -> same key -> nginx replays the stored response instead of re-running OCR.

    The engine prefix and query string MUST be folded in. nginx's cache key is
    `$request_method$uri$http_idempotency_key`, and by the time it is evaluated
    the location has already rewritten `/v1/api-lens/ocr-image` down to
    `/ocr-image` — so the engine and the query args are NOT part of the server's
    key. Verified: the same key sent to /api-lens then /api-vllm returns the
    LENS result with `X-Idempotency-Replay: HIT`. A hand-rolled key reused
    across engines silently returns the wrong engine's output; deriving it here
    makes that impossible.
    """
    h = hashlib.sha256()
    h.update(prefix.encode("utf-8") + b"\0" + path.encode("utf-8") + b"\0")
    for key in sorted(params):
        h.update(f"{key}={params[key]}\0".encode("utf-8"))
    for field, (name, data, _ctype) in parts:
        h.update(field.encode("utf-8") + b"\0" + name.encode("utf-8") + b"\0")
        h.update(hashlib.sha256(data).digest())
    return str(uuid.uuid5(_IDEM_NAMESPACE, h.hexdigest()))


def _render_detail(detail: Any) -> str:
    """FastAPI's `detail` is a string on our adapters but a LIST of validation
    objects on a 422 — `str(detail)` there prints raw Python dicts at the user.
    """
    if isinstance(detail, str):
        return detail
    if isinstance(detail, list):
        out = []
        for item in detail:
            if isinstance(item, dict):
                loc = ".".join(str(x) for x in (item.get("loc") or []))
                out.append(f"{loc}: {item.get('msg')}" if loc else str(item.get("msg")))
            else:
                out.append(str(item))
        return "; ".join(out)
    return str(detail)


def _retry_after_seconds(value: str | None) -> float | None:
    """`Retry-After` is either delta-seconds or an HTTP-date. nginx sends the
    former; upstreams have been known to send the latter.
    """
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(int(value)))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    return max(0.0, when.timestamp() - time.time())


def _split_pdf_pages(data: bytes) -> list[bytes] | None:
    """One single-page PDF per page, or None when we cannot split.

    Optional dependency on purpose: pypdf is not installed in plenty of
    environments and this client must import cleanly without it. The caller
    warns and falls back to sending the whole document.
    """
    try:
        from pypdf import PdfReader, PdfWriter  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001 - not just ImportError: a pypdf that is
        # installed but broken (missing transitive dep, a shadowed stdlib module
        # in the caller's cwd) raises something else entirely, and the contract
        # here is "cannot split", not "take down the caller's document job".
        try:
            from PyPDF2 import PdfReader, PdfWriter  # type: ignore[import-not-found,no-redef]
        except Exception:  # noqa: BLE001 - same reasoning
            return None
    try:
        reader = PdfReader(io.BytesIO(data))
        if getattr(reader, "is_encrypted", False):
            # An empty user password is the common "encrypted but not really"
            # case; anything else we hand to the engine whole.
            try:
                reader.decrypt("")
            except Exception:  # noqa: BLE001 - any failure means "cannot split"
                return None
        pages: list[bytes] = []
        for page in reader.pages:
            writer = PdfWriter()
            writer.add_page(page)
            buf = io.BytesIO()
            writer.write(buf)
            pages.append(buf.getvalue())
        return pages or None
    except Exception:  # noqa: BLE001 - a malformed PDF must degrade, not crash
        return None


# --------------------------------------------------------------------------- #
# Client
# --------------------------------------------------------------------------- #
class RomdoulClient:
    """Thread-safe client for one engine.

    The instance holds no mutable request state, and each thread gets its own
    `requests.Session` (see `_session`), so one client can be shared by a thread
    pool. Pass `session=` only if you need custom auth/proxies/mounts — you then
    own its thread-safety, including inside `parse_document_pages`, which hands
    that one session to every worker thread.

    Long-lived processes: keep ONE client and reuse it. Sessions are held only by
    the thread that made them and the page-OCR pool is created once, so neither
    grows with the number of documents processed. `close()` is optional cleanup,
    not a leak fix, and the client stays usable afterwards.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        engine: str = "cloud",
        timeout: float = 300,
        max_retries: int = 3,
        session: requests.Session | None = None,
        *,
        adapter_token: str | None = None,
        user_agent: str | None = None,
    ) -> None:
        if engine not in ENGINE_PREFIXES:
            raise ValueError(f"engine must be one of {sorted(ENGINE_PREFIXES)}, got {engine!r}")
        self.base_url = base_url.rstrip("/")
        self.engine = engine
        self.prefix = ENGINE_PREFIXES[engine]
        self.timeout = float(timeout)
        self.max_retries = int(max_retries)
        # Only needed when talking to an adapter DIRECTLY (localhost:8091 &c.).
        # Through nginx the header is injected server-side and this stays None.
        self.adapter_token = adapter_token
        self.user_agent = user_agent or f"romdoul-python/{__version__}"

        self._user_session = session
        self._local = threading.local()
        # WeakSet, NOT a list: the only strong reference to a per-thread Session
        # must be the thread-local itself, so the Session (and its keep-alive
        # TLS sockets) dies with the thread that made it. A plain list pinned
        # every Session a worker thread ever created until close(), which a
        # long-lived pipeline never calls — steady memory growth and eventual
        # fd/handle exhaustion after a few thousand documents.
        self._sessions: weakref.WeakSet[requests.Session] = weakref.WeakSet()
        self._sessions_lock = threading.Lock()
        self._pool: ThreadPoolExecutor | None = None
        self._pool_workers = 0
        self._pool_busy = 0
        self._pool_lock = threading.Lock()

    # -- plumbing ---------------------------------------------------------- #
    def _session(self) -> requests.Session:
        if self._user_session is not None:
            return self._user_session
        sess: requests.Session | None = getattr(self._local, "session", None)
        if sess is None:
            sess = requests.Session()
            # urllib3's own retry stays off (adapter default max_retries=0): it
            # cannot see Retry-After semantics or our idempotency key, so
            # retrying there would duplicate work we handle properly below.
            adapter = HTTPAdapter(pool_connections=4, pool_maxsize=32)
            sess.mount("https://", adapter)
            sess.mount("http://", adapter)
            self._local.session = sess
            with self._sessions_lock:
                self._sessions.add(sess)
        return sess

    @contextlib.contextmanager
    def _worker_pool(self, workers: int) -> Iterator[ThreadPoolExecutor]:
        """Lend out this client's shared page-OCR executor.

        One executor per client, not one per call. A fresh executor means fresh
        threads, and every fresh thread mints a fresh Session with fresh TLS
        connections — so a per-call executor made the thread and socket count
        grow with the NUMBER OF DOCUMENTS instead of with `concurrency`.
        Reusing the pool also skips a round of TLS handshakes per document.
        """
        workers = max(1, int(workers))
        stale: ThreadPoolExecutor | None = None
        private: ThreadPoolExecutor | None = None
        with self._pool_lock:
            # `== workers`, not `>= workers`: reusing a LARGER pool silently ran
            # more pages in flight than the caller asked for, so once any call had
            # built an 8-worker pool a later concurrency=2 still hammered the GPU
            # with 8. The knob has to mean what it says.
            if self._pool is not None and self._pool_workers == workers:
                pool = self._pool
                self._pool_busy += 1
            elif self._pool_busy == 0:
                # Safe to resize only while nobody is inside the shared pool;
                # replacing it under a concurrent call would shut the executor
                # its futures are still queued on.
                stale, self._pool = self._pool, ThreadPoolExecutor(max_workers=workers, thread_name_prefix="romdoul")
                self._pool_workers = workers
                self._pool_busy = 1
                pool = self._pool
            else:
                # Another thread is mid-call on a smaller shared pool. Give this
                # call a private executor rather than starving it of workers.
                pool = private = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="romdoul-x")
        try:
            if stale is not None:
                # Inside the try: anything that raises after `_pool_busy` was
                # incremented must still decrement it, or the client is pinned
                # to a private executor per call forever after.
                stale.shutdown(wait=False)
            yield pool
        finally:
            # wait=False everywhere: an abandoned page request cannot be
            # cancelled mid-flight, and blocking here would re-impose the very
            # delay fail_fast exists to avoid.
            if private is not None:
                private.shutdown(wait=False)
            else:
                with self._pool_lock:
                    self._pool_busy = max(0, self._pool_busy - 1)

    def close(self) -> None:
        """Close every session this client opened and stop its worker pool. A
        user-supplied session is left alone — the caller owns it.

        Idempotent: calling it twice, or after the WeakSet has already dropped a
        dead thread's Session, is a no-op.
        """
        with self._pool_lock:
            pool, self._pool = self._pool, None
            self._pool_workers = 0
            self._pool_busy = 0
        if pool is not None:
            # wait=False: a fail_fast abort deliberately leaves in-flight page
            # requests running (see parse_document_pages); close() must not
            # block for up to `timeout` seconds waiting them out.
            pool.shutdown(wait=False)
        with self._sessions_lock:
            sessions = list(self._sessions)
            self._sessions.clear()
        for sess in sessions:
            sess.close()
        self._local = threading.local()

    def __enter__(self) -> RomdoulClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def with_engine(self, engine: str) -> RomdoulClient:
        """A sibling client for another engine, same base URL and settings.
        Handy for A/B-ing the same page across engines."""
        return RomdoulClient(
            self.base_url,
            engine,
            self.timeout,
            self.max_retries,
            self._user_session,
            adapter_token=self.adapter_token,
            user_agent=self.user_agent,
        )

    def _backoff(self, attempt: int) -> float:
        """Equal-jitter exponential backoff: half the window fixed, half random.
        Pure random ("full jitter") lets a fleet of workers retry almost
        instantly; a fixed delay makes them retry in lockstep."""
        window = min(30.0, 1.0 * (2 ** attempt))
        return window / 2 + random.uniform(0, window / 2)

    def _error(self, resp: requests.Response) -> RomdoulError:
        body: Any
        try:
            body = resp.json()
        except ValueError:
            body = (resp.text or "").strip()

        code: str | None = None
        message: str | None = None
        retry_after: float | None = None

        if isinstance(body, dict):
            envelope = body.get("error")
            if isinstance(envelope, dict):
                code = envelope.get("code") or None
                message = envelope.get("message") or None
                raw_ra = envelope.get("retry_after")
                retry_after = float(raw_ra) if isinstance(raw_ra, (int, float)) else None
            if message is None and body.get("detail") is not None:
                message = _render_detail(body["detail"])
        elif isinstance(body, str) and body:
            message = body[:500]

        if retry_after is None:
            retry_after = _retry_after_seconds(resp.headers.get("Retry-After"))

        return RomdoulError(
            resp.status_code,
            code or _STATUS_CODES.get(resp.status_code, "http_error"),
            message or f"request failed with status {resp.status_code}",
            retry_after=retry_after,
            body=body,
        )

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        parts: Sequence[tuple[str, tuple[str, bytes, str]]] | None = None,
        idempotency_key: str | None = None,
        timeout: float | None = None,
        max_retries: int | None = None,
    ) -> Any:
        params = dict(params or {})
        parts = list(parts or [])
        url = f"{self.base_url}{self.prefix}{path}"
        attempts = self.max_retries if max_retries is None else int(max_retries)
        read_timeout = self.timeout if timeout is None else float(timeout)

        headers = {"Accept": "application/json", "User-Agent": self.user_agent}
        if self.adapter_token:
            headers["X-Adapter-Token"] = self.adapter_token
        if parts:
            # Resolved ONCE, outside the retry loop, and deliberately not
            # regenerated per attempt: re-sending the same key is what makes a
            # retry of a request that actually landed cost nothing.
            #   None -> derive from the request   "" -> no header at all
            key = _derive_idempotency_key(self.prefix, path, params, parts) if idempotency_key is None else idempotency_key
            if key:
                headers["Idempotency-Key"] = key

        last: RomdoulError | None = None
        for attempt in range(attempts + 1):
            try:
                resp = self._session().request(
                    method,
                    url,
                    params=params or None,
                    files=parts or None,
                    headers=headers,
                    # Connect fast, read slow: a cold engine takes tens of
                    # seconds to answer but should never take that long to
                    # accept a TCP connection.
                    timeout=(min(30.0, read_timeout), read_timeout),
                )
            except requests.RequestException as exc:
                # Includes read timeouts. Retrying is right and cheap: if the
                # engine did finish, nginx replays it against our key.
                last = RomdoulError(0, "network_error", f"{type(exc).__name__}: {exc}")
                if attempt >= attempts:
                    raise last from exc
                time.sleep(self._backoff(attempt))
                continue

            if resp.ok:
                try:
                    return resp.json()
                except ValueError:
                    # /ocr-image on the cloud engine has been observed returning
                    # a bare body; hand it back as text and let the caller
                    # normalise rather than failing a successful OCR.
                    return resp.text

            err = self._error(resp)
            if resp.status_code not in _RETRY_STATUSES or attempt >= attempts:
                raise err
            if resp.status_code == 429:
                # Obey the server. Cap it so a daily-quota Retry-After does not
                # park a batch job for an hour.
                delay = min(err.retry_after or self._backoff(attempt), _MAX_RETRY_AFTER_SLEEP)
            else:
                delay = self._backoff(attempt)
            last = err
            time.sleep(delay)

        raise last or RomdoulError(0, "http_error", "request failed")  # pragma: no cover - loop always returns/raises

    # -- endpoints --------------------------------------------------------- #
    def health(self) -> dict[str, Any]:
        """`{"status", "models_loaded", "message"}`.

        No retries — a probe should answer now, and a 503 from the vLLM adapter
        is a real answer ("GPU unreachable"), not a blip. It still raises;
        catch RomdoulError and read `err.code` / `err.body`.
        """
        result = self._request("GET", "/health", timeout=min(self.timeout, 60.0), max_retries=0)
        return result if isinstance(result, dict) else {"status": "unknown", "message": str(result)}

    def ocr_image(
        self,
        path_or_bytes: Any,
        *,
        use_ctc: bool = True,
        idempotency_key: str | None = None,
        filename: str | None = None,
        dpi: int | None = None,
    ) -> dict[str, Any]:
        """One image -> `{"text", "confidence", "filename", "decoder"}`.

        `confidence` is None when the engine does not report one (the cloud
        engine omits the field entirely; Lens sends a literal 0.0). Multipart
        field name is **file**, singular.
        """
        part = _as_part(path_or_bytes, filename=filename, default_name="image.png")
        params: dict[str, Any] = {"use_ctc": "true" if use_ctc else "false"}
        if dpi is not None:
            params["dpi"] = int(dpi)
        raw = self._request("POST", "/ocr-image", params=params, parts=[("file", part)], idempotency_key=idempotency_key)
        return _normalise_ocr(raw, part[0])

    def parse_table(
        self,
        path_or_bytes: Any,
        *,
        row_tolerance: int | None = None,
        idempotency_key: str | None = None,
        filename: str | None = None,
        dpi: int | None = None,
    ) -> dict[str, Any]:
        """Table structure -> `{"num_rows", "num_cols", "cells", "structured_text", ...}`.

        Multipart field name is **file**, singular. `use_ctc` is pinned on: the
        autoregressive decoder can fall into repetition loops on noisy Khmer,
        which wrecks a grid. On a page with no detectable table the engines
        return the text as an N x 1 grid rather than 0 x 0.
        """
        part = _as_part(path_or_bytes, filename=filename, default_name="table.png")
        params: dict[str, Any] = {"use_ctc": "true"}
        if row_tolerance is not None:
            params["row_tolerance"] = int(row_tolerance)
        if dpi is not None:
            params["dpi"] = int(dpi)
        result = self._request("POST", "/parse-table", params=params, parts=[("file", part)], idempotency_key=idempotency_key)
        return _expect_dict(result, "/parse-table")

    def parse_document(
        self,
        path: Any,
        *,
        translate: bool = False,
        target_lang: str = "en",
        source_lang: str | None = None,
        detect_layout: bool | None = None,
        detect_lines: bool | None = None,
        use_ctc: bool = True,
        dpi: int | None = None,
        idempotency_key: str | None = None,
        filename: str | None = None,
    ) -> dict[str, Any]:
        """Whole document in ONE request -> DocumentResult.

        `path` may be a single path/bytes/file object, or a sequence of them —
        the endpoint's `files` field is repeatable and multiple inputs merge
        into one document with renumbered pages.

        For anything longer than a handful of pages use `parse_document_pages`
        instead: one 500-page request will hit the 300 s ceiling (or the 100 MB
        upload cap) and lose the whole job.
        """
        sources: Iterable[Any] = path if isinstance(path, (list, tuple)) else [path]
        # `filename` overrides only make sense for a single input; with several,
        # every part would land under the same name.
        parts = [
            ("files", _as_part(src, filename=filename if not isinstance(path, (list, tuple)) else None, default_name="document.pdf"))
            for src in sources
        ]
        return self._parse_document_parts(
            parts,
            translate=translate,
            target_lang=target_lang,
            source_lang=source_lang,
            detect_layout=detect_layout,
            detect_lines=detect_lines,
            use_ctc=use_ctc,
            dpi=dpi,
            idempotency_key=idempotency_key,
        )

    def _parse_document_parts(
        self,
        parts: Sequence[tuple[str, tuple[str, bytes, str]]],
        *,
        translate: bool = False,
        target_lang: str = "en",
        source_lang: str | None = None,
        detect_layout: bool | None = None,
        detect_lines: bool | None = None,
        use_ctc: bool = True,
        dpi: int | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"use_ctc": "true" if use_ctc else "false"}
        if detect_layout is not None:
            params["detect_layout"] = "true" if detect_layout else "false"
        if detect_lines is not None:
            params["detect_lines"] = "true" if detect_lines else "false"
        if dpi is not None:
            params["dpi"] = int(dpi)
        path = "/parse-pdf"
        if translate:
            path = "/parse-pdf-translated"
            if target_lang:
                params["target_lang"] = target_lang
            if source_lang:
                params["source_lang"] = source_lang
        result = self._request("POST", path, params=params, parts=parts, idempotency_key=idempotency_key)
        return _expect_dict(result, path)

    def parse_document_pages(
        self,
        pdf_path: Any,
        *,
        concurrency: int = 4,
        on_progress: Callable[[int, int], None] | None = None,
        fail_fast: bool = True,
        filename: str | None = None,
        **opts: Any,
    ) -> dict[str, Any]:
        """Split locally, OCR pages concurrently, merge into ONE DocumentResult.

        This is the endpoint you want for real documents. Each page is its own
        request, so:
          * no single request approaches the 300 s gateway ceiling;
          * each page carries an Idempotency-Key derived from that page's bytes,
            so re-running the job after a crash re-downloads finished pages from
            nginx's 24 h replay cache instead of re-running OCR;
          * a slow page does not block the rest.

        `pdf_path` may also be an image, or raw `bytes` of either — the type is
        taken from the payload's magic bytes, not from a default name. Pass
        `filename=` to name it yourself (the engines echo it back, and it feeds
        the idempotency key).

        `on_progress(done, total)` is called from the thread that called
        `parse_document_pages`, never from a worker, so it needs no locking of
        its own — but it runs between page results, so keep it cheap.

        `fail_fast=True` (default) raises the first page error immediately: the
        pages still queued are cancelled, and the handful already in flight are
        abandoned rather than waited out (an HTTP request in progress cannot be
        cancelled). Those abandoned pages finish in the background and land in
        nginx's replay cache, so a re-run gets them for free. With
        `fail_fast=False` the job completes, failed pages appear as empty pages
        so page numbers still line up with the source PDF, and the reasons are
        listed in the extra `failed_pages` key.

        `**opts` are the per-page request options — `translate`, `target_lang`,
        `source_lang`, `detect_layout`, `detect_lines`, `use_ctc`, `dpi` — and
        are applied to every page. NOT the full `parse_document` signature:
        `filename` is the parameter above, and `idempotency_key` is ignored
        because each page derives its own (one shared key across pages would
        make every page replay page 1's response).

        Without pypdf installed there is nothing to split with: it warns and
        sends the whole file as one request. `pip install pypdf` to get the real
        behaviour.
        """
        name, data, ctype = _as_part(pdf_path, filename=filename, default_name="document.pdf")
        opts.pop("idempotency_key", None)  # per-page keys are derived; a shared one would collide
        # Reject unknown options here rather than letting them surface as a
        # TypeError naming a private method the caller never heard of.
        unknown = sorted(set(opts) - _PAGE_OPTIONS)
        if unknown:
            raise TypeError(f"parse_document_pages() got unexpected keyword argument(s): {', '.join(unknown)}")

        # Both single-request fallbacks below go back through _merge_pages so the
        # return shape is identical whether or not the split happened — a caller
        # reading `failed_pages` must not KeyError just because pypdf is absent.
        if not data.startswith(_PDF_MAGIC):
            # A single image is already one page — nothing to split.
            whole = self._parse_document_parts([("files", (name, data, ctype))], **opts)
            return _merge_pages(name, [whole], [])

        blobs = _split_pdf_pages(data)
        if blobs is None:
            warnings.warn(
                "Cannot split this PDF locally (pypdf not installed, or the file is "
                "encrypted/malformed); sending the whole document as ONE request. Long "
                "documents will hit the gateway timeout — `pip install pypdf`.",
                RuntimeWarning,
                stacklevel=2,
            )
            whole = self._parse_document_parts([("files", (name, data, ctype))], **opts)
            return _merge_pages(name, [whole], [])

        stem = os.path.splitext(name)[0] or "document"
        total = len(blobs)
        results: list[dict[str, Any] | None] = [None] * total
        failures: list[dict[str, Any]] = []
        done = 0

        def work(index: int) -> dict[str, Any]:
            page_name = f"{stem}-p{index + 1:04d}.pdf"
            return self._parse_document_parts([("files", (page_name, blobs[index], "application/pdf"))], **opts)

        # No lock around `done` / `on_progress`: this loop, and therefore every
        # callback, runs in the CALLING thread — the workers only return values.
        # A lock here would be dead weight that reads as a promise of worker-side
        # callbacks the code does not make.
        with self._worker_pool(concurrency) as pool:
            futures = {pool.submit(work, i): i for i in range(total)}
            try:
                for future in as_completed(futures):
                    index = futures[future]
                    try:
                        results[index] = future.result()
                    except RomdoulError as exc:
                        if fail_fast:
                            raise
                        failures.append(
                            {"page_number": index + 1, "code": exc.code, "status": exc.status, "message": exc.message}
                        )
                    finally:
                        done += 1
                        if on_progress is not None:
                            on_progress(done, total)
            except BaseException:
                # Cancels what is still queued. Pages already in flight cannot be
                # called back and are abandoned, not awaited — the shared pool is
                # never shut down here, so the error reaches the caller now
                # instead of after the slowest in-flight page (up to `timeout`).
                for future in futures:
                    future.cancel()
                raise

        return _merge_pages(name, results, failures)

    # -- helpers ----------------------------------------------------------- #
    @staticmethod
    def text_of(document_result: dict[str, Any]) -> str:
        """Plain text of a DocumentResult, correctly.

        `full_text` arrives as an EMPTY STRING on plenty of real documents while
        the regions underneath hold every word (reproducible today on the cloud
        engine). `result.get("full_text") or ""` therefore silently returns
        nothing — treat blank as missing and fall back to the region text.
        """
        full = document_result.get("full_text")
        if isinstance(full, str) and full.strip():
            return full
        pages: list[str] = []
        for page in document_result.get("pages") or []:
            lines = [
                (region.get("text") or "").strip()
                for region in (page.get("regions") or [])
                if (region.get("text") or "").strip()
            ]
            if lines:
                pages.append("\n".join(lines))
        return "\n\n".join(pages)


# The per-page options `parse_document_pages(**opts)` accepts, read off the
# function that consumes them (they are all keyword-only with defaults) so the
# two can never drift apart. `idempotency_key` is excluded deliberately: pages
# derive their own, and a shared one would make every page replay page 1.
_PAGE_OPTIONS: frozenset[str] = frozenset(RomdoulClient._parse_document_parts.__kwdefaults__ or {}) - {"idempotency_key"}


# --------------------------------------------------------------------------- #
# Response shaping
# --------------------------------------------------------------------------- #
def _expect_dict(result: Any, path: str) -> dict[str, Any]:
    if isinstance(result, dict):
        return result
    raise RomdoulError(200, "bad_response", f"{path} returned {type(result).__name__}, expected a JSON object", body=result)


def _normalise_ocr(raw: Any, filename: str) -> dict[str, Any]:
    """The three engines disagree about /ocr-image's envelope: the cloud engine
    omits `confidence` entirely, Lens sends 0.0, vLLM sends a real number, and
    the cloud engine has been seen returning a bare string. Give the caller one
    shape, with None meaning "this engine reports no confidence" rather than a
    fake zero.
    """
    if isinstance(raw, str):
        return {"text": raw, "confidence": None, "filename": filename, "decoder": None}
    if not isinstance(raw, dict):
        return {"text": "", "confidence": None, "filename": filename, "decoder": None}
    out = dict(raw)
    out["text"] = raw.get("text") if isinstance(raw.get("text"), str) else ""
    conf = raw.get("confidence")
    out["confidence"] = float(conf) if isinstance(conf, (int, float)) else None
    out["filename"] = raw.get("filename") or filename
    out["decoder"] = raw.get("decoder") or None
    return out


def _merge_pages(filename: str, results: Sequence[dict[str, Any] | None], failures: list[dict[str, Any]]) -> dict[str, Any]:
    """Stitch per-page DocumentResults back into one, page_number 1..N.

    A failed page becomes an empty placeholder so page numbers keep matching the
    source PDF — silently closing the gap would misattribute every later page.
    """
    pages: list[dict[str, Any]] = []
    texts: list[str] = []
    translations: list[str] = []
    table_crops: list[Any] = []
    figure_crops: list[Any] = []
    image_crops: list[Any] = []

    for doc in results:
        if doc is None:
            pages.append({"page_number": len(pages) + 1, "width": 0, "height": 0, "regions": []})
            continue
        for page in doc.get("pages") or []:
            merged_page = dict(page)
            merged_page["page_number"] = len(pages) + 1
            pages.append(merged_page)
        text = RomdoulClient.text_of(doc)
        if text.strip():
            texts.append(text)
        translated = doc.get("translated_text")
        if isinstance(translated, str) and translated.strip():
            translations.append(translated)
        table_crops.extend(doc.get("table_crops") or [])
        figure_crops.extend(doc.get("figure_crops") or [])
        image_crops.extend(doc.get("image_crops") or [])

    return {
        "filename": filename,
        "num_pages": len(pages),
        "pages": pages,
        "full_text": "\n\n".join(texts),
        "translated_text": "\n\n".join(translations) if translations else None,
        "table_crops": table_crops,
        "figure_crops": figure_crops,
        "image_crops": image_crops,
        # Client-added, not part of the API contract: empty unless fail_fast=False
        # let the job finish past a page error.
        "failed_pages": failures,
    }


# --------------------------------------------------------------------------- #
# `python romdoul.py health|ocr|doc <file>` — a smoke test you can run from any
# box to answer "is the API reachable from HERE", without writing a script.
# --------------------------------------------------------------------------- #
def _main(argv: list[str]) -> int:  # pragma: no cover - operator convenience
    import json
    import sys

    cmd = argv[1] if len(argv) > 1 else "health"
    engine = os.environ.get("ROMDOUL_ENGINE", "cloud")
    client = RomdoulClient(os.environ.get("ROMDOUL_BASE_URL", DEFAULT_BASE_URL), engine)
    try:
        if cmd == "health":
            print(json.dumps(client.health(), ensure_ascii=False))
        elif cmd == "ocr":
            print(client.ocr_image(argv[2])["text"])
        elif cmd == "doc":
            doc = client.parse_document_pages(argv[2], on_progress=lambda d, t: print(f"  {d}/{t}", file=sys.stderr))
            print(client.text_of(doc))
        else:
            print(f"usage: {os.path.basename(argv[0])} [health|ocr <image>|doc <pdf>]")
            return 2
    except RomdoulError as exc:
        print(f"{exc}  (code={exc.code}, retry_after={exc.retry_after})")
        return 1
    except IndexError:
        print(f"usage: {os.path.basename(argv[0])} [health|ocr <image>|doc <pdf>]")
        return 2
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys as _sys

    raise SystemExit(_main(_sys.argv))
