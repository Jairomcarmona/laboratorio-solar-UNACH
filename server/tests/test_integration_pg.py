"""Integración con PostgreSQL real (initdb temporal). Se omite si PostgreSQL 16 no está instalado."""
import datetime as dt
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import pytest
import sqlalchemy as sa

from labsolar import db
from labsolar.repo import Repo

PGBIN = Path("/usr/lib/postgresql/16/bin")
pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def pg_url():
    if not (PGBIN / "initdb").exists() or os.geteuid() != 0:
        pytest.skip("PostgreSQL 16 no disponible (o no se puede iniciar como usuario postgres)")
    base = Path(tempfile.mkdtemp(prefix="pgtest-", dir="/tmp"))        # fuera de /tmp/pytest-of-root, que postgres no puede atravesar
    shutil.chown(base, "postgres")
    base.chmod(0o755)
    data = base / "data"
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    run = lambda *a: subprocess.run(["su", "postgres", "-c", " ".join(map(str, a))], check=True, capture_output=True, text=True)    # noqa: E731
    run(PGBIN / "initdb", "-D", data, "-A", "trust", "-U", "postgres")
    run(PGBIN / "pg_ctl", "-D", data, "-o", f"'-p {port} -k {base} -c listen_addresses=127.0.0.1'", "-w", "-l", base / "log", "start")
    run(PGBIN / "createdb", "-h", "127.0.0.1", "-p", port, "-U", "postgres", "labsolar")
    yield f"postgresql://postgres@127.0.0.1:{port}/labsolar"
    run(PGBIN / "pg_ctl", "-D", data, "-m", "immediate", "stop")
    shutil.rmtree(base, ignore_errors=True)


def test_migracion_en_postgresql_y_restriccion_contra_traslapes(pg_url):
    db.migrate(pg_url)
    eng = db.make_engine(pg_url)
    repo = Repo(eng)
    u1 = repo.create_user("ana", "x", "student", "Ana")
    u2 = repo.create_user("beto", "x", "student", "Beto")
    t = db.utcnow() + dt.timedelta(hours=1)
    assert repo.create_booking(u1["id"], "lab1", t, t + dt.timedelta(minutes=60), None)
    assert repo.create_booking(u2["id"], "lab1", t + dt.timedelta(minutes=30), t + dt.timedelta(minutes=90), None) is None
    assert repo.create_booking(u2["id"], "lab1", t + dt.timedelta(minutes=60), t + dt.timedelta(minutes=90), None)      # contiguas: sí
    # la base lo impide aunque la aplicación no lo hubiera comprobado (carrera entre dos peticiones)
    with pytest.raises(sa.exc.IntegrityError):
        with eng.begin() as c:
            c.execute(sa.insert(db.bookings).values(user_id=u2["id"], bank="lab1", start_at=t + dt.timedelta(minutes=10), end_at=t + dt.timedelta(minutes=20),
                                                    cancelled=False, created_at=db.utcnow()))
    # una reserva cancelada libera el horario
    b = repo.list_bookings(u1["id"])[0]
    repo.cancel_booking(b["id"], None)
    assert repo.create_booking(u2["id"], "lab1", t, t + dt.timedelta(minutes=30), None)


def test_muestras_jsonb_y_consulta(pg_url):
    eng = db.make_engine(pg_url)
    repo = Repo(eng)
    repo.insert_event("lab1", {"ts": 1, "level": "info", "src": "x", "code": "c", "msg": "m", "data": {"a": 1}})
    with eng.connect() as c:
        assert c.execute(sa.select(sa.func.count()).select_from(db.events)).scalar() == 1
