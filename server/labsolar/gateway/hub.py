"""Centro de la pasarela: WebSocket de los navegadores <-> bus interno.

Reglas (plan, «Contrato de mensajes v1»):
  - El navegador nunca habla con el PLC ni con el broker; habla con esta pasarela, que autentica.
  - Una sola sesión con el control; las demás reciben la telemetría en solo lectura.
  - La pasarela añade sessionId, user y role desde la identidad autenticada; el navegador no puede ponerlos.
  - Máximo 5 comandos/s por conexión; cada comando recibe exactamente un acuse (sin respuesta en 3 s -> kind 'timeout').
  - Latido navegador -> pasarela cada 1 s: 6 s sin latido retiran el control (event session.lost).
  - Latido pasarela -> puente (hb/gateway) cada 1 s: lo vigila el puente.
"""
from __future__ import annotations

import asyncio
import collections
import contextlib
import datetime as dt
import logging
import time
import uuid
from typing import Any

from .. import contract
from ..bus import Bus
from ..repo import Repo
from .security import SlidingWindow
from .settings import Settings

log = logging.getLogger("labsolar.gateway")

OPERATE_ROLES = ("student", "teacher")


def now_ms() -> int:
    return int(time.time() * 1000)


class Client:
    def __init__(self, ws, user: dict) -> None:
        self.ws, self.user = ws, user
        self.id = "c_" + uuid.uuid4().hex[:10]
        self.out: asyncio.Queue = asyncio.Queue(maxsize=200)
        self.hb_last = time.monotonic()
        self.writer: asyncio.Task | None = None
        self.closed = False

    def send(self, msg: dict) -> None:
        if self.closed:
            return
        try:
            self.out.put_nowait(msg)
        except asyncio.QueueFull:                       # cliente lento: se descarta lo más viejo, nunca se bloquea al resto
            with contextlib.suppress(asyncio.QueueEmpty):
                self.out.get_nowait()
            self.out.put_nowait(msg)


