"""Pila completa en UN proceso para desarrollo y pruebas extremo a extremo, sin hardware ni broker:
bus en memoria + banco virtual + puente + registrador + gemelo + pasarela (que también sirve el simulador en el mismo origen).

    python -m labsolar.devstack --port 8000 --static ../laboratorio-solar-3d

Cuentas de prueba (solo para desarrollo): ana/estudiante, vera/visitante, root/administración. Contraseña: la de --password.
NO es el despliegue: en producción cada servicio corre por separado (server/deploy/docker-compose.yml) y las cuentas se crean con labsolar-gateway create-user.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import logging

import uvicorn

from . import contract, db
from .bridge.app import BridgeApp, BridgeConfig
from .bridge.daq.fake import FakeDaq
from .bridge.drivers.fake import FakeController
from .bridge.fakebank import FakeBank, run_bank
from .bus import MemoryBus
from .gateway.app import create_app
from .gateway.security import hash_password
from .gateway.settings import CSP, Settings
from .recorder.app import RecorderApp
from .repo import Repo
from .twin.app import TwinApp


async def run(a: argparse.Namespace) -> None:
    bus = MemoryBus()
    bank_cfg = {"hb_timeout_s": 2.0}
    if a.solar_start:
        bank_cfg["solar_start"] = a.solar_start
    bank = FakeBank(bank_cfg)
    bridge = BridgeApp(bus, FakeController(bank), FakeDaq(bank), BridgeConfig(bank=a.bank, tele_period_s=1.0, hb_period_s=0.5, gateway_timeout_s=a.gateway_timeout))
    engine = db.make_engine(a.db)
    db.init_db(engine)
    repo = Repo(engine)
    for name, role in (("ana", "student"), ("beto", "student"), ("vera", "visitor"), ("root", "admin")):
        if not repo.user_by_name(name):
            repo.create_user(name, hash_password(a.password), role, name.title())
    ana = repo.user_by_name("ana")
    now = db.utcnow()
    if not repo.active_booking(ana["id"], a.bank):
        repo.create_booking(ana["id"], a.bank, now - dt.timedelta(minutes=1), now + dt.timedelta(hours=2), None)
    settings = Settings(bank=a.bank, db_url=a.db, cookie_secure=False, static_dir=a.static, csp=CSP, mqtt={"kind": "memory"}, client_hb_timeout_s=a.client_timeout)
    api = create_app(settings, bus=bus, repo=repo)
    recorder = RecorderApp(bus, repo, a.bank)
    twin = TwinApp(bus, a.bank)
    ticker = asyncio.create_task(run_bank(bank, 20.0, speed=a.speed))
    await bridge.start()
    await recorder.start()
    await twin.start()
    server = uvicorn.Server(uvicorn.Config(api, host=a.host, port=a.port, log_level="warning", ws="websockets"))
    print(f"Pila de desarrollo en http://{a.host}:{a.port}/  (cuentas: ana, beto, vera, root; contraseña: {a.password})", flush=True)
    try:
        await server.serve()
    finally:
        ticker.cancel()
        await twin.stop()
        await recorder.stop()
        await bridge.stop()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--static", default=None, help="carpeta del simulador (index.html) para servirla en el mismo origen")
    ap.add_argument("--db", default="sqlite://", help="URL SQLAlchemy; por omisión SQLite en memoria")
    ap.add_argument("--bank", default="lab1")
    ap.add_argument("--password", default="dev-password-123")
    ap.add_argument("--solar-start", default=None, help="hora UTC ISO desde la que arranca el Sol del banco virtual, p. ej. 2026-10-23T17:30:00")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--gateway-timeout", type=float, default=6.0)
    ap.add_argument("--client-timeout", type=float, default=6.0)
    a = ap.parse_args()
    logging.basicConfig(level=logging.WARNING)
    asyncio.run(run(a))


if __name__ == "__main__":
    main()
