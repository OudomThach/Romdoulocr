# Romdoul System Architecture

The Romdoul stack: a mobile-first Khmer OCR SPA, five FastAPI adapter sidecars,
a local Surya OCR 2 · vLLM GPU stack, a metadata service + analyst portal, and
the hosting glue (nginx, Netlify, Tailscale) that puts it on the internet.

Repos (all under `C:\Users\USER\work\`):

| Repo | Role |
|---|---|
| `ocrapi_backup` | The SPA + nginx + Netlify config + all 5 adapter sidecars |
| `surya-container-testing` | Local OCR engine: Surya OCR 2 served by vLLM (Flask app on top) |
| `metadata-service` | Extraction metadata store + analyst portal (FastAPI + Postgres + React) |
| `romdoul-dataset` | Public CPI dataset built from OCR sessions |

## System diagram

```mermaid
graph TB
    subgraph Public
        Browser["Browser<br/>(mobile-first SPA)"]
        NL["Netlify<br/>romdoulocr.netlify.app"]
        TS["Tailscale Funnel<br/>apt-server-desktop.ts.net"]
    end

    subgraph HomePC["Home PC (Docker)"]
        NGINX["nginx<br/>SPA + proxy + rate limits + idempotency cache"]
        SPA["SPA build<br/>(Vite dist)"]
        VLLM_AD["vllm-adapter :8090"]
        LENS_AD["lens-adapter :8091"]
        TIDY_AD["tidy-adapter :8092"]
        JOBS_AD["jobs-adapter :8093"]
        STATUS_AD["status-adapter :8094"]
        META["metadata-service :8095<br/>+ Postgres"]
    end

    subgraph GPU["GPU (Docker, surya network)"]
        VLLM["vLLM server<br/>surya-ocr-2 model"]
        FLASK["surya-container-vllm<br/>(Flask app)"]
    end

    subgraph Cloud
        MODAL["Khmer Parsing API<br/>(Modal cloud)"]
        LENSAPI["Google Lens<br/>(unofficial)"]
        ANTHROPIC["Anthropic / Gemini API"]
    end

    Browser --> NL
    NL -->|"/api/*  → Modal direct"| MODAL
    NL -->|"/api-vllm/*  /api-lens/*  /api-tidy/*  /api-meta/*  /portal/*"| TS
    NL -->|"/v1/api/*  versioned"| TS
    TS --> NGINX
    NGINX --> SPA
    NGINX -->|"/api-vllm/*"| VLLM_AD
    NGINX -->|"/api-lens/*"| LENS_AD
    NGINX -->|"/api-tidy/*"| TIDY_AD
    NGINX -->|"/api-jobs/*"| JOBS_AD
    NGINX -->|"/v1/status"| STATUS_AD
    NGINX -->|"/api-meta/*"| META
    NGINX -->|"/portal/*"| META
    NGINX -->|"/api/*  (default engine)"| MODAL

    VLLM_AD -->|"upload/process (stateful)"| FLASK
    FLASK --> VLLM
    LENS_AD --> LENSAPI
    TIDY_AD --> ANTHROPIC
    JOBS_AD -->|"concurrent pages"| MODAL
    JOBS_AD --> VLLM_AD
    JOBS_AD --> LENS_AD
    STATUS_AD -->|"fans out"| MODAL
    STATUS_AD --> VLLM_AD
    STATUS_AD --> LENS_AD

    META --> META_DB[("Postgres<br/>records + audit")]
```

## Data flow — one OCR call

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as nginx
    participant A as vllm-adapter
    participant F as Flask (surya)
    participant V as vLLM (GPU)

    B->>N: POST /api-vllm/parse-pdf (multipart)
    N->>N: rate limit + Idempotency-Key check
    N->>A: POST /parse-pdf (X-Adapter-Token injected)
    A->>A: preprocess image (upscale/deskew/gray)
    A->>F: POST /upload (file)
    F-->>A: file_path
    A->>F: POST /process {file_path, page, mode}
    F->>V: vLLM inference
    V-->>F: HTML blocks + bboxes
    F-->>A: page result
    A->>A: reshape to SPA LayoutRegion[] (labels, pipe tables)
    A-->>N: DocumentResult JSON
    N-->>B: response (cached 24h under Idempotency-Key)
```

## Engine matrix

| Engine | Adapter | Path | Default | Translation | Notes |
|---|---|---|---|---|---|
| vLLM | `vllm-adapter` | `/api-vllm/*` | **✅ default** | ❌ | Local, free; needs GPU container up; auto-fallback to cloud when down |
| Cloud | — (nginx direct) | `/api/*` | fallback | ✅ | Fallback engine when GPU is offline |
| Lens | `lens-adapter` | `/api-lens/*` | optional | ✅ | Google Lens (unofficial); ToS caveat; benchmarking |
| Tidy | `tidy-adapter` | `/api-tidy/*` | — | — | 3-step prompt pipeline (profile→diagnose→code) |
| Jobs | `jobs-adapter` | `/api-jobs/*` | — | — | Async submit/poll, resume on restart |
| Status | `status-adapter` | `/v1/status` | — | — | Cached fan-out; `ok/degraded/down` |

**Backend selection:** fresh visitors default to vLLM (`src/lib/backend.ts`);
the health poller (`src/hooks/useHealth.ts`) auto-switches to the cloud API
when the GPU is unreachable and back again when it recovers — the header shows
a "GPU offline — using cloud" badge while fallback is active. The choice is
persisted in localStorage and overridable at any time via the header toggle.

## Key design decisions (ADRs)

### ADR-001: Same-origin proxying instead of direct API calls
**Status:** Accepted
**Context:** The Modal upstream sends no CORS headers; direct funnel URLs break
on tailnet devices (Local Network Access prompt).
**Decision:** SPA calls relative `/api*` paths; nginx (Docker) and Netlify
rewrites (public) proxy server-side. Browser only ever talks to its own origin.
**Consequences:** No CORS preflight; Netlify's ~26s proxy cap applies to the
public path; Idempotency-Key replay + rate limits live at nginx.

### ADR-002: Sidecar adapters per engine, not in-SPA logic
**Status:** Accepted
**Context:** Each engine (vLLM/Flask, Lens, Anthropic) speaks a different
contract than the SPA's khparser API.
**Decision:** One thin FastAPI sidecar per engine, reached by container name,
guarded by a shared `ADAPTER_TOKEN` secret.
**Consequences:** Adding an engine = new adapter + nginx location + status entry;
SPA tabs stay contract-stable. 5 small services vs one fat monolith.

### ADR-003: Batch jobs as an async service (not long-held connections)
**Status:** Accepted
**Context:** Bulk OCR exceeds gateway ceilings (~26s Netlify / ~300s funnel);
a 10k-doc batch can't be one HTTP call.
**Decision:** `jobs-adapter` accepts upload → returns `job_id` (202) → OCRs pages
concurrently under semaphores → spills results to disk → streams merged result.
Crash recovery resumes unfinished jobs at startup (max 3 resumes).
**Consequences:** Pipelines submit/poll; page failures are per-page, never
job-killing; results stream as JSONL/CSV without loading whole files.

### ADR-004: Metadata as a fire-and-forget side effect
**Status:** Accepted
**Context:** Every parse should feed Data management without ever breaking OCR.
**Decision:** SPA POSTs to `/api-meta/api/v1/records` (open, idempotent by client
id, 2s cap) — unreachable metadata service never affects parsing. `/portal`
serves the analyst UI same-origin.
**Consequences:** Open ingest endpoint requires the nginx rate limit; portal
reads/edits are login-gated.

### ADR-005: Open API with rate limits, not auth, on the GPU path
**Status:** Accepted (revisit before public exposure)
**Context:** One GPU behind the stack; the funnel URL is shared.
**Decision:** No user auth; nginx rate limits (2 req/s sustained, burst 40) +
Idempotency-Key replay + `ADAPTER_TOKEN` on local sidecars.
**Consequences:** Any URL-holder can call, but burst damage is bounded; real
auth/keys documented as the pre-public-exposure step in INTEGRATION.md.

## Deployment topology

```mermaid
graph LR
    subgraph Public
        NETLIFY["Netlify static<br/>(SPA + rewrites)"]
    end
    subgraph Home
        NG["nginx container :8181"]
    end
    subgraph Adapters
        A1["vllm :8090"]
        A2["lens :8091"]
        A3["tidy :8092"]
        A4["jobs :8093"]
        A5["status :8094"]
    end
    subgraph Data
        M["metadata :8095 + Postgres"]
    end
    NETLIFY -->|"Tailscale Funnel"| NG
    NG --> A1 & A2 & A3 & A4 & A5 & M
```

- Public SPA: Netlify build (`npm run build` → `dist`), rewrites proxy engine
  calls to Modal directly and sidecars via the funnel.
- Home: nginx container serves the SPA and proxies; adapters + metadata join
  the `surya-container-vllm_default` Docker network; `tailscale funnel --bg 8181`.
- GPU: `docker compose -f docker-compose.vllm.yml up` (vLLM server + Flask app).

## Rate limits (nginx)

| Zone | Rate | Purpose |
|---|---|---|
| `api_rl` | 120 req/min, burst 40 | all OCR/API calls per client |
| `health_rl` | 600 req/min, burst 20 | health/status polling |
| Idempotency cache | 24h | retry returns original result, no re-OCR |

Errors: structured JSON `{error:{code,message}}` with `429/413/502/504` maps
and `Retry-After` headers for pipeline-safe backoff.
