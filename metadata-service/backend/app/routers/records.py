import asyncio
import datetime as dt
import uuid

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import crud, models, schemas
from ..db import get_session
from ..errors import APIError
from ..security import Actor, require_auth
from .webhooks import fire_webhooks

# POST /records is deliberately OPEN so extraction pipelines can record from
# anywhere without shipping a key in a public bundle (idempotent via client id,
# rate-limited at nginx). Everything else — reads, edits, deletes — requires a
# valid X-API-Key (see auth).
router = APIRouter(prefix="/api/v1/records", tags=["records"])

STATUSES = {"raw", "edited", "verified"}


def _build_envelope(payload: schemas.RecordCreate, actor: str, now: dt.datetime) -> dict:
    audit_in = (payload.audit or schemas.AuditIn()).model_dump(exclude_none=True)
    created_at = audit_in.pop("created_at", now)
    created_by = audit_in.pop("created_by", actor)
    status = audit_in.pop("status", "raw")
    if status not in STATUSES:
        raise APIError(422, "invalid_status", f"status must be one of {sorted(STATUSES)}")
    envelope = payload.model_dump(mode="json", exclude_none=True, exclude={"id"})
    envelope["audit"] = {
        "created_at": created_at.isoformat(),
        "created_by": created_by,
        "status": status,
        "edit_count": 0,
        **audit_in,
    }
    envelope["record"] = {"validation": {"status": "accepted", "warnings": []}, "ingested_at": now.isoformat()}
    if payload.record and payload.record.validation:
        envelope["record"]["validation"] = {
            **envelope["record"]["validation"],
            **payload.record.validation.model_dump(exclude_none=True),
        }
    return envelope


def _parse_dt(v: object) -> dt.datetime | None:
    if v is None or isinstance(v, dt.datetime):
        return v
    if isinstance(v, str):
        return dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    return None


def _parse_date(v: object) -> dt.date | None:
    if v is None or isinstance(v, dt.date):
        return v
    if isinstance(v, str):
        return dt.date.fromisoformat(v)
    return None


def _apply_envelope(rec: models.Record, env: dict) -> None:
    rec.envelope = env
    src = env.get("source") or {}
    aud = env.get("audit") or {}
    pl = env.get("pipeline") or {}
    rcd = env.get("record") or {}
    biz = env.get("business") or {}
    rec.schema_version = env.get("schema_version", "1.0")
    rec.type = env.get("type", rec.type)
    rec.domain = biz.get("domain")
    rec.status = aud.get("status", rec.status)
    rec.business_date = _parse_date(biz.get("date"))
    rec.tags = biz.get("tags")
    rec.source_filename = src.get("filename")
    rec.source_model = src.get("model")
    rec.source_system = src.get("source_system")
    rec.source_page = src.get("page")
    rec.extracted_at = _parse_dt(src.get("extracted_at"))
    rec.created_at = _parse_dt(aud.get("created_at")) or rec.created_at
    rec.created_by = aud.get("created_by", rec.created_by)
    rec.edited_at = _parse_dt(aud.get("edited_at"))
    rec.edited_by = aud.get("edited_by", rec.edited_by)
    rec.edit_count = aud.get("edit_count", rec.edit_count)
    rec.pipeline_run_id = pl.get("run_id")
    rec.pipeline_batch_id = pl.get("batch_id")
    rec.pipeline_version = pl.get("version")
    val = rcd.get("validation") or {}
    rec.validation_status = val.get("status")
    rec.validation_warnings = val.get("warnings")
    rec.is_duplicate = biz.get("is_duplicate")
    rec.coverage = biz.get("coverage")
    rec.raw_ref = aud.get("raw_ref")
    rec.data = env.get("data", {})


@router.post("", status_code=201, response_model=schemas.RecordOut)
async def create_record(
    payload: schemas.RecordCreate,
    session: AsyncSession = Depends(get_session),
    x_api_key: str | None = Header(default=None),
    x_session_token: str | None = Header(default=None),
) -> models.Record:
    actor = "system:api"
    if x_api_key:
        actor = f"key:{x_api_key}"
    elif x_session_token:
        from ..security import user_by_token
        user = await user_by_token(session, x_session_token)
        actor = f"user:{user.username}" if user else "system:api"
    now = dt.datetime.now(dt.timezone.utc)
    record_id = payload.id or str(uuid.uuid4())
    exists = (await session.execute(select(func.count()).select_from(models.Record).where(models.Record.id == record_id))).scalar()
    if exists:
        raise APIError(409, "duplicate_id", f"record {record_id} already exists")

    envelope = _build_envelope(payload, actor, now)
    rec = models.Record(id=record_id, data=payload.data, envelope=envelope)
    _apply_envelope(rec, envelope)
    session.add(rec)
    await session.flush()  # assign rec.id before the FK-referencing audit row
    await crud.log_audit(session, record_id, "create", actor, envelope)
    await session.commit()
    asyncio.create_task(fire_webhooks(record_id, "create", envelope))
    await session.refresh(rec)
    return crud.to_out(rec)


