"""
Surya OCR 2 (vLLM) + Metadata — the complete flow, step by step.

    python surya_metadata_example.py [image-or-pdf] [--cleanup]

Steps:
  1. vLLM health check            GET  /v1/api-vllm/health
  2. Parse TABLE (vLLM)           POST /v1/api-vllm/parse-table   (field: file)
  3. Parse PDF/document (vLLM)    POST /v1/api-vllm/parse-pdf     (field: files)
  4. Auto-save metadata record    POST /v1/api-meta/api/v1/records   (open, no auth)
  5. Fill metadata + dataset      PATCH /v1/api-meta/api/v1/records/{id}
                                 (login -> X-Session-Token; business merges)
  6. Verify + export              GET /records/{id}, /export

Environment:
    ROMDOUL_META_USER / ROMDOUL_META_PASS   metadata credentials (steps 5-6)
    ROMDOUL_BASE_URL                        default https://romdoulocr.netlify.app

With --cleanup the created record is deleted at the end (demo mode).
"""

from __future__ import annotations

import os
import sys
import uuid

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

from metadata import MetadataClient
from romdoul import RomdoulClient

BASE = os.environ.get("ROMDOUL_BASE_URL", "https://romdoulocr.netlify.app").rstrip("/")
META_BASE = os.environ.get("ROMDOUL_META_URL", f"{BASE}/api-meta").rstrip("/")
META_USER = os.environ.get("ROMDOUL_META_USER", "").strip()
META_PASS = os.environ.get("ROMDOUL_META_PASS", "").strip()

ENGINE = "vllm"  # Surya OCR 2 on the home GPU


def step(n: int, title: str) -> None:
    print(f"\n── Step {n}: {title} ─" + "─" * max(0, 40 - len(title)))


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    path = args[0] if args else None
    cleanup = "--cleanup" in sys.argv

    if not path:
        print("no file given — generating a sample table image for the demo")
        from PIL import Image, ImageDraw, ImageFont  # type: ignore[import-not-found]
        img = Image.new("RGB", (480, 240), "white")
        draw = ImageDraw.Draw(img)
        font = ImageFont.load_default()
        cells = [["Item", "Qty", "Price"], ["Rice", "10", "2500"], ["Fish", "3", "18000"]]
        for r, row in enumerate(cells):
            for c, val in enumerate(row):
                draw.rectangle([c * 160, r * 80, c * 160 + 160, r * 80 + 80], outline="black", width=2)
                draw.text((c * 160 + 12, r * 80 + 22), val, fill="black", font=font)
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_sample_table.png")
        img.save(path)
        print(f"  wrote {path}")

    print("Surya OCR 2 (vLLM) + metadata example")
    print(f"  engine: {ENGINE}   base: {BASE}   file: {path}")

    # -- 1. health --------------------------------------------------------- #
    step(1, "vLLM health")
    c = RomdoulClient(BASE, ENGINE, timeout=180)
    print(" ", c.health())

    # -- 2. parse table ---------------------------------------------------- #
    step(2, "Parse TABLE (Surya vLLM)")
    try:
        table = c.parse_table(path, dpi=240)
        print(f"  {table['num_rows']} rows x {table['num_cols']} cols, {len(table['cells'])} cells")
        print("  structured_text:")
        for line in (table.get("structured_text") or "").splitlines()[:8]:
            print(f"    {line}")
    except Exception as exc:  # noqa: BLE001
        print(f"  (parse-table skipped: {exc})")

    # -- 3. parse pdf / document ------------------------------------------- #
    step(3, "Parse PDF/document (Surya vLLM)")
    doc = c.parse_document(path, dpi=240)
    text = c.text_of(doc)
    print(f"  {doc['num_pages']} page(s), {len(text.strip())} chars of text")
    print("  preview:", " ".join(text.split())[:120])

    # -- 4. auto-save record (open endpoint) -------------------------------- #
    step(4, "Auto-save metadata record (open)")
    m = MetadataClient(META_USER, META_PASS, base_url=META_BASE)
    rid = f"surya-demo-{uuid.uuid4().hex[:8]}"
    rec = m.create_record({
        "id": rid,
        "type": "document",
        "data": {"document_name": os.path.basename(path), "full_text": text},
    })
    print(f"  record {rid} saved, status={rec.get('status')}")

    # -- 5. fill metadata + dataset fields ---------------------------------- #
    step(5, "Fill metadata + dataset fields (editor PATCH)")
    if not META_USER or not META_PASS:
        print("  SKIPPED — set ROMDOUL_META_USER / ROMDOUL_META_PASS to run steps 5-6")
        print(f"  (record left saved: {rid})")
        return 0
    patched = m.patch_record(
        rid,
        data={**rec.get("data", {}), "dataset": {
            "name": f"Surya OCR 2 demo — {os.path.basename(path)}",
            "managed_by": "GDDE, MEF",
            "frequency": "Yearly",
            "coverage_start": "2026-01-01",
            "categories": "report",
            "url": f"{BASE}/api-docs.html",
            "description": "Demo extraction via Surya OCR 2 (vLLM) + Romdoul metadata.",
        }},
        business={"owner": "demo", "category": "report", "domain": "documents",
                  "tags": ["surya", "vllm"], "date": "2026-08-10"},
    )
    dataset = (patched.get("data") or {}).get("dataset") or {}
    print(f"  status={patched.get('status')}  edit_count={patched.get('edit_count')}")
    print(f"  data.dataset.name = {dataset.get('name')}")

    # -- 6. verify + export -------------------------------------------------- #
    step(6, "Verify + export")
    got = m.get_record(rid)
    print(f"  GET /records/{rid}: status={got.get('status')}, "
          f"full_text={len((got.get('data') or {}).get('full_text') or '')} chars")
    hist = m.record_history(rid)
    print(f"  history: {len(hist)} events ({', '.join(e['action'] for e in hist)})")

    if cleanup:
        m.delete_record(rid)
        print(f"  --cleanup: deleted record {rid}")
    else:
        print(f"  kept record {rid} — find it at {META_BASE}/api/v1/records/{rid}")

    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
