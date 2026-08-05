"""
Airflow DAG examples for the Romdoul OCR + Metadata system.

Each example is a self-contained DAG you can copy into your Airflow dags/ folder.
Prerequisites: pip install requests apache-airflow, then copy metadata.py + romdoul.py
into dags/ (or your PYTHONPATH).

Credentials: set Airflow Variables or env vars:
  ROMDOUL_META_USER=admin
  ROMDOUL_META_PASS=romdoul-v1cgt5jkq492dhzymlwr
  ROMDOUL_META_URL=https://romdoulocr.netlify.app/api-meta
"""

import os
from datetime import datetime, timedelta

from airflow.decorators import dag, task

from metadata import MetadataClient
from romdoul import RomdoulClient

DEFAULT_ARGS = dict(
    owner="data-engineering",
    retries=1,
    retry_delay=timedelta(seconds=30),
    start_date=datetime(2026, 8, 1),
    catchup=False,
)


# ─── DAG 1: Daily metadata export ───────────────────────────────────────────
# Every morning, pull yesterday's extraction records from the metadata service
# and write a timestamped CSV to the data lake.


@dag(schedule="@daily", default_args=DEFAULT_ARGS, tags=["romdoul", "export"])
def romdoul_daily_export():
    @task
    def export_yesterdays_records():
        client = MetadataClient(
            os.getenv("ROMDOUL_META_USER"),
            os.getenv("ROMDOUL_META_PASS"),
        )
        yesterday = (datetime.utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")
        out = f"/data/metadata-records-{yesterday}.csv"
        client.export_csv(out, business_from=yesterday, business_to=yesterday)
        stats = client.stats()
        print(f"Exported {stats['total']} records to {out}")

    export_yesterdays_records()


romdoul_daily_export()


# ─── DAG 2: Health monitor ──────────────────────────────────────────────────
# Every 5 minutes, check the metadata service + all OCR engines. Alert via
# Airflow's built-in failure notification if any are down.


@dag(
    schedule=timedelta(minutes=5),
    default_args={**DEFAULT_ARGS, "retries": 0},
    tags=["romdoul", "monitoring"],
)
def romdoul_health_check():
    @task
    def check_metadata():
        client = MetadataClient(
            os.getenv("ROMDOUL_META_USER"),
            os.getenv("ROMDOUL_META_PASS"),
        )
        h = client.health()
        assert h.get("db") == "ok", f"DB degraded: {h}"
        print("metadata: ok")

    @task
    def check_ocr_default():
        c = RomdoulClient(engine="cloud")
        h = c.health()
        assert h["models_loaded"], f"Cloud OCR down: {h}"
        print("cloud OCR: ready")

    @task
    def check_ocr_vllm():
        c = RomdoulClient(engine="vllm")
        h = c.health()
        assert h["models_loaded"], f"vLLM OCR down: {h}"
        print("vLLM OCR: ready")

    [check_metadata(), check_ocr_default(), check_ocr_vllm()]


romdoul_health_check()


# ─── DAG 3: OCR → ingest metadata pipeline ──────────────────────────────────
# For a list of documents (from a local folder, S3, or a DB query), OCR each
# one and POST the result to the metadata service so it appears in your portal.
# The metadata POST is open — no auth needed, so extraction works from anywhere.


@dag(schedule=None,  # triggered manually or by an upstream DAG
     default_args=DEFAULT_ARGS,
     tags=["romdoul", "pipeline"])
def romdoul_ocr_to_metadata():
    DOCUMENTS = [
        "/data/incoming/menu-001.pdf",
        "/data/incoming/invoice-july.pdf",
    ]

    @task
    def ocr_and_store(filepath: str):
        ocr = RomdoulClient(engine="vllm")
        doc = ocr.parse_document_pages(filepath)
        text = ocr.text_of(doc)
        filename = os.path.basename(filepath)

        meta = MetadataClient()  # no auth — POST /records is open
        payload = {
            "type": "document",
            "source": {
                "filename": filename,
                "file_type": filename.rsplit(".", 1)[-1] if "." in filename else None,
                "model": "vllm",
                "source_system": "airflow-pipeline",
                "extracted_at": datetime.utcnow().isoformat(),
            },
            "data": {
                "filename": filename,
                "num_pages": doc.get("num_pages", 1),
                "full_text": text[:50_000] if text else None,
            },
        }
        rec = meta.create_record(payload)
        print(f"Stored {rec['id'][:12]}… → {filename}")
        return rec["id"]

    for path in DOCUMENTS:
        ocr_and_store(path)


romdoul_ocr_to_metadata()


# ─── DAG 4: Stats report → Slack ────────────────────────────────────────────
# Weekly summary of extraction activity, formatted as a message.

@dag(
    schedule="@weekly",
    default_args={**DEFAULT_ARGS, "retries": 1},
    tags=["romdoul", "reporting"],
)
def romdoul_weekly_report():
    @task
    def send_report():
        client = MetadataClient(
            os.getenv("ROMDOUL_META_USER"),
            os.getenv("ROMDOUL_META_PASS"),
        )
        s = client.stats()
        report = (
            f"*Romdoul weekly report*\n"
            f"  Total records: {s['total']}\n"
            f"  Raw: {s['by_status'].get('raw', 0)} | "
            f"Edited: {s['by_status'].get('edited', 0)} | "
            f"Verified: {s['by_status'].get('verified', 0)}\n"
            f"  By model: {s['by_type']}\n"
            f"  Coverage avg: {s.get('coverage_avg') or 'N/A'}"
        )
        print(report)
        # Send to Slack via your SlackWebhookOperator:
        # SlackWebhookOperator(..., message=report).execute(context)

    send_report()


romdoul_weekly_report()
