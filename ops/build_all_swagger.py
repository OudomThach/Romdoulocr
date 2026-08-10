"""
Build the all-in-one Swagger spec: public/openapi.json.

Merges every service's OpenAPI spec into a single document served at
/api-docs.html (Swagger UI) + /openapi.json:
  - the hand-curated OCR spec (already in public/openapi.json): /api, /api-vllm,
    /api-lens, /api-jobs, /status
  - jobs adapter spec (live): /api-jobs/* incl. /metrics
  - tidy adapter spec (live): /api-tidy/*
  - status adapter (no spec served - hand-written): /api-status/*
  - metadata service spec (live, custom /api/docs): /api-meta/*

Schema names from the extra specs are prefixed (J_, Tidy_, S_, Meta_) so they
can never collide with the base spec; every internal $ref is rewritten to match.

Run (after deploying adapter changes, to refresh the merged spec):
    python ops/build_all_swagger.py
"""

from __future__ import annotations

import json
import os
import urllib.request

BASE = "https://romdoulocr.netlify.app"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "openapi.json")

JOBS_SPEC = f"{BASE}/v1/api-jobs/openapi.json"
TIDY_SPEC = f"{BASE}/v1/api-tidy/openapi.json"
META_SPEC = f"{BASE}/v1/api-meta/api/openapi.json"


def fetch(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.load(resp)


def rewrite_refs(obj, prefix: str):
    """Deep-rewrite '#/components/schemas/X' -> '#/components/schemas/{prefix}X'."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "$ref" and isinstance(v, str) and v.startswith("#/components/schemas/"):
                out[k] = f"#/components/schemas/{prefix}{v[len('#/components/schemas/'):]}"
            else:
                out[k] = rewrite_refs(v, prefix)
        return out
    if isinstance(obj, list):
        return [rewrite_refs(v, prefix) for v in obj]
    return obj


def add_service(merged: dict, spec: dict, path_prefix: str, schema_prefix: str) -> int:
    """Copy all paths of a spec under path_prefix; rename its schemas."""
    n = 0
    for path, ops in (spec.get("paths") or {}).items():
        public = f"{path_prefix}{path}"
        merged.setdefault("paths", {})[public] = rewrite_refs(ops, schema_prefix)
        n += 1
    for name, schema in (spec.get("components", {}).get("schemas") or {}).items():
        merged.setdefault("components", {}).setdefault("schemas", {})[f"{schema_prefix}{name}"] = schema
    return n


def add_handwritten_status(merged: dict) -> None:
    """The status adapter serves no /openapi.json (nginx answers HTML), so its
    two endpoints are written from the code (status-adapter/app.py)."""
    status_paths = {
        "/api-status/health": {
            "get": {
                "summary": "Status adapter liveness",
                "tags": ["Status"],
                "responses": {"200": {"description": "OK"}},
            }
        },
        "/api-status/status": {
            "get": {
                "summary": "Aggregate engine status (cloud, vLLM, Lens)",
                "tags": ["Status"],
                "responses": {"200": {"description": "JSON of per-engine liveness"}},
            }
        },
    }
    merged.setdefault("paths", {}).update(status_paths)


def main() -> int:
    base = json.load(open(OUT, encoding="utf-8"))  # the hand-curated OCR spec

    jobs = fetch(JOBS_SPEC)
    tidy = fetch(TIDY_SPEC)
    meta = fetch(META_SPEC)

    n_jobs = add_service(base, jobs, "/api-jobs", "J_")
    n_tidy = add_service(base, tidy, "/api-tidy", "Tidy_")
    n_meta = add_service(base, meta, "/api-meta", "Meta_")
    add_handwritten_status(base)

    base["info"]["title"] = "Romdoul OCR — Complete API (all services)"
    base["info"]["version"] = "1.0.0-all"
    base["info"].setdefault("description", "")
    base["info"]["description"] = (
        base["info"]["description"]
        + "\n\n---\n\nThis is the merged all-in-one spec: OCR engines (`/api`, `/api-vllm`, "
        "`/api-lens`), batch jobs (`/api-jobs`), tidy (`/api-tidy`), aggregate status "
        "(`/api-status`) and the metadata service (`/api-meta`). Every service also exposes "
        "its own FastAPI Swagger at `/docs` (metadata: `/api/docs`)."
    )

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(base, fh, ensure_ascii=False, indent=2)

    print(f"merged spec written: {OUT}")
    print(f"  paths: {len(base['paths'])}  (jobs +{n_jobs}, tidy +{n_tidy}, metadata +{n_meta}, status +2)")
    print(f"  schemas: {len(base['components'].get('schemas', {}))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
