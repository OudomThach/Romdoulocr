# Romdoul OCR — Backend API Reference

Every OCR backend in this project speaks the **same contract** (the "khparser"
contract, named after the original Modal API). That is the whole design: the SPA
has one API client, and switching backends only changes the URL prefix.

A separate **tidy** service has its own small contract (`/tidy`).

- Source of truth: `src/lib/api.ts` (client), `src/types/api.ts` (types),
  `vllm-adapter/app.py`, `lens-adapter/app.py`, `tidy-adapter/app.py`.
- Last verified: 2026-07-28.

---

## 1. Architecture

```
Browser (SPA)
   │  same-origin calls: /api, /api-vllm, /api-lens, /api-tidy
   ▼
Netlify  (hosted build — proxies to the funnel, see netlify.toml)
   │     [ or, at home: straight to nginx on :8181 ]
   ▼
Tailscale Funnel  →  nginx (khmer-parser-ui container)
   ├── /api/*        → https://rinabuoy13--khparser-api.modal.run   (cloud, GPU)
   ├── /api-vllm/*   → vllm-adapter:8090   → Surya OCR 2 on local GPU
   ├── /api-lens/*   → lens-adapter:8091   → Google Lens (unofficial)
   └── /api-tidy/*   → tidy-adapter:8092   → Gemini / Claude
```

nginx injects the `X-Adapter-Token` header server-side, so the browser never
holds a secret.

### Base URLs

| Backend | Prefix | Upstream | Notes |
|---|---|---|---|
| **Default** ("Khmer Parsing API") | `/api` | Modal cloud | GPU, translation, no PC needed |
| **vLLM** ("Surya OCR 2") | `/api-vllm` | local GPU | needs the home GPU running |
| **Google Lens** | `/api-lens` | Google (unofficial) | free, no GPU, needs internet |
| **Tidy** | `/api-tidy` | Gemini/Claude | table reshaping only |

All prefixes are same-origin from the SPA's perspective. Full endpoint =
`<prefix><path>`, e.g. `POST /api-vllm/ocr-image`.

---

## 2. Authentication

**From the browser: none.** The SPA calls same-origin paths and nginx adds the
shared secret.

**Calling an adapter directly** (bypassing nginx, e.g. `localhost:8091`): if that
adapter has `ADAPTER_TOKEN` set, send it:

```
X-Adapter-Token: <token>
```

- Missing/wrong token → `401 {"detail": "unauthorized"}`
- `GET /health` and `OPTIONS` are always exempt (so healthchecks work)
- If `ADAPTER_TOKEN` is unset on the adapter, no token is required

CORS: adapters send `Access-Control-Allow-Origin: *`; nginx strips the upstream
copy and sets its own (two ACAO headers make browsers reject the response).

---

## 3. Shared OCR contract

These five endpoints exist on **Default, vLLM and Lens** with identical shapes.

### `GET /health`

```json
{ "status": "ok", "models_loaded": true, "message": "All models loaded and ready" }
```

`200` = usable. The vLLM adapter returns `503` with `models_loaded: false` when
the GPU service is unreachable.

> `GET /api/health` is **cached by nginx for 120s** (stale-while-revalidate),
> because a cold Modal takes 16–22s to answer. See `nginx.conf`.

---

### `POST /ocr-image`

Single image → plain text. **Multipart**, field name **`file`** (singular).

```json
{ "text": "...", "confidence": 0.94, "filename": "scan.png", "decoder": "ctc" }
```

- `confidence` is `0` on Lens (it provides none).
- The Default backend may return a bare JSON string; the client normalises it
  (`normalizeOcrResponse`).

---

### `POST /parse-pdf`

Full document OCR with layout. **Multipart**, field name **`files`** (plural,
repeatable — multiple files merge into one document with renumbered pages).
Accepts PDFs and images.

Returns a **`DocumentResult`**:

