"""Pasarela FastAPI (S22): cuentas, reservas, autorización, WebSocket, descargas.

Rutas: POST /api/login · POST /api/logout · GET /api/me · GET|POST /api/bookings · DELETE /api/bookings/{id} · POST /api/ws-ticket
       GET /api/runs · GET /api/runs/{id}.csv · POST /api/runs/{id}/discard · GET /api/sweeps · GET /api/sweeps/{id}.csv
       GET /api/auth/check (auth_request de Nginx para las cámaras) · GET /api/health · WS /ws?ticket=
       Administración: GET|POST /api/admin/users · PATCH /api/admin/users/{id} · POST /api/admin/bookings · GET /api/admin/audit

Seguridad: contraseñas con argon2id; sesión en cookie HttpOnly + SameSite=Strict (+ Secure); límite de intentos de acceso; bloqueo temporal de la
cuenta; comprobación de Origin en peticiones que cambian estado y en el WebSocket; ticket de un solo uso (30 s) para el WebSocket.
"""
from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import json
import logging
import re
from typing import Annotated, Any

from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

from .. import contract, db, runs_csv
from ..bus import Bus, bus_from_config
from ..repo import Repo, aware
from .hub import Hub, OPERATE_ROLES
from .security import SlidingWindow, hash_password, verify_password
from .settings import Settings

log = logging.getLogger("labsolar.gateway")
ROLES = ("visitor", "student", "teacher", "admin")
USERNAME_RE = re.compile(r"^[A-Za-z0-9._@-]{3,64}$")


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class BookingIn(BaseModel):
    start: dt.datetime
    end: dt.datetime
    user_id: int | None = None


class UserIn(BaseModel):
    username: str
    password: str
    role: str
    display_name: str = ""


class UserPatch(BaseModel):
    active: bool | None = None
    role: str | None = None
    password: str | None = None


def public_user(u: dict) -> dict:
    return {"id": u["id"], "username": u["username"], "display_name": u.get("display_name") or u["username"], "role": u["role"], "profile_id": u.get("profile_id")}


