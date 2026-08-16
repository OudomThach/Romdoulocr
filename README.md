# Romdoul OCR 🌸

> បង្កើតឡើងដោយកូនខ្មែរសម្រាប់ជួយក្នុង OCR និងការស្រង់ឯកសារ
> *Built by young Khmer to help with OCR and document extraction.*

A mobile-first, bilingual (English / ខ្មែរ) web app for Khmer document OCR:
snap or drop an image and the text appears instantly — plus full PDF parsing,
table extraction, Khmer→English translation, and a side-by-side backend
comparison lab. Neon cyberpunk skin, light + dark.

Named after the **romdoul** (រំដួល), Cambodia's national flower.

## Features

- **Guest-first welcome gate** — "Continue as guest" and you're in.
  Google / email sign-in are visible but **not in service yet** (no auth backend).
- **OCR Image (default tab)** — ONE image, zero buttons:
  - auto-OCR the moment you drop / pick / paste / photograph an image
    (`capture="environment"` opens the phone's rear camera)
  - simple **box crop → re-run** (drag a rectangle, done)
  - automatic **full-page fallback** when the layout pass finds no text
    (signs / photos / screenshots often classify as "picture" regions)
  - minimal preprocessing — resize + JPEG encode only; your pixels are not
    silently edited (grayscale/contrast/deskew stay on the document tabs)
- **Parse Document** — layout-aware OCR with bounding boxes, confidence
  dashboard, low-confidence review, region re-OCR, edit-then-export
- **Parse + Translate** — per-region Khmer → target translation
- **Parse Table** — rows/cols/cells reconstruction, CSV / XLSX export
- **Compare** — run the SAME input through both backends side-by-side:
  per-page timing, CER vs ground truth, HuggingFace **parquet dataset eval**
  (client-side via hyparquet), batch runs, `.docx` benchmark reports
- **History** — every run saved to **IndexedDB** (effectively uncapped),
  with source-image thumbnails, favorites, re-use settings
- **Exports** — TXT / MD / JSON / CSV / XLSX / DOCX / HTML / searchable PDF /
  ZIP, all UTF-8-BOM-safe for Khmer in Excel
- **EN / ខ្មែរ UI switch** — shell + OCR tab localized (see
  [`src/lib/i18n.ts`](src/lib/i18n.ts); add a key + `t()` to extend)
- **CTC decoder on by default everywhere** — the autoregressive decoder can
  repetition-loop on noisy Khmer; CTC is forced on at the API layer and in
  every tab default (manual per-session opt-out in Settings)
- **Dual backend at runtime** — cloud **Khmer Parsing API** (default) or a
  local **Surya OCR 2 · vLLM** GPU stack, switchable in the header with live
  health badges

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full system diagram,
data flow, engine matrix and design decisions (ADRs).

```
Browser (React SPA — Vite, Tailwind, zustand, TanStack Query)
   │  relative /api/... calls (no CORS headaches)
   ▼
nginx (Docker, serves dist/ + reverse proxy)
   ├── /api/*       →  Khmer Parsing API (Modal cloud)        [Default]
   ├── /api-vllm/*  →  vllm-adapter (FastAPI sidecar)         [vLLM]
   │                       │  translates khparser contract
   │                       ▼
   │                   surya-container-vllm (Flask + vLLM GPU stack)
   ├── /api-lens/*  →  lens-adapter (Google Lens, unofficial) [Lens]
   ├── /api-tidy/*  →  tidy-adapter (Gemini/Anthropic 3-step) [Tidy]
   ├── /api-jobs/*  →  jobs-adapter (async submit/poll batch) [Jobs]
   ├── /v1/status   →  status-adapter (aggregate health fan-out)
   └── /api-meta/*  →  metadata-service (+ /portal analyst UI)
```

- The Modal upstream sends no `Access-Control-Allow-Origin`, so the SPA calls
  relative URLs and nginx proxies same-origin — identical code path in dev
  (Vite proxy) and prod (nginx).
- The **vLLM adapter** ([`vllm-adapter/`](vllm-adapter/)) adapts the SPA's
  khparser API contract onto the local Surya OCR 2 stack: label mapping,
  HTML-table → pipe-markdown, block HTML → markdown, image preprocessing
  (upscale/deskew where safe), block-OCR→full-page fallback.

## Run it

### Docker (recommended — no local Node needed)

The SPA builds **inside** the image (`node:22-alpine` → `nginx:1.27-alpine`,
final image ≈ 74 MB). Any source change ships with one command:

```bash
# build + run (default port 8080; we use 8181)
PORT=8181 docker compose up -d --build

# open http://localhost:8181
```

Build-time knobs:

```bash
# point at a different khparser-compatible upstream
API_UPSTREAM="https://your-api.example.com" docker compose build

# bypass the proxy entirely (only if the upstream sends CORS headers)
VITE_API_URL="https://your-cors-enabled-api.example.com" docker compose build
```

### Optional: local vLLM backend (GPU)

Requires the `surya-container-vllm` stack running (external Docker network
`surya-container-vllm_default`).

```bash
docker compose -f docker-compose.vllm-adapter.yml up -d --build
```

Then flip the header toggle to **vLLM**. Caveats: no translation on vLLM
(`translated_text` is null); a render-quality DPI toggle appears (vLLM only).
If the GPU container is down after a reboot: `docker start surya-vllm`.

### Dev server (needs Node ≥ 20 locally)

```bash
npm install
npm run dev        # http://127.0.0.1:5173 (Vite proxy handles /api)
npm run typecheck
```

## UI language (i18n)

All shell strings live in a flat dictionary in
[`src/lib/i18n.ts`](src/lib/i18n.ts) (`'key': { en, km }`), consumed via the
`useLocale()` hook's `t('key')`. The EN/ខ្មែរ pill persists to localStorage and
sets `<html lang>`. To localize more of the app: add keys, replace literals
with `t()` — unknown keys safely fall back to English.

## UI ⇄ API map

| UI surface          | Endpoint(s)                    | Notes                                            |
|---------------------|--------------------------------|--------------------------------------------------|
| OCR Image           | `POST /parse-pdf`              | layout pass → auto retry with `detect_layout=false` if no text |
| Parse Document      | `POST /parse-pdf`              | optional second full-page pass merged in         |
| Parse + Translate   | `POST /parse-pdf-translated`   | `source_lang` / `target_lang`                    |
| Parse Table         | `POST /parse-table`            |                                                  |
| Compare             | all of the above, ×2 backends  | per-call backend override                        |
| Health badge        | `GET /health`                  | polled per backend, shows round-trip latency     |

`use_ctc=true` is sent by default on every OCR call.

## Project layout

```
├── Dockerfile                    # multi-stage: node build → nginx serve+proxy
├── docker-compose.yml            # SPA container (PORT, API_UPSTREAM)
├── docker-compose.vllm-adapter.yml
├── nginx.conf                    # SPA fallback, asset caching, /api proxies
├── vllm-adapter/                 # FastAPI sidecar: khparser contract → Surya
├── lens-adapter/                 # Google Lens sidecar (unofficial, benchmarking)
├── tidy-adapter/                 # Transform-to-tidy sidecar (Gemini/Anthropic)
├── jobs-adapter/                 # Async batch jobs (submit → poll → fetch)
├── status-adapter/               # Aggregate health fan-out (GET /v1/status)
└── src/
    ├── App.tsx                   # shell: sidebar, top bar, guest gate, tabs
    ├── lib/                      # api client, i18n, exporters, metrics, storage
    ├── hooks/                    # settings store, batch processor, history
    └── components/
        ├── Sidebar.tsx  LandingGate.tsx  SettingsModal.tsx  SimpleCrop.tsx
        └── tabs/                 # OcrImage, DocumentParser, Translated,
                                  # TableParser, Compare, History
```

## Hosting notes

- **Fastest zero-change path:** keep the container where it is and expose it
  with a **Cloudflare Tunnel** (free HTTPS domain → `localhost:8181`).
- **Static hosts** (Netlify / Cloudflare Pages / Vercel) work if you recreate
  the `/api` proxy with their rewrite/function feature — cloud backend only.
- **Docker hosts / VPS** (Fly.io, Hetzner, DO Singapore) run the image as-is;
  pair with Tailscale if the vLLM toggle should keep reaching a home GPU.
- HTTPS matters: the native clipboard API and PWA install need a secure
  context (an `execCommand` copy fallback covers plain-HTTP LAN use).

## Notes / limitations

- Accounts (Google / email / create) are **placeholders** — guest is the only
  live path until an auth backend exists.
- vLLM mode: translation unavailable; OCR quality on low-res Khmer lines is a
  known model weakness (the cloud backend uses a different model).
- Old History entries created before 2026-07-05 have no source-image thumbnail.

## License

Proprietary — © 2026 Oudom Thach, all rights reserved. See [LICENSE](LICENSE).
Not open source; no permission to use, copy, or distribute without written consent.