```jsonc
{
  "filename": "report.pdf",
  "num_pages": 3,
  "pages": [
    {
      "page_number": 1,
      "width": 1654,
      "height": 2339,
      "regions": [
        {
          "bbox": { "points": [[x1,y1],[x2,y2],[x3,y3],[x4,y4]], "confidence": 0.99 },
          "region_type": "text",          // text | title | section-header | table
                                          // | list-item | caption | footnote | picture | figure
          "text": "…",
          "confidence": 0.96,
          "lines": [ { "bbox": {...}, "text": "…", "confidence": 0.97 } ],
          "khmer_text": null,
          "english_text": null,
          "crop_base64": null             // set for picture/figure regions
        }
      ]
    }
  ],
  "full_text": "…",                       // may be "" — see the gotcha below
  "translated_text": null,
  "table_crops": [], "figure_crops": [], "image_crops": []
}
```

> ⚠️ **`full_text` can be an empty string** while regions still hold text. Never
> write `full_text ?? fallback` — use `docText()` in `src/lib/documentExport.ts`.

---

### `POST /parse-pdf-translated`

Same request and response as `/parse-pdf`, plus `translated_text` populated.

- **Default**: real Khmer→English translation.
- **Lens**: translation comes from Lens itself.
- **vLLM**: **not supported** — `translated_text` is `null`.

---

### `POST /parse-table`

Table structure extraction. **Multipart**, field name **`file`** (singular).

Returns a **`TableResult`**:

```jsonc
{
  "filename": "invoice.png",
  "num_rows": 12,
  "num_cols": 5,
  "cells": [
    { "row": 0, "col": 0, "text": "Item",
      "bbox": { "points": [[…]], "confidence": 1.0 }, "confidence": 0.98 }
  ],
  "structured_text": "Item\tQty\tPrice\n…",
  "width": 1200, "height": 800,
  "debug_image": null                    // RAW base64 PNG (no data: prefix)
}
```

> `debug_image` / `crop_base64` are **raw base64** — the SPA prepends
> `data:image/png;base64,` itself. Adapters strip any data-URL prefix.

**No-table fallback:** on a page with no detectable table, the adapters return
the page text as a single-column grid (N×1) rather than an empty `0×0`, matching
the cloud API's behaviour.

---

### Query parameters

| Param | Type | Applies to | Default | Honoured by |
|---|---|---|---|---|
| `use_ctc` | bool | ocr-image, parse-pdf(-translated), parse-table | `true` | **Default** only |
| `detect_layout` | bool | parse-pdf(-translated) | — | **Default** only |
| `detect_lines` | bool | parse-pdf(-translated) | — | **Default** only |
| `source_lang` | string | parse-pdf-translated | — | Default, Lens |
| `target_lang` | string | parse-pdf-translated | — | Default, Lens |
| `row_tolerance` | int | parse-table | `20` | **Default** only |
| `dpi` | int | all POST endpoints | `150` | **vLLM** only |

Unknown params are ignored (FastAPI drops them), so the client can send the same
query string to every backend. `use_ctc=true` is forced on `parse-pdf` and
`parse-table` for stability — the autoregressive decoder can hit repetition loops
on noisy Khmer.

`dpi` maps to render quality on vLLM: `96` low / `150` balanced / `300` high.

---

## 4. Tidy service (`/api-tidy`)

Reshapes an OCR'd Markdown table into **tidy data** (one variable per column, one
observation per row). This is a post-extraction transform — it is *not* an OCR
backend and is independent of the backend toggle.

### `GET /api-tidy/health`

```json
{ "status": "ok", "ready": true, "provider": "gemini",
  "model": "gemini-2.5-flash-lite", "pipeline": "never",
  "message": "tidy backend (gemini)" }
```

`pipeline` is `never` | `auto` | `always` (how many LLM calls a transform may spend).

