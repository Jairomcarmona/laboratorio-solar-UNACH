"""labsolar-gateway [serve | create-user USER ROLE]  (variables de entorno: ver server/deploy/.env.example)"""
from __future__ import annotations

import argparse
import getpass
import logging
import os
import sys

from .. import db
from ..repo import Repo
from .app import ROLES, create_app
from .security import hash_password
from .settings import Settings


def main() -> None:
    ap = argparse.ArgumentParser(description="Pasarela del Laboratorio Solar Remoto")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("serve")
    s.add_argument("--host", default="0.0.0.0")
    s.add_argument("--port", type=int, default=8000)
    cu = sub.add_parser("create-user", help="crea una cuenta (la contraseña se pide por teclado o LABSOLAR_NEW_PASSWORD)")
    cu.add_argument("username")
    cu.add_argument("role", choices=ROLES)
    cu.add_argument("--name", default="")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = Settings.from_env()
    if a.cmd == "create-user":
        pw = os.environ.get("LABSOLAR_NEW_PASSWORD") or getpass.getpass("Contraseña: ")
        if len(pw) < cfg.password_min_len:
            sys.exit(f"La contraseña debe tener al menos {cfg.password_min_len} caracteres")
        engine = db.make_engine(cfg.db_url)
        db.init_db(engine)
        repo = Repo(engine)
        if repo.user_by_name(a.username):
            sys.exit("Ese usuario ya existe")
        repo.create_user(a.username, hash_password(pw), a.role, a.name)
        print(f"Cuenta creada: {a.username} ({a.role})")
        return
    import uvicorn
    uvicorn.run(create_app(cfg), host=getattr(a, "host", "0.0.0.0"), port=getattr(a, "port", 8000), proxy_headers=True, forwarded_allow_ips="*", log_level="info",
                ws_max_size=16384)


if __name__ == "__main__":
    main()
