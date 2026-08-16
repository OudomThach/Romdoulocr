"""
Aggregate status adapter for the Romdoul OCR API.

Integrators currently have to poll THREE health endpoints (/api/health,
/api-vllm/health, /api-lens/health) to decide which engine to send a job to.
That is three round-trips before any real work, and each one can be slow for a
different reason. This adapter fans out to all three in parallel and answers the
question once, at GET /v1/status.

Why a sidecar and not nginx: nginx cannot fan out to several upstreams and merge
their responses within one request. `mirror` copies a request without collecting
replies, and there is no join primitive. Expressing this in nginx would mean
embedding Lua/njs — far more machinery than a 200-line FastAPI service.

Mirrors the vllm/lens/tidy adapter sidecar pattern: nginx reaches it by container
name, ADAPTER_TOKEN shared-secret gate, permissive CORS.

TWO PROPERTIES THIS SERVICE MUST NEVER VIOLATE:

  1. It must never hang. A status endpoint that blocks is worse than useless —
     it is the thing you call WHEN the stack is misbehaving. Every probe gets a
     hard deadline (its own read budget, plus CONNECT_TIMEOUT), and a probe that
     misses it reports the engine rather than holding the response open.

  2. Polling it must be cheap. Results are cached for STATUS_TTL seconds and
     refreshed under a lock, so a hundred pollers still produce one fan-out. An
     expired cache is served immediately while a refresh runs in the background
     — the same trade nginx's health cache makes in this repo with
     `proxy_cache_background_update` + `proxy_cache_use_stale`.

GOTCHA that shaped this design: the cloud engine (Modal) scales to zero, so a
cold /health legitimately takes ~10s. Calling that "down" would be WRONG — the
engine is fine, it is booting, and a caller should still send work to it. Two
mechanisms keep that from being misreported, and they cover different cases:

  - A longer READ budget for the cloud engine (PROBE_TIMEOUT_CLOUD). Safe because
    CONNECT_TIMEOUT stays short for everyone, so a truly unreachable host still
    fails fast; see the measurements next to those constants.
  - state="warming" for a probe that misses even that budget but succeeded within
    COLD_GRACE seconds. Only a sustained failure past COLD_GRACE becomes "down".

An expired cache is refreshed in the BACKGROUND while the caller is handed the
previous answer immediately, and the cache is primed at startup. In steady state
every caller is therefore served from memory in single-digit milliseconds, and
the long cloud budget is absorbed by a background task rather than by a user.

WORST CASE, stated honestly: only a caller who arrives before the startup prime
has landed — i.e. within the first seconds of the container's life, with a cold
cloud engine — actually waits, and then for at most PROBE_TIMEOUT_CLOUD. That is
bounded and rare, but real, and it is why PROBE_TIMEOUT_CLOUD must stay below the
~26s Netlify proxy ceiling.

Env:
  ADAPTER_TOKEN       (optional shared secret; when set, X-Adapter-Token required)
  STATUS_TTL          (default 5)     seconds a fan-out result is reused
  PROBE_TIMEOUT       (default 4.0)   read budget for the local sidecars
  PROBE_TIMEOUT_CLOUD (default 22.0)  read budget for the scale-to-zero cloud engine
  CONNECT_TIMEOUT     (default 2.0)   TCP/TLS connect budget, all engines
  COLD_GRACE          (default 120)   how long a recent success excuses a slow probe
  REFRESH_INTERVAL    (default 30)    background refresh cadence while in use
  ACTIVE_WINDOW       (default 300)   idle out the refresher this long after use
  STATUS_CLOUD_URL / STATUS_VLLM_URL / STATUS_LENS_URL   override probe targets
"""

from __future__ import annotations

import asyncio
import hmac
import os
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

ADAPTER_TOKEN = os.environ.get("ADAPTER_TOKEN", "").strip()
STATUS_TTL = float(os.environ.get("STATUS_TTL", "5"))
PROBE_TIMEOUT = float(os.environ.get("PROBE_TIMEOUT", "4.0"))
COLD_GRACE = float(os.environ.get("COLD_GRACE", "120"))