> ⚠️ **`ready` only means a key is *present*, not that it works.** It is not
> validated (that would cost an API call per healthcheck). If `/health` says
> `ready: true` but `/tidy` returns `502 … Gemini HTTP 401 UNAUTHENTICATED`, the
> credential is bad or expired.
>
> **Key format matters.** A Gemini API key from
> [AI Studio](https://aistudio.google.com/apikey) looks like `AIza…` (~39 chars)
> and does not expire. A value starting **`AQ.…`** is a short-lived **OAuth
> access token** — it works for about an hour and then every tidy request fails
> with 401. Put the `AIza…` key in the root `.env` as `GEMINI_API_KEY=` and
> restart: `docker compose -f docker-compose.tidy-adapter.yml up -d`.

### `POST /api-tidy/tidy`

**JSON** body (not multipart):

```json
{ "markdown": "| Province | 2021 | 2022 |\n| --- | --- | --- |\n| Phnom Penh | 10 | 12 |",
  "instructions": "optional extra guidance" }
```

Response:

```jsonc
{
  "columns": ["Province", "Year", "Value"],
  "rows": [["Phnom Penh", "2021", "10"], ["Phnom Penh", "2022", "12"]],
  "tidy_markdown": "| Province | Year | Value |\n| --- | --- | --- |\n…",
  "tidy_csv": "Province,Year,Value\r\nPhnom Penh,2021,10\r\n…",
  "notes": "Unpivoted the year columns into rows.",
  "model": "gemini-2.5-flash-lite",
  "method": "single",        // "single" (1 call) | "pipeline" (3 calls)

  // pipeline runs only:
  "diagnosis": { … },        // step 1 — structural problems found
  "strategy":  { … },        // step 2 — the fix plan
  "code": "def clean(df_raw): …",  // step 3 — generated pandas, executed sandboxed
  "log": ["dropped 2 total rows", "melted 3 year columns"],
  "fallback_reason": "…"     // present only if the pipeline fell back to single-pass
}
```

**How it works.** With `TIDY_PIPELINE=never` (current default) it's one LLM call.
With `auto`/`always` it runs the 3-prompt chain ported from the reference repo:
profile the table (deterministic) → **diagnose** → **strategy** → **generate
pandas** → execute that code in a restricted sandbox (whitelisted builtins,
blocked-construct scan, wall-clock timeout). Any failure falls back to the
single-pass prompt, so a result is always returned.

`tidy_markdown` / `tidy_csv` are built in Python, so they match the SPA's table
shapes exactly. CSV uses CRLF; prepend a UTF-8 BOM before writing a file Excel
will open, or Khmer mojibakes.

---

## 4c. Batch jobs API (`/api-jobs`)

Asynchronous OCR for anything too big or too slow for a synchronous call: submit
once, poll for progress, fetch the merged result. The service splits PDFs into
single pages, drives the engines itself, and survives dropped connections.

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/api-jobs/jobs` | POST | Submit a batch → `202 {"job_id": "..."}` |
| `/v1/api-jobs/jobs` | GET | List jobs (`?limit=&offset=`) |
| `/v1/api-jobs/jobs/{job_id}` | GET | Poll status + progress |
| `/v1/api-jobs/jobs/{job_id}/result` | GET | Merged result (`?format=json|jsonl|csv&partial=true`) |
| `/v1/api-jobs/jobs/{job_id}` | DELETE | Cancel / clean up |
| `/v1/api-jobs/metrics` | GET | Queue depth, per-engine latency percentiles |

**Submit — multipart `files`** (same field-name rules as the sync contract:
`files` plural here, even for `ocr-image`/`parse-table` modes). Query params:

| Param | Default | Notes |
|---|---|---|
| `engine` | `cloud` | `cloud` \| `vllm` \| `lens` |
| `mode` | `parse-pdf` | `parse-pdf` \| `parse-pdf-translated` \| `ocr-image` \| `parse-table` |
| `concurrency` | 6 | in-flight pages per engine (capped: vLLM 6, cloud 8, lens 3) |
| `target_lang` / `source_lang` | — | translated mode only |
| `use_ctc` / `detect_layout` / `detect_lines` / `dpi` / `row_tolerance` | — | same meaning as the sync contract |

Jobs keep state in a named volume (SQLite + `<job>/parts/`), so a restarted
service **resumes** interrupted jobs. Statuses: `queued → running → done | failed | canceled`.
Send `Idempotency-Key` to make re-submits replay instead of re-running.

```bash
# submit a PDF for parsing on the home GPU
curl -s -F "files=@report.pdf" \
  "$BASE/v1/api-jobs/jobs?engine=vllm&mode=parse-pdf&dpi=240"

# poll
curl -s "$BASE/v1/api-jobs/jobs/9f2c..."        # → {"status":"running","done":3,"total":12,...}

# fetch the merged result
curl -s "$BASE/v1/api-jobs/jobs/9f2c.../result?format=json"
```

---

## 4d. Metadata API (`/api-meta`)

Extraction records — the saved OCR results and their metadata (owner, category,
dataset fields, audit trail). Public at `https://romdoulocr.netlify.app/api-meta/api/v1`,
served by the home metadata service (postgres + FastAPI).

**Auth.** Login is session-based:

```bash
curl -s -X POST "$BASE/api-meta/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"...","password":"..."}'
# → {"token":"...", "user":{"username":"...","role":"admin"}}
```

Send `X-Session-Token: <token>` on subsequent calls. Editing (PATCH/DELETE)
requires `admin` or `editor`. `POST /records` is open (extractions auto-save).

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Liveness + DB (no auth) |
| `/auth/login` `/auth/logout` `/auth/me` | POST | Session management |
| `/auth/users` | GET/POST | List / create users (admin) |
| `/records` | GET | List + filter (`type, domain, status, tag, q, page, page_size, sort`) |
| `/records` | POST | Create an extraction record (open, `id` for idempotency) |
| `/records/{id}` | GET | Full record envelope + data |
| `/records/{id}` | PATCH | Edit `data` / `business` / `status`; bumps the audit trail |
| `/records/{id}` | DELETE | Delete (admin) |
| `/records/{id}/history` | GET | Audit trail (create/update/delete events) |
| `/export` | GET | CSV or JSON of filtered records (`?format=csv|json`) |
| `/stats` | GET | Totals by status/type/domain + per-day |
| `/meta` | GET | Distinct types/domains (filter dropdowns) |

**Record shape.** `{id, type, status, source, audit, pipeline, business, data, envelope, created_at, ...}`.
The post-OCR dataset form stores its fields under `data.dataset`:

```jsonc
{ "data": { "dataset": {
    "name": "Cambodia CPI Reports 1994-2025",
    "managed_by": "GDDE, MEF",
    "frequency": "Yearly",
    "coverage_start": "1994-01-01",
    "coverage_end": "2025-12-31",
    "categories": "receipt, bank transfer",
    "url": "https://...",
    "description": "...",
    "file": { "name": "cpi.csv", "size": 4823000, "type": "text/csv" }
}}}
```

Python client: `clients/python/metadata.py` (`MetadataClient`, `AsyncMetadataClient`),
including `airflow_metadata_connection()` for DAGs (env: `ROMDOUL_META_URL`,
`ROMDOUL_META_USER`, `ROMDOUL_META_PASS`).

---

## 4e. Availability — read this before you depend on it

**There is no SLA. This is best-effort.** Be explicit with anyone integrating:

| Engine | Depends on the home PC? | Notes |
|---|---|---|
| `/api` (cloud) via **the SPA** | **No** | Netlify proxies straight to Modal, so it survives the desktop being asleep or rebooting |
| `/v1/api/*` (cloud, integrators) | Yes | Routed through home nginx, which is where rate limiting, structured errors and idempotency live |
| `/v1/api-vllm/*`, `/v1/api-lens/*` | **Yes** | These engines physically run on that machine |
| `/v1/api-jobs/*` | **Yes** | Job state lives on that machine |

A watchdog repairs the stack every 2 minutes, so it is **self-healing, not highly available**:
expect occasional multi-minute gaps, and a hard outage if the machine is off, has no
internet, or reboots without anyone logging in.

**What an integrator should do about it**

- Poll `GET /v1/status` and pick an engine with `up: true`. One call covers all three.
- Treat `state: "warming"` as usable-but-slow (a cold cloud engine takes ~20s), not down.
- **If `/v1/status` itself does not answer, assume the whole deployment is unavailable** — it
  runs on the same machine as the self-hosted engines, so it cannot report its own host being
  down.
- Retry `502`/`503`/`504` with backoff; honour `Retry-After` on `429`.
- **Always send `Idempotency-Key` when retrying or failing over**, so a request that actually
  landed is replayed instead of re-running and double-spending GPU time.
- For anything large, use the batch job API — it survives a dropped connection, which a
  synchronous call does not.

## 5. Errors

Every service returns `{"detail": "..."}` on failure.

| Status | Meaning |
|---|---|
| `400` | Bad request (e.g. empty `markdown`) |
| `401` | Missing/invalid `X-Adapter-Token` |
| `413` | Payload too large (nginx caps uploads at 100MB; tidy caps markdown at 200k chars) |
| `422` | The model declined the input (tidy) |
| `429` | LLM rate limit / quota — tidy sends `Retry-After` |
| `502` | Upstream failed (OCR engine or LLM error) |
| `503` | Backend not ready (vLLM GPU unreachable, or tidy has no API key) |
| `504` | Upstream timeout |

Client-side (`src/lib/api.ts`): `ApiError(status, body, message)`, with
`status: 0` for network failure or the 5-minute client timeout, and a separate
`AbortError` for user cancellation.

---

## 6. Examples

```bash
BASE=https://romdoulocr.netlify.app     # or http://localhost:8181

# health
curl -s $BASE/api/health

# single image OCR (note: field name is "file")
curl -s -F "file=@scan.png" "$BASE/api/ocr-image?use_ctc=true"

# full document (note: field name is "files", repeatable)
curl -s -F "files=@doc.pdf" "$BASE/api/parse-pdf?detect_layout=true&use_ctc=true"

# same page through the local GPU at 300 DPI
curl -s -F "files=@doc.pdf" "$BASE/api-vllm/parse-pdf?dpi=300"

# translate
curl -s -F "files=@khmer.pdf" "$BASE/api/parse-pdf-translated?target_lang=en"

# table
curl -s -F "file=@invoice.png" "$BASE/api/parse-table?row_tolerance=20"

# tidy (JSON, not multipart)
curl -s -X POST "$BASE/api-tidy/tidy" -H "Content-Type: application/json" \
  -d '{"markdown":"| A | 2021 | 2022 |\n| --- | --- | --- |\n| x | 1 | 2 |"}'
```

Direct to an adapter, bypassing nginx (needs the token if one is set):

```bash
curl -s -F "file=@scan.png" -H "X-Adapter-Token: $ADAPTER_TOKEN" \
  http://localhost:8091/ocr-image
```

---

## 7. Choosing a backend

| | Default (Modal) | vLLM (Surya) | Google Lens |
|---|---|---|---|
| Hardware | cloud GPU | your GPU | none |
| Needs the PC | no* | **yes** | no* |
| Khmer quality | best | varies (weak on low-res) | good |
| Translation | ✅ | ❌ | ✅ |
| Table structure | ✅ | ✅ | ❌ (text fallback) |
| Confidence scores | ✅ | ✅ | ❌ (always 0) |
| Cold start | ~22s when idle | ~2 min if the model is unloaded | none |

\* The public site currently routes *everything* through the home nginx, so in
practice the PC must be on for all backends. See `netlify.toml`.

---


## 7b. Testing — one script, every surface

`clients/python/smoke_test.py` hits the whole public API end-to-end:

1. **Status** — `GET /v1/status` (all engines in one call)
2. **Health** — cloud, vLLM, Lens, tidy, jobs
3. **Normal OCR mode** - `ocr-image` through each engine (cloud, vLLM, Lens)
3b. **Document full mode** - `parse-pdf` (page/region/full_text) through cloud + vLLM
3c. **Table mode** - `parse-table` (cell grid) through cloud + vLLM
5b. **Metadata after OCR** - OCR -> auto-save record -> PATCH business/dataset -> verify -> delete
4. **Batch jobs** — submit → poll → fetch the merged result
5. **Metadata** — login, stats, list, create/patch/history/delete a record, CSV/JSON export

```bash
# OCR engines only (no credentials needed):
python clients/python/smoke_test.py

# Full run including the metadata API:
$env:ROMDOUL_META_USER = "admin"
$env:ROMDOUL_META_PASS = "your-password"      # from metadata-service/.env
python clients/python/smoke_test.py
```

Output is `[PASS]/[FAIL]/[SKIP]` per check, a summary line, and a non-zero exit
code if anything failed. Metadata checks are skipped (not failed) when the
credentials are absent, so the OCR side stays runnable for anyone.

Clients you can reuse in your own scripts: `clients/python/romdoul.py`
(sync OCR, retries, idempotency keys, per-page document splitting) and
`clients/python/metadata.py` (records CRUD, export, user management, Airflow
helper). Both are stdlib + `requests`.

## 7c. Interactive docs — Swagger UI

| Service | Swagger UI | OpenAPI spec |
|---|---|---|
| **Full OCR API (custom, branded)** | `https://romdoulocr.netlify.app/api-docs.html` | `/openapi.json` |
| vLLM adapter | `/v1/api-vllm/docs` | `/v1/api-vllm/openapi.json` |
| Lens adapter | `/v1/api-lens/docs` | `/v1/api-lens/openapi.json` |
| Tidy adapter | `/v1/api-tidy/docs` | `/v1/api-tidy/openapi.json` |
| Jobs adapter | `/v1/api-jobs/docs` | `/v1/api-jobs/openapi.json` |
| Status adapter | `/v1/api-status/docs` | `/v1/api-status/openapi.json` |
| Metadata service | `/v1/api-meta/api/docs` | `/v1/api-meta/api/openapi.json` |

All relative to `https://romdoulocr.netlify.app` (public) or
`https://apt-server-desktop.tail806605.ts.net` (direct funnel) or
`http://localhost:8181` (home). The custom `api-docs.html` is the recommended
entry point for integrators — it documents the whole OCR contract across all
three engines in one page; the per-service `/docs` pages are the raw FastAPI
schemas (useful for jobs/metadata specifics).

## 7d. Airflow integration

Yes — the API is built for it. Both clients are stdlib + `requests`, thread-safe
for parallel page OCR, and the metadata client has an Airflow helper:

```python
from metadata import airflow_metadata_connection
client = airflow_metadata_connection()   # reads ROMDOUL_META_URL/USER/PASS
```

Ready-to-copy DAGs live in `clients/python/airflow_examples.py`:

| DAG | Schedule | What it does |
|---|---|---|
| `romdoul_daily_export` | `@daily` | Pulls yesterday's records → timestamped CSV |
| `romdoul_health_check` | every 5 min | Probes metadata + cloud + vLLM health, alerts on failure |
| `romdoul_ocr_to_metadata` | manual | OCRs a list of files (vLLM) → auto-saves each to metadata |
| `romdoul_weekly_report` | `@weekly` | Stats summary (ready for a Slack hook) |

Setup: `pip install requests apache-airflow`, copy `romdoul.py` + `metadata.py`
into your `dags/` folder (or PYTHONPATH), set the three env vars above.

Key points for pipelines:
- `POST /records` is **open** — extraction DAGs can save records without any
  credential (see DAG 3, which uses `MetadataClient()` with no auth).
- Editing metadata (PATCH) needs the session login — the client handles it.
- Retry any `5xx`/timeout with the same `Idempotency-Key`; the batch jobs API
  (`/v1/api-jobs`) survives dropped connections for long documents.

## 8. Operations

| Concern | Where |
|---|---|
| Routing / CORS / health cache | `nginx.conf` |
| Public routing | `netlify.toml` |
| Auto-restart & health monitoring | `ops/keepalive.ps1` (every 2 min) |
| One-click watchdog install | `ops/install-keepalive.ps1` |

Deploy an adapter change:

```bash
docker compose -f docker-compose.tidy-adapter.yml up -d --build
```

Deploy an nginx/SPA change (the image build is also the typecheck — there is no
local Node):

```bash
docker compose up -d --build
```

> ⚠️ Rebuilding the main stack recreates its Docker network and temporarily
> orphans the adapters (they return `502`). Run `ops/keepalive.ps1` once
> afterwards — or wait ~2 min for the watchdog — to re-attach them.
