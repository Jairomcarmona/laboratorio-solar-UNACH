"""Entorno de Alembic: la URL de la base viene de LABSOLAR_DB_URL (o de -x url=...)."""
import os

from alembic import context

from labsolar import db

target_metadata = db.metadata


def _url() -> str:
    url = context.get_x_argument(as_dictionary=True).get("url") or os.environ.get("LABSOLAR_DB_URL")
    if not url:
        raise SystemExit("Define LABSOLAR_DB_URL (o alembic -x url=...) para migrar la base.")
    return url


def run_migrations_online() -> None:
    cfg_conn = context.config.attributes.get("connection")
    if cfg_conn is not None:
        context.configure(connection=cfg_conn, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
        return
    engine = db.make_engine(_url())
    with engine.connect() as conn:
        context.configure(connection=conn, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


def run_migrations_offline() -> None:
    context.configure(url=_url(), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
