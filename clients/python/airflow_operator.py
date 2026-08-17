"""
Apache Airflow Provider & Custom Operators for Romdoul OCR & Metadata Service.

Provides:
- RomdoulOcrOperator: Extracts text/tables from local files, S3, or GCS and pushes results to XCom/Data Lake.
- RomdoulBatchSensor: Asynchronous sensor for tracking long-running batch OCR jobs.
- RomdoulMetadataHook: Low-level hook for interacting with the Metadata Service API.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Sequence

try:
    from airflow.exceptions import AirflowException
    from airflow.models import BaseOperator
    from airflow.sensors.base import BaseSensorOperator
    from airflow.hooks.base import BaseHook
except ImportError:
    class AirflowException(Exception):  # type: ignore
        pass

    class BaseOperator:  # type: ignore
        template_fields: Sequence[str] = ()
        def __init__(self, task_id: str = "task", **kwargs: Any) -> None:
            self.task_id = task_id
            self.kwargs = kwargs
            self.log = logging.getLogger(f"airflow.task.{task_id}")

    class BaseSensorOperator(BaseOperator):  # type: ignore
        pass

    class BaseHook:  # type: ignore
        pass

from romdoul import RomdoulClient
from metadata import MetadataClient

log = logging.getLogger("airflow.providers.romdoul")


class RomdoulMetadataHook(BaseHook):
    """Airflow Hook for the Romdoul Metadata Service."""

    conn_name_attr = "romdoul_conn_id"
    default_conn_name = "romdoul_default"
    conn_type = "romdoul"
    hook_name = "Romdoul OCR"

    def __init__(self, romdoul_conn_id: str = default_conn_name) -> None:
        super().__init__()
        self.romdoul_conn_id = romdoul_conn_id

    def get_client(self) -> MetadataClient:
        conn = self.get_connection(self.romdoul_conn_id)
        base_url = f"{conn.schema or 'http'}://{conn.host}:{conn.port or 8095}"
        return MetadataClient(
            username=conn.login,
            password=conn.password,
            base_url=base_url,
        )


class RomdoulOcrOperator(BaseOperator):
    """
    Executes an OCR extraction job on an input file using Romdoul OCR.

    :param file_path: Local file path or cloud URI to extract.
    :param engine: OCR engine to use ('cloud', 'vllm', 'lens').
    :param save_to_metadata: If True, automatically persists extraction into the Metadata Service.
    :param output_path: Optional local or remote path to write the extracted JSON/Markdown/CSV.
    """

    template_fields: Sequence[str] = ("file_path", "output_path")

    def __init__(
        self,
        file_path: str,
        engine: str = "vllm",
        save_to_metadata: bool = True,
        output_path: str | None = None,
        romdoul_conn_id: str = "romdoul_default",
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.file_path = file_path
        self.engine = engine
        self.save_to_metadata = save_to_metadata
        self.output_path = output_path
        self.romdoul_conn_id = romdoul_conn_id

    def execute(self, context: dict[str, Any]) -> dict[str, Any]:
        self.log.info("Starting Romdoul OCR on %s with engine=%s", self.file_path, self.engine)

        client = RomdoulClient(engine=self.engine)
        if self.file_path.lower().endswith(".pdf"):
            result = client.parse_pdf(self.file_path, save=self.save_to_metadata)
        else:
            result = client.ocr_image(self.file_path, save=self.save_to_metadata)

        if not result or "pages" not in result and "text" not in result:
            raise AirflowException(f"OCR failed for {self.file_path}")

        extracted_text = result.get("full_text") or result.get("text", "")
        self.log.info("OCR completed successfully. Extracted %d characters.", len(extracted_text))

        if self.output_path:
            with open(self.output_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            self.log.info("Saved OCR artifact to %s", self.output_path)

        return result


class RomdoulBatchSensor(BaseSensorOperator):
    """
    Polls an asynchronous batch OCR job until completion.

    :param job_id: Unique batch job ID returned by /api/v1/batch/jobs.
    :param poke_interval: Polling frequency in seconds (default: 10s).
    :param timeout: Maximum seconds to wait before failing (default: 600s).
    """

    template_fields: Sequence[str] = ("job_id",)

    def __init__(
        self,
        job_id: str,
        romdoul_conn_id: str = "romdoul_default",
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.job_id = job_id
        self.romdoul_conn_id = romdoul_conn_id

    def poke(self, context: dict[str, Any]) -> bool:
        self.log.info("Checking status of Romdoul Batch Job: %s", self.job_id)
        client = RomdoulClient()
        status_data = client.get_job_status(self.job_id)
        state = status_data.get("status", "").lower()

        if state == "completed":
            self.log.info("Batch Job %s finished successfully!", self.job_id)
            return True
        elif state in ("failed", "error"):
            raise AirflowException(f"Batch Job {self.job_id} failed: {status_data.get('error')}")

        self.log.info("Batch Job %s is still %s (%d%%)...", self.job_id, state, status_data.get("progress", 0))
        return False
