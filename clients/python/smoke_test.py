"""
End-to-end smoke test for the Romdoul OCR API — every public surface, one script.

Sections:
  1. Aggregated status      GET /v1/status
  2. Engine health          cloud / vLLM / Lens / tidy / jobs
  3. Normal OCR mode        /ocr-image through each engine (cloud, vLLM, Lens)
  3b. Document full mode    /parse-pdf (document result) through cloud + vLLM
  3c. Table mode            /parse-table (cell grid) through cloud + vLLM
  4. Async batch job        submit -> poll -> fetch result (jobs API)
  5. Metadata API           full CRUD + stats + export (login required)
  5b. Metadata after OCR    OCR -> auto-save record -> patch business/dataset
                           -> verify -> delete (the post-OCR flow end to end)

Run:
    python smoke_test.py

Environment:
    ROMDOUL_BASE_URL    API base, default https://romdoulocr.netlify.app
    ROMDOUL_META_URL    metadata base, default <base>/api-meta
    ROMDOUL_META_USER   metadata username  (required for sections 5/5b)
    ROMDOUL_META_PASS   metadata password  (required for sections 5/5b)

Exit code is 0 only when every executed check passed; sections that cannot run
(e.g. no test image, no metadata credentials) are skipped, not failed.

The test image is rendered with PIL when available, else the repo's ops/warm.png.
"""

from __future__ import annotations

import io
import os
import sys
import time
import uuid

import requests

from romdoul import RomdoulClient, RomdoulError
from metadata import MetadataClient, MetadataError

BASE = os.environ.get("ROMDOUL_BASE_URL", "https://romdoulocr.netlify.app").rstrip("/")
META_BASE = os.environ.get("ROMDOUL_META_URL", f"{BASE}/api-meta").rstrip("/")
META_USER = os.environ.get("ROMDOUL_META_USER", "").strip()
META_PASS = os.environ.get("ROMDOUL_META_PASS", "").strip()

PASS = "PASS"
FAIL = "FAIL"
SKIP = "SKIP"
results: list[tuple[str, str, str]] = []


def check(section: str, name: str, ok: bool, detail: str = "") -> None:
    status = PASS if ok else FAIL
    results.append((section, status, name))
    suffix = f" — {detail}" if detail else ""
    print(f"[{status}] {section}: {name}{suffix}")


def skip(section: str, name: str, reason: str) -> None:
    results.append((section, SKIP, name))
    print(f"[SKIP] {section}: {name} — {reason}")


def make_test_image() -> bytes | None:
    """Render 'Smoke test <year>' on a small white PNG; PIL optional."""
    try:
        from PIL import Image, ImageDraw, ImageFont  # type: ignore[import-not-found]
        img = Image.new("RGB", (640, 200), "white")
        draw = ImageDraw.Draw(img)
        try:
            font = ImageFont.truetype("arial.ttf", 42)
        except Exception:  # noqa: BLE001
            font = ImageFont.load_default()
        draw.text((24, 70), f"Smoke test {time.strftime('%Y')}", fill="black", font=font)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        warm = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "ops", "warm.png")
        if os.path.exists(warm):
            with open(warm, "rb") as fh:
                return fh.read()
        return None


def make_table_image() -> bytes | None:
    """Render a tiny 3x3 table (grid + labels) — for the parse-table checks."""
    try:
        from PIL import Image, ImageDraw, ImageFont  # type: ignore[import-not-found]
        img = Image.new("RGB", (480, 240), "white")
        draw = ImageDraw.Draw(img)
        try:
            font = ImageFont.truetype("arial.ttf", 26)
        except Exception:  # noqa: BLE001
            font = ImageFont.load_default()
        # header + two data rows, three columns
        cells = [["Item", "Qty", "Price"], ["Rice", "10", "2500"], ["Fish", "3", "18000"]]
        cw, ch, x0, y0 = 160, 80, 0, 0
        for r, row in enumerate(cells):
            for c, val in enumerate(row):
                cx, cy = x0 + c * cw, y0 + r * ch
                draw.rectangle([cx, cy, cx + cw, cy + ch], outline="black", width=2)
                draw.text((cx + 12, cy + 22), val, fill="black", font=font)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------- #
