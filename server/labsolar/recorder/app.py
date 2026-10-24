"""Registrador (S23): siempre encendido, guarda toda la telemetría, eventos, comandos con su acuse y barridos en la base de datos.

- Se graba SIEMPRE: cada tele es una fila de samples; run_id queda vacío fuera de corridas.
- Las corridas las marcan los acuses de acq.newRun / acq.start / acq.stop (el navegador no graba nada).
- Huecos: seq lleva la cuenta; un salto se registra como evento 'recorder.gap'.
- Nada se borra (acq.discard no existe en el servidor: POST /api/runs/{id}/discard marca descartada).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from typing import Any

from .. import contract
from ..bus import Bus
from ..repo import Repo
from ..samples import tele_to_row
from ..db import NUM_COLS, samples

log = logging.getLogger("labsolar.recorder")


class RecorderApp:
    def __init__(self, bus: Bus, repo: Repo, bank: str, flush_every_s: float = 1.0, flush_rows: int = 100) -> None:
        self.bus, self.repo, self.bank = bus, repo, bank
        self.flush_every_s, self.flush_rows = flush_every_s, flush_rows
        self.buf: list[dict] = []
        self.pending_req: dict[str, dict] = {}
        self.session: dict | None = None          # {id, user, user_id, role}
        self.run: dict | None = None              # {id, n, segment, recording}
        self.last_seq: int | None = None
        self.stats = {"samples": 0, "gaps": 0, "lost": 0, "events": 0, "commands": 0, "sweeps": 0, "flushes": 0}
        self._tasks: list[asyncio.Task] = []
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        b = self.bank
        self._sub = self.bus.subscribe(*(contract.topic(b, t) for t in ("tele", "event", "cmd/req", "cmd/ack", "sweep")))
        await asyncio.to_thread(self._resume)
        self._tasks = [asyncio.create_task(self._consume(), name="rec-consume"), asyncio.create_task(self._flusher(), name="rec-flush")]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        self._sub.close()
        await self.flush()

    def _resume(self) -> None:
        r = self.repo.active_run(self.bank, None)
        if r:
            n = self.repo.count(samples, samples.c.run_id == r["id"])
            self.run = {"id": r["id"], "n": n, "segment": "s1", "recording": r["status"] == "recording", "session_id": r["session_id"]}

    # ------------------------------------------------------------------ consumo
    async def _consume(self) -> None:
        async for topic, payload in self._sub:
            try:
                name = topic.split(f"{contract.PREFIX}/{self.bank}/", 1)[1]
                await getattr(self, "_on_" + name.replace("/", "_"))(payload)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("mensaje en %s", topic)

    async def _on_tele(self, tele: dict) -> None:
        seq = tele.get("seq")
        if seq is not None and self.last_seq is not None and seq > self.last_seq + 1:
            lost = seq - self.last_seq - 1
            self.stats["gaps"] += 1
            self.stats["lost"] += lost
            await self._on_event(contract.event(tele["ts"], "warn", "registrador", "recorder.gap", f"Se perdieron {lost} muestras (seq {self.last_seq}→{seq})", {"lost": lost}))
        if seq is not None:
            self.last_seq = seq
        row = tele_to_row(tele)
        run = self.run if self.run and self.run["recording"] else None
        db_row: dict[str, Any] = {"bank": self.bank, "ts": tele["ts"], "seq": seq, "run_id": run["id"] if run else None, "n": None, "segment_id": None,
                                  "tr_mode": row["trMode"], "load_mode": row["loadMode"], "safety": row["safety"], "quality": tele.get("quality", []), "tele": tele}
        if run:
            db_row["n"], db_row["segment_id"] = run["n"], run["segment"]
            run["n"] += 1
        for col, name in NUM_COLS.items():
            db_row[name] = row.get(col)
        self.buf.append(db_row)
        self.stats["samples"] += 1
        if len(self.buf) >= self.flush_rows:
            await self.flush()

    async def _on_event(self, e: dict) -> None:
        self.stats["events"] += 1
        await asyncio.to_thread(self.repo.insert_event, self.bank, e)

    async def _on_cmd_req(self, req: dict) -> None:
        self.pending_req[req["id"]] = req
        if len(self.pending_req) > 500:
            self.pending_req.pop(next(iter(self.pending_req)))
        await asyncio.to_thread(self.repo.upsert_command, self.bank, req)

    async def _on_cmd_ack(self, a: dict) -> None:
        self.stats["commands"] += 1
        await asyncio.to_thread(self.repo.ack_command, self.bank, a)
        req = self.pending_req.pop(a["id"], None)
        if not req or not a.get("ok"):
            return
        ctype, ts = req["type"], a["ts"]
        if ctype == "session.start":
            user = await asyncio.to_thread(self.repo.user_by_name, req["user"])
            self.session = {"id": req["sessionId"], "user": req["user"], "user_id": user["id"] if user else None, "role": req["role"]}
            await asyncio.to_thread(self.repo.open_session, req["sessionId"], self.bank, user, req["user"], req["role"], ts)
        elif ctype == "session.end":
            await self._close_run(ts)
            await asyncio.to_thread(self.repo.close_session, req["sessionId"], ts, (req.get("args") or {}).get("why", "terminada por el usuario"))
            self.session = None
        elif ctype == "acq.newRun":
            await self._new_run(req, ts, recording=False)
        elif ctype == "acq.start":
            if not self.run or self.run.get("session_id") != req.get("sessionId"):
                await self._new_run(req, ts, recording=True)
            else:
                self.run["recording"] = True
                self.run["segment"] = f"s{int(self.run['segment'][1:]) + 1}"
                await asyncio.to_thread(self.repo.set_run_status, self.run["id"], "recording")
        elif ctype == "acq.stop" and self.run:
            self.run["recording"] = False
            await self.flush()
            await asyncio.to_thread(self.repo.set_run_status, self.run["id"], "stopped")

    async def _new_run(self, req: dict, ts: int, recording: bool) -> None:
        await self._close_run(ts)
        rid = "run_" + uuid.uuid4().hex[:12]
        s = self.session or {}
        a = req.get("args") or {}
        await asyncio.to_thread(self.repo.create_run, rid, self.bank, req.get("sessionId"), req.get("user"), s.get("user_id"), a.get("practiceId"), a.get("label", ""), ts,
                                "recording" if recording else "open")
        self.run = {"id": rid, "n": 0, "segment": "s1", "recording": recording, "session_id": req.get("sessionId")}

    async def _close_run(self, ts: int) -> None:
        if self.run:
            await self.flush()
            await asyncio.to_thread(self.repo.set_run_status, self.run["id"], "closed", ts)
            self.run = None

    async def _on_sweep(self, sw: dict) -> None:
        self.stats["sweeps"] += 1
        run_id = self.run["id"] if self.run and self.run["recording"] else None
        await asyncio.to_thread(self.repo.save_sweep, self.bank, sw, run_id)

    # ------------------------------------------------------------------ escritura por lotes
    async def _flusher(self) -> None:
        while True:
            await asyncio.sleep(self.flush_every_s)
            await self.flush()

    async def flush(self) -> None:
        async with self._lock:
            rows, self.buf = self.buf, []
            if rows:
                try:
                    await asyncio.to_thread(self.repo.insert_samples, rows)
                    self.stats["flushes"] += 1
                except Exception:
                    log.exception("no se pudo escribir %d muestras; se reintenta", len(rows))
                    self.buf = rows + self.buf
