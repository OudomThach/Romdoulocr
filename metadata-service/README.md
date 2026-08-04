# Metadata Service

Domain-agnostic extraction-metadata service + analyst portal. Every extracted record gets an envelope (source, audit, pipeline, business) + free-form `data`. Built for the Romdoul OCR stack but consumes records from anything.

## Stack

- **API**: FastAPI + SQLAlchemy (async) + Postgres, Alembic migrations
- **Portal**: React + Vite + Tailwind + TanStack Query (served by the API container)
- **Deploy**: one Docker image (`metadata-service`) + one Postgres container

## Quick start

```bash
cp .env.example .env        # then set METADATA_API_KEYS to your team password
docker compose up -d --build
```

- Portal: http://localhost:8095 (also live at **https://romdoulocr.netlify.app/portal** via the Romdoul funnel)
- OpenAPI docs: http://localhost:8095/api/docs
- Postgres: localhost:5433 (user/pass/db: `metadata`)

## Login (multi-user)

The portal is gated behind real accounts: `users` + `sessions` tables, PBKDF2
password hashing, 30-day session tokens. Sign in with username + password —
every edit is attributed to that user (`edited_by: user:<name>`).

- `POST /api/v1/auth/login` — `{"username", "password"}` → `{token, user: {username, role}}`
- `POST /api/v1/auth/logout` — revokes the session
- `GET /api/v1/auth/me` — current user
- Roles: `admin` (full access) / `viewer` (read + export; PATCH/DELETE blocked by the UI only for now — role checks enforced server-side for future endpoints)
- First admin is seeded on boot from `METADATA_ADMIN_USERNAME` / `METADATA_ADMIN_PASSWORD`
- Machine access: `X-API-Key` with one of `METADATA_API_KEYS` still works (external consumers)
- **`POST /api/v1/records` is deliberately open** — extraction pipelines record
  from anywhere without leaking credentials into a public bundle (idempotent by
  client-supplied `id`, rate-limited at nginx).

## Ingesting records

```bash
curl -X POST http://localhost:8095/api/v1/records \
  -H "Content-Type: application/json" \
  -d '{
    "id": "optional-client-id",          # idempotent; 409 on duplicate
    "type": "invoice",
    "source": {"document_id": "doc_1", "filename": "scan.pdf", "page": 1,
               "extracted_at": "2026-08-04T07:00:00Z", "model": "surya-vllm-v2"},
    "pipeline": {"run_id": "run_1", "batch_id": "batch_1", "version": "1.2.0"},
    "business": {"date": "2026-08-01", "tags": ["import"], "domain": "logistics"},
    "data": {"order_no": "INV-2201", "amount": 1500}
  }'
```

Rules: `data` is the only domain-dependent part. The envelope is fixed for every document type. Status lifecycle: `raw → edited → verified`. Every change writes an immutable audit entry and bumps `edit_count`.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/records` | Ingest (client id = idempotent) |
| GET | `/api/v1/records` | List — filters: `type`, `domain`, `status`, `tag`, `business_from/to`, `created_from/to`, `q`; pagination `page`, `page_size` (≤200); `sort=col:asc\|desc` |
| GET | `/api/v1/records/{id}` | One record |
| PATCH | `/api/v1/records/{id}` | Edit `data` / `business` / `status`; header `X-Edited-By: user:<name>`; audit auto-updated |
| DELETE | `/api/v1/records/{id}` | Delete (audit entry kept) |
| GET | `/api/v1/export?format=csv\|json` | Export (flattened CSV for spreadsheets) |
| GET | `/api/v1/stats` | Aggregates by status/type/domain, per-day |
| GET | `/api/v1/meta` | Distinct types/domains for filter dropdowns |
| GET | `/health` | Liveness + DB check |

### Auth

Portal users: username + password (`users`/`sessions`, PBKDF2 hashed, 30-day
tokens) — session sent as `X-Session-Token`. Machine consumers: `X-API-Key`.
`POST /records` stays open so pipelines record without shipping credentials.

| Method | Path | Auth |
|---|---|---|
| POST | `/api/v1/records` | open |
| POST | `/api/v1/auth/login` | open |
| GET | `/api/v1/auth/me`, POST `/api/v1/auth/logout` | session |
| GET | `/api/v1/records` … | session or `X-API-Key` |
| GET | `/api/v1/records/{id}` | session or `X-API-Key` |
| PATCH/DELETE | `/api/v1/records/{id}` | session or `X-API-Key` |
| GET | `/api/v1/export` | session or `X-API-Key` |
| GET | `/api/v1/stats`, `/api/v1/meta` | session or `X-API-Key` |
| GET | `/health`, `/api/docs` | open |

### Error format

```json
{ "error": { "code": "duplicate_id", "message": "record rec-x already exists" } }
```
Codes: `validation_error`, `not_found`, `duplicate_id`, `invalid_status`, `http_error`.

## Development

```bash
# backend tests (SQLite, no Docker needed)
cd backend && python -m pytest tests

# portal dev server (needs Node)
cd web && npm install && npm run dev   # http://127.0.0.1:5174, proxies /api to :8095
```

## Database

Migrations run automatically on container start (`alembic upgrade head`). To migrate manually:

```bash
cd backend
alembic upgrade head    # or: alembic revision --autogenerate -m "..."
```

Tables: `records` (queryable envelope columns + JSONB `envelope`/`data`), `audit_log` (immutable history).

## Integration with Romdoul OCR

The Romdoul SPA sends one fire-and-forget POST per successful parse (see `ocrapi_backup` api layer). Failure to reach the metadata service never affects parsing.
