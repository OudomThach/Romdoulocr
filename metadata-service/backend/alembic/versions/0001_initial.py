"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-08-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "records",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("schema_version", sa.String(length=16), nullable=False, server_default="1.0"),
        sa.Column("type", sa.String(length=64), nullable=False),
        sa.Column("domain", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="raw"),
        sa.Column("business_date", sa.Date(), nullable=True),
        sa.Column("tags", ARRAY(sa.String()), nullable=True),
        sa.Column("source_filename", sa.String(length=512), nullable=True),
        sa.Column("source_model", sa.String(length=128), nullable=True),
        sa.Column("source_system", sa.String(length=128), nullable=True),
        sa.Column("source_page", sa.Integer(), nullable=True),
        sa.Column("extracted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("created_by", sa.String(length=128), server_default="system:unknown", nullable=False),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("edited_by", sa.String(length=128), nullable=True),
        sa.Column("edit_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("status_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ingested_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("pipeline_run_id", sa.String(length=128), nullable=True),
        sa.Column("pipeline_batch_id", sa.String(length=128), nullable=True),
        sa.Column("pipeline_version", sa.String(length=64), nullable=True),
        sa.Column("validation_status", sa.String(length=16), nullable=True),
        sa.Column("validation_warnings", JSONB(), nullable=True),
        sa.Column("is_duplicate", sa.Boolean(), nullable=True),
        sa.Column("coverage", sa.Float(), nullable=True),
        sa.Column("raw_ref", sa.String(length=512), nullable=True),
        sa.Column("envelope", JSONB(), nullable=False),
        sa.Column("data", JSONB(), nullable=False),
    )
    op.create_index("ix_records_type", "records", ["type"])
    op.create_index("ix_records_domain", "records", ["domain"])
    op.create_index("ix_records_status", "records", ["status"])
    op.create_index("ix_records_business_date", "records", ["business_date"])

    op.create_table(
        "audit_log",
        sa.Column("id", sa.Integer(), autoincrement=True, primary_key=True),
        sa.Column("record_id", sa.String(length=36), sa.ForeignKey("records.id", ondelete="CASCADE"), nullable=False),
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("actor", sa.String(length=128), server_default="system:unknown", nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("envelope_snapshot", JSONB(), nullable=False),
    )
    op.create_index("ix_audit_log_record_id", "audit_log", ["record_id"])


def downgrade() -> None:
    op.drop_table("audit_log")
    op.drop_table("records")
