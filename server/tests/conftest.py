import asyncio
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("LABSOLAR_CONTRACT_DIR", str(Path(__file__).resolve().parent.parent / "contract" / "v1"))

from labsolar import contract                                    # noqa: E402
from labsolar.bridge.app import BridgeApp, BridgeConfig          # noqa: E402
from labsolar.bridge.daq.fake import FakeDaq                     # noqa: E402
from labsolar.bridge.drivers.fake import FakeController          # noqa: E402
from labsolar.bridge.fakebank import FakeBank, run_bank          # noqa: E402
from labsolar.bus import MemoryBus                               # noqa: E402

BANK = "t1"
SOLAR_NOON = "2026-10-23T17:30:00"       # 11:30 hora local de Tuxtla, Sol alto


class Rig:
    """Puente + banco virtual + bus en memoria, con tiempos cortos para las pruebas."""

    def __init__(self, bank_cfg=None, bridge_cfg=None, controller=None, daq=None):
        self.bus = MemoryBus()
        self.bus.keep_log = True
        cfg = {"solar_start": SOLAR_NOON, "hb_timeout_s": 0.6, "wind": {"stow_delay_s": 0.3, "resume_hold_s": 0.5}}
        cfg.update(bank_cfg or {})
        self.bank = FakeBank(cfg)
        self.ctrl = controller or FakeController(self.bank)
        self.daq = daq or FakeDaq(self.bank)
        bc = dict(bank=BANK, tele_period_s=0.1, hb_period_s=0.1, gateway_timeout_s=0.8, sweep_seconds=1.0, sweep_point_s=0.05)
        bc.update(bridge_cfg or {})
        self.app = BridgeApp(self.bus, self.ctrl, self.daq, BridgeConfig(**bc))
        self.tasks = []
        self.acks = self.bus.subscribe(contract.topic(BANK, "cmd/ack"))
        self.events = self.bus.subscribe(contract.topic(BANK, "event"))
        self.teles = self.bus.subscribe(contract.topic(BANK, "tele"))
        self.sweeps = self.bus.subscribe(contract.topic(BANK, "sweep"))
        self._n = 0
        self.gateway_alive = True

    async def start(self, gateway=True, bank_runner=True):
        if bank_runner:
            self.tasks.append(asyncio.create_task(run_bank(self.bank, 50.0)))
        await self.app.start()
        if gateway:
            self.tasks.append(asyncio.create_task(self._gateway_hb()))
            await asyncio.sleep(0.4)

    async def _gateway_hb(self):
        while True:
            if self.gateway_alive:
                await self.bus.publish(contract.topic(BANK, "hb/gateway"), {"ts": 1})
            await asyncio.sleep(0.1)

    async def cmd(self, ctype, args=None, session="s1", role="student", user="ana", timeout=3.0):
        self._n += 1
        cid = f"c{self._n}"
        # publicación cruda: el puente debe resistir también lo que la pasarela jamás enviaría (defensa en profundidad)
        await self.bus.publish(contract.topic(BANK, "cmd/req"), {"id": cid, "ts": 1, "sessionId": session, "user": user, "role": role, "type": ctype, **({"args": args} if args else {})})
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while True:
            _, a = await self.acks.get(timeout=max(0.01, end - loop.time()))
            if a["id"] == cid:
                return a

    async def login(self, session="s1", role="student"):
        return await self.cmd("session.start", {"role": role, "user": "ana"}, session=session, role=role)

    async def stop(self):
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.app.stop()


@pytest.fixture
async def rig():
    r = Rig()
    await r.start()
    yield r
    await r.stop()


# ---------------------------------------------------------------------------------------------- pasarela
import datetime as dt                                           # noqa: E402
import socket                                                   # noqa: E402

import httpx                                                    # noqa: E402
import uvicorn                                                  # noqa: E402
import websockets                                               # noqa: E402

from labsolar import db as ldb                                  # noqa: E402
from labsolar.gateway.app import create_app                     # noqa: E402
from labsolar.gateway.security import hash_password             # noqa: E402
from labsolar.gateway.settings import Settings                  # noqa: E402
from labsolar.repo import Repo                                  # noqa: E402

