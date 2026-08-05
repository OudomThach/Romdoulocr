# Romdoul OCR — Python client

`romdoul.py` is one self-contained module. Copy it into your project (or add
this folder to `PYTHONPATH`) — there is nothing to `pip install` except
`requests`, which you almost certainly already have.

```bash
pip install requests          # required
pip install pypdf             # optional, but you want it for PDFs — see below
```

Tested against Python 3.10. No global state; one client is safe to share across
threads — each thread gets its own `requests.Session`. The exception is a
caller-supplied `session=`: that one object is handed to every thread, including
`parse_document_pages`' workers, and `requests.Session` is not thread-safe. Only
pass it if you need custom auth/proxies/mounts, and then own the locking.

Keep one client for the life of the process and reuse it. Sessions belong to the
thread that made them and the page-OCR thread pool is created once, so neither
grows with the number of documents; `close()` is tidy-up, not a leak fix.

## Quickstart

```python
from romdoul import RomdoulClient

client = RomdoulClient()                       # cloud engine, direct funnel
print(client.health())                         # {'status': 'ok', ...}
print(client.ocr_image("scan.png")["text"])    # one image -> text
doc = client.parse_document_pages("report.pdf", concurrency=4)
print(client.text_of(doc))                     # full document text
```

Defaults: `base_url="https://apt-server-desktop.tail806605.ts.net/v1"`,
`engine="cloud"`, `timeout=300`, `max_retries=3`. Use
`https://romdoulocr.netlify.app/v1` only from a browser-ish context — that proxy
cuts requests off at ~26 s and real OCR pages take longer.

## Surface

| Call | Returns |
|---|---|
| `health()` | `{"status", "models_loaded", "message"}` |
| `ocr_image(path_or_bytes, *, use_ctc=True, idempotency_key=None, filename=None, dpi=None)` | `{"text", "confidence", "filename", "decoder"}` |
| `parse_table(path_or_bytes, *, row_tolerance=None, ...)` | `TableResult` — `num_rows`, `num_cols`, `cells`, `structured_text` |
| `parse_document(path, *, translate=False, target_lang="en", ...)` | `DocumentResult`, whole file in one request |
| `parse_document_pages(pdf_path, *, concurrency=4, on_progress=None, fail_fast=True, filename=None, **opts)` | one merged `DocumentResult`, pages OCR'd concurrently |
| `text_of(document_result)` | plain text, handling the `full_text` gotcha |
| `with_engine("vllm")` | sibling client on another engine |

## Metadata client

`metadata.py` — same philosophy (stdlib + requests, one file). Covers the
extraction-records API. Copy it next to `romdoul.py`.

```python
from metadata import MetadataClient

c = MetadataClient("admin", "romdoul-v1cgt5jkq492dhzymlwr")

# Browse
c.health()                              # liveness + DB check
c.stats()                               # aggregates by status/type/domain
c.list_records(type="document", page_size=50, sort="created_at:desc")
c.get_record("id")                      # full envelope + data
c.record_history("id")                  # audit trail (who/what/when)

# Edit (admin/editor role needed)
c.patch_record("id", data={"price": 12}, business={"domain": "retail"})

# Ingest (POST /records is OPEN — no auth needed)
c.create_record({"type": "invoice", "source": {"filename": "inv.pdf", "model": "vllm"}, "data": {...}})

# Export
c.export_csv("out.csv", domain="logistics")
c.export_json(type="document")

# User management (admin only)
c.create_user("dara", "pass", role="editor")
c.list_users()
c.update_user(42, role="admin")
```

### Quick smoke test (no OCR needed, 2 seconds)

```bash
python smoke_test.py
```

## Airflow integration

Four ready-to-copy DAGs in `airflow_examples.py`:

| DAG | What |
|---|---|
| `romdoul_daily_export` | @daily — export yesterday's records to CSV |
| `romdoul_health_check` | @5min — check metadata + all OCR engines are alive |
| `romdoul_ocr_to_metadata` | manual — OCR a list of documents, POST each result to the metadata service |
| `romdoul_weekly_report` | @weekly — stats summary |

### Setup (2 minutes)

1. Copy `metadata.py`, `romdoul.py`, and `airflow_examples.py` into your Airflow `dags/` folder
2. Set Airflow Variables:
   ```
   ROMDOUL_META_USER=admin
   ROMDOUL_META_PASS=romdoul-v1cgt5jkq492dhzymlwr
   ROMDOUL_META_URL=https://romdoulocr.netlify.app/api-meta
   ```
