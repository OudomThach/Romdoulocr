import os

os.environ["METADATA_DATABASE_URL"] = "sqlite+aiosqlite:///./test_metadata.db"

import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from app.db import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest_asyncio.fixture(autouse=True)
async def clean_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield


@pytest_asyncio.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def auth_client(client, monkeypatch):
    """Client with a valid admin session token attached to every request."""
    from app import config
    from app.security import seed_admin

    monkeypatch.setattr(config.settings, "admin_username", "admin")
    monkeypatch.setattr(config.settings, "admin_password", "test-pass")
    await seed_admin()
    r = await client.post("/api/v1/auth/login", json={"username": "admin", "password": "test-pass"})
    token = r.json()["token"]
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test", headers={"X-Session-Token": token}
    ) as c:
        yield c


def sample_record(**overrides):
    payload = {
        "id": "rec-0001",
        "type": "invoice",
        "source": {"document_id": "doc_1", "filename": "scan.pdf", "page": 1, "model": "surya-vllm-v2", "source_system": "khmer-parser-ui"},
        "pipeline": {"run_id": "run_1", "batch_id": "batch_1", "version": "1.2.0"},
        "business": {"date": "2026-08-01", "tags": ["import", "warehouse"], "domain": "logistics", "coverage": 0.87},
        "data": {"order_no": "INV-2201", "amount": 1500, "note": "paid"},
    }
    payload.update(overrides)
    return payload
