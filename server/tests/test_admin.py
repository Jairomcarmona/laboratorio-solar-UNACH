"""Administración global: control en vivo, liberar, mantenimiento, rol técnico y /api/health sin datos de sesión."""
import asyncio

import pytest

from labsolar import db
from labsolar.gateway.hub import Hub
from tests.conftest import GatewayRig


@pytest.fixture
async def arig():
    r = GatewayRig(settings_over={"session_reconcile_s": 0.6}, bridge_cfg={"session_reconcile_s": 0.6})
    await r.start_all()
    yield r
    await r.stop_all()


async def operador(rig, name="ana"):
    rig.book(rig.add_user(name, "student"))
    w = await rig.ws(await rig.client(name))
    await w.wait(lambda m: m["t"] == "hello")
    assert (await w.cmd("session.start", {"role": "student"}))["ok"]
    return w


async def test_health_sin_sesion_no_publica_ids_ni_conteos(arig):
    await operador(arig)
    import httpx
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{arig.port}") as anon:
        assert (await anon.get("/api/health")).json() == {"ok": True}
    arig.add_user("root", "admin")
    adm = await arig.client("root")
    h = (await adm.get("/api/health")).json()
    assert h["control"].startswith("ses_") and h["clients"] >= 1


async def test_el_panel_muestra_quien_tiene_el_control_y_quien_mira(arig):
    await operador(arig, "ana")
    arig.add_user("vera", "visitor")
    await arig.ws(await arig.client("vera"))
    arig.add_user("root", "admin")
    adm = await arig.client("root")
    await asyncio.sleep(0.5)
    snap = (await adm.get("/api/admin/control")).json()
    assert snap["control"]["user"] == "ana" and snap["control"]["sessionId"].startswith("ses_")
    assert {c["user"] for c in snap["clients"]} == {"ana", "vera"}
    assert snap["state"]["safety"] and snap["maintenance"] is None


@pytest.mark.parametrize("role", ["student", "teacher", "visitor"])
async def test_los_endpoints_de_control_solo_son_de_admin_y_tecnico(arig, role):
    arig.add_user("zeta", role)
    h = await arig.client("zeta")
    assert (await h.get("/api/admin/control")).status_code == (200 if role == "teacher" else 403)       # el docente lo ve en solo lectura
    assert (await h.post("/api/admin/control/release")).status_code == 403
    assert (await h.post("/api/admin/maintenance", json={"on": True})).status_code == 403
    assert (await h.get("/api/admin/audit")).status_code == 403


async def test_liberar_el_control_deja_al_operador_como_espectador_y_el_banco_en_posicion_segura(arig):
    w = await operador(arig)
    arig.add_user("root", "admin")
    adm = await arig.client("root")
    r = await adm.post("/api/admin/control/release")
    assert r.json() == {"released": True}
    ev = await w.wait(lambda m: m["t"] == "event" and m["d"]["code"] == "session.revoked")
    assert "administración" in ev["d"]["msg"]
    await asyncio.sleep(0.4)
    assert arig.api.state.hub.control is None and arig.app.control_session is None and arig.bank.comms_stow
    assert w.closed is None                                   # sigue conectado, solo mira
    assert (await adm.post("/api/admin/control/release")).json() == {"released": False}
    assert any(a["action"] == "control.release" for a in arig.repo.audit_list())


async def test_el_tecnico_ve_y_libera_pero_no_gestiona_usuarios(arig):
    w = await operador(arig)
    arig.add_user("tec", "tech")
    h = await arig.client("tec")
    assert (await h.get("/api/admin/control")).json()["control"]["user"] == "ana"
    assert (await h.post("/api/admin/control/release")).json()["released"] is True
    assert (await h.get("/api/admin/users")).status_code == 403
    assert (await h.get("/api/health")).json().get("control") is None


async def test_el_admin_puede_dar_de_alta_un_tecnico(arig):
    arig.add_user("root", "admin")
    adm = await arig.client("root")
    r = await adm.post("/api/admin/users", json={"username": "tecnico1", "password": "una-clave-larga-1", "role": "tech", "display_name": "Técnico"})
    assert r.status_code == 201 and r.json()["user"]["role"] == "tech"


async def test_mantenimiento_corta_la_sesion_bloquea_y_se_levanta(arig):
    w = await operador(arig, "ana")
    arig.book(arig.add_user("beto", "student"))
    wb = await arig.ws(await arig.client("beto"))
    await wb.wait(lambda m: m["t"] == "hello")
    arig.add_user("root", "admin")
    adm = await arig.client("root")
    r = await adm.post("/api/admin/maintenance", json={"on": True, "reason": "cambio de sensor"})
    assert r.json()["sessionCut"] is True and r.json()["maintenance"]["reason"] == "cambio de sensor"
    await asyncio.sleep(0.4)
    assert arig.api.state.hub.control is None and arig.app.control_session is None
    a = await wb.cmd("session.start", {"role": "student"})
    assert not a["ok"] and "mantenimiento" in a["reason"] and "cambio de sensor" in a["reason"]
    assert arig.repo.get_setting("maintenance")["reason"] == "cambio de sensor"        # sobrevive a un reinicio de la pasarela
    hub2 = Hub(arig.bus, arig.repo, arig.settings)
    await hub2.start()
    assert hub2.maintenance and hub2.maintenance["by"] == "root"
    await hub2.stop()
    assert (await adm.post("/api/admin/maintenance", json={"on": False})).json()["maintenance"] is None
    await asyncio.sleep(1.5)                                   # la reconciliación del puente ya liberó lo anterior
    a = await wb.cmd("session.start", {"role": "student"})
    assert a["ok"], a.get("reason")


