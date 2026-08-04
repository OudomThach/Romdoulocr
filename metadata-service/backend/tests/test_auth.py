from sqlalchemy import select

async def _seed_admin(monkeypatch):
    from app import config

    monkeypatch.setattr(config.settings, "admin_username", "admin")
    monkeypatch.setattr(config.settings, "admin_password", "admin-pass-123")
    from app.security import seed_admin

    await seed_admin()


async def _login(client, username="admin", password="admin-pass-123"):
    r = await client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200
    return r.json()


async def test_login_wrong_credentials(client, monkeypatch):
    await _seed_admin(monkeypatch)
    r = await client.post("/api/v1/auth/login", json={"username": "admin", "password": "wrong"})
    assert r.status_code == 401

    r = await client.post("/api/v1/auth/login", json={"username": "nobody", "password": "admin-pass-123"})
    assert r.status_code == 401


async def test_login_me_and_reads(client, monkeypatch):
    await _seed_admin(monkeypatch)
    body = await _login(client)
    token = body["token"]
    assert body["user"]["username"] == "admin"
    assert body["user"]["role"] == "admin"

    r = await client.get("/api/v1/auth/me", headers={"X-Session-Token": token})
    assert r.status_code == 200
    assert r.json() == {"id": 0, "username": "admin", "role": "admin"}

    # reads without credentials are blocked
    assert (await client.get("/api/v1/records")).status_code == 401
    assert (await client.get("/api/v1/stats")).status_code == 401

    # reads with the session token work
    assert (await client.get("/api/v1/records", headers={"X-Session-Token": token})).status_code == 200
    assert (await client.get("/api/v1/stats", headers={"X-Session-Token": token})).status_code == 200


async def test_logout_revokes_session(client, monkeypatch):
    await _seed_admin(monkeypatch)
    body = await _login(client)
    token = body["token"]

    r = await client.post("/api/v1/auth/logout", headers={"X-Session-Token": token})
    assert r.status_code == 200

    r = await client.get("/api/v1/records", headers={"X-Session-Token": token})
    assert r.status_code == 401


async def test_patch_attribution_uses_username(client, monkeypatch):
    await _seed_admin(monkeypatch)
    token = (await _login(client))["token"]
    headers = {"X-Session-Token": token}

    await client.post("/api/v1/records", json={"type": "invoice", "data": {"n": 1}})
    r = await client.patch("/api/v1/records", json={}, headers=headers)
    # no id → 404; use a real one
    r = await client.get("/api/v1/records", headers=headers)
    record_id = r.json()["items"][0]["id"]
    r = await client.patch(f"/api/v1/records/{record_id}", json={"data": {"n": 2}}, headers=headers)
    assert r.status_code == 200
    assert r.json()["edited_by"] == "user:admin"


async def test_api_key_still_works(client, monkeypatch):
    from app import config

    monkeypatch.setattr(config.settings, "api_keys", "machine-key-1")
    r = await client.get("/api/v1/records", headers={"X-API-Key": "machine-key-1"})
    assert r.status_code == 200
    r = await client.get("/api/v1/records", headers={"X-API-Key": "nope"})
    assert r.status_code == 401


async def test_post_records_stays_open(client, monkeypatch):
    r = await client.post("/api/v1/records", json={"type": "invoice", "data": {"n": 1}})
    assert r.status_code == 201


async def test_admin_can_create_users(client, monkeypatch):
    await _seed_admin(monkeypatch)
    token = (await _login(client))["token"]
    headers = {"X-Session-Token": token}

    r = await client.post("/api/v1/auth/users", json={"username": "dara", "password": "dara-pass-123", "role": "viewer"}, headers=headers)
    assert r.status_code == 201
    body = r.json()
    assert body["username"] == "dara"
    assert body["role"] == "viewer"

    r = await client.post("/api/v1/auth/users", json={"username": "dara", "password": "dara-pass-123"}, headers=headers)
    assert r.status_code == 409

    # the new user can log in and read
    body = await _login(client, "dara", "dara-pass-123")
    assert body["user"]["username"] == "dara"
    assert body["user"]["role"] == "viewer"
    assert (await client.get("/api/v1/records", headers={"X-Session-Token": body["token"]})).status_code == 200