PW = "una-contraseña-larga-1"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class WS:
    """Cliente WebSocket de prueba."""

    def __init__(self, conn):
        self.conn = conn
        self.inbox = []
        self.task = asyncio.create_task(self._rx())
        self.closed = None

    async def _rx(self):
        try:
            async for m in self.conn:
                self.inbox.append(contract.loads(m))
        except websockets.ConnectionClosed as e:
            self.closed = e.rcvd.code if e.rcvd else None
        except Exception:
            pass
        if self.closed is None and self.conn.close_code:
            self.closed = self.conn.close_code

    async def send(self, obj):
        await self.conn.send(contract.dumps(obj))

    async def wait(self, pred, timeout=3.0):
        end = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < end:
            for m in self.inbox:
                if pred(m):
                    return m
            await asyncio.sleep(0.02)
        raise asyncio.TimeoutError(f"no llegó el mensaje esperado; recibidos: {[m['t'] for m in self.inbox][-10:]}")

    async def ack(self, cid, timeout=3.0):
        return (await self.wait(lambda m: m["t"] == "ack" and m["d"]["id"] == cid, timeout))["d"]

    async def cmd(self, ctype, args=None, cid=None, timeout=3.0):
        cid = cid or f"w{len(self.inbox)}{ctype}{id(args)}"[:60].replace(" ", "")
        await self.send({"t": "cmd", "v": 1, "id": cid, "type": ctype, **({"args": args} if args is not None else {})})
        return await self.ack(cid, timeout)

    async def close(self):
        await self.conn.close()
        self.task.cancel()


class GatewayRig(Rig):
    def __init__(self, settings_over=None, **kw):
        super().__init__(**kw)
        self.engine = ldb.make_engine("sqlite://")
        ldb.init_db(self.engine)
        self.repo = Repo(self.engine)
        self.port = free_port()
        s = Settings(bank=BANK, cookie_secure=False, client_hb_timeout_s=1.0, ack_timeout_s=1.5, ticket_ttl_s=30, mqtt={"kind": "memory"}, gateway_hb_period_s=0.1)
        for k, v in (settings_over or {}).items():
            setattr(s, k, v)
        self.settings = s
        self.server = None
        self.http = []
        self.sockets = []

    async def start_all(self):
        await self.start(gateway=False)
        self.api = create_app(self.settings, bus=self.bus, repo=self.repo)
        cfg = uvicorn.Config(self.api, host="127.0.0.1", port=self.port, log_level="warning", lifespan="on", ws="websockets")
        self.server = uvicorn.Server(cfg)
        self.server_task = asyncio.create_task(self.server.serve())
        for _ in range(100):
            if self.server.started:
                break
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.5)                     # primer latido de la pasarela hacia el puente

    def add_user(self, name, role, pw=PW):
        return self.repo.create_user(name, hash_password(pw), role, name.title())

    def book(self, user, start=None, minutes=30):
        start = start or (ldb.utcnow() - dt.timedelta(minutes=1))
        with self.engine.begin() as c:                  # inserción directa: permite traslapes que la API de reservas impide
            c.execute(ldb.bookings.insert().values(user_id=user["id"], bank=BANK, start_at=start, end_at=start + dt.timedelta(minutes=minutes),
                                                   created_by=None, cancelled=False, created_at=ldb.utcnow()))

    async def client(self, name, pw=PW):
        h = httpx.AsyncClient(base_url=f"http://127.0.0.1:{self.port}")
        r = await h.post("/api/login", json={"username": name, "password": pw})
        assert r.status_code == 200, r.text
        self.http.append(h)
        return h

    async def ws(self, http, ticket=None):
        if ticket is None:
            ticket = (await http.post("/api/ws-ticket")).json()["ticket"]
        conn = await websockets.connect(f"ws://127.0.0.1:{self.port}/ws?ticket={ticket}")
        w = WS(conn)
        self.sockets.append(w)
        return w

    async def stop_all(self):
        for w in self.sockets:
            with contextlib.suppress(Exception):
                await w.close()
        for h in self.http:
            await h.aclose()
        self.server.should_exit = True
        await asyncio.wait_for(self.server_task, 5)
        await self.stop()


import contextlib                                               # noqa: E402


@pytest.fixture
async def grig():
    r = GatewayRig()
    await r.start_all()
    yield r
    await r.stop_all()