def create_app(settings: Settings | None = None, bus: Bus | None = None, repo: Repo | None = None) -> FastAPI:
    cfg = settings or Settings.from_env()
    engine = None
    if repo is None:
        engine = db.make_engine(cfg.db_url)
        if cfg.db_url.startswith("sqlite"):
            db.init_db(engine)                      # desarrollo; con PostgreSQL el esquema lo crea «labsolar-gateway migrate» (Alembic)
        repo = Repo(engine)
    the_bus = bus or bus_from_config(cfg.mqtt, client_id="gateway")
    hub = Hub(the_bus, repo, cfg)
    login_rate = SlidingWindow(cfg.login_rate_per_min, 60.0)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        await the_bus.start()
        if cfg.admin_user and cfg.admin_password and not repo.user_by_name(cfg.admin_user):
            repo.create_user(cfg.admin_user, hash_password(cfg.admin_password), "admin", "Administración")
            log.info("Cuenta de administración inicial creada: %s", cfg.admin_user)
        await hub.start()
        yield
        await hub.stop()
        await the_bus.close()

    app = FastAPI(title="Laboratorio Solar Remoto UNACH", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.hub, app.state.repo, app.state.cfg = hub, repo, cfg

    # ------------------------------------------------------------------ middleware
    def origin_ok(request_origin: str | None, host: str | None) -> bool:
        if not request_origin:
            return True                       # peticiones sin Origin (curl, servidor a servidor) no llevan cookie de un navegador cruzado
        if cfg.allowed_origins:
            return request_origin in cfg.allowed_origins
        m = re.match(r"^https?://([^/]+)$", request_origin)
        return bool(m and host and m.group(1).lower() == host.lower())

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and not origin_ok(request.headers.get("origin"), request.headers.get("host")):
            return JSONResponse({"detail": "Origen no permitido"}, status_code=403)
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Cache-Control", "no-store")
        resp.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        if cfg.cookie_secure:
            resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        if cfg.csp:
            resp.headers.setdefault("Content-Security-Policy", cfg.csp)
        return resp

    # ------------------------------------------------------------------ autenticación
    def current_user(request: Request) -> dict:
        u = repo.user_for_token(request.cookies.get(cfg.cookie_name))
        if not u:
            raise HTTPException(401, "No has iniciado sesión")
        return u

    def require(*roles: str):
        def dep(u: dict = Depends(current_user)) -> dict:
            if u["role"] not in roles:
                raise HTTPException(403, "Tu rol no permite esta operación")
            return u
        return dep

    def client_ip(request: Request) -> str:
        return request.headers.get("x-real-ip") or (request.client.host if request.client else "?")

    @app.post("/api/login")
    def login(body: LoginIn, request: Request, response: Response):
        ip = client_ip(request)
        if not login_rate.allow(ip):
            repo.audit("login.throttled", False, body.username, ip)
            raise HTTPException(429, "Demasiados intentos: espera un minuto")
        u = repo.user_by_name(body.username)
        locked = u and u.get("locked_until") and aware(u["locked_until"]) > db.utcnow()
        good = verify_password(u["password_hash"] if u else None, body.password)
        if not u or locked or not u["active"] or not good:
            if u and not locked and u["active"] and not good:
                repo.login_failed(u["id"], cfg.max_failed_logins, cfg.lock_seconds)
            repo.audit("login", False, body.username, ip, "bloqueada" if locked else "credenciales")
            raise HTTPException(401, "Usuario o contraseña incorrectos")           # mismo mensaje en todos los casos
        repo.login_ok(u["id"])
        tok = repo.create_auth_session(u["id"], cfg.session_ttl_s, ip)
        response.set_cookie(cfg.cookie_name, tok, max_age=cfg.session_ttl_s, httponly=True, samesite="strict", secure=cfg.cookie_secure, path="/")
        repo.audit("login", True, u["username"], ip)
        return {"user": public_user(u)}

    @app.post("/api/logout")
    def logout(request: Request, response: Response):
        tok = request.cookies.get(cfg.cookie_name)
        if tok:
            repo.revoke_token(tok)
        response.delete_cookie(cfg.cookie_name, path="/")
        return {"ok": True}

    @app.get("/api/me")
    def me(u: dict = Depends(current_user)):
        return {"user": public_user(u), "bank": cfg.bank}

    @app.get("/api/health")
    def health():
        return {"ok": True, "clients": len(hub.clients), "control": hub.control_session}

    @app.get("/api/auth/check")
    def auth_check(u: dict = Depends(current_user)):
        """auth_request de Nginx: las cámaras solo se sirven con sesión válida."""
        return PlainTextResponse("ok", headers={"X-Auth-User": u["username"]})

    # ------------------------------------------------------------------ reservas
    def check_window(start: dt.datetime, end: dt.datetime) -> tuple[dt.datetime, dt.datetime]:
        s = aware(start).astimezone(dt.timezone.utc)
        e = aware(end).astimezone(dt.timezone.utc)
        now = db.utcnow()
        if e <= s:
            raise HTTPException(422, "El fin debe ser posterior al inicio")
        if (e - s) > dt.timedelta(minutes=cfg.booking_max_minutes):
            raise HTTPException(422, f"Una reserva dura como máximo {cfg.booking_max_minutes} minutos")
        if e <= now:
            raise HTTPException(422, "La reserva ya terminó")
        if s > now + dt.timedelta(days=cfg.booking_horizon_days):
            raise HTTPException(422, f"Solo se reserva con {cfg.booking_horizon_days} días de anticipación")
        return s, e

    @app.get("/api/bookings")
    def list_bookings(all: bool = False, u: dict = Depends(current_user)):
        everyone = all and u["role"] in ("teacher", "admin")
        rows = repo.list_bookings(None if everyone else u["id"], since=db.utcnow() - dt.timedelta(hours=1))
        return {"bookings": [{"id": r["id"], "user": r["username"], "start": aware(r["start_at"]).isoformat(), "end": aware(r["end_at"]).isoformat()} for r in rows]}

    @app.post("/api/bookings", status_code=201)
    def create_booking(body: BookingIn, u: dict = Depends(require("student", "teacher", "admin"))):
        target = u["id"]
        if body.user_id is not None and body.user_id != u["id"]:
            if u["role"] != "admin":
                raise HTTPException(403, "Solo la administración reserva a nombre de otra persona")
            target = body.user_id
        s, e = check_window(body.start, body.end)
        b = repo.create_booking(target, cfg.bank, s, e, u["id"])
        if not b:
            raise HTTPException(409, "Ese horario ya está reservado")
        repo.audit("booking.create", True, u["username"], None, f"{s.isoformat()} - {e.isoformat()} para user {target}")
        return {"id": b["id"], "start": s.isoformat(), "end": e.isoformat()}

    @app.delete("/api/bookings/{bid}")
    def cancel_booking(bid: int, u: dict = Depends(current_user)):
        if not repo.cancel_booking(bid, None if u["role"] == "admin" else u["id"]):
            raise HTTPException(404, "No existe esa reserva (o no es tuya)")
        repo.audit("booking.cancel", True, u["username"], None, str(bid))
        return {"ok": True}

    # ------------------------------------------------------------------ WebSocket
    @app.post("/api/ws-ticket")
    def ws_ticket(u: dict = Depends(current_user)):
        return {"ticket": hub.issue_ticket(u), "ttl": cfg.ticket_ttl_s}

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket, ticket: str | None = None):
        await ws.accept()
        if not origin_ok(ws.headers.get("origin"), ws.headers.get("host")):
            await ws.close(code=4403)
            return
        user = hub.redeem_ticket(ticket)
        if not user:
            await ws.close(code=4401)
            return
        fresh = repo.user_by_id(user["id"])
        if not fresh or not fresh["active"]:
            await ws.close(code=4401)
            return
        client = await hub.connect(ws, {**user, "role": fresh["role"]})
        try:
            while True:
                text = await ws.receive_text()
                if len(text) > 8192:
                    await ws.close(code=1009)
                    break
                await hub.on_message(client, text)
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("ws")
        finally:
            await hub.disconnect(client)

    # ------------------------------------------------------------------ datos
    def can_see_run(u: dict, run: dict | None) -> bool:
        return bool(run) and (u["role"] in ("teacher", "admin") or run["user_id"] == u["id"])

    @app.get("/api/runs")
    def list_runs(include_discarded: bool = False, u: dict = Depends(current_user)):
        rows = repo.list_runs(u, include_discarded=include_discarded)
        return {"runs": [{"id": r["id"], "label": r["label"], "practiceId": r["practice_id"], "user": r["username"], "status": r["status"], "discarded": r["discarded"],
                          "createdMs": r["created_ms"], "closedMs": r["closed_ms"], "samples": r["samples"]} for r in rows]}

    @app.get("/api/runs/{rid}.csv")
    def run_csv(rid: str, u: dict = Depends(current_user)):
        run = repo.get_run(rid)
        if not can_see_run(u, run):
            raise HTTPException(404, "No existe esa corrida")
        evs: dict[int, list[str]] = {}
        text = runs_csv.run_to_csv(run, repo.run_rows(rid), evs)
        return Response(text, media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="lab-solar-unach_{rid}.csv"'})

    @app.post("/api/runs/{rid}/discard")
    def discard_run(rid: str, u: dict = Depends(current_user)):
        run = repo.get_run(rid)
        if not can_see_run(u, run):
            raise HTTPException(404, "No existe esa corrida")
        repo.discard_run(rid)                                  # se marca; nada se borra
        repo.audit("run.discard", True, u["username"], None, rid)
        return {"ok": True}

    @app.get("/api/sweeps")
    def list_sweeps(u: dict = Depends(current_user)):
        return {"sweeps": [{"id": r["id"], "runId": r["run_id"], "ts": r["ts"], "status": r["status"]} for r in repo.list_sweeps(u)]}

    @app.get("/api/sweeps/{sid}.csv")
    def sweep_csv(sid: str, u: dict = Depends(current_user)):
        sw = repo.get_sweep(sid)
        if not sw or (u["role"] not in ("teacher", "admin") and sw["session_id"] not in repo.user_session_ids(u["id"])):
            raise HTTPException(404, "No existe ese barrido")
        return Response(runs_csv.sweep_to_csv(sw["data"]), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="lab-solar-unach_{sid}.csv"'})

    # ------------------------------------------------------------------ administración
    @app.get("/api/admin/users")
    def admin_users(u: dict = Depends(require("admin"))):
        return {"users": [public_user(x) | {"active": x["active"]} for x in repo.list_users()]}

    def check_password(pw: str) -> None:
        if len(pw) < cfg.password_min_len:
            raise HTTPException(422, f"La contraseña debe tener al menos {cfg.password_min_len} caracteres")

    @app.post("/api/admin/users", status_code=201)
    def admin_create_user(body: UserIn, u: dict = Depends(require("admin"))):
        if body.role not in ROLES:
            raise HTTPException(422, "Rol desconocido")
        if not USERNAME_RE.match(body.username):
            raise HTTPException(422, "Usuario no válido (3 a 64 caracteres: letras, números . _ @ -)")
        check_password(body.password)
        if repo.user_by_name(body.username):
            raise HTTPException(409, "Ese usuario ya existe")
        n = repo.create_user(body.username, hash_password(body.password), body.role, body.display_name)
        repo.audit("user.create", True, u["username"], None, f"{body.username} ({body.role})")
        return {"user": public_user(n)}

    @app.patch("/api/admin/users/{uid}")
    def admin_patch_user(uid: int, body: UserPatch, u: dict = Depends(require("admin"))):
        t = repo.user_by_id(uid)
        if not t:
            raise HTTPException(404, "No existe ese usuario")
        vals: dict[str, Any] = {}
        if body.active is not None:
            if uid == u["id"] and not body.active:
                raise HTTPException(422, "No puedes desactivar tu propia cuenta")
            vals["active"] = body.active
        if body.role is not None:
            if body.role not in ROLES:
                raise HTTPException(422, "Rol desconocido")
            vals["role"] = body.role
        if body.password is not None:
            check_password(body.password)
            vals["password_hash"] = hash_password(body.password)
        repo.update_user(uid, **vals)
        repo.audit("user.update", True, u["username"], None, f"{t['username']}: {','.join(k for k in vals if k != 'password_hash') or 'contraseña'}")
        return {"ok": True}

    @app.post("/api/admin/bookings", status_code=201)
    def admin_booking(body: BookingIn, u: dict = Depends(require("admin"))):
        if body.user_id is None or not repo.user_by_id(body.user_id):
            raise HTTPException(422, "Indica un user_id existente")
        s, e = check_window(body.start, body.end)
        b = repo.create_booking(body.user_id, cfg.bank, s, e, u["id"])
        if not b:
            raise HTTPException(409, "Ese horario ya está reservado")
        repo.audit("booking.create", True, u["username"], None, f"admin para user {body.user_id}")
        return {"id": b["id"]}

    @app.get("/api/admin/audit")
    def admin_audit(u: dict = Depends(require("admin"))):
        return {"audit": [{**r, "ts": aware(r["ts"]).isoformat()} for r in repo.audit_list()]}

    if cfg.static_dir:                                      # el simulador en el mismo origen que la API (desarrollo y prueba extremo a extremo)
        from fastapi.staticfiles import StaticFiles
        app.mount("/", StaticFiles(directory=cfg.static_dir, html=True), name="static")
    return app