3. Enable the wanted DAGs in the Airflow UI

### Without Airflow — the same client works anywhere

```python
# Jupyter notebook
from metadata import MetadataClient
c = MetadataClient("admin", "romdoul-v1cgt5jkq492dhzymlwr")
df = pd.DataFrame(c.export_json(type="document"))

# cron job
# */5 * * * * python -c "from metadata import MetadataClient; MetadataClient().health()"

# Dagster
@asset
def romdoul_metadata() -> list[dict]:
    return MetadataClient(USER, PASS).export_json()

`**opts` on `parse_document_pages` are the per-page request options —
`translate`, `target_lang`, `source_lang`, `detect_layout`, `detect_lines`,
`use_ctc`, `dpi` — applied to every page. It is *not* the whole `parse_document`
signature: `filename` is a parameter in its own right (above), `idempotency_key`
is ignored because every page derives its own, and anything else raises
`TypeError` naming the argument.

Anywhere a file is taken you may pass a path, `bytes`, or an open binary file
object. Bytes are identified by their magic bytes (PDF / PNG / JPEG / TIFF /
GIF / BMP / WEBP), so a PNG handed over as `bytes` is uploaded as a PNG, not as
`document.pdf`. Pass `filename=` to name it yourself — the engines echo it back,
and it feeds the idempotency key.

## Recipe: a 500-page PDF

```python
from romdoul import RomdoulClient, RomdoulError

client = RomdoulClient()          # funnel base URL: ~300 s ceiling, not 26 s

def progress(done, total):        # runs in THIS thread, not a worker — no locking needed
    print(f"\r{done}/{total} pages", end="", flush=True)

doc = client.parse_document_pages(
    "big-report.pdf",
    concurrency=4,
    on_progress=progress,
    fail_fast=False,              # finish the job, collect the casualties
)

with open("big-report.txt", "w", encoding="utf-8") as fh:
    fh.write(client.text_of(doc))

for bad in doc["failed_pages"]:   # [] when everything worked
    print(bad)                    # {'page_number': 231, 'code': 'engine_timeout', ...}
