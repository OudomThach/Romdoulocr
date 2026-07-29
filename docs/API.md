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
