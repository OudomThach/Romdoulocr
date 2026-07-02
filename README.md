# Khmer Document Parser — UI

A clean, dark-themed web UI for the
[Khmer Document Parser API](https://rinabuoy13--khparser-api.modal.run/docs).

Drop in PDFs or images, get back layout-aware OCR with bounding boxes, bilingual
Khmer → English output, image-only OCR, and table extraction. No backend needed
in this repo — the UI talks directly to the Modal-hosted API.

## Stack

- **Vite + React 18 + TypeScript** — fast dev, full type safety end-to-end
- **Tailwind CSS** — utility-first styling, custom dark palette
- **TanStack Query** — caching, retries, mutation states
- **No backend** — pure SPA; all server logic is the Modal API

## Endpoints exposed by the UI

| UI tab              | API endpoint                  | What it does                                              |
|---------------------|-------------------------------|-----------------------------------------------------------|
| Parse Document      | `POST /parse-pdf`             | Layout regions + OCR + bounding boxes for PDF / image     |
| Parse + Translate   | `POST /parse-pdf-translated`  | Adds Khmer → target translation per region & line         |
| OCR Image           | `POST /ocr-image`             | Quick OCR + confidence for a single image                 |
| Parse Table         | `POST /parse-table`           | Detects rows/cols/cells and reconstructs a table          |
| (header banner)     | `GET /health`                 | Polls every 30s — shows whether models are loaded         |

## Input quality + workflow features

Beyond the raw API options, the UI adds:

- **Image enhancement panel** (image inputs only) — DPI target slider (auto-upscale to chosen DPI, capped at 2× source), contrast, brightness, grayscale, unsharp-mask sharpen, 3×3 median denoise. Live before/after split preview. All native Canvas2D, no extra dependencies.
- **PDF page-range selector** + render DPI dropdown — extract only the pages you care about at 150/200/300/400 DPI in the browser (`pdfjs-dist`), then upload them as PNGs. Avoids burning API quota on a 100-page doc when you only need pages 1-3.
- **Batch queue** with bounded concurrency (default 2), per-file status, individual cancel/retry, "cancel all" — drop 10 files, watch them stream through.
- **Cancel button** on every in-flight request (AbortController → XHR abort) — stop a hung upload without reloading the page.
- **Confidence dashboard** in parsed-document results — average / min / max / three-bucket distribution. Lets you spot pages with weak OCR before you trust the output.
- **Markdown export** (.md) and **searchable PDF export** (.pdf via `pdf-lib`, with embedded text layer using the OCR bounding boxes).
- **CSV export** for parsed tables.

Heavy libraries (`pdfjs-dist`, `pdf-lib`, the pdf.js worker) are split into lazy chunks so the initial page load stays around **74 KB gzipped**. They only load when the user actually needs them.

The image processing and PDF rasterization also run entirely in the browser before upload, so processed images and selected PDF pages are what hits the API — the upstream never sees your untouched originals unless you want it to.

## Run it

### Option A — dev server

```bash
npm install
cp .env.example .env       # optional: override VITE_API_URL
npm run dev                # http://127.0.0.1:5173
```

### Option B — production build

```bash
npm install
npm run build              # outputs dist/
npm run preview            # http://127.0.0.1:4173
```

### Option C — Docker (recommended for deployment)

The included `Dockerfile` is a multi-stage build: `node:22-alpine` builds the
SPA, then `nginx:1.27-alpine` (~40 MB) serves the static output AND
reverse-proxies `/api/*` to the upstream API. The final image is around
**74 MB** and contains only compiled assets + nginx.

```bash
# Build and run with the bundled compose file (defaults to port 8080):
docker compose up --build -d

# Or run the image directly on a custom host port:
docker build -t khmer-parser-ui .
docker run -d --name khmer-parser-ui -p 8181:80 --restart unless-stopped khmer-parser-ui

# Open http://127.0.0.1:8080  (or whichever host port you mapped)
```

#### Why an nginx reverse-proxy

The Modal API does not return `Access-Control-Allow-Origin`, so any
cross-origin fetch from the browser is blocked at the preflight stage. To
make the app "just work" without touching the upstream, the SPA calls
relative URLs (`/api/...`) and nginx in the container reverse-proxies them
to the upstream. Same code path in dev (Vite proxy) and prod (nginx proxy).

If you point at an upstream that *does* send CORS headers, you can bypass
the proxy by setting `VITE_API_URL` to a full URL:

```bash
VITE_API_URL="https://your-cors-enabled-api.example.com" docker compose build
```

Otherwise the default relative `/api` works for any compatible upstream —
just override the proxy target with `API_UPSTREAM` at build time:

```bash
API_UPSTREAM="https://your-api.example.com" docker compose build
```

The nginx config (`nginx.conf`) sets:

- `public, max-age=31536000, immutable` on `/assets/` (Vite's hashed bundles)
- `no-cache, no-store, must-revalidate` on `/` so deployments take effect immediately
- SPA fallback to `/index.html` for unknown paths
- `gzip` on text payloads ≥ 1024 bytes
- 403 on dotfiles (defense in depth — `.env`, `.git`, …)
- `client_max_body_size 100M` so multipart PDF uploads don't get silently truncated
- `/api/` reverse-proxy with `proxy_ssl_server_name on`, `proxy_read_timeout 300s`

## Project layout (feature-first)

```
.
├── Dockerfile                  # Multi-stage build: node builder → nginx static
├── docker-compose.yml          # Build + run convenience
├── nginx.conf                  # SPA config with hashed-asset caching
├── .dockerignore
├── src/
│   ├── App.tsx                 # Tabs + layout shell
│   ├── main.tsx                # React entry + QueryClient
│   ├── index.css               # Tailwind + theme tokens
│   ├── types/api.ts            # TypeScript types mirroring /openapi.json
│   ├── lib/
│   │   ├── api.ts              # Typed fetch + XHR (upload progress) client
│   │   └── utils.ts            # BBox → percent, format helpers, downloads
│   ├── hooks/
│   │   ├── useHealth.ts                # Polls /health every 30s
│   │   ├── useParsePdf.ts              # Mutation wrapping /parse-pdf
│   │   ├── useParsePdfTranslated.ts    # Mutation wrapping /parse-pdf-translated
│   │   ├── useOcrImage.ts              # Mutation wrapping /ocr-image
│   │   └── useParseTable.ts            # Mutation wrapping /parse-table
│   └── components/
│       ├── HealthStatus.tsx
│       ├── FileDropzone.tsx             # Drag/drop, multi-file, type validation
│       ├── BoundingBoxViewer.tsx        # Page preview + bbox overlays + region list
│       ├── ErrorBanner.tsx
│       ├── ProgressBar.tsx
│       ├── ResultsToolbar.tsx           # Copy / download .txt / download .json
│       └── tabs/
│           ├── DocumentParserTab.tsx
│           ├── TranslatedTab.tsx
│           ├── OcrImageTab.tsx
│           └── TableParserTab.tsx
```

## How it talks to the API

- All uploads are `multipart/form-data` exactly as the API expects
- Query params (`detect_layout`, `detect_lines`, `use_ctc`, etc.) are wired
  into toggle controls in the UI
- Uploads use `XMLHttpRequest` so we get real `upload` progress events;
  the result fetch uses the regular `fetch` API
- Errors from the API (4xx/5xx with FastAPI-style `detail`) surface in a
  dedicated `ErrorBanner` rather than as silent failures

## Accepted file types

PDF, PNG, JPG/JPEG, BMP, TIFF, WEBP — enforced in the dropzone before upload
so users get immediate feedback instead of a 422 from the server.

## Notes / limitations

- The Modal API does not return a per-page raster image for PDFs, so the
  DocumentParser / Translated tabs render bbox overlays only when the input
  is a single image. PDFs still produce fully structured text + bboxes.
- For the `parse-pdf-translated` endpoint, source/target language codes are
  exposed as text inputs (defaults: `km` → `en`) — adjust to whatever the
  deployment supports.

## License

MIT