```

What that does, and why it is not the same as posting the whole PDF:

- **It splits locally** (via `pypdf`) and sends one page per request, so no
  single request goes near the 300 s gateway ceiling or the 100 MB upload cap.
  Without `pypdf` installed it warns and posts the whole file — which works for
  a few pages and times out for 500. Install `pypdf`.
- **It is resumable for free.** Every page carries an `Idempotency-Key` derived
  from that page's bytes, and nginx replays a stored response for 24 h. Re-run
  the script after a crash and the pages that already finished come back from
  cache in milliseconds without touching the GPU.
- **Page numbers stay honest.** Pages are renumbered 1..N in source order, and a
  failed page (with `fail_fast=False`) becomes an empty placeholder rather than
  silently shifting everything after it up by one.
- **Concurrency 4–8 is the sweet spot.** The gateway allows 120 requests/minute
  per IP (burst 40) and there is exactly one GPU behind all of this. Higher
  concurrency just converts into 429s that the client then sleeps off.
- **Watch memory on very large jobs.** `crop_base64` and the crop lists are
  inline base64; 500 image-heavy pages held as one dict can get fat. If that
  bites, split the PDF yourself and call `parse_document_pages` per 50-page
  chunk, writing each chunk's text out as you go.
- **`fail_fast=True` raises at once, but does not stop the GPU.** Queued pages
  are cancelled; the handful already in flight cannot be — an HTTP request in
  progress has no cancel. They finish in the background and their responses land
  in nginx's replay cache, so re-running the job picks them up for free. The
  error itself reaches you immediately rather than after the slowest in-flight
  page.

Translation is the same call with `translate=True, target_lang="en"`. The cloud
engine translates properly. Lens also translates, but only into English — its
adapter hardcodes the target language, so `target_lang=` is accepted and then
ignored. vLLM does not translate at all and returns `translated_text: None`.

## Engines

```python
RomdoulClient(engine="cloud")   # /api       Modal cloud GPU   (default)
RomdoulClient(engine="vllm")    # /api-vllm  Surya OCR 2, home GPU
RomdoulClient(engine="lens")    # /api-lens  Google Lens
```

| | cloud | vllm | lens |
|---|---|---|---|
| Khmer quality | best | varies, weak on low-res | good |
| Translation | yes | no | English only, `target_lang=` ignored |
| Table structure | yes | yes | best-effort: rows/columns reconstructed from word geometry, no table model |
| `confidence` | often absent on `/ocr-image` → `None` | real numbers | always `0.0` |
| Cold start | ~22 s when idle | ~2 min if the model is unloaded | none |
| `dpi=` honoured | no | yes (96 / 150 / 300) | no |

In practice all three route through the home nginx, so the PC has to be on
regardless of which you pick. Compare two engines on the same page with
`client.with_engine("lens").ocr_image(path)`.

## Errors

Every failure raises `RomdoulError`. Branch on `err.code`, never on
`err.message` — prose changes, codes do not. Also available: `err.status`,
`err.retry_after`, `err.body`.

| `code` | HTTP | What happened | What to do |
|---|---|---|---|
| `rate_limited` | 429 | 120 req/min per IP exceeded | Already retried after `Retry-After`. If you still see it, lower `concurrency`. |
| `payload_too_large` | 413 | Upload over 100 MB | Use `parse_document_pages`, or split the file. |
| `engine_unreachable` | 502 | Engine down, or adapters orphaned after a `docker compose up --build` | Retried automatically. If it persists, the PC/GPU is off or `ops/keepalive.ps1` needs a run. |
| `engine_timeout` | 504 | Request exceeded the gateway ceiling | Send fewer pages per request — i.e. use `parse_document_pages`. |
| `engine_not_ready` | 503 | vLLM GPU unreachable or model unloaded | Wait ~2 min for the model to load, or switch engine. |
| `bad_request` | 400 / 422 | Malformed request — nearly always a wrong multipart field name | Not retried. Use the client's methods; they get the field names right. |
| `input_declined` | 422 | The engine rejected the input as unparseable. Emitted by the batch job service (per failed page), not by the synchronous endpoints this client calls. | Change the input; retrying is pointless. |
| `unauthorized` | 401 | Calling an adapter directly with `ADAPTER_TOKEN` set | Pass `RomdoulClient(..., adapter_token="…")`. Not needed through nginx. |
| `not_found` | 404 | The engine prefix resolved but the endpoint did not — e.g. an adapter older than the endpoint you called | Check the engine actually implements it; `health()` first. |
| `http_error` | any | A status this client has no specific code for. Overwhelmingly a **405 from a wrong `base_url`**: `/v2` or `/v1/typo` falls through to the SPA's `location /`, which answers a POST with `405 Not Allowed`. `health()` on such a URL does not raise at all — it gets a 200 HTML page and returns `{"status": "unknown", "message": "<!doctype html>…"}`. | Check `base_url` ends in `/v1`. |
| `engine_error` | 500 | The engine could not parse this file | Not retried — it fails identically every time. Fix or skip the input. |
| `network_error` | 0 | DNS, refused connection, or read timeout | Retried with backoff. If it persists, the funnel or the PC is down. |
| `bad_response` | 200 | Success, but not the JSON object we expected | Report it; `err.body` has the payload. |

## Gotchas worth knowing

- **`full_text` can be an empty string** while the regions underneath hold every
  word. `doc["full_text"] or ""` silently loses the whole document. Use
  `client.text_of(doc)`, which falls back to the region text.
- **Multipart field names differ per endpoint** — `file` (singular) for
  `/ocr-image` and `/parse-table`, `files` (plural, repeatable) for
  `/parse-pdf*`. Get it wrong and you get a 422 that says
  `body.file: Field required`. The client handles this.
- **Do not hand-roll an `Idempotency-Key` and reuse it across engines.** The
  gateway's cache key does not include the engine prefix or the query string, so
  the same key sent to `/api-lens` and then `/api-vllm` returns the *Lens*
  result with `X-Idempotency-Replay: HIT`. The client derives its keys from
  engine + endpoint + query + file bytes, so this cannot happen — but if you
  pass `idempotency_key=` yourself, make it unique per engine and per query.
  Pass `idempotency_key=""` to send no key at all and force a fresh run.
- **`confidence` is not comparable across engines.** Cloud omits it entirely
  (the client reports `None`, not a fake `0.0`), Lens always sends `0.0`, vLLM
  sends real numbers.

## Smoke test

```bash
python romdoul.py health
python romdoul.py ocr scan.png
python romdoul.py doc report.pdf
# ROMDOUL_ENGINE=vllm and ROMDOUL_BASE_URL=... override the defaults
```
