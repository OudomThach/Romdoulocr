import asyncio
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Webhook
from ..security import Actor, require_auth

log = logging.getLogger("metadata.webhooks")
router = APIRouter(prefix="/api/v1/webhooks", tags=["webhooks"])


class WebhookCreate(BaseModel):
    url: str
    events: list[str] = ["create", "update", "delete"]


@router.post("", status_code=201, response_model=dict)
async def create_webhook(payload: WebhookCreate, actor: Actor = Depends(require_auth), session: AsyncSession = Depends(get_session)) -> dict:
    if actor.role != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    for e in payload.events:
        if e not in ("create", "update", "delete"):
            raise HTTPException(status_code=422, detail=f"Unknown event: {e}")
    wh = Webhook(url=payload.url.strip(), events=payload.events, enabled=True)
    session.add(wh)
    await session.commit()
    return {"id": wh.id, "url": wh.url, "events": wh.events, "enabled": wh.enabled}


@router.get("", response_model=list[dict])
async def list_webhooks(actor: Actor = Depends(require_auth), session: AsyncSession = Depends(get_session)) -> list[dict]:
    if actor.role != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    rows = await session.execute(select(Webhook).order_by(Webhook.id))
    return [{"id": w.id, "url": w.url, "events": w.events, "enabled": w.enabled} for w in rows.scalars()]


@router.delete("/{webhook_id:int}", response_model=None, status_code=204)
async def delete_webhook(webhook_id: int, actor: Actor = Depends(require_auth), session: AsyncSession = Depends(get_session)) -> None:
    if actor.role != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    wh = await session.get(Webhook, webhook_id)
    if not wh:
        raise HTTPException(status_code=404, detail="Webhook not found")
    await session.delete(wh)
    await session.commit()


async def fire_webhooks(record_id: str, action: str, snapshot: dict) -> None:
    """Fire matching webhooks asynchronously (fire-and-forget, 5s cap).
    Uses its own session to avoid concurrent-access issues with the caller's session."""
    from ..db import SessionLocal
    async with SessionLocal() as session:
        rows = await session.execute(select(Webhook).where(Webhook.enabled == True, Webhook.events.contains([action])))
        hooks = rows.scalars().all()
        if not hooks:
            return
        payload = {"event": action, "record_id": record_id, "snapshot": snapshot}

        async def _send(wh: Webhook) -> None:
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                    await client.post(wh.url, json=payload)
            except Exception as exc:
                log.warning("webhook %s failed: %s", wh.id, exc)

        tasks = [asyncio.create_task(_send(wh)) for wh in hooks]
        for t in tasks:
            t.add_done_callback(lambda _: None)
