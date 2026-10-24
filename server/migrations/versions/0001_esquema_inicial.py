"""Esquema inicial (v1)

Revision ID: 0001
Revises:
"""
from alembic import op

from labsolar import db

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

# Esta revisión crea el esquema tal como existía al publicar la v1. Los cambios posteriores van en revisiones nuevas
# con operaciones explícitas (op.add_column, op.create_index, ...), nunca editando esta.
TABLES = ["users", "bookings", "auth_sessions", "sessions", "runs", "samples", "events", "commands", "sweeps", "audit"]


def upgrade() -> None:
    db.metadata.create_all(op.get_bind())


def downgrade() -> None:
    bind = op.get_bind()
    for name in reversed(TABLES):
        if name in db.metadata.tables:
            db.metadata.tables[name].drop(bind, checkfirst=True)
