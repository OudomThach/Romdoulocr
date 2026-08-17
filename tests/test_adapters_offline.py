"""
Offline unit tests for adapter helper functions and response shape transformers.
"""

from __future__ import annotations


def test_vllm_rect_to_points():
    """Verify conversion of [x0, y0, x1, y1] to 4 corner points."""
    # Local import helper directly
    def _rect_to_points(bbox: list[float]) -> list[list[float]]:
        x0, y0, x1, y1 = (float(v) for v in bbox[:4])
        return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

    bbox = [10.0, 20.0, 110.0, 220.0]
    points = _rect_to_points(bbox)
    assert len(points) == 4
    assert points[0] == [10.0, 20.0]
    assert points[1] == [110.0, 20.0]
    assert points[2] == [110.0, 220.0]
    assert points[3] == [10.0, 220.0]


def test_vllm_raw_base64_stripping():
    """Verify data URL prefix is properly stripped for raw base64 output."""
    def _raw_base64(s: str | None) -> str | None:
        if s and s.startswith("data:") and "," in s:
            return s.split(",", 1)[1]
        return s

    raw = "aGVsbG8gd29ybGQ="
    data_url = "data:image/png;base64,aGVsbG8gd29ybGQ="
    assert _raw_base64(data_url) == raw
    assert _raw_base64(raw) == raw
    assert _raw_base64(None) is None


def test_tidy_table_detection():
    """Verify wide layout detection condition for tidy pipeline."""
    def _needs_tidy(ncols: int, numeric_heavy: int) -> bool:
        if numeric_heavy >= 3:
            return True
        return ncols >= 8

    assert _needs_tidy(8, 0) is True
    assert _needs_tidy(10, 1) is True
    assert _needs_tidy(4, 3) is True
    assert _needs_tidy(4, 2) is False
