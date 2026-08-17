"""
Unit tests for Romdoul Apache Airflow Operators and Sensors.
"""

from __future__ import annotations

import json
from datetime import datetime

try:
    from datetime import UTC
except ImportError:
    from datetime import timezone
    UTC = timezone.utc  # noqa: UP017
from unittest.mock import MagicMock, patch

import pytest
from airflow_operator import AirflowException, RomdoulBatchSensor, RomdoulOcrOperator


class TestRomdoulAirflowOperator:
    """Test suite for RomdoulOcrOperator."""

    def test_operator_initialization(self):
        op = RomdoulOcrOperator(
            task_id="test_khmer_ocr",
            file_path="sample.pdf",
            engine="vllm",
            output_path="out.json",
        )
        assert op.task_id == "test_khmer_ocr"
        assert op.file_path == "sample.pdf"
        assert op.engine == "vllm"
        assert op.output_path == "out.json"

    @patch("romdoul.RomdoulClient.ocr_image")
    def test_operator_execute_success(self, mock_ocr, tmp_path, sample_image_bytes, mock_ocr_response):
        # Create temp input file
        input_file = tmp_path / "invoice.png"
        input_file.write_bytes(sample_image_bytes)
        output_file = tmp_path / "result.json"

        mock_ocr.return_value = mock_ocr_response

        op = RomdoulOcrOperator(
            task_id="ocr_task",
            file_path=str(input_file),
            engine="vllm",
            output_path=str(output_file),
        )

        context = {"execution_date": datetime.now(UTC), "task_instance": MagicMock()}
        res = op.execute(context)

        assert res["filename"] == "document.pdf"
        assert "ព្រះរាជាណាចក្រកម្ពុជា" in res["full_text"]
        assert output_file.exists()

        saved = json.loads(output_file.read_text(encoding="utf-8"))
        assert saved["filename"] == "document.pdf"


class TestRomdoulBatchSensor:
    """Test suite for RomdoulBatchSensor."""

    @patch("romdoul.RomdoulClient.get_job_status")
    def test_sensor_poke_completed(self, mock_status):
        mock_status.return_value = {"status": "completed", "job_id": "job_123", "progress": 1.0}

        sensor = RomdoulBatchSensor(task_id="sensor_task", job_id="job_123")
        res = sensor.poke({})
        assert res is True

    @patch("romdoul.RomdoulClient.get_job_status")
    def test_sensor_poke_running(self, mock_status):
        mock_status.return_value = {"status": "running", "job_id": "job_123", "progress": 0.45}

        sensor = RomdoulBatchSensor(task_id="sensor_task", job_id="job_123")
        res = sensor.poke({})
        assert res is False

    @patch("romdoul.RomdoulClient.get_job_status")
    def test_sensor_poke_failed_raises_airflow_exception(self, mock_status):
        mock_status.return_value = {
            "status": "failed",
            "job_id": "job_123",
            "error": "GPU worker crash",
        }

        sensor = RomdoulBatchSensor(task_id="sensor_task", job_id="job_123")
        with pytest.raises(AirflowException) as exc_info:
            sensor.poke({})
        assert "failed" in str(exc_info.value)
