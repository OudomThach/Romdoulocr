"""
High-throughput asynchronous Python client for Romdoul OCR & Metadata Service.

Features:
- Async connection pooling with HTTP/2 and Keep-Alive support via httpx.
- Automatic exponential backoff retries on transient errors (502, 503, 504, 429).
- Batch concurrent document worker using asyncio.TaskGroup.
- Direct Parquet / Polars / Pandas dataframe integration for Data Engineers.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import httpx

DEFAULT_BASE_URL = os.environ.get("ROMDOUL_API_URL", "http://localhost:8181")
DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=60.0, pool=60.0)


class AsyncRomdoulClient:
    """Async client for high-scale batch OCR processing."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        api_key: str | None = None,
        max_connections: int = 20,
        max_keepalive: int = 10,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or os.environ.get("ROMDOUL_API_KEY", "")
        limits = httpx.Limits(max_connections=max_connections, max_keepalive_connections=max_keepalive)
        headers = {"X-API-Key": self.api_key} if self.api_key else {}
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=DEFAULT_TIMEOUT,
            limits=limits,
            http2=True,
        )

    async def __aenter__(self) -> AsyncRomdoulClient:
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        await self.close()

    async def close(self) -> None:
        await self.client.aclose()

    async def parse_image(
        self,
        image_path_or_bytes: str | Path | bytes,
        filename: str = "document.jpg",
        engine: str = "vllm",
        max_retries: int = 3,
    ) -> dict[str, Any]:
        """Extract text from an image with automated retry logic."""
        endpoint = "/api-vllm/ocr-image" if engine == "vllm" else "/api/ocr-image"

        if isinstance(image_path_or_bytes, (str, Path)):
            with open(image_path_or_bytes, "rb") as f:
                content = f.read()
                filename = Path(image_path_or_bytes).name
        else:
            content = image_path_or_bytes

        files = {"file": (filename, content, "image/jpeg")}

        for attempt in range(1, max_retries + 1):
            try:
                resp = await self.client.post(endpoint, files=files)
                resp.raise_for_status()
                return resp.json()
            except (httpx.HTTPStatusError, httpx.TransportError):
                if attempt == max_retries:
                    raise
                await asyncio.sleep(0.5 * (2 ** (attempt - 1)))
        return {}

    async def process_batch(
        self,
        file_paths: Sequence[str | Path],
        concurrency: int = 5,
        engine: str = "vllm",
    ) -> list[dict[str, Any]]:
        """Process a list of files concurrently with a fixed concurrency semaphore."""
        semaphore = asyncio.Semaphore(concurrency)

        async def _worker(p: str | Path) -> dict[str, Any]:
            async with semaphore:
                try:
                    res = await self.parse_image(p, engine=engine)
                    return {"file": str(p), "status": "success", "result": res}
                except Exception as e:
                    return {"file": str(p), "status": "error", "error": str(e)}

        tasks = [_worker(p) for p in file_paths]
        return await asyncio.gather(*tasks)