# The cloud engine scales to zero, so it needs a much longer READ budget than the
# local sidecars. 22s is not a guess — it is this repo's own documented ceiling
# for a cold Modal /health (nginx.conf: "a COLD /health can take 16-22s";
# openapi.json: "May take up to ~22 s on a cold start"). An earlier 12s value was
# tried and observed reporting a healthy-but-cold Modal as DOWN.
#
# MEASURED here: cold connect=0.36s / first byte=10.04s; warm connect=0.29s /
# first byte=0.91s. Connect is fast either way — only the RESPONSE is slow when
# cold. That is what makes a long read budget safe: CONNECT_TIMEOUT stays short
# for every engine, so a genuinely unreachable host still fails in ~2s, and this
# budget is only ever spent on a host that accepted the connection and is
# thinking — exactly the cold start we must not misreport as an outage.
#
# It costs callers nothing in practice because the background refresher below
# absorbs it; see the worst case noted in the module docstring.
PROBE_TIMEOUT_CLOUD = float(os.environ.get("PROBE_TIMEOUT_CLOUD", "22.0"))
CONNECT_TIMEOUT = float(os.environ.get("CONNECT_TIMEOUT", "2.0"))

# Background refresh, so callers almost never pay for a fan-out themselves and
# _last_ok stays recent enough for the "warming" state to work at all (it can
# only excuse a slow probe if something probed successfully in the recent past).
#
# GATED ON RECENT USE on purpose. The cloud engine belongs to someone else's
# Modal account, and an unconditional 30s loop would spend ~2,900 requests/day of
# it whether or not anyone is using the site. So the loop idles until a real
# caller shows up and stops again ACTIVE_WINDOW after the last one — zero
# background cost when nobody is polling.
REFRESH_INTERVAL = float(os.environ.get("REFRESH_INTERVAL", "30"))
ACTIVE_WINDOW = float(os.environ.get("ACTIVE_WINDOW", "300"))

# (key, public path prefix, health URL, read-timeout budget).
#
# We probe each engine DIRECTLY rather than through nginx (/api/health etc.).
# Two reasons: going back through nginx would make this service re-enter the
# proxy that is calling it, and it would conflate "the engine is down" with
# "the proxy is down" — but if the proxy were down nobody could reach /v1/status
# in the first place, so that distinction is exactly the one worth keeping.
#
# The tidy backend is deliberately absent: it is excluded from the public API
# surface, and it is not an OCR engine a caller could fail over to.
ENGINES: tuple[tuple[str, str, str, float], ...] = (
    ("cloud", "/api", os.environ.get("STATUS_CLOUD_URL", "https://rinabuoy13--khparser-api.modal.run/health"), PROBE_TIMEOUT_CLOUD),
    ("vllm", "/api-vllm", os.environ.get("STATUS_VLLM_URL", "http://vllm-adapter:8090/health"), PROBE_TIMEOUT),
    ("lens", "/api-lens", os.environ.get("STATUS_LENS_URL", "http://lens-adapter:8091/health"), PROBE_TIMEOUT),
)

# Monotonic timestamp of the last successful probe per engine — the input to the
# "warming vs down" decision above. Monotonic, not wall clock, so an NTP step or
# a resume-from-sleep clock jump cannot silently widen or collapse the grace
# window.
_last_ok: dict[str, float] = {}

# Cached fan-out result, guarded by _refresh_lock.
_cache: dict[str, Any] | None = None
_cache_at: float = 0.0
_refresh_lock = asyncio.Lock()

# Monotonic time of the last real /status request, used to decide whether the
# background refresher should keep running.
_last_request: float = 0.0

# Strong reference to the in-flight background refresh; see _spawn_refresh.
_refresh_task: asyncio.Task[None] | None = None

_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def _lifespan(_: FastAPI):
    """One shared AsyncClient for the process.

    A per-request client would re-do the TLS handshake to Modal on every poll,
    which is most of the cost of a warm probe (~0.9s total, most of it setup).
    Keep-alive makes a warm cloud probe cheap enough to poll on a short TTL.
    """
    global _client
    _client = httpx.AsyncClient(
        # Per-request timeouts override this; it is only the fallback.
        timeout=httpx.Timeout(PROBE_TIMEOUT, connect=CONNECT_TIMEOUT),
        limits=httpx.Limits(max_keepalive_connections=8, max_connections=16),
        follow_redirects=True,
    )
    # Prime the cache before serving. Without this, the first caller after a
    # container restart pays a full fan-out — and if the cloud engine happens to
    # be cold that is the worst latency this service can produce, handed to the
    # unluckiest possible caller.
    warmer = asyncio.create_task(_keep_warm())
    try:
        yield
    finally:
        warmer.cancel()
        try:
            await warmer
        except asyncio.CancelledError:
            pass
        await _client.aclose()
        _client = None


async def _keep_warm() -> None:
    """Refresh the cache in the background while the service is in use."""
    try:
        await _refresh_once()  # prime immediately at startup
    except Exception:  # noqa: BLE001
        pass  # a failed prime is not fatal; the first caller re-probes
    while True:
        await asyncio.sleep(REFRESH_INTERVAL)
        # Idle out when nobody is polling, so we do not spend a third party's
        # Modal quota around the clock for nothing.
        if _last_request == 0.0 or (time.monotonic() - _last_request) > ACTIVE_WINDOW:
            continue
        try:
            await _refresh_once()
        except Exception:  # noqa: BLE001
            pass  # never let a probe failure kill the refresher


