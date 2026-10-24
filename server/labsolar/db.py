"""Esquema y acceso a la base de datos (PostgreSQL 16 en producción; SQLite en pruebas y desarrollo).

Tablas: users, bookings, auth_sessions, sessions, runs, samples, events, commands, sweeps, audit.
Regla del plan: nada se borra. acq.discard marca discarded = true; las cuentas se desactivan, no se eliminan.
"""
from __future__ import annotations

import datetime as dt
import json
import secrets
from typing import Any

import sqlalchemy as sa
from sqlalchemy import JSON, Boolean, Column, DateTime, Float, ForeignKey, Index, Integer, MetaData, String, Table, Text, BigInteger
from sqlalchemy.dialects.postgresql import JSONB

JSONType = JSON().with_variant(JSONB(), "postgresql")
metadata = MetaData()

# columnas de una muestra en el mismo orden y con los mismos nombres que LAB.core.RUN_COLS del simulador
RUN_COLS = ["n", "segmentId", "simMs", "realMs", "gA", "gB", "tcA", "tcB", "ta", "rh", "wind", "windDir", "vA", "iA", "pA", "eA", "vB", "iB", "pB", "eB",
            "azB", "tiltB", "trMode", "loadMode", "safety", "cloud", "shA", "shB"]

# columna del simulador (RUN_COLS) -> columna SQL en snake_case, solo las numéricas
NUM_COLS = {"gA": "g_a", "gB": "g_b", "tcA": "tc_a", "tcB": "tc_b", "ta": "ta", "rh": "rh", "wind": "wind", "windDir": "wind_dir",
            "vA": "v_a", "iA": "i_a", "pA": "p_a", "eA": "e_a", "vB": "v_b", "iB": "i_b", "pB": "p_b", "eB": "e_b",
            "azB": "az_b", "tiltB": "tilt_b", "cloud": "cloud", "shA": "sh_a", "shB": "sh_b"}

users = Table("users", metadata,
              Column("id", Integer, primary_key=True, autoincrement=True),
              Column("username", String(64), nullable=False, unique=True),
              Column("display_name", String(120), nullable=False, default=""),
              Column("password_hash", String(255), nullable=False),
              Column("role", String(16), nullable=False),            # visitor | student | teacher | admin
              Column("active", Boolean, nullable=False, default=True),
              Column("failed_logins", Integer, nullable=False, default=0),
              Column("locked_until", DateTime(timezone=True)),
              Column("created_at", DateTime(timezone=True), nullable=False),
              Column("profile_id", String(64)))

bookings = Table("bookings", metadata,
                 Column("id", Integer, primary_key=True, autoincrement=True),
                 Column("user_id", Integer, ForeignKey("users.id"), nullable=False),
                 Column("bank", String(32), nullable=False),
                 Column("start_at", DateTime(timezone=True), nullable=False),
                 Column("end_at", DateTime(timezone=True), nullable=False),
                 Column("created_by", Integer, ForeignKey("users.id")),
                 Column("cancelled", Boolean, nullable=False, default=False),
                 Column("created_at", DateTime(timezone=True), nullable=False),
                 Index("ix_bookings_bank_time", "bank", "start_at", "end_at"))

auth_sessions = Table("auth_sessions", metadata,
                      Column("token_hash", String(64), primary_key=True),
                      Column("user_id", Integer, ForeignKey("users.id"), nullable=False),
                      Column("created_at", DateTime(timezone=True), nullable=False),
                      Column("expires_at", DateTime(timezone=True), nullable=False),
                      Column("revoked", Boolean, nullable=False, default=False),
                      Column("ip", String(64)))

sessions = Table("sessions", metadata,                  # sesiones de operación (control del banco)
                 Column("id", String(64), primary_key=True),
                 Column("bank", String(32), nullable=False),
                 Column("user_id", Integer, ForeignKey("users.id")),
                 Column("username", String(64)),
                 Column("role", String(16)),
                 Column("started_ms", BigInteger, nullable=False),
                 Column("ended_ms", BigInteger),
                 Column("why", String(120)))

