"""
Official Python client for the Romdoul Metadata API.

One module, stdlib + `requests`. Designed for data engineers and Airflow DAGs —
drop it next to your script or `pip install requests` and copy it next to
`romdoul.py`.

Quickstart:

    from metadata import MetadataClient
    c = MetadataClient("admin", "romdoul-v1cgt5jkq492dhzymlwr")
    print(c.health())
    recs = c.list_records(page_size=10, type="document")
    c.export_csv("records.csv", domain="logistics")

What it covers:
    * Session-based auth (username/password → token, stored for reuse)
    * Full record CRUD (create/read/update/delete)
    * Filtered listing, search, pagination, sorting
    * CSV/JSON export to a file or in-memory
    * Stats, meta, health
    * User management (admin only)
    * Retries on transient failures (502/503/504) with backoff
"""

from __future__ import annotations

import csv
import io
import json
import time
from typing import Any

import requests


class MetadataError(Exception):
    def __init__(self, status: int, message: str, body: dict | None = None) -> None:
        self.status = status
        self.body = body
        super().__init__(f"[{status}] {message}")


def _bail(status: int, body: dict, msg: str | None = None) -> Never:
    err_body = (body or {}).get("error") or {}
    raise MetadataError(status, err_body.get("message") or msg or body.get("detail") or f"HTTP {status}", body)