class Hub:
    def __init__(self, bus: Bus, repo: Repo, cfg: Settings) -> None:
        self.bus, self.repo, self.cfg = bus, repo, cfg
        self.bank = cfg.bank
        self.clients: dict[str, Client] = {}
        self.control: Client | None = None
        self.control_session: str | None = None
        self.pending: dict[str, tuple[Client, float, str]] = {}
        self.rate = SlidingWindow(cfg.cmd_rate_per_s, 1.0)
        self.last_tele: dict | None = None
        self.last_state: dict | None = None
        self.tickets: dict[str, tuple[dict, float]] = {}
        self._tasks: list[asyncio.Task] = []
        self._booking_end: dt.datetime | None = None
        self.stats = {"cmd_in": 0, "cmd_rejected_local": 0, "cmd_published": 0, "acks": 0, "timeouts": 0}

    # ------------------------------------------------------------------ ciclo de vida
    async def start(self) -> None:
        b = self.bank
        self._sub = self.bus.subscribe(*(contract.topic(b, t) for t in ("tele", "state", "event", "cmd/ack", "sweep", "twin")))
        self._tasks = [asyncio.create_task(self._pump(), name="hub-pump"), asyncio.create_task(self._hb_publisher(), name="hub-hb"),
                       asyncio.create_task(self._watchdog(), name="hub-watchdog")]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        self._sub.close()
        for c in list(self.clients.values()):
            c.closed = True

    # ------------------------------------------------------------------ tickets de WebSocket
    def issue_ticket(self, user: dict) -> str:
        t = uuid.uuid4().hex + uuid.uuid4().hex
        self.tickets[t] = (user, time.monotonic() + self.cfg.ticket_ttl_s)
        for k in [k for k, (_, exp) in self.tickets.items() if exp < time.monotonic() - 60]:
            self.tickets.pop(k, None)
        return t

    def redeem_ticket(self, ticket: str | None) -> dict | None:
        """Un solo uso: se consume al canjear, válido o no."""
        entry = self.tickets.pop(ticket or "", None)
        if not entry or entry[1] < time.monotonic():
            return None
        return entry[0]

    # ------------------------------------------------------------------ bus -> navegadores
    async def _pump(self) -> None:
        async for topic, payload in self._sub:
            name = topic.split(f"{contract.PREFIX}/{self.bank}/", 1)[1]
            if name == "cmd/ack":
                await self._on_ack(payload)
                continue
            if name == "tele":
                self.last_tele = payload
            elif name == "state":
                self.last_state = payload
            kind = {"tele": "tele", "state": "state", "event": "event", "sweep": "sweep", "twin": "twin"}[name]
            for c in list(self.clients.values()):
                c.send({"t": kind, "v": 1, "d": payload})

    async def _on_ack(self, a: dict) -> None:
        ent = self.pending.pop(a["id"], None)
        if not ent:
            return
        self.stats["acks"] += 1
        client, _deadline, ctype = ent
        client.send({"t": "ack", "v": 1, "d": a})
        if ctype == "session.start" and a.get("ok") and client is not self.control:
            pass                                          # el control ya se asignó de forma optimista; se confirma aquí
        if ctype == "session.start" and not a.get("ok") and self.control is client:
            self._release_local()

    # ------------------------------------------------------------------ latidos y vigilancia
    async def _hb_publisher(self) -> None:
        while True:
            await self.bus.publish_msg(self.bank, "hb/gateway", {"ts": now_ms(), "sessionId": self.control_session})
            await asyncio.sleep(self.cfg.gateway_hb_period_s)

    async def _watchdog(self) -> None:
        while True:
            await asyncio.sleep(0.25)
            now = time.monotonic()
            c = self.control
            if c is not None:
                if now - c.hb_last > self.cfg.client_hb_timeout_s:
                    await self._revoke_control("session.lost", f"Sin latido del navegador en {self.cfg.client_hb_timeout_s:.0f} s: se retira el control", "sin latido del navegador")
                elif self._booking_end is not None and dt.datetime.now(dt.timezone.utc) >= self._booking_end:
                    await self._revoke_control("session.expired", "La reserva terminó: se retira el control", "reserva terminada")
            for cid, (client, deadline, ctype) in list(self.pending.items()):
                if now >= deadline:
                    self.pending.pop(cid, None)
                    self.stats["timeouts"] += 1
                    client.send({"t": "ack", "v": 1, "d": contract.ack(cid, now_ms(), False, "timeout", "Sin respuesta del banco.")})

    def _release_local(self) -> None:
        self.control = None
        self.control_session = None
        self._booking_end = None

    async def _revoke_control(self, code: str, msg: str, why: str) -> None:
        c, sid = self.control, self.control_session
        self._release_local()
        if c is None or sid is None:
            return
        await self._publish_req("session.end", {"why": why}, sid, c.user, c.user["role"], f"gw_{uuid.uuid4().hex[:10]}")
        ev = contract.event(now_ms(), "warn", "pasarela", code, msg, {"sessionId": sid, "user": c.user["username"]})
        await self.bus.publish_msg(self.bank, "event/gw", ev)      # el navegador lo recibe directo (abajo); el registrador, por este tópico
        c.send({"t": "event", "v": 1, "d": ev})

    # ------------------------------------------------------------------ conexiones
    async def connect(self, ws, user: dict) -> Client:
        c = Client(ws, user)
        self.clients[c.id] = c
        c.writer = asyncio.create_task(self._writer(c))
        c.send({"t": "hello", "v": 1, "user": user["username"], "role": user["role"], "control": False, "state": self.last_state, "serverTime": now_ms()})
        if self.last_tele:
            c.send({"t": "tele", "v": 1, "d": self.last_tele})
        return c

    async def _writer(self, c: Client) -> None:
        try:
            while True:
                msg = await c.out.get()
                await c.ws.send_text(contract.dumps(msg))
        except Exception:
            c.closed = True

    async def disconnect(self, c: Client) -> None:
        self.clients.pop(c.id, None)
        c.closed = True
        if c.writer:
            c.writer.cancel()
        if self.control is c:
            await self._revoke_control("session.lost", "El navegador con el control se desconectó", "navegador desconectado")

    # ------------------------------------------------------------------ navegador -> bus
    async def on_message(self, c: Client, text: str) -> None:
        try:
            msg = contract.loads(text)
        except Exception:
            c.send({"t": "event", "v": 1, "d": contract.event(now_ms(), "warn", "pasarela", "msg.invalid", "Mensaje no válido (JSON estricto)")})
            return
        if not isinstance(msg, dict):
            return
        t = msg.get("t")
        if t == "hb":
            c.hb_last = time.monotonic()
        elif t == "cmd":
            await self._on_cmd(c, msg)
        # otros tipos del navegador se ignoran

    async def _local_reject(self, c: Client, cid: str, kind: str, reason: str, field: str | None = None, ctype: str = "?", args: Any = None) -> None:
        self.stats["cmd_rejected_local"] += 1
        c.send({"t": "ack", "v": 1, "d": contract.ack(cid, now_ms(), False, kind, reason, field)})
        await asyncio.to_thread(self.repo.audit, "cmd.rejected", False, c.user["username"], None, f"{ctype}: {kind}: {reason}"[:300])

    async def _on_cmd(self, c: Client, msg: dict) -> None:
        self.stats["cmd_in"] += 1
        cid = msg.get("id") if isinstance(msg.get("id"), str) and 0 < len(msg["id"]) <= 64 else "invalid_" + uuid.uuid4().hex[:8]
        if not self.rate.allow(c.id):
            return await self._local_reject(c, cid, "interlock", f"Demasiados comandos (máximo {self.cfg.cmd_rate_per_s} por segundo).")
        unsupported = contract.cmd_types()[1]
        if msg.get("type") in unsupported:
            return await self._local_reject(c, cid, "unsupported", f"El banco real no admite «{msg.get('type')}».", None, msg.get("type"))
        errs = contract.errors("cmd", msg)
        if errs:
            return await self._local_reject(c, cid, "validation", "Comando no válido: " + errs[0][:200], None, str(msg.get("type")))
        ctype, args = msg["type"], msg.get("args") or {}
        user = c.user
        role = user["role"]
        if ctype == "safety.estop":                          # pedir un paro es siempre posible para cualquier cuenta autenticada
            sid = self.control_session if self.control is c else f"obs_{c.id}"
            return await self._send_req(c, cid, ctype, args, sid)
        if ctype == "session.start":
            if role not in OPERATE_ROLES:
                return await self._local_reject(c, cid, "interlock", "Tu cuenta es de solo observación." if role == "visitor" else "Las cuentas de administración no operan el banco.", None, ctype)
            if self.control is not None and self.control is not c:
                return await self._local_reject(c, cid, "interlock", "Otra sesión tiene el control del banco; tu vista es de solo lectura.", None, ctype)
            if self.control is c:
                return await self._local_reject(c, cid, "interlock", "Ya tienes una sesión activa.", None, ctype)
            booking = await asyncio.to_thread(self.repo.active_booking, user["id"], self.bank)
            if not booking:
                return await self._local_reject(c, cid, "interlock", "No tienes una reserva vigente para operar el banco.", None, ctype)
            sid = "ses_" + uuid.uuid4().hex[:12]
            self.control, self.control_session = c, sid
            c.hb_last = time.monotonic()
            self._booking_end = _aware(booking["end_at"])
            args = {**args, "role": role, "user": user["username"], "profileId": user.get("profile_id") or ""}
            c.send({"t": "event", "v": 1, "d": contract.event(now_ms(), "ok", "pasarela", "session.granted", "Tienes el control del banco", {"sessionId": sid})})
            return await self._send_req(c, cid, ctype, args, sid)
        if self.control is not c or self.control_session is None:
            return await self._local_reject(c, cid, "interlock", "Interlock: no hay sesión activa. Inicia sesión y reserva para operar.", None, ctype)
        sid = self.control_session
        await self._send_req(c, cid, ctype, args, sid)
        if ctype == "session.end":
            self._release_local()

    async def _send_req(self, c: Client, cid: str, ctype: str, args: dict, sid: str) -> None:
        self.pending[cid] = (c, time.monotonic() + self.cfg.ack_timeout_s, ctype)
        await self._publish_req(ctype, args, sid, c.user, c.user["role"], cid)

    async def _publish_req(self, ctype: str, args: dict, sid: str, user: dict, role: str, cid: str) -> None:
        req: dict[str, Any] = {"id": cid, "ts": now_ms(), "sessionId": sid, "user": user["username"], "role": role, "type": ctype}
        if args:
            req["args"] = args
        self.stats["cmd_published"] += 1
        await self.bus.publish_msg(self.bank, "cmd/req", req)


def _aware(d: dt.datetime) -> dt.datetime:
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