runs = Table("runs", metadata,
             Column("id", String(64), primary_key=True),
             Column("bank", String(32), nullable=False),
             Column("session_id", String(64)),
             Column("user_id", Integer, ForeignKey("users.id")),
             Column("username", String(64)),
             Column("practice_id", String(32)),
             Column("label", String(120), default=""),
             Column("status", String(16), nullable=False),    # open | recording | stopped | closed
             Column("discarded", Boolean, nullable=False, default=False),
             Column("created_ms", BigInteger, nullable=False),
             Column("closed_ms", BigInteger),
             Column("meta", JSONType))

samples = Table("samples", metadata,
                Column("bank", String(32), nullable=False),
                Column("ts", BigInteger, nullable=False),
                Column("seq", BigInteger),
                Column("run_id", String(64), ForeignKey("runs.id")),   # vacío fuera de corridas
                Column("n", Integer),
                Column("segment_id", String(16)),
                *[Column(c, Float) for c in NUM_COLS.values()],
                Column("tr_mode", String(16)),
                Column("load_mode", String(8)),
                Column("safety", String(16)),
                Column("quality", JSONType),
                Column("tele", JSONType),
                Index("ix_samples_bank_ts", "bank", "ts"),
                Index("ix_samples_run", "run_id", "ts"))

events = Table("events", metadata,
               Column("id", Integer, primary_key=True, autoincrement=True),
               Column("bank", String(32), nullable=False),
               Column("ts", BigInteger, nullable=False),
               Column("level", String(8)), Column("src", String(32)), Column("code", String(64)), Column("msg", Text),
               Column("data", JSONType),
               Index("ix_events_bank_ts", "bank", "ts"))

commands = Table("commands", metadata,
                 Column("id", String(64), primary_key=True),
                 Column("bank", String(32), nullable=False),
                 Column("ts", BigInteger, nullable=False),
                 Column("session_id", String(64)), Column("username", String(64)), Column("role", String(16)),
                 Column("type", String(32), nullable=False),
                 Column("args", JSONType),
                 Column("ack_ts", BigInteger), Column("ok", Boolean), Column("kind", String(16)), Column("reason", Text),
                 Index("ix_commands_session", "session_id", "ts"))

sweeps = Table("sweeps", metadata,
               Column("id", String(64), primary_key=True),
               Column("bank", String(32), nullable=False),
               Column("run_id", String(64)),
               Column("session_id", String(64)),
               Column("ts", BigInteger, nullable=False),
               Column("status", String(16)),
               Column("discarded", Boolean, nullable=False, default=False),
               Column("data", JSONType))

audit = Table("audit", metadata,                       # bitácora de seguridad: login, logout, denegaciones, cambios de cuentas
              Column("id", Integer, primary_key=True, autoincrement=True),
              Column("ts", DateTime(timezone=True), nullable=False),
              Column("username", String(64)), Column("ip", String(64)),
              Column("action", String(48), nullable=False), Column("ok", Boolean, nullable=False),
              Column("detail", Text))


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def make_engine(url: str) -> sa.Engine:
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    kw: dict[str, Any] = {}
    if url.startswith("sqlite"):
        kw["connect_args"] = {"check_same_thread": False}
        if url in ("sqlite://", "sqlite:///:memory:"):
            kw["poolclass"] = sa.pool.StaticPool
    else:
        kw["pool_pre_ping"] = True
        kw["pool_size"] = 5
    eng = sa.create_engine(url, json_serializer=lambda o: json.dumps(o, allow_nan=False, separators=(",", ":")), **kw)
    if url.startswith("sqlite"):
        @sa.event.listens_for(eng, "connect")
        def _fk(dbapi, _rec):                              # noqa: ANN001
            dbapi.execute("PRAGMA foreign_keys=ON")
    return eng


def init_db(engine: sa.Engine) -> None:
    metadata.create_all(engine)


def new_token() -> str:
    return secrets.token_urlsafe(32)
