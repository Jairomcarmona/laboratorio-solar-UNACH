"""Tabla de ajustes de operación (bloqueo por mantenimiento)

Revision ID: 0003
Revises: 0002
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import JSONB

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "settings" in sa.inspect(op.get_bind()).get_table_names():      # la revisión 0001 usa create_all y en bases nuevas ya la creó
        return
    op.create_table("settings",
                    sa.Column("key", sa.String(48), primary_key=True),
                    sa.Column("value", JSON().with_variant(JSONB(), "postgresql")),
                    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False))


def downgrade() -> None:
    op.drop_table("settings")