app = FastAPI(title="Aggregate status adapter", version="1.0.0", lifespan=_lifespan)


@app.middleware("http")
async def _require_token(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    exempt = request.method == "OPTIONS" or request.url.path.rstrip("/") == "/health"
    if ADAPTER_TOKEN and not exempt:
        if not hmac.compare_digest(request.headers.get("x-adapter-token", ""), ADAPTER_TOKEN):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# --------------------------------------------------------------------------- #
# Probing
# --------------------------------------------------------------------------- #
def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _degraded(key: str, detail: str, latency_ms: int) -> dict[str, Any]:
    """Classify a FAILED probe as either 'warming' or 'down'.

    See the module docstring: a cloud engine that scales to zero is not down
    just because it missed a 4s budget. Only a failure that persists past
    COLD_GRACE since the last success is reported as down.
    """
    last = _last_ok.get(key)
    if last is not None and (time.monotonic() - last) <= COLD_GRACE:
        return {
            "up": True,
            "state": "warming",
            "latency_ms": latency_ms,
            "http_status": None,
            "models_loaded": None,
            "detail": f"{detail} (answered OK {int(time.monotonic() - last)}s ago; likely a cold start)",
        }
    return {
        "up": False,
        "state": "down",
        "latency_ms": latency_ms,
        "http_status": None,
        "models_loaded": None,
        "detail": detail,
    }


def _host_of(url: str) -> str:
    return urlsplit(url).netloc or url


async def _probe(key: str, url: str, budget: float) -> dict[str, Any]:
    assert _client is not None  # set by the lifespan handler before serving
    headers: dict[str, str] = {}
    if ADAPTER_TOKEN:
        # /health is token-exempt on every adapter today, so this is belt and
        # braces — it keeps the probe working if that exemption is ever removed.
        # Harmless on the cloud engine, which ignores unknown headers.
        headers["X-Adapter-Token"] = ADAPTER_TOKEN

    t0 = time.perf_counter()
    try:
        # asyncio.wait_for is a second, independent deadline. httpx's own timeout
        # already covers connect/read, but a DNS stall or a stuck TLS handshake
        # has historically been the way "short timeout" services still hang, and
        # property 1 in the module docstring is not negotiable.
        resp = await asyncio.wait_for(
            _client.get(url, headers=headers, timeout=httpx.Timeout(budget, connect=CONNECT_TIMEOUT)),
            timeout=budget + 0.5,
        )
    except TimeoutError:
        return _degraded(
            key, f"no response from {_host_of(url)} within {budget:.0f}s", int((time.perf_counter() - t0) * 1000)
        )
    except Exception as exc:  # noqa: BLE001
        # VERIFIED: httpx's connect/timeout exceptions routinely carry an EMPTY
        # str(), so the obvious f"{type}: {exc}" renders as "ConnectTimeout: "
        # and tells an operator nothing about WHICH host failed. Always name the
        # target — an unresolvable container name and a dead engine produce the
        # same exception class but need very different fixes.
        msg = str(exc).strip()
        detail = f"{type(exc).__name__} contacting {_host_of(url)}" + (f": {msg}" if msg else "")
        return _degraded(key, detail[:200], int((time.perf_counter() - t0) * 1000))

    latency_ms = int((time.perf_counter() - t0) * 1000)

    if resp.status_code != 200:
        return {
            "up": False,
            "state": "down",
            "latency_ms": latency_ms,
            "http_status": resp.status_code,
            "models_loaded": None,
            "detail": f"HTTP {resp.status_code}",
        }

    # A 200 whose body says the models are not loaded is NOT usable. Report it
    # with the vocabulary the rest of the API already uses for this condition
    # (the `engine_not_ready` error code) rather than inventing a new word.
    models_loaded: bool | None = None
    message: str | None = None
    try:
        body = resp.json()
        if isinstance(body, dict):
            raw = body.get("models_loaded")
            models_loaded = bool(raw) if raw is not None else None
            msg = body.get("message")
            message = str(msg) if msg is not None else None
    except ValueError:
        # Engine answered 200 with something that is not JSON. Reachable, but we
        # cannot confirm readiness — treat reachability as the weaker signal.
        pass

    _last_ok[key] = time.monotonic()

    if models_loaded is False:
        return {
            "up": False,
            "state": "not_ready",
            "latency_ms": latency_ms,
            "http_status": 200,
            "models_loaded": False,
            "detail": message or "engine reachable but models are not loaded",
        }

    return {
        "up": True,
        "state": "up",
        "latency_ms": latency_ms,
        "http_status": 200,
        "models_loaded": models_loaded,
        "detail": message,
    }


async def _fan_out() -> dict[str, Any]:
    results = await asyncio.gather(*(_probe(key, url, budget) for key, _, url, budget in ENGINES))
    engines = {key: {"prefix": prefix, **res} for (key, prefix, _, _b), res in zip(ENGINES, results, strict=True)}

    # "ok" requires every engine to be genuinely FAST, not merely usable. An
    # all-"warming" stack still answers `up: true` per engine (send it work), but
    # calling the rollup "ok" would hide the fact that every request right now is
    # paying a cold start — which is the single most common way this deployment
    # looks broken to a user. Reserve "ok" for state=="up" across the board.
    usable = sum(1 for e in engines.values() if e["up"])
    fully_up = sum(1 for e in engines.values() if e["state"] == "up")
    if fully_up == len(engines):
        overall = "ok"
    elif usable > 0:
        overall = "degraded"
    else:
        overall = "down"

    return {
        "status": overall,
        "engines": engines,
        "generated_at": _now_iso(),
        "cache_ttl_s": int(STATUS_TTL),
    }


async def _refresh_once() -> None:
    """Re-probe every engine and replace the cache. Serialised by the lock."""
    async with _refresh_lock:
        # Someone may have refreshed while we waited for the lock.
        if _cache is not None and (time.monotonic() - _cache_at) < STATUS_TTL:
            return
        _cache_set(await _fan_out())


def _spawn_refresh() -> None:
    """Kick off a background refresh unless one is already running.

    The task is held in a module global, not just fired and forgotten: asyncio
    only keeps a weak reference to running tasks, so a local-variable task can be
    garbage-collected mid-flight and silently never finish.
    """
    global _refresh_task
    if _refresh_task is not None and not _refresh_task.done():
        return
    _refresh_task = asyncio.create_task(_refresh_once())


async def _snapshot() -> tuple[dict[str, Any], str]:
    """Return (result, cache_state) where cache_state is HIT | STALE | MISS."""
    if _cache is not None and (time.monotonic() - _cache_at) < STATUS_TTL:
        return _cache, "HIT"

    # STALE-WHILE-REVALIDATE — the property that keeps this endpoint fast.
    #
    # An expired cache is refreshed in the BACKGROUND while the caller is served
    # the previous answer immediately. This is deliberately the same trade
    # nginx already makes for /api/health in this repo (proxy_cache_use_stale +
    # proxy_cache_background_update), and for the same reason: MEASURED, a cold
    # Modal /health blew past a 22s budget, so making callers wait for a fresh
    # probe turns "the cloud engine is warming up" into a 22-second stall on a
    # status endpoint. `generated_at` always states how old the answer is, so a
    # caller who cares can tell.
    if _cache is not None:
        _spawn_refresh()
        return _cache, "STALE"

    # No cached answer at all — only reachable before the startup prime lands.
    # Here we genuinely must wait, bounded by the largest per-engine budget.
    async with _refresh_lock:
        if _cache is not None:
            return _cache, "STALE"
        fresh = await _fan_out()
        _cache_set(fresh)
        return fresh, "MISS"


def _cache_set(fresh: dict[str, Any]) -> None:
    global _cache, _cache_at
    _cache, _cache_at = fresh, time.monotonic()


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@app.get("/health")
async def health() -> JSONResponse:
    """Liveness of THIS adapter only — deliberately probes nothing.

    Keeping it dependency-free means the watchdog can tell "the status service
    is broken" apart from "the status service is fine and reporting bad news".
    Shaped like every other adapter's /health so the same tooling reads it.
    """
    return JSONResponse({"status": "ok", "models_loaded": True, "message": "aggregate status backend"})


@app.get("/status")
async def status() -> JSONResponse:
    """Every engine's state in one call.

    ALWAYS returns HTTP 200, even when `status` is "down". A 503 here would be
    indistinguishable from the status service itself failing, which is precisely
    the ambiguity a caller polls this endpoint to resolve. Branch on the `status`
    field in the body, never on the HTTP code.
    """
    global _last_request
    _last_request = time.monotonic()
    result, cache_state = await _snapshot()
    return JSONResponse(
        result,
        headers={
            "X-Status-Cache": cache_state,
            # This body is a point-in-time measurement; a CDN or browser caching
            # it would hand out stale liveness data long after the TTL expires.
            "Cache-Control": "no-store",
        },
    )
