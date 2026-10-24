import sqlalchemy as sa

from labsolar import db


def test_migrate_crea_el_esquema_completo_y_es_idempotente(tmp_path):
    url = f"sqlite:///{tmp_path}/m.db"
    db.migrate(url)
    db.migrate(url)                                   # volver a correr no rompe nada
    eng = db.make_engine(url)
    names = set(sa.inspect(eng).get_table_names())
    assert set(db.metadata.tables) <= names and "alembic_version" in names
    with eng.connect() as c:
        assert c.execute(sa.text("select version_num from alembic_version")).scalar() == "0003"


def test_el_esquema_migrado_es_igual_al_de_init_db(tmp_path):
    a, b = db.make_engine(f"sqlite:///{tmp_path}/a.db"), db.make_engine(f"sqlite:///{tmp_path}/b.db")
    db.migrate(f"sqlite:///{tmp_path}/a.db")
    db.init_db(b)
    cols = lambda e: {t: sorted(c["name"] for c in sa.inspect(e).get_columns(t)) for t in db.metadata.tables}   # noqa: E731
    assert cols(a) == cols(b)