# 1. Aggregated status
# --------------------------------------------------------------------------- #
def section_status() -> None:
    try:
        r = requests.get(f"{BASE}/v1/status", timeout=30)
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        ok = r.status_code == 200 and isinstance(body.get("engines"), dict)
        check("status", "GET /v1/status", ok, f"HTTP {r.status_code}")
        if ok:
            for engine, st in body["engines"].items():
                check("status", f"  engine '{engine}'", st.get("up") is not None, str(st.get("up")))
    except Exception as exc:  # noqa: BLE001
        check("status", "GET /v1/status", False, str(exc))


# --------------------------------------------------------------------------- #
# 2. Engine health
# --------------------------------------------------------------------------- #
def section_health() -> None:
    for label, path in [
        ("cloud", "/v1/api/health"),
        ("vllm", "/v1/api-vllm/health"),
        ("lens", "/v1/api-lens/health"),
        ("tidy", "/v1/api-tidy/health"),
        ("jobs", "/v1/api-jobs/health"),
    ]:
        try:
            r = requests.get(f"{BASE}{path}", timeout=45)
            check("health", label, r.status_code == 200, f"HTTP {r.status_code}")
        except Exception as exc:  # noqa: BLE001
            check("health", label, False, str(exc))


# --------------------------------------------------------------------------- #
# 3. Real OCR through each engine
# --------------------------------------------------------------------------- #
def section_ocr(image: bytes) -> None:
    for engine in ("cloud", "vllm", "lens"):
        try:
            client = RomdoulClient(BASE, engine, timeout=180)
            res = client.ocr_image(image, filename="smoke.png")
            text = (res.get("text") or "").strip()
            check("ocr", f"{engine} /ocr-image", bool(text), f"{len(text)} chars")
        except RomdoulError as exc:
            check("ocr", f"{engine} /ocr-image", False, f"[{exc.code}] {exc.message[:120]}")
        except Exception as exc:  # noqa: BLE001
            check("ocr", f"{engine} /ocr-image", False, str(exc)[:120])


# --------------------------------------------------------------------------- #
# 3b. Document full mode: /parse-pdf
# --------------------------------------------------------------------------- #
def section_document(image: bytes) -> None:
    for engine in ("cloud", "vllm"):
        try:
            client = RomdoulClient(BASE, engine, timeout=240)
            doc = client.parse_document(image, filename="smoke.png")
            pages = doc.get("pages") or []
            text = client.text_of(doc)
            check("document", f"{engine} /parse-pdf",
                  len(pages) >= 1 and bool(text.strip()),
                  f"{len(pages)} page(s), {len(text.strip())} chars")
        except RomdoulError as exc:
            check("document", f"{engine} /parse-pdf", False, f"[{exc.code}] {exc.message[:120]}")
        except Exception as exc:  # noqa: BLE001
            check("document", f"{engine} /parse-pdf", False, str(exc)[:120])


# --------------------------------------------------------------------------- #
# 3c. Table mode: /parse-table
# --------------------------------------------------------------------------- #
def section_table(table_image: bytes | None) -> None:
    if not table_image:
        skip("table", "parse-table", "PIL unavailable to render a table image")
        return
    for engine in ("cloud", "vllm"):
        try:
            client = RomdoulClient(BASE, engine, timeout=240)
            res = client.parse_table(table_image, filename="smoke-table.png")
            n_cells = len(res.get("cells") or [])
            n_rows = int(res.get("num_rows") or 0)
            check("table", f"{engine} /parse-table",
                  n_rows >= 2 and n_cells > 0,
                  f"{n_rows} rows, {n_cells} cells")
        except RomdoulError as exc:
            check("table", f"{engine} /parse-table", False, f"[{exc.code}] {exc.message[:120]}")
        except Exception as exc:  # noqa: BLE001
            check("table", f"{engine} /parse-table", False, str(exc)[:120])


