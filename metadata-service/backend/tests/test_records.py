import pytest
from conftest import sample_record


async def test_create_record_returns_201_with_envelope(auth_client):
    r = await auth_client.post("/api/v1/records", json=sample_record())
    assert r.status_code == 201
    body = r.json()
    assert body["id"] == "rec-0001"
    assert body["status"] == "raw"
    assert body["created_by"] == "system:api"
    assert body["audit"]["status"] == "raw"
    assert body["record"]["validation"]["status"] == "accepted"
    assert body["data"]["order_no"] == "INV-2201"


async def test_create_auto_generates_id(auth_client):
    payload = sample_record()
    del payload["id"]
    r = await auth_client.post("/api/v1/records", json=payload)
    assert r.status_code == 201
    assert len(r.json()["id"]) == 36


async def test_create_duplicate_id_conflicts(auth_client):
    await auth_client.post("/api/v1/records", json=sample_record())
    r = await auth_client.post("/api/v1/records", json=sample_record())
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "duplicate_id"


async def test_create_invalid_status_rejected(auth_client):
    r = await auth_client.post("/api/v1/records", json=sample_record(audit={"status": "weird"}))
    assert r.status_code == 422


async def test_create_missing_type_and_data_rejected(auth_client):
    r = await auth_client.post("/api/v1/records", json={"data": {}})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


async def test_list_records_paginated_and_filtered(auth_client):
    for i in range(5):
        p = sample_record(id=f"rec-{i:04d}", type="invoice" if i % 2 == 0 else "label",
                          business={"date": f"2026-08-{i+1:02d}", "tags": ["x"], "domain": "logistics"})
        assert (await auth_client.post("/api/v1/records", json=p)).status_code == 201

    r = await auth_client.get("/api/v1/records", params={"type": "invoice", "page_size": 2})
    body = r.json()
    assert r.status_code == 200
    assert body["total"] == 3
    assert body["total_pages"] == 2
    assert len(body["items"]) == 2

    r = await auth_client.get("/api/v1/records", params={"domain": "logistics", "status": "raw"})
    assert r.json()["total"] == 5

    r = await auth_client.get("/api/v1/records", params={"q": "INV-2201"})
    assert r.json()["total"] == 5

    r = await auth_client.get("/api/v1/records", params={"tag": "x"})
    assert r.json()["total"] == 5


async def test_get_record_not_found(auth_client):
    r = await auth_client.get("/api/v1/records/nope")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


async def test_patch_record_updates_audit(auth_client):
    await auth_client.post("/api/v1/records", json=sample_record())
    r = await auth_client.patch("/api/v1/records/rec-0001", json={"data": {"order_no": "INV-9999", "amount": 999}},
                           headers={"X-Edited-By": "user:dara"})
    assert r.status_code == 200
    body = r.json()
    assert body["data"]["order_no"] == "INV-9999"
    assert body["status"] == "edited"
    assert body["edited_by"] == "user:dara"
    assert body["edit_count"] == 1
    assert body["audit"]["edit_count"] == 1
    assert body["audit"]["edited_by"] == "user:dara"


async def test_patch_verify_status(auth_client):
    await auth_client.post("/api/v1/records", json=sample_record())
    r = await auth_client.patch("/api/v1/records/rec-0001", json={"status": "verified"})
    assert r.json()["status"] == "verified"


async def test_delete_record(auth_client):
    await auth_client.post("/api/v1/records", json=sample_record())
    r = await auth_client.delete("/api/v1/records/rec-0001")
    assert r.status_code == 204
    assert (await auth_client.get("/api/v1/records/rec-0001")).status_code == 404


async def test_audit_log_written_on_create_and_update(auth_client):
    from sqlalchemy import func, select
    from app.db import SessionLocal
    from app.models import AuditEvent

    await auth_client.post("/api/v1/records", json=sample_record())
    await auth_client.patch("/api/v1/records/rec-0001", json={"data": {"order_no": "X"}})

    async with SessionLocal() as s:
        actions = [a.action for a in (await s.execute(select(AuditEvent).order_by(AuditEvent.id))).scalars()]
    assert actions == ["create", "update"]