async def test_non_admin_cannot_create_users(client, monkeypatch):
    await _seed_admin(monkeypatch)
    admin_token = (await _login(client))["token"]
    await client.post("/api/v1/auth/users", json={"username": "dara", "password": "dara-pass-123", "role": "viewer"}, headers={"X-Session-Token": admin_token})

    viewer_token = (await _login(client, "dara", "dara-pass-123"))["token"]
    r = await client.post("/api/v1/auth/users", json={"username": "bob", "password": "bob-pass-123"}, headers={"X-Session-Token": viewer_token})
    assert r.status_code == 403


async def test_admin_can_list_users(client, monkeypatch):
    await _seed_admin(monkeypatch)
    token = (await _login(client))["token"]
    headers = {"X-Session-Token": token}
    await client.post("/api/v1/auth/users", json={"username": "dara", "password": "dara-pass-123"}, headers=headers)
    r = await client.get("/api/v1/auth/users", headers=headers)
    assert r.status_code == 200
    users = r.json()
    assert len(users) == 2
    assert users[0]["username"] == "admin"
    assert users[1]["username"] == "dara"


async def test_admin_can_promote_and_demote(client, monkeypatch):
    await _seed_admin(monkeypatch)
    token = (await _login(client))["token"]
    headers = {"X-Session-Token": token}
    await client.post("/api/v1/auth/users", json={"username": "dara", "password": "dara-pass-123"}, headers=headers)
    uc = r = await client.get("/api/v1/auth/users", headers=headers)
    dara = [u for u in r.json() if u["username"] == "dara"][0]

    # get the user ID from the response... we don't have IDs. Let me add user IDs to list_users.
    from app.models import User
    from app.db import SessionLocal
    async with SessionLocal() as s:
        rows = await s.execute(select(User).where(User.username == "dara"))
        dara_id = rows.scalar_one().id

    r = await client.patch(f"/api/v1/auth/users/{dara_id}", json={"role": "admin"}, headers=headers)
    assert r.status_code == 200
    assert r.json()["role"] == "admin"

    r = await client.patch(f"/api/v1/auth/users/{dara_id}", json={"role": "viewer"}, headers=headers)
    assert r.status_code == 200
    assert r.json()["role"] == "viewer"


async def test_admin_can_delete_user(client, monkeypatch):
    await _seed_admin(monkeypatch)
    token = (await _login(client))["token"]
    headers = {"X-Session-Token": token}
    await client.post("/api/v1/auth/users", json={"username": "delme", "password": "delme-pass-123"}, headers=headers)

    from app.models import User
    from app.db import SessionLocal
    async with SessionLocal() as s:
        rows = await s.execute(select(User).where(User.username == "delme"))
        uid = rows.scalar_one().id

    r = await client.delete(f"/api/v1/auth/users/{uid}", headers=headers)
    assert r.status_code == 204


async def test_admin_cannot_delete_self(client, monkeypatch):
    await _seed_admin(monkeypatch)
    token = (await _login(client))["token"]
    headers = {"X-Session-Token": token}

    from app.models import User
    from app.db import SessionLocal
    async with SessionLocal() as s:
        rows = await s.execute(select(User).where(User.username == "admin"))
        admin_id = rows.scalar_one().id

    r = await client.delete(f"/api/v1/auth/users/{admin_id}", headers=headers)
    assert r.status_code == 422


async def test_viewer_cannot_delete_record(client, monkeypatch):
    await _seed_admin(monkeypatch)
    admin_token = (await _login(client))["token"]
    await client.post("/api/v1/auth/users", json={"username": "dara", "password": "dara-pass-123", "role": "viewer"}, headers={"X-Session-Token": admin_token})

    r = await client.post("/api/v1/records", json={"type": "invoice", "data": {"n": 1}})
    record_id = r.json()["id"]

    viewer_token = (await _login(client, "dara", "dara-pass-123"))["token"]
    r = await client.delete(f"/api/v1/records/{record_id}", headers={"X-Session-Token": viewer_token})
    assert r.status_code == 403


async def test_admin_can_delete_record(client, monkeypatch):
    await _seed_admin(monkeypatch)
    token = (await _login(client))["token"]
    headers = {"X-Session-Token": token}

    r = await client.post("/api/v1/records", json={"type": "invoice", "data": {"n": 1}})
    record_id = r.json()["id"]
    r = await client.delete(f"/api/v1/records/{record_id}", headers=headers)
    assert r.status_code == 204