async def test_la_bitacora_se_filtra_por_usuario_y_accion(arig):
    arig.add_user("root", "admin")
    arig.add_user("ana", "student")
    adm = await arig.client("root")
    await arig.client("ana")
    arig.repo.audit("booking.create", True, "ana", None, "x")
    a = (await adm.get("/api/admin/audit", params={"user": "ana"})).json()["audit"]
    assert a and all(r["username"] == "ana" for r in a)
    b = (await adm.get("/api/admin/audit", params={"action": "booking"})).json()["audit"]
    assert b and all(r["action"].startswith("booking") for r in b)
    assert (await adm.get("/api/admin/audit", params={"hours": 0.0001, "limit": 1})).status_code == 200


# ---------------------------------------------------------------------------- bloque final: docente en lectura, seguridad, reservas, exportaciones
async def test_el_docente_ve_el_panel_en_solo_lectura(arig):
    await operador(arig)
    arig.add_user("profe", "teacher")
    h = await arig.client("profe")
    snap = (await h.get("/api/admin/control")).json()
    assert snap["control"]["user"] == "ana" and snap["control"]["sessionId"] is None and snap["state"]["controlSession"] is None
    assert snap["link"]["source"] and snap["alarm"]["state"]
    assert (await h.post("/api/admin/control/release")).status_code == 403
    assert (await h.post("/api/admin/maintenance", json={"on": True})).status_code == 403
    for path in ("safety/ack", "safety/stow", "safety/estop"):
        assert (await h.post(f"/api/admin/{path}")).status_code == 403
    assert (await h.get("/api/admin/audit")).status_code == 403 and (await h.get("/api/admin/audit.csv")).status_code == 403
    assert (await h.get("/api/admin/sessions.csv")).status_code == 403
    assert arig.api.state.hub.control is not None


async def test_posicion_segura_y_reconocimiento_desde_administracion(arig):
    arig.add_user("root", "admin")
    adm = await arig.client("root")
    r = (await adm.post("/api/admin/safety/stow")).json()
    assert r["ok"], r
    await asyncio.sleep(0.5)
    assert arig.bank.comms_stow
    snap = (await adm.get("/api/admin/control")).json()
    assert snap["alarm"]["state"] == "COMMS_STOW"
    assert (await adm.post("/api/admin/safety/ack")).json()["ok"]
    await asyncio.sleep(0.5)
    assert not arig.bank.comms_stow
    acts = [a["action"] for a in arig.repo.audit_list()]
    assert "safety.stow" in acts and "safety.ack" in acts


async def test_paro_desde_administracion_queda_registrado_y_el_tecnico_tambien_puede(arig):
    arig.add_user("tec", "tech")
    h = await arig.client("tec")
    assert (await h.post("/api/admin/safety/estop")).json()["ok"]
    await asyncio.sleep(0.4)
    assert arig.bank.estop
    assert any(a["action"] == "safety.estop" and a["username"] == "tec" for a in arig.repo.audit_list())


async def test_mover_una_reserva_valida_traslapes_y_corta_si_deja_sin_turno(arig):
    import datetime as dt
    w = await operador(arig)
    arig.add_user("root", "admin")
    adm = await arig.client("root")
    ana = arig.repo.user_by_name("ana")
    bid = arig.repo.list_bookings(ana["id"])[0]["id"]
    now = db.utcnow()
    otro = arig.repo.create_booking(arig.repo.create_user("beto", "x", "student")["id"], arig.settings.bank, now + dt.timedelta(hours=3), now + dt.timedelta(hours=4), None)
    assert otro is not None
    r = await adm.patch(f"/api/admin/bookings/{bid}", json={"start": (now + dt.timedelta(hours=3, minutes=30)).isoformat(), "end": (now + dt.timedelta(hours=5)).isoformat()})
    assert r.status_code == 409
    assert (await adm.patch("/api/admin/bookings/9999", json={"start": (now + dt.timedelta(hours=8)).isoformat(), "end": (now + dt.timedelta(hours=9)).isoformat()})).status_code == 404
    r = await adm.patch(f"/api/admin/bookings/{bid}", json={"start": (now + dt.timedelta(hours=6)).isoformat(), "end": (now + dt.timedelta(hours=7)).isoformat()})
    assert r.status_code == 200 and r.json()["sessionCut"] is True
    await asyncio.sleep(0.4)
    assert arig.api.state.hub.control is None
    assert any(a["action"] == "booking.move" for a in arig.repo.audit_list())


async def test_exportar_auditoria_y_sesiones_queda_registrado(arig):
    arig.add_user("root", "admin")
    adm = await arig.client("root")
    arig.repo.open_session("ses_x", "lab1", None, "ana", "student", 1_700_000_000_000)
    arig.repo.upsert_command("lab1", {"id": "k1", "ts": 1_700_000_000_500, "sessionId": "ses_x", "user": "ana", "role": "student", "type": "tracker.target", "args": {"az": 150}})
    a = await adm.get("/api/admin/audit.csv")
    assert a.status_code == 200 and "attachment" in a.headers["content-disposition"] and a.text.splitlines()[0].lstrip("﻿").startswith("id,utc_iso")
    s = await adm.get("/api/admin/sessions.csv")
    assert "ses_x" in s.text
    c = await adm.get("/api/admin/sessions/ses_x/commands.csv")
    assert "tracker.target" in c.text and "150" in c.text
    assert (await adm.get("/api/admin/sessions")).json()["sessions"][0]["id"] == "ses_x"
    acts = [x["action"] for x in arig.repo.audit_list()]
    assert {"export.audit", "export.sessions", "export.commands"} <= set(acts)
