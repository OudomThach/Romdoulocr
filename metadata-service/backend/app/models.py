import datetime as dt

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from .db import Base

JsonType = JSONB().with_variant(JSON(), "sqlite")
StringArray = ARRAY(String).with_variant(JSON(), "sqlite")


class Record(Base):
    __tablename__ = "records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    schema_version: Mapped[str] = mapped_column(String(16), default="1.0")
    type: Mapped[str] = mapped_column(String(64), index=True)
    domain: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="raw", index=True)
    business_date: Mapped[dt.date | None] = mapped_column(Date, index=True, nullable=True)
    tags: Mapped[list[str] | None] = mapped_column(StringArray, nullable=True)

    source_filename: Mapped[str | None] = mapped_column(String(512), nullable=True)
    source_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    source_system: Mapped[str | None] = mapped_column(String(128), nullable=True)
    source_page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    extracted_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_by: Mapped[str] = mapped_column(String(128), default="system:unknown")
    edited_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    edited_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    edit_count: Mapped[int] = mapped_column(Integer, default=0)
    status_verified_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    ingested_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    pipeline_run_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    pipeline_batch_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    pipeline_version: Mapped[str | None] = mapped_column(String(64), nullable=True)

    validation_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    validation_warnings: Mapped[list | None] = mapped_column(JsonType, nullable=True)

    is_duplicate: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    coverage: Mapped[float | None] = mapped_column(Float, nullable=True)
    raw_ref: Mapped[str | None] = mapped_column(String(512), nullable=True)

    envelope: Mapped[dict] = mapped_column(JsonType)
    data: Mapped[dict] = mapped_column(JsonType)


class AuditEvent(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    record_id: Mapped[str] = mapped_column(String(36), ForeignKey("records.id", ondelete="CASCADE"), index=True)
    action: Mapped[str] = mapped_column(String(16))  # create | update | delete | verify
    actor: Mapped[str] = mapped_column(String(128), default="system:unknown")
    at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    envelope_snapshot: Mapped[dict] = mapped_column(JsonType)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(16), default="viewer")  # admin | viewer
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Session(Base):
    __tablename__ = "sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256 hex of the opaque token
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
