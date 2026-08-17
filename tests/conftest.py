"""
Pytest configuration and shared test fixtures for Romdoul OCR test suite.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure clients/python and adapters are on python path
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "clients" / "python"))
sys.path.insert(0, str(REPO_ROOT / "vllm-adapter"))
sys.path.insert(0, str(REPO_ROOT / "jobs-adapter"))
sys.path.insert(0, str(REPO_ROOT / "status-adapter"))
sys.path.insert(0, str(REPO_ROOT / "tidy-adapter"))


@pytest.fixture
def sample_image_bytes() -> bytes:
    """Returns minimal valid PNG image bytes for OCR tests."""
    # Minimal 1x1 valid PNG
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00"
        b"\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
    )


@pytest.fixture
def mock_ocr_response() -> dict:
    """Mock standard OCR JSON response envelope."""
    return {
        "filename": "document.pdf",
        "num_pages": 1,
        "full_text": "ព្រះរាជាណាចក្រកម្ពុជា\nជាតិ សាសនា ព្រះមហាក្សត្រ",
        "confidence": 0.991,
        "pages": [
            {
                "page_number": 1,
                "width": 1200,
                "height": 1600,
                "regions": [
                    {
                        "region_type": "title",
                        "text": "ព្រះរាជាណាចក្រកម្ពុជា",
                        "confidence": 0.995,
                        "bbox": {"points": [[100, 100], [500, 100], [500, 150], [100, 150]]},
                    },
                    {
                        "region_type": "section-header",
                        "text": "ជាតិ សាសនា ព្រះមហាក្សត្រ",
                        "confidence": 0.988,
                        "bbox": {"points": [[100, 160], [450, 160], [450, 200], [100, 200]]},
                    },
                ],
            }
        ],
    }


@pytest.fixture
def mock_status_response() -> dict:
    """Mock standard /v1/status aggregated response."""
    return {
        "status": "healthy",
        "engine": "vllm",
        "engines": {
            "vllm": {"status": "healthy", "latency_ms": 42.5},
            "cloud": {"status": "healthy", "latency_ms": 120.0},
            "lens": {"status": "healthy", "latency_ms": 85.0},
        },
        "adapters": {
            "jobs": "healthy",
            "tidy": "healthy",
        },
    }