@router.get("", response_model=schemas.PageOut)
async def list_records(
    _actor: Actor = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    type: str | None = Query(default=None),
    domain: str | None = Query(default=None),
    status: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    business_from: dt.date | None = Query(default=None),
    business_to: dt.date | None = Query(default=None),
    created_from: dt.datetime | None = Query(default=None),
    created_to: dt.datetime | None = Query(default=None),
    q: str | None = Query(default=None, max_length=256),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    sort: str = Query(default="created_at:desc", pattern=r"^(created_at|business_date|edited_at|type|status):(asc|desc)$"),
) -> schemas.PageOut:
    base = crud.apply_filters(
        select(models.Record),
        dialect=session.get_bind().dialect.name,
        type=type,
        domain=domain,
        status=status,
        tag=tag,
        business_from=business_from,
        business_to=business_to,
        created_from=created_from,
        created_to=created_to,
        q=q,
    )
    total = (await session.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
    stmt = crud.sort_stmt(base, sort).offset((page - 1) * page_size).limit(page_size)
    rows = (await session.execute(stmt)).scalars().all()
    return schemas.PageOut(
        items=[crud.to_out(r) for r in rows],
        page=page,
        page_size=page_size,
        total=int(total),
        total_pages=max(1, -(-int(total) // page_size)),
    )


@router.get("/{record_id}", response_model=schemas.RecordOut)
async def get_record(record_id: str, session: AsyncSession = Depends(get_session), _actor: Actor = Depends(require_auth)) -> models.Record:
    rec = await session.get(models.Record, record_id)
    if not rec:
        raise APIError(404, "not_found", f"record {record_id} not found")
    return crud.to_out(rec)


@router.delete("", response_model=dict)
async def bulk_delete_records(
    session: AsyncSession = Depends(get_session),
    _actor: Actor = Depends(require_auth),
    type: str | None = Query(default=None),
    domain: str | None = Query(default=None),
    status: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    created_before: dt.datetime | None = Query(default=None),
) -> dict:
    if _actor.role != "admin":
        raise APIError(403, "forbidden", "Admin role required")
    stmt = crud.apply_filters(
        select(models.Record),
        dialect=session.get_bind().dialect.name,
        type=type, domain=domain, status=status, tag=tag,
        business_from=None, business_to=None,
        created_from=None, created_to=created_before,
        q=None,
    )
    rows = (await session.execute(stmt)).scalars().all()
    count = len(rows)
    for r in rows:
        await crud.log_audit(session, r.id, "delete", _actor.label(), r.envelope or {})
        await session.delete(r)
    await session.commit()
    return {"deleted": count}


@router.get("/{record_id}/history", response_model=list[schemas.AuditEventOut])
async def record_history(
    record_id: str,
    session: AsyncSession = Depends(get_session),
    _actor: Actor = Depends(require_auth),
) -> list[schemas.AuditEventOut]:
    rec = await session.get(models.Record, record_id)
    if not rec:
        raise APIError(404, "not_found", f"record {record_id} not found")
    rows = (
        await session.execute(
            select(models.AuditEvent)
            .where(models.AuditEvent.record_id == record_id)
            .order_by(models.AuditEvent.at.asc())
        )
    ).scalars().all()
    return [
        schemas.AuditEventOut(
            id=e.id,
            action=e.action,
            actor=e.actor,
            at=e.at,
            snapshot=e.envelope_snapshot,
        )
        for e in rows
    ]


@router.patch("/{record_id}", response_model=schemas.RecordOut)
async def patch_record(
    record_id: str,
    payload: schemas.RecordPatch,
    session: AsyncSession = Depends(get_session),
    x_edited_by: str | None = Header(default=None),
    _actor: Actor = Depends(require_auth),
) -> models.Record:
    if _actor.role not in ("admin", "editor"):
        raise APIError(403, "forbidden", "Admin or editor role required to edit records")
    rec = await session.get(models.Record, record_id)
    if not rec:
        raise APIError(404, "not_found", f"record {record_id} not found")
    actor = x_edited_by or _actor.label()
    now = dt.datetime.now(dt.timezone.utc)

    env = dict(rec.envelope or {})
    changed = False
    if payload.data is not None:
        env["data"] = payload.data
        changed = True
    if payload.business is not None:
        biz = dict(env.get("business") or {})
        biz.update(payload.business.model_dump(mode="json", exclude_none=True))
        env["business"] = biz
        changed = True
    if payload.status is not None:
        if payload.status not in STATUSES:
            raise APIError(422, "invalid_status", f"status must be one of {sorted(STATUSES)}")
        env.setdefault("audit", {})["status"] = payload.status
        if payload.status == "verified":
            rec.status_verified_at = now
    elif changed:
        env.setdefault("audit", {})["status"] = "edited"

    aud = dict(env.get("audit") or {})
    aud["edited_at"] = now.isoformat()
    aud["edited_by"] = actor
    aud["edit_count"] = int(aud.get("edit_count", rec.edit_count or 0)) + 1
    if "status" not in aud:
        aud["status"] = rec.status
    env["audit"] = aud

    _apply_envelope(rec, env)
    await crud.log_audit(session, record_id, "update", actor, env)
    await session.commit()
    asyncio.create_task(fire_webhooks(record_id, "update", env))
    await session.refresh(rec)
    return crud.to_out(rec)


@router.delete("/{record_id}", status_code=204)
async def delete_record(
    record_id: str,
    session: AsyncSession = Depends(get_session),
    _actor: Actor = Depends(require_auth),
) -> None:
    rec = await session.get(models.Record, record_id)
    if not rec:
        raise APIError(404, "not_found", f"record {record_id} not found")
    if _actor.role != "admin":
        raise APIError(403, "forbidden", "Admin role required to delete records")
    actor = _actor.label()
    await crud.log_audit(session, record_id, "delete", actor, rec.envelope or {})
    await session.delete(rec)
    await session.commit()
    asyncio.create_task(fire_webhooks(record_id, "delete", rec.envelope or {}))
