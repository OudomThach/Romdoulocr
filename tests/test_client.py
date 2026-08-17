"""
Unit tests for synchronous and asynchronous Romdoul OCR Python clients.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import requests
from async_client import AsyncRomdoulClient
from romdoul import DEFAULT_BASE_URL, RomdoulClient, RomdoulError


class TestRomdoulClient:
    """Test suite for synchronous RomdoulClient."""

    def test_client_init_defaults(self):
        client = RomdoulClient()
        assert client.base_url == DEFAULT_BASE_URL.rstrip("/")
        assert client.engine == "cloud"
        assert client.timeout == 300.0
        assert client.max_retries == 3

    def test_client_custom_init(self):
        client = RomdoulClient(
            base_url="http://localhost:8181",
            api_key="secret-key",
            adapter_token="adapter-token",
            engine="vllm",
            timeout=30.0,
            max_retries=5,
        )
        assert client.base_url == "http://localhost:8181"
        assert client.api_key == "secret-key"
        assert client.adapter_token == "adapter-token"
        assert client.engine == "vllm"
        assert client.timeout == 30.0
        assert client.max_retries == 5

    def test_client_with_engine(self):
        client = RomdoulClient(base_url="http://localhost:8181", engine="cloud")
        vllm_client = client.with_engine("vllm")
        assert vllm_client.engine == "vllm"
        assert vllm_client.base_url == "http://localhost:8181"

    @patch.object(requests.Session, "request")
    def test_health_check_success(self, mock_req, mock_status_response):
        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.status_code = 200
        mock_resp.json.return_value = mock_status_response
        mock_req.return_value = mock_resp

        client = RomdoulClient(base_url="http://localhost:8181", engine="vllm")
        status = client.health()
        assert status["status"] == "healthy"
        assert status["engine"] == "vllm"

    @patch.object(requests.Session, "request")
    def test_ocr_image_bytes(self, mock_req, sample_image_bytes, mock_ocr_response):
        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.status_code = 200
        mock_resp.json.return_value = mock_ocr_response
        mock_req.return_value = mock_resp

        client = RomdoulClient(base_url="http://localhost:8181", engine="vllm")
        result = client.ocr_image(sample_image_bytes, filename="test.png")

        assert result["filename"] == "document.pdf"
        assert "ព្រះរាជាណាចក្រកម្ពុជា" in result["full_text"]
        assert len(result["pages"]) == 1

    @patch("time.sleep")
    @patch.object(requests.Session, "request")
    def test_client_retry_on_503(self, mock_req, mock_sleep, sample_image_bytes, mock_ocr_response):
        # First call 503 (waking up), second call 200 (success)
        mock_fail = MagicMock()
        mock_fail.ok = False
        mock_fail.status_code = 503
        mock_fail.json.return_value = {"error": {"code": "engine_not_ready", "message": "waking up"}}

        mock_ok = MagicMock()
        mock_ok.ok = True
        mock_ok.status_code = 200
        mock_ok.json.return_value = mock_ocr_response

        mock_req.side_effect = [mock_fail, mock_ok]

        client = RomdoulClient(base_url="http://localhost:8181", engine="vllm", max_retries=2)
        result = client.ocr_image(sample_image_bytes)

        assert result["full_text"] == mock_ocr_response["full_text"]
        assert mock_req.call_count == 2

    @patch.object(requests.Session, "request")
    def test_client_raises_romdoul_error_on_400(self, mock_req, sample_image_bytes):
        mock_resp = MagicMock()
        mock_resp.ok = False
        mock_resp.status_code = 400
        mock_resp.json.return_value = {"error": {"code": "bad_request", "message": "Invalid image payload"}}
        mock_req.return_value = mock_resp

        client = RomdoulClient(base_url="http://localhost:8181")
        with pytest.raises(RomdoulError) as exc_info:
            client.ocr_image(sample_image_bytes)

        assert exc_info.value.status == 400
        assert exc_info.value.code == "bad_request"


class TestAsyncRomdoulClient:
    """Test suite for AsyncRomdoulClient."""

    @pytest.mark.asyncio
    async def test_async_client_context_manager(self):
        async with AsyncRomdoulClient(base_url="http://localhost:8181", max_connections=5) as client:
            assert client.base_url == "http://localhost:8181"
            assert client.client is not None

    @pytest.mark.asyncio
    async def test_async_parse_image(self, sample_image_bytes, mock_ocr_response):
        async with AsyncRomdoulClient(base_url="http://localhost:8181") as client:
            with patch.object(client.client, "post", new_callable=AsyncMock) as mock_post:
                mock_resp = MagicMock()
                mock_resp.status_code = 200
                mock_resp.json.return_value = mock_ocr_response
                mock_resp.text = ""
                mock_post.return_value = mock_resp

                res = await client.parse_image(sample_image_bytes, filename="test.png")
                assert res["full_text"] == mock_ocr_response["full_text"]