# --------------------------------------------------------------------------- #
# 4. Async batch job: submit -> poll -> result
# --------------------------------------------------------------------------- #
def section_jobs(image: bytes) -> None:
    try:
        files = {"files": ("smoke.png", image, "image/png")}
        r = requests.post(f"{BASE}/v1/api-jobs/jobs", files=files,
                          params={"engine": "cloud", "mode": "ocr-image"}, timeout=60)
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        job_id = body.get("job_id") if isinstance(body, dict) else None
        check("jobs", "POST /jobs", r.status_code == 202 and bool(job_id), f"HTTP {r.status_code}")
        if not job_id:
            return

        status, attempts = None, 0
        while attempts < 40:  # up to ~4 minutes
            time.sleep(6)
            attempts += 1
            r = requests.get(f"{BASE}/v1/api-jobs/jobs/{job_id}", timeout=30)
            body = r.json()
            status = body.get("status") if isinstance(body, dict) else None
            if status in ("done", "succeeded", "failed", "canceled"):
                break
        check("jobs", f"GET /jobs/{job_id} → {status}",
              status in ("done", "succeeded"), f"after {attempts * 6}s")

        if status in ("done", "succeeded"):
            r = requests.get(f"{BASE}/v1/api-jobs/jobs/{job_id}/result", timeout=60)
            result = r.json() if r.headers.get("content-type", "").startswith("application/json") else None
            text = ""
            if isinstance(result, dict):
                # parse-pdf modes merge to a DocumentResult
                text = "".join((result.get("full_text") or "").split())
                if not text and isinstance(result.get("pages"), list):
                    text = "".join(
                        (p.get("text") or "") for p in result["pages"] if isinstance(p, dict)
                    )
            elif isinstance(result, list):
                # ocr-image / parse-table modes merge to a list of results
                text = "".join(
                    "".join((str(item.get("text") or "")).split())
                    for item in result if isinstance(item, dict)
                )
            check("jobs", "GET /jobs/{id}/result", bool(text), f"{len(text)} chars")
    except Exception as exc:  # noqa: BLE001
        check("jobs", "batch flow", False, str(exc)[:120])


# --------------------------------------------------------------------------- #
# 5. Metadata API — full CRUD + stats + export
# --------------------------------------------------------------------------- #
def section_metadata() -> None:
    if not META_USER or not META_PASS:
        skip("meta", "metadata API", "set ROMDOUL_META_USER / ROMDOUL_META_PASS to run")
        return
    try:
        c = MetadataClient(META_USER, META_PASS, base_url=META_BASE)
        check("meta", "login + health", c.signed_in, c.user and c.user.get("role"))

        s = c.stats()
        check("meta", "stats", isinstance(s, dict) and "total" in s, f"total={s.get('total')}")

        page = c.list_records(page_size=2, sort="created_at:desc")
        check("meta", "list records", isinstance(page, dict) and "items" in page, f"total={page.get('total')}")

        rid = f"smoke-{uuid.uuid4().hex[:8]}"
        created = c.create_record({
            "id": rid,
            "type": "document",
            "data": {"full_text": "smoke test record", "document_name": "smoke.png"},
        })
        check("meta", "create record", created.get("id") == rid)

        got = c.get_record(rid)
        check("meta", "get record", got.get("id") == rid)

        patched = c.patch_record(rid, data={**got.get("data", {}), "full_text": "smoke test edited"})
        check("meta", "patch record", patched.get("edit_count", 0) >= 1)

        hist = c.record_history(rid)
        check("meta", "record history", isinstance(hist, list) and len(hist) >= 2, f"{len(hist)} events")

        csv_out = c.export_csv(page_size=1)
        check("meta", "export csv", len(csv_out) > 0, f"{len(csv_out)} bytes")

        jx = c.export_json(page_size=1)
        check("meta", "export json", isinstance(jx, list), f"{len(jx)} records")

        meta = c.meta()
        check("meta", "meta", isinstance(meta, dict) and "types" in meta)

        c.delete_record(rid)
        check("meta", "delete record", True, rid)
    except MetadataError as exc:
        check("meta", "metadata flow", False, f"[{exc.status}] {str(exc)[:120]}")
    except Exception as exc:  # noqa: BLE001
        check("meta", "metadata flow", False, str(exc)[:120])


