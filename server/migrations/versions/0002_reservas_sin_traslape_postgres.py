"""Reservas sin traslape garantizadas por la base (PostgreSQL)

Revision ID: 0002
Revises: 0001

La aplicación ya rechaza los traslapes, pero dos peticiones simultáneas podrían pasar la comprobación a la vez. Una restricción
de exclusión hace que la propia base lo impida. En SQLite (pruebas) no existe y no se aplica.
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")
    op.execute("ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap EXCLUDE USING gist "
               "(bank WITH =, tstzrange(start_at, end_at) WITH &&) WHERE (NOT cancelled)")


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_overlap")