class MetadataClient:
    """Typed client for the Romdoul metadata service REST API.

    * base_url — public URL of the metadata API (served through the Romdoul
      nginx + Netlify proxy). Defaults to the public hosted instance.
    * session_auth — if True (default), login with username/password to get
      a session token. The token is reused for every authenticated call.

    All methods raise MetadataError on failure (HTTP >= 400 or network error).
    """

    base_url: str
    _token: str | None
    _user: dict | None

    def __init__(
        self,
        username: str | None = None,
        password: str | None = None,
        base_url: str = "https://romdoulocr.netlify.app/api-meta",
        session_auth: bool = True,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._token = None
        self._user = None
        if username and password and session_auth:
            self.login(username, password)

    # -- helpers ----------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {}
        if self._token:
            h["X-Session-Token"] = self._token
        return h

    def _request(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        params: dict | None = None,
        stream: bool = False,
        timeout: int = 30,
    ) -> requests.Response:
        url = f"{self.base_url}/api/v1{path}"
        kwargs: dict = dict(
            method=method,
            url=url,
            headers=self._headers(),
            timeout=timeout,
            stream=stream,
        )
        if params:
            kwargs["params"] = {k: v for k, v in params.items() if v is not None and v != ""}
        if body is not None:
            kwargs["json"] = body

        for attempt in range(2):
            try:
                resp = requests.request(**kwargs)
            except requests.RequestException as exc:
                if attempt == 0:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise MetadataError(0, str(exc)) from exc
            if resp.status_code >= 500 and attempt == 0:
                time.sleep(1.5 * (attempt + 1))
                continue
            if resp.status_code >= 400:
                try:
                    err = resp.json()
                except Exception:
                    err = {}
                _bail(resp.status_code, err)
            return resp
        # unreachable
        raise MetadataError(0, "Too many retries")

    def _get(self, path: str, params: dict | None = None) -> Any:
        return self._request("GET", path, params=params).json()

    def _post(self, path: str, body: dict) -> Any:
        return self._request("POST", path, body=body).json()

    def _patch(self, path: str, body: dict) -> Any:
        return self._request("PATCH", path, body=body).json()

    def _delete(self, path: str) -> None:
        self._request("DELETE", path)

    # -- auth ------------------------------------------------------------------

    def login(self, username: str, password: str) -> dict[str, Any]:
        """Authenticate and store the session token for subsequent calls."""
        resp = self._post("/auth/login", {"username": username, "password": password})
        self._token = resp.get("token")
        self._user = resp.get("user")
        return resp

    def logout(self) -> None:
        """Revoke the current session."""
        if self._token:
            self._post("/auth/logout", {})
        self._token = None
        self._user = None

    @property
    def signed_in(self) -> bool:
        return self._token is not None

    @property
    def user(self) -> dict | None:
        return self._user

    # -- records ---------------------------------------------------------------

    def create_record(self, payload: dict[str, Any]) -> dict[str, Any]:
        """POST a new extraction record (open — no auth needed). Returns the
        created record envelope. Supply an ``id`` field for idempotency (409 on
        duplicate)."""
        return self._post("/records", payload)

    def list_records(self, **filters: Any) -> dict[str, Any]:
        """GET filtered records. Returns the page object:
        {items, page, page_size, total, total_pages}.

        Filters: type, domain, status, tag, business_from, business_to,
        created_from, created_to, q (search), page, page_size, sort."""
        params = {k: v for k, v in filters.items() if v is not None and v != ""}
        return self._get("/records", params if params else None)

    def get_record(self, record_id: str) -> dict[str, Any]:
        """Fetch a single record (full envelope + data)."""
        return self._get(f"/records/{record_id}")

    def patch_record(
        self,
        record_id: str,
        *,
        data: dict[str, Any] | None = None,
        business: dict[str, Any] | None = None,
        status: str | None = None,
        edited_by: str | None = None,
    ) -> dict[str, Any]:
        """Edit a record's data, business metadata, or status. Auto-updates the
        audit trail (edited_at, edited_by, edit_count++, status→edited)."""
        body: dict[str, Any] = {}
        if data is not None:
            body["data"] = data
        if business is not None:
            body["business"] = business
        if status is not None:
            body["status"] = status
        headers = {"X-Edited-By": edited_by} if edited_by else {}
        return self._patch(f"/records/{record_id}", body)

    def delete_record(self, record_id: str) -> None:
        """Delete a record (admin only)."""
        self._delete(f"/records/{record_id}")

    def record_history(self, record_id: str) -> list[dict[str, Any]]:
        """Get the audit trail for a record (create/update/delete events)."""
        return self._get(f"/records/{record_id}/history")

    # -- export ----------------------------------------------------------------

    def export_csv(
        self,
        dest: str | None = None,
        **filters: Any,
    ) -> str:
        """Export filtered records as CSV. If ``dest`` is a file path, stream
        the response to disk. Returns the raw CSV string."""
        params = {k: v for k, v in filters.items() if v is not None and v != ""}
        params.setdefault("format", "csv")
        resp = self._request("GET", "/export", params=params, stream=dest is not None, timeout=120)
        if dest:
            with open(dest, "wb") as f:
                for chunk in resp.iter_content(8192):
                    f.write(chunk)
            return dest
        return resp.text

    def export_json(self, **filters: Any) -> list[dict[str, Any]]:
        """Export filtered records as a list of full envelope dicts."""
        params = {k: v for k, v in filters.items() if v is not None and v != ""}
        params.setdefault("format", "json")
        return self._get("/export", params)

    # -- stats / meta / health -------------------------------------------------

    def stats(self) -> dict[str, Any]:
        """Aggregates: total, by_status, by_type, by_domain, per-day."""
        return self._get("/stats")

    def meta(self) -> dict[str, Any]:
        """Distinct types and domains (for filter dropdowns)."""
        return self._get("/meta")

    def health(self) -> dict[str, Any]:
        """Liveness + DB check. No auth needed."""
        return requests.get(f"{self.base_url}/health", timeout=10).json()

    # -- user management (admin only) ------------------------------------------

    def list_users(self) -> list[dict[str, Any]]:
        return self._get("/auth/users")

    def create_user(
        self, username: str, password: str, role: str = "viewer"
    ) -> dict[str, Any]:
        return self._post("/auth/users", {
            "username": username,
            "password": password,
            "role": role,
        })

    def update_user(self, user_id: int, *, role: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if role is not None:
            body["role"] = role
        return self._patch(f"/auth/users/{user_id}", body)

    def delete_user(self, user_id: int) -> None:
        self._delete(f"/auth/users/{user_id}")


# -- Airflow / Dagster helpers -------------------------------------------------

def airflow_metadata_connection(
    conn_id: str = "romdoul_metadata",
    *,
    base_url: str = "https://romdoulocr.netlify.app/api-meta",
    username: str | None = None,
    password: str | None = None,
) -> MetadataClient:
    """Create a MetadataClient from Airflow connection variables or direct
    credentials. Falls back to os.environ lookups.

    Usage in a DAG::

        from metadata import airflow_metadata_connection

        client = airflow_metadata_connection()

        @task
        def pull_records():
            return client.list_records(type="document", page_size=200)

    Set these Airflow Variables or env vars:
        ROMDOUL_META_URL     — base URL
        ROMDOUL_META_USER    — username
        ROMDOUL_META_PASS    — password
    """
    import os

    url = base_url if base_url else os.getenv("ROMDOUL_META_URL", "https://romdoulocr.netlify.app/api-meta")
    user = username or os.getenv("ROMDOUL_META_USER")
    pw = password or os.getenv("ROMDOUL_META_PASS")
    return MetadataClient(user, pw, base_url=url)


# ─── Async variant (aiohttp) ────────────────────────────────────────────────

class AsyncMetadataClient:
    """aiohttp-based async variant for high-throughput Airflow DAGs / asyncio apps.

    Usage::

        from metadata import AsyncMetadataClient

        async with AsyncMetadataClient("admin", "pass") as c:
            stats = await c.stats()
            recs = await c.list_records(page_size=50)
    """

    def __init__(
        self,
        username: str | None = None,
        password: str | None = None,
        base_url: str = "https://romdoulocr.netlify.app/api-meta",
    ) -> None:
        try:
            import aiohttp
        except ImportError:
            raise ImportError("aiohttp is required for AsyncMetadataClient: pip install aiohttp") from None
        self.base_url = base_url.rstrip("/")
        self._token: str | None = None
        self._session: aiohttp.ClientSession | None = None
        self._creds = (username, password)

    async def __aenter__(self):
        import aiohttp
        self._session = aiohttp.ClientSession(headers={"Content-Type": "application/json"})
        if self._creds[0] and self._creds[1]:
            await self.login(self._creds[0], self._creds[1])
        return self

    async def __aexit__(self, *_: Any) -> None:
        if self._session:
            await self._session.close()

    async def _request(self, method: str, path: str, body: dict | None = None, params: dict | None = None, timeout: int = 30) -> Any:
        import aiohttp
        if not self._session:
            raise RuntimeError("Use 'async with AsyncMetadataClient(...)' or call open() first")
        headers: dict = {}
        if self._token:
            headers["X-Session-Token"] = self._token
        url = f"{self.base_url}/api/v1{path}"
        kwargs: dict = dict(method=method, url=url, headers=headers, timeout=aiohttp.ClientTimeout(total=timeout))
        if params:
            kwargs["params"] = {k: v for k, v in params.items() if v is not None and v != ""}
        if body is not None:
            kwargs["json"] = body
        for attempt in range(2):
            try:
                async with self._session.request(**kwargs) as resp:
                    if resp.status >= 500 and attempt == 0:
                        import asyncio
                        await asyncio.sleep(1.5 * (attempt + 1))
                        continue
                    if resp.status >= 400:
                        try:
                            err = await resp.json()
                        except Exception:
                            err = {}
                        _bail(resp.status, err)
                    if resp.status == 204:
                        return None
                    return await resp.json()
            except aiohttp.ClientError as exc:
                if attempt == 0:
                    import asyncio
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue
                raise MetadataError(0, str(exc)) from exc

    async def login(self, username: str, password: str) -> dict:
        resp = await self._request("POST", "/auth/login", body={"username": username, "password": password})
        self._token = resp.get("token")
        return resp

    async def health(self) -> dict:
        async with self._session.get(f"{self.base_url}/health", timeout=aiohttp.ClientTimeout(10)) as resp:
            return await resp.json()

    async def stats(self) -> dict: return await self._request("GET", "/stats")

    async def list_records(self, **filters: Any) -> dict:
        return await self._request("GET", "/records", params={k: v for k, v in filters.items() if v is not None})

    async def get_record(self, record_id: str) -> dict:
        return await self._request("GET", f"/records/{record_id}")

    async def create_record(self, payload: dict) -> dict:
        return await self._request("POST", "/records", body=payload)

    async def patch_record(self, record_id: str, *, data: dict | None = None, business: dict | None = None, status: str | None = None) -> dict:
        body: dict = {}
        if data is not None: body["data"] = data
        if business is not None: body["business"] = business
        if status is not None: body["status"] = status
        return await self._request("PATCH", f"/records/{record_id}", body=body)

    async def delete_record(self, record_id: str) -> None:
        await self._request("DELETE", f"/records/{record_id}")

    async def record_history(self, record_id: str) -> list:
        return await self._request("GET", f"/records/{record_id}/history")

    async def list_users(self) -> list:
        return await self._request("GET", "/auth/users")

    async def create_user(self, username: str, password: str, role: str = "viewer") -> dict:
        return await self._request("POST", "/auth/users", body={"username": username, "password": password, "role": role})

    async def export_json(self, **filters: Any) -> list:
        return await self._request("GET", "/export", params={"format": "json", **{k: v for k, v in filters.items() if v is not None}})
