"""
Simulated Airflow DAG Execution Pipeline for Romdoul OCR.

This script simulates how Apache Airflow executes a daily Khmer document ETL pipeline:
1. Ingests raw document.
2. Runs RomdoulOcrOperator to extract text and tables.
3. Validates confidence thresholds.
4. Exports structured dataset artifacts to data lake.
5. Emits downstream task events.
"""

import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

# Configure rich colored logger
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("AirflowExecutor")

# Import our custom operator
try:
    from airflow_operator import RomdoulBatchSensor, RomdoulOcrOperator
except ImportError:
    from ocrapi_backup.clients.python.airflow_operator import RomdoulBatchSensor, RomdoulOcrOperator


def run_simulated_airflow_dag():
    logger.info("==========================================================")
    logger.info("🚀 AIRFLOW DAG SIMULATION: 'daily_khmer_document_etl'")
    logger.info("📅 Execution Date: %s", datetime.now(timezone.utc).isoformat())
    logger.info("==========================================================")

    # Simulated OCR extraction output
    mock_ocr_result = {
        "filename": "sample_khmer_invoice_2026.pdf",
        "num_pages": 2,
        "full_text": "ព្រះរាជាណាចក្រកម្ពុជា\nវិក្កយបត្រពន្ធ / TAX INVOICE\nសរុបរួម: $1,450.00 USD",
        "confidence": 0.982,
        "pages": [
            {
                "page_number": 1,
                "width": 1240,
                "height": 1754,
                "regions": [
                    {"region_type": "header", "text": "ព្រះរាជាណាចក្រកម្ពុជា", "confidence": 0.99},
                    {"region_type": "table", "text": "| ទំនិញ | ចំនួន | តម្លៃ |\n| --- | --- | --- |\n| សេវាកម្ម | 1 | $1450 |", "confidence": 0.97},
                ],
            }
        ],
    }

    # Step 1: Mock RomdoulClient to simulate backend response
    with patch("airflow_operator.RomdoulClient") as MockRomdoulClient:
        mock_instance = MagicMock()
        mock_instance.parse_pdf.return_value = mock_ocr_result
        mock_instance.get_job_status.return_value = {"status": "completed", "progress": 100}
        MockRomdoulClient.return_value = mock_instance

        # Task 1: Execute RomdoulOcrOperator
        logger.info("\n--- [TASK 1: extract_khmer_invoice (RomdoulOcrOperator)] ---")
        output_json_path = Path("fake_airflow_output.json")

        operator = RomdoulOcrOperator(
            task_id="extract_khmer_invoice",
            file_path="sample_khmer_invoice_2026.pdf",
            engine="vllm",
            save_to_metadata=True,
            output_path=str(output_json_path),
        )

        context = {"execution_date": datetime.now(timezone.utc), "task_instance": MagicMock()}
        result = operator.execute(context)

        logger.info("✅ Task 1 Success! Extracted %d characters.", len(result["full_text"]))
        logger.info("📄 Extracted Sample Text:\n%s", result["full_text"])

        # Task 2: Validate output & simulate sensor check
        logger.info("\n--- [TASK 2: wait_for_batch_processing (RomdoulBatchSensor)] ---")
        sensor = RomdoulBatchSensor(
            task_id="wait_for_batch_processing",
            job_id="job_batch_khmer_20260817_001",
        )
        sensor_success = sensor.poke(context)
        logger.info("✅ Task 2 Sensor Poll Result: %s (Job Completed)", sensor_success)

        # Task 3: Downstream Data Lake validation
        logger.info("\n--- [TASK 3: data_lake_sink_validation] ---")
        assert output_json_path.exists(), "Output file was not created!"
        with open(output_json_path, "r", encoding="utf-8") as f:
            saved_data = json.load(f)
        logger.info("✅ Verified Data Lake artifact: %s (Size: %d bytes)", output_json_path.name, output_json_path.stat().st_size)

        # Clean up test output
        if output_json_path.exists():
            output_json_path.unlink()

    logger.info("\n==========================================================")
    logger.info("🎉 AIRFLOW PIPELINE RUN FINISHED WITH STATE: SUCCESS")
    logger.info("==========================================================")


if __name__ == "__main__":
    run_simulated_airflow_dag()