# --------------------------------------------------------------------------- #
# 5b. Metadata after OCR — the post-OCR flow end to end:
#     OCR the image, auto-save the record (open endpoint), then PATCH the
#     business/dataset fields exactly like the app's dataset form does.
# --------------------------------------------------------------------------- #
def section_meta_after_ocr(image: bytes) -> None:
    if not META_USER or not META_PASS:
        skip("meta-after-ocr", "post-OCR flow", "set ROMDOUL_META_USER / ROMDOUL_META_PASS to run")
        return
    rid = f"smoke-{uuid.uuid4().hex[:8]}"
    try:
        # 1. OCR the image (cloud engine, like the app's default).
        client = RomdoulClient(BASE, "cloud", timeout=180)
        ocr = client.ocr_image(image, filename="smoke.png")
        ocr_text = (ocr.get("text") or "").strip()
        check("meta-after-ocr", "OCR first", bool(ocr_text), f"{len(ocr_text)} chars")
        if not ocr_text:
            return

        # 2. Auto-save the extraction record (open — no auth, like the SPA).
        c = MetadataClient(META_USER, META_PASS, base_url=META_BASE)
        created = c.create_record({
            "id": rid,
            "type": "document",
            "data": {"full_text": ocr_text, "document_name": "smoke.png"},
        })
        check("meta-after-ocr", "auto-save record", created.get("id") == rid, f"status={created.get('status')}")

        # 3. PATCH business + dataset fields — the dataset-form payload.
        patched = c.patch_record(
            rid,
            data={**created.get("data", {}), "dataset": {
                "name": "Smoke test dataset",
                "managed_by": "GDDE, MEF",
                "frequency": "Yearly",
                "coverage_start": "2026-01-01",
                "categories": "receipt, bank transfer",
            }},
            business={"owner": "smoke-test", "tags": ["smoke"]},
        )
        dataset = ((patched.get("data") or {}).get("dataset") or {})
        check("meta-after-ocr", "PATCH dataset fields",
              dataset.get("name") == "Smoke test dataset" and dataset.get("managed_by") == "GDDE, MEF",
              f"edit_count={patched.get('edit_count')}")

        # 4. Verify the record round-trips with the OCR text + dataset.
        got = c.get_record(rid)
        got_text = ((got.get("data") or {}).get("full_text") or "").strip()
        check("meta-after-ocr", "record round-trip",
              got_text == ocr_text and ((got.get("data") or {}).get("dataset") or {}).get("name") == "Smoke test dataset",
              f"status={got.get('status')}")

        # 5. Clean up.
        c.delete_record(rid)
        check("meta-after-ocr", "delete record", True, rid)
    except MetadataError as exc:
        check("meta-after-ocr", "post-OCR flow", False, f"[{exc.status}] {str(exc)[:120]}")
    except RomdoulError as exc:
        check("meta-after-ocr", "post-OCR flow", False, f"[{exc.code}] {exc.message[:120]}")
    except Exception as exc:  # noqa: BLE001
        check("meta-after-ocr", "post-OCR flow", False, str(exc)[:120])


def main() -> int:
    print(f"Romdoul OCR smoke test — base: {BASE}")
    print(f"metadata base: {META_BASE}  (user set: {bool(META_USER)})")
    print("=" * 70)

    image = make_test_image()
    table_image = make_table_image()

    section_status()
    section_health()
    if image:
        section_ocr(image)
        section_document(image)
        section_jobs(image)
    else:
        skip("ocr", "all engines", "no test image (PIL missing and ops/warm.png not found)")
        skip("document", "parse-pdf", "no test image")
        skip("jobs", "batch flow", "no test image")

    section_table(table_image)

    section_metadata()
    if image:
        section_meta_after_ocr(image)
    else:
        skip("meta-after-ocr", "post-OCR flow", "no test image")

    print("=" * 70)
    failed = [r for r in results if r[1] == FAIL]
    passed = [r for r in results if r[1] == PASS]
    skipped = [r for r in results if r[1] == SKIP]
    print(f"PASS {len(passed)} · FAIL {len(failed)} · SKIP {len(skipped)}")
    for _, status, name in failed:
        print(f"  FAILED: {name}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
