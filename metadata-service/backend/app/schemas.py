import datetime as dt
from typing import Any

from pydantic import BaseModel, Field, field_validator


# --------------------------------------------------------------------------- #
# Envelope models — domain-agnostic metadata, validated at the API boundary
# --------------------------------------------------------------------------- #
class SourceIn(BaseModel):
    document_id: str | None = None
    filename: str | None = None
    page: int | None = Field(default=None, ge=1)
    extracted_at: dt.datetime | None = None
    model: str | None = None
    source_system: str | None = None


class AuditIn(BaseModel):
    created_at: dt.datetime | None = None
    created_by: str | None = None
    edited_at: dt.datetime | None = None
    edited_by: str | None = None
    edit_count: int | None = Field(default=None, ge=0)
    status: str | None = None
    raw_ref: str | None = None


class PipelineIn(BaseModel):
    run_id: str | None = None
    batch_id: str | None = None
    version: str | None = None


class ValidationIn(BaseModel):
    status: str | None = Field(default=None, pattern=r"^(accepted|rejected|quarantined)$")
    warnings: list[str] | None = None


class RecordIn(BaseModel):
    validation: ValidationIn | None = None


class BusinessIn(BaseModel):
    date: dt.date | None = None
    tags: list[str] | None = None
    domain: str | None = None
    is_duplicate: bool | None = None
    coverage: float | None = Field(default=None, ge=0, le=1)


class RecordCreate(BaseModel):
    id: str | None = Field(default=None, max_length=36)
    schema_version: str = "1.0"
    type: str = Field(min_length=1, max_length=64)
    source: SourceIn | None = None
    audit: AuditIn | None = None
    pipeline: PipelineIn | None = None
    record: RecordIn | None = None
    business: BusinessIn | None = None
    data: dict[str, Any]

    @field_validator("id")
    @classmethod
    def _id_chars(cls, v: str | None) -> str | None:
        if v and not all(c.isalnum() or c in "-_" for c in v):
            raise ValueError("id must be alphanumeric, dash or underscore")
        return v


class RecordPatch(BaseModel):
    data: dict[str, Any] | None = None
    business: BusinessIn | None = None
    status: str | None = Field(default=None, pattern=r"^(raw|edited|verified)$")


# --------------------------------------------------------------------------- #
# Response models
# --------------------------------------------------------------------------- #
class RecordOut(BaseModel):
    id: str
    schema_version: str
    type: str
    domain: str | None
    status: str
    business_date: dt.date | None
    tags: list[str] | None
    source: SourceIn | None = None
    audit: AuditIn | None = None
    pipeline: PipelineIn | None = None
    record: RecordIn | None = None
    business: BusinessIn | None = None
    data: dict[str, Any]
    envelope: dict[str, Any]
    created_at: dt.datetime
    created_by: str
    edited_at: dt.datetime | None
    edited_by: str | None
    edit_count: int
    source_model: str | None = None
    source_system: str | None = None


class PageOut(BaseModel):
    items: list[RecordOut]
    page: int
    page_size: int
    total: int
    total_pages: int


class ErrorOut(BaseModel):
    error: dict[str, Any]
