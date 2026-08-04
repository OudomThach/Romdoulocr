import csv
import datetime as dt
import io
import json

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import crud, models
from ..db import get_session
from ..security import require_auth

router = APIRouter(prefix="/api/v1", tags=["export"], dependencies=[Depends(require_auth)])


def _csv_headers() -> list[str]:
    return [
        "id", "type", "domain", "status", "business_date", "tags", "created_at", "created_by",
        "edited_at", "edited_by", "edit_count", "ingested_at", "source_filename", "source_model",
        "source_system", "source_page", "extracted_at", "validation_status", "pipeline_run_id",
        "pipeline_batch_id", "is_duplicate", "coverage", "data",
    ]


def _csv_row(r: models.Record) -> list[str]:
    return [
        r.id, r.type, r.domain or "", r.status,
        r.business_date.isoformat() if r.business_date else "",
        json.dumps(r.tags or [], ensure_ascii=False),
        r.created_at.isoformat() if r.created_at else "",
        r.created_by or "",
        r.edited_at.isoformat() if r.edited_at else "",
        r.edited_by or "",
        str(r.edit_count),
        r.ingested_at.isoformat() if r.ingested_at else "",
        r.source_filename or "", r.source_model or "", r.source_system or "",
        str(r.source_page) if r.source_page is not None else "",
        r.extracted_at.isoformat() if r.extracted_at else "",
        r.validation_status or "",
        r.pipeline_run_id or "", r.pipeline_batch_id or "",
        str(r.is_duplicate) if r.is_duplicate is not None else "",
        f"{r.coverage:.3f}" if r.coverage is not None else "",
        json.dumps(r.data or {}, ensure_ascii=False),
    ]


@router.get("/export", response_model=None)
async def export(
    format: str = Query(pattern=r"^(csv|json)$"),
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
) -> StreamingResponse | JSONResponse:
    stmt = crud.apply_filters(
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
    ).order_by(models.Record.created_at.desc())
    rows = (await session.execute(stmt)).scalars().all()

    if format == "json":
        return JSONResponse(content=[crud.to_out(r).model_dump(mode="json") for r in rows])

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(_csv_headers())
    for r in rows:
        writer.writerow(_csv_row(r))
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="records-{dt.date.today().isoformat()}.csv"'},
    )
