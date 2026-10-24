"""Operaciones de base de datos (síncronas; el gateway las llama desde hilos). Nada se borra."""
from __future__ import annotations

import datetime as dt
import hashlib
import uuid
from typing import Any, Iterable

import sqlalchemy as sa

from . import db
from .db import RUN_COLS, NUM_COLS


def aware(d: dt.datetime | None) -> dt.datetime | None:
    if d is None:
        return None
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def _row(r) -> dict | None:
    return dict(r._mapping) if r is not None else None


class Repo:
    def __init__(self, engine: sa.Engine) -> None:
        self.engine = engine

    # ------------------------------------------------------------------ usuarios
    def create_user(self, username: str, password_hash: str, role: str, display_name: str = "") -> dict:
        with self.engine.begin() as c:
            res = c.execute(sa.insert(db.users).values(username=username, display_name=display_name or username, password_hash=password_hash,
                                                       role=role, active=True, failed_logins=0, created_at=db.utcnow(), profile_id=uuid.uuid4().hex[:16]))
            return _row(c.execute(sa.select(db.users).where(db.users.c.id == res.inserted_primary_key[0])).first())

    def user_by_name(self, username: str) -> dict | None:
        with self.engine.connect() as c:
            return _row(c.execute(sa.select(db.users).where(db.users.c.username == username)).first())

    def user_by_id(self, uid: int) -> dict | None:
        with self.engine.connect() as c:
            return _row(c.execute(sa.select(db.users).where(db.users.c.id == uid)).first())

    def list_users(self) -> list[dict]:
        with self.engine.connect() as c:
            return [dict(r._mapping) for r in c.execute(sa.select(db.users).order_by(db.users.c.id))]

    def update_user(self, uid: int, **vals: Any) -> None:
        with self.engine.begin() as c:
            c.execute(sa.update(db.users).where(db.users.c.id == uid).values(**vals))
            if vals.get("active") is False:                       # desactivar cierra todas sus sesiones
                c.execute(sa.update(db.auth_sessions).where(db.auth_sessions.c.user_id == uid).values(revoked=True))

    def login_failed(self, uid: int, max_fails: int, lock_s: int) -> None:
        with self.engine.begin() as c:
            n = (c.execute(sa.select(db.users.c.failed_logins).where(db.users.c.id == uid)).scalar() or 0) + 1
            vals: dict[str, Any] = {"failed_logins": n}
            if n >= max_fails:
                vals["locked_until"] = db.utcnow() + dt.timedelta(seconds=lock_s)
                vals["failed_logins"] = 0
            c.execute(sa.update(db.users).where(db.users.c.id == uid).values(**vals))

    def login_ok(self, uid: int) -> None:
        with self.engine.begin() as c:
            c.execute(sa.update(db.users).where(db.users.c.id == uid).values(failed_logins=0, locked_until=None))

    # ------------------------------------------------------------------ sesiones de autenticación (cookie)
    @staticmethod
    def _h(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def create_auth_session(self, uid: int, ttl_s: int, ip: str | None) -> str:
        tok = db.new_token()
        now = db.utcnow()
        with self.engine.begin() as c:
            c.execute(sa.insert(db.auth_sessions).values(token_hash=self._h(tok), user_id=uid, created_at=now, expires_at=now + dt.timedelta(seconds=ttl_s), revoked=False, ip=ip))
        return tok

    def user_for_token(self, token: str | None) -> dict | None:
        if not token:
            return None
        with self.engine.connect() as c:
            r = c.execute(sa.select(db.auth_sessions, db.users).join(db.users, db.users.c.id == db.auth_sessions.c.user_id)
                          .where(db.auth_sessions.c.token_hash == self._h(token))).first()
        if r is None:
            return None
        m = r._mapping
        if m["revoked"] or not m["active"] or aware(m["expires_at"]) < db.utcnow():
            return None
        return {k: m[k] for k in ("id", "username", "display_name", "role", "profile_id")} | {"active": m["active"]}

    def revoke_token(self, token: str) -> None:
        with self.engine.begin() as c:
            c.execute(sa.update(db.auth_sessions).where(db.auth_sessions.c.token_hash == self._h(token)).values(revoked=True))

    # ------------------------------------------------------------------ reservas
    def create_booking(self, uid: int, bank: str, start: dt.datetime, end: dt.datetime, created_by: int | None) -> dict | None:
        """None si se traslapa con otra reserva vigente del mismo banco."""
        with self.engine.begin() as c:
            clash = c.execute(sa.select(db.bookings.c.id).where(sa.and_(db.bookings.c.bank == bank, db.bookings.c.cancelled == False,    # noqa: E712
                                                                        db.bookings.c.start_at < end, db.bookings.c.end_at > start))).first()
            if clash:
                return None
            try:
                res = c.execute(sa.insert(db.bookings).values(user_id=uid, bank=bank, start_at=start, end_at=end, created_by=created_by, cancelled=False, created_at=db.utcnow()))
            except sa.exc.IntegrityError:              # la restricción de exclusión de PostgreSQL atrapó una carrera entre dos peticiones
                return None
            return _row(c.execute(sa.select(db.bookings).where(db.bookings.c.id == res.inserted_primary_key[0])).first())

    def list_bookings(self, uid: int | None, since: dt.datetime | None = None, until: dt.datetime | None = None) -> list[dict]:
        q = sa.select(db.bookings, db.users.c.username).join(db.users, db.users.c.id == db.bookings.c.user_id).where(db.bookings.c.cancelled == False)   # noqa: E712
        if uid is not None:
            q = q.where(db.bookings.c.user_id == uid)
        if since:
            q = q.where(db.bookings.c.end_at > since)
        if until:
            q = q.where(db.bookings.c.start_at < until)
        with self.engine.connect() as c:
            return [dict(r._mapping) for r in c.execute(q.order_by(db.bookings.c.start_at))]

    def cancel_booking(self, bid: int, uid: int | None) -> bool:
        with self.engine.begin() as c:
            q = sa.update(db.bookings).where(db.bookings.c.id == bid).values(cancelled=True)
            if uid is not None:
                q = q.where(db.bookings.c.user_id == uid)
            return c.execute(q).rowcount > 0

    def active_booking(self, uid: int, bank: str, now: dt.datetime | None = None) -> dict | None:
        now = now or db.utcnow()
        with self.engine.connect() as c:
            return _row(c.execute(sa.select(db.bookings).where(sa.and_(db.bookings.c.user_id == uid, db.bookings.c.bank == bank, db.bookings.c.cancelled == False,    # noqa: E712
                                                                       db.bookings.c.start_at <= now, db.bookings.c.end_at > now))).first())

    # ------------------------------------------------------------------ auditoría
    def audit(self, action: str, ok: bool, username: str | None = None, ip: str | None = None, detail: str = "") -> None:
        with self.engine.begin() as c:
            c.execute(sa.insert(db.audit).values(ts=db.utcnow(), username=username, ip=ip, action=action, ok=ok, detail=detail[:1000]))

    def audit_list(self, limit: int = 200) -> list[dict]:
        with self.engine.connect() as c:
            return [dict(r._mapping) for r in c.execute(sa.select(db.audit).order_by(db.audit.c.id.desc()).limit(limit))]

    # ------------------------------------------------------------------ registrador
    def insert_samples(self, rows: list[dict]) -> None:
        if not rows:
            return
        with self.engine.begin() as c:
            c.execute(sa.insert(db.samples), rows)

    def insert_event(self, bank: str, e: dict) -> None:
        with self.engine.begin() as c:
            c.execute(sa.insert(db.events).values(bank=bank, ts=e["ts"], level=e.get("level"), src=e.get("src"), code=e.get("code"), msg=e.get("msg"), data=e.get("data")))

    def upsert_command(self, bank: str, req: dict) -> None:
        with self.engine.begin() as c:
            if c.execute(sa.select(db.commands.c.id).where(db.commands.c.id == req["id"])).first():
                return
            c.execute(sa.insert(db.commands).values(id=req["id"], bank=bank, ts=req["ts"], session_id=req.get("sessionId"), username=req.get("user"), role=req.get("role"),
                                                    type=req["type"], args=req.get("args")))

    def ack_command(self, bank: str, a: dict) -> None:
        with self.engine.begin() as c:
            res = c.execute(sa.update(db.commands).where(db.commands.c.id == a["id"]).values(ack_ts=a["ts"], ok=a["ok"], kind=a.get("kind"), reason=a.get("reason")))
            if res.rowcount == 0:                                 # acuse sin solicitud registrada (p. ej. rechazado en la pasarela)
                c.execute(sa.insert(db.commands).values(id=a["id"], bank=bank, ts=a["ts"], type="?", ack_ts=a["ts"], ok=a["ok"], kind=a.get("kind"), reason=a.get("reason")))

    def save_sweep(self, bank: str, sw: dict, run_id: str | None) -> None:
        with self.engine.begin() as c:
            c.execute(sa.delete(db.sweeps).where(db.sweeps.c.id == sw["id"]))       # reintento idempotente del mismo barrido
            c.execute(sa.insert(db.sweeps).values(id=sw["id"], bank=bank, run_id=run_id, session_id=sw.get("sessionId"), ts=sw.get("endSimMs") or sw.get("startSimMs") or 0,
                                                  status=sw["status"], discarded=False, data={**sw, "runId": run_id}))

    def open_session(self, sid: str, bank: str, user: dict | None, username: str, role: str, ts: int) -> None:
        with self.engine.begin() as c:
            if c.execute(sa.select(db.sessions.c.id).where(db.sessions.c.id == sid)).first():
                return
            c.execute(sa.insert(db.sessions).values(id=sid, bank=bank, user_id=(user or {}).get("id"), username=username, role=role, started_ms=ts))

    def close_session(self, sid: str, ts: int, why: str) -> None:
        with self.engine.begin() as c:
            c.execute(sa.update(db.sessions).where(db.sessions.c.id == sid).values(ended_ms=ts, why=why[:120]))

    def create_run(self, rid: str, bank: str, session_id: str | None, username: str | None, user_id: int | None, practice_id: str | None, label: str, ts: int, status: str = "open") -> None:
        with self.engine.begin() as c:
            c.execute(sa.insert(db.runs).values(id=rid, bank=bank, session_id=session_id, user_id=user_id, username=username, practice_id=practice_id,
                                                label=label or "", status=status, discarded=False, created_ms=ts, meta={}))

    def set_run_status(self, rid: str, status: str, ts: int | None = None) -> None:
        with self.engine.begin() as c:
            vals: dict[str, Any] = {"status": status}
            if status in ("closed",) and ts:
                vals["closed_ms"] = ts
            c.execute(sa.update(db.runs).where(db.runs.c.id == rid).values(**vals))

    def active_run(self, bank: str, session_id: str | None) -> dict | None:
        with self.engine.connect() as c:
            q = sa.select(db.runs).where(sa.and_(db.runs.c.bank == bank, db.runs.c.status.in_(["open", "recording"]), db.runs.c.discarded == False))    # noqa: E712
            if session_id:
                q = q.where(db.runs.c.session_id == session_id)
            return _row(c.execute(q.order_by(db.runs.c.created_ms.desc())).first())

    # ------------------------------------------------------------------ lectura (API)
    def list_runs(self, user: dict, limit: int = 100, include_discarded: bool = False) -> list[dict]:
        q = sa.select(db.runs, sa.select(sa.func.count()).select_from(db.samples).where(db.samples.c.run_id == db.runs.c.id).scalar_subquery().label("samples"))
        if user["role"] not in ("teacher", "admin"):
            q = q.where(db.runs.c.user_id == user["id"])
        if not include_discarded:
            q = q.where(db.runs.c.discarded == False)   # noqa: E712
        with self.engine.connect() as c:
            return [dict(r._mapping) for r in c.execute(q.order_by(db.runs.c.created_ms.desc()).limit(limit))]

    def get_run(self, rid: str) -> dict | None:
        with self.engine.connect() as c:
            return _row(c.execute(sa.select(db.runs).where(db.runs.c.id == rid)).first())

    def run_rows(self, rid: str) -> Iterable[dict]:
        """Muestras de una corrida con las claves de RUN_COLS, en orden de tiempo."""
        rev = {v: k for k, v in NUM_COLS.items()}
        with self.engine.connect() as c:
            for r in c.execute(sa.select(db.samples).where(db.samples.c.run_id == rid).order_by(db.samples.c.ts, db.samples.c.seq)).yield_per(2000):
                m = r._mapping
                out = {"n": m["n"], "segmentId": m["segment_id"], "simMs": m["ts"], "realMs": m["ts"], "trMode": m["tr_mode"], "loadMode": m["load_mode"], "safety": m["safety"]}
                for col, name in NUM_COLS.items():
                    out[col] = m[name]
                yield out

    def run_events(self, rid: str, bank: str) -> list[dict]:
        run = self.get_run(rid)
        if not run:
            return []
        with self.engine.connect() as c:
            return [dict(r._mapping) for r in c.execute(sa.select(db.events).where(sa.and_(db.events.c.bank == bank, db.events.c.ts >= run["created_ms"],
                                                                                         db.events.c.ts <= (run["closed_ms"] or 2**62))).order_by(db.events.c.ts))]

    def list_sweeps(self, user: dict, limit: int = 100) -> list[dict]:
        q = sa.select(db.sweeps).where(db.sweeps.c.discarded == False)    # noqa: E712
        with self.engine.connect() as c:
            rows = [dict(r._mapping) for r in c.execute(q.order_by(db.sweeps.c.ts.desc()).limit(limit * 3))]
        if user["role"] not in ("teacher", "admin"):
            sids = self.user_session_ids(user["id"])
            rows = [r for r in rows if r["session_id"] in sids]
        return rows[:limit]

    def user_session_ids(self, uid: int) -> set[str]:
        with self.engine.connect() as c:
            return {r[0] for r in c.execute(sa.select(db.sessions.c.id).where(db.sessions.c.user_id == uid))}

    def get_sweep(self, sid: str) -> dict | None:
        with self.engine.connect() as c:
            return _row(c.execute(sa.select(db.sweeps).where(db.sweeps.c.id == sid)).first())

    def discard_run(self, rid: str, discarded: bool = True) -> None:
        with self.engine.begin() as c:
            c.execute(sa.update(db.runs).where(db.runs.c.id == rid).values(discarded=discarded))

    def count(self, table: sa.Table, *where) -> int:
        with self.engine.connect() as c:
            return c.execute(sa.select(sa.func.count()).select_from(table).where(*where) if where else sa.select(sa.func.count()).select_from(table)).scalar() or 0
