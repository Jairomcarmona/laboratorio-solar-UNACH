import asyncio
import datetime as dt

import httpx
import pytest

from labsolar import contract, db
from tests.conftest import BANK, PW, GatewayRig


async def operator(grig, name="ana", role="student"):
    u = grig.add_user(name, role)
    grig.book(u)
    h = await grig.client(name)
    w = await grig.ws(h)
    await w.wait(lambda m: m["t"] == "hello")
    return u, h, w


async def test_el_visitante_ve_la_telemetria_pero_no_opera(grig):
    grig.add_user("vera", "visitor")
    h = await grig.client("vera")
    w = await grig.ws(h)
    hello = await w.wait(lambda m: m["t"] == "hello")
    assert hello["role"] == "visitor" and hello["control"] is False
    t = await w.wait(lambda m: m["t"] == "tele")
    contract.validate("tele", t["d"])
    a = await w.cmd("session.start", {"role": "student"})
    assert not a["ok"] and a["kind"] == "interlock" and "observación" in a["reason"]
    a = await w.cmd("tracker.target", {"az": 150, "tilt": 20})
    assert not a["ok"] and a["kind"] == "interlock"


async def test_el_estudiante_sin_reserva_vigente_es_rechazado(grig):
    u = grig.add_user("eva", "student")
    grig.book(u, start=db.utcnow() + dt.timedelta(hours=3))        # reserva futura: fuera de su horario
    w = await grig.ws(await grig.client("eva"))
    a = await w.cmd("session.start", {"role": "student"})
    assert not a["ok"] and "reserva" in a["reason"]


async def test_flujo_completo_estudiante_con_reserva(grig):
    u, h, w = await operator(grig)
    a = await w.cmd("session.start", {"role": "student"})
    assert a["ok"], a.get("reason")
    a = await w.cmd("tracker.target", {"az": 200, "tilt": 30})
    assert a["ok"], a.get("reason")
    await asyncio.sleep(0.5)
    assert grig.bank.target_az == pytest.approx(200, abs=0.01)
    # el puente vio la identidad que puso la pasarela, no la del navegador
    reqs = [p for t, p in grig.bus.log if t.endswith("/cmd/req") and p["type"] == "tracker.target"]
    assert reqs and reqs[-1]["user"] == "ana" and reqs[-1]["role"] == "student" and reqs[-1]["sessionId"].startswith("ses_")
    for r in reqs:
        contract.validate("req", r)


async def test_el_navegador_no_puede_falsear_rol_ni_sesion(grig):
    u, h, w = await operator(grig)
    await w.cmd("session.start", {"role": "teacher", "user": "admin"})          # intenta presentarse como docente/admin
    req = [p for t, p in grig.bus.log if t.endswith("/cmd/req") and p["type"] == "session.start"][-1]
    assert req["role"] == "student" and req["user"] == "ana" and req["args"]["role"] == "student" and req["args"]["user"] == "ana"
    await w.send({"t": "cmd", "v": 1, "id": "x1", "type": "tracker.target", "args": {"az": 150}, "sessionId": "ses_robada", "role": "teacher", "user": "root"})
    a = await w.ack("x1")
    assert not a["ok"] and a["kind"] == "validation"                              # campos extra: el esquema no los admite


async def test_dos_estudiantes_un_solo_control(grig):
    _, _, w1 = await operator(grig, "ana")
    _, _, w2 = await operator(grig, "beto")
    assert (await w1.cmd("session.start", {"role": "student"}))["ok"]
    a = await w2.cmd("session.start", {"role": "student"})
    assert not a["ok"] and a["kind"] == "interlock" and "control" in a["reason"]
    a = await w2.cmd("tracker.target", {"az": 150, "tilt": 20})
    assert not a["ok"] and a["kind"] == "interlock"
    await w2.wait(lambda m: m["t"] == "tele")                                    # el segundo recibe telemetría en solo lectura
    assert (await w1.cmd("session.end"))["ok"]
    a = await w2.cmd("session.start", {"role": "student"})
    assert a["ok"], a.get("reason")


async def test_ticket_reutilizado_o_vencido_cierra_con_4401(grig):
    grig.add_user("ana", "student")
    h = await grig.client("ana")
    t = (await h.post("/api/ws-ticket")).json()["ticket"]
    w1 = await grig.ws(h, ticket=t)
    await w1.wait(lambda m: m["t"] == "hello")
    w2 = await grig.ws(h, ticket=t)
    await asyncio.sleep(0.3)
    assert w2.closed == 4401
    w3 = await grig.ws(h, ticket="nada")
    await asyncio.sleep(0.3)
    assert w3.closed == 4401
    grig.settings.ticket_ttl_s = 0
    t2 = (await h.post("/api/ws-ticket")).json()["ticket"]
    await asyncio.sleep(0.05)
    w4 = await grig.ws(h, ticket=t2)
    await asyncio.sleep(0.3)
    assert w4.closed == 4401


async def test_rafaga_de_50_comandos_por_segundo_queda_limitada(grig):
    _, _, w = await operator(grig)
    await w.cmd("session.start", {"role": "student"})
    for k in range(50):
        await w.send({"t": "cmd", "v": 1, "id": f"b{k}", "type": "tracker.target", "args": {"tilt": 10 + (k % 5)}})
    await asyncio.sleep(1.5)
    acks = {m["d"]["id"]: m["d"] for m in w.inbox if m["t"] == "ack" and m["d"]["id"].startswith("b")}
    limited = [a for a in acks.values() if not a["ok"] and "Demasiados" in a.get("reason", "")]
    assert len(acks) == 50                                  # cada comando recibe exactamente un acuse
    assert len(limited) >= 40
    published = [p for t, p in grig.bus.log if t.endswith("/cmd/req") and p["id"].startswith("b")]
    assert len(published) <= 8


async def test_sim_y_reset_no_pasan_de_la_pasarela(grig):
    _, _, w = await operator(grig)
    await w.cmd("session.start", {"role": "student"})
    for ctype in ("sim.cloud", "scenario.apply", "safety.reset", "acq.discard", "fault.inject"):
        await asyncio.sleep(0.25)                        # por debajo del límite de 5 comandos por segundo
        a = await w.cmd(ctype, {"value": 1})
        assert not a["ok"] and a["kind"] == "unsupported", (ctype, a.get("reason"))
    assert not [p for t, p in grig.bus.log if t.endswith("/cmd/req") and p["type"].startswith(("sim.", "scenario.", "fault."))]


async def test_json_no_estricto_o_enorme_no_llega_al_bus(grig):
    _, _, w = await operator(grig)
    await w.cmd("session.start", {"role": "student"})
    before = len([1 for t, p in grig.bus.log if t.endswith("/cmd/req")])
    await w.conn.send('{"t":"cmd","v":1,"id":"n1","type":"tracker.target","args":{"az":NaN}}')
    await w.conn.send('{"t":"cmd","v":1,"id":"n2","id":"n3","type":"tracker.target","args":{"az":150}}')
    await w.conn.send("no es json")
    await asyncio.sleep(0.4)
    assert len([1 for t, p in grig.bus.log if t.endswith("/cmd/req")]) == before


async def test_sin_latido_del_navegador_se_retira_el_control(grig):
    _, _, w = await operator(grig)
    assert (await w.cmd("session.start", {"role": "student"}))["ok"]
    await w.wait(lambda m: m["t"] == "event" and m["d"]["code"] == "session.lost", timeout=4)
    ended = [p for t, p in grig.bus.log if t.endswith("/cmd/req") and p["type"] == "session.end"]
    assert ended
    assert grig.api.state.hub.control_session is None
    a = await w.cmd("tracker.target", {"az": 150, "tilt": 20})
    assert not a["ok"]


async def test_con_latidos_se_conserva_el_control(grig):
    _, _, w = await operator(grig)
    assert (await w.cmd("session.start", {"role": "student"}))["ok"]
    for _ in range(15):
        await w.send({"t": "hb", "v": 1})
        await asyncio.sleep(0.2)
    assert grig.api.state.hub.control_session is not None


async def test_acuse_perdido_da_timeout(grig):
    _, _, w = await operator(grig)
    await w.cmd("session.start", {"role": "student"})
    for t in grig.app._tasks:
        t.cancel()                                          # el puente deja de contestar
    a = await w.cmd("tracker.target", {"az": 150, "tilt": 20}, timeout=4)
    assert not a["ok"] and a["kind"] == "timeout"


async def test_la_reserva_que_termina_retira_el_control():
    r = GatewayRig()
    await r.start_all()
    try:
        u = r.add_user("ana", "student")
        r.repo.create_booking(u["id"], BANK, db.utcnow() - dt.timedelta(minutes=1), db.utcnow() + dt.timedelta(seconds=1.2), None)
        w = await r.ws(await r.client("ana"))
        assert (await w.cmd("session.start", {"role": "student"}))["ok"]
        for _ in range(12):
            await w.send({"t": "hb", "v": 1})
            await asyncio.sleep(0.2)
        ev = await w.wait(lambda m: m["t"] == "event" and m["d"]["code"] == "session.expired", timeout=3)
        assert ev
    finally:
        await r.stop_all()


# ---------------------------------------------------------------------------------------------- cuentas y reservas
async def test_login_cookie_httponly_samesite_y_mensaje_uniforme(grig):
    grig.add_user("ana", "student")
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{grig.port}") as h:
        bad1 = await h.post("/api/login", json={"username": "ana", "password": "mala"})
        bad2 = await h.post("/api/login", json={"username": "noexiste", "password": "mala"})
        assert bad1.status_code == bad2.status_code == 401 and bad1.json() == bad2.json()
        ok = await h.post("/api/login", json={"username": "ana", "password": PW})
        c = ok.headers["set-cookie"].lower()
        assert "httponly" in c and "samesite=strict" in c
        assert (await h.get("/api/me")).json()["user"]["username"] == "ana"
        await h.post("/api/logout")
        assert (await h.get("/api/me")).status_code == 401


async def test_bloqueo_temporal_tras_intentos_fallidos():
    r = GatewayRig({"max_failed_logins": 3, "login_rate_per_min": 100})
    await r.start_all()
    try:
        r.add_user("ana", "student")
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{r.port}") as h:
            for _ in range(3):
                assert (await h.post("/api/login", json={"username": "ana", "password": "mala"})).status_code == 401
            assert (await h.post("/api/login", json={"username": "ana", "password": PW})).status_code == 401      # bloqueada aun con la clave buena
    finally:
        await r.stop_all()


async def test_limite_de_intentos_de_acceso_por_ip():
    r = GatewayRig({"login_rate_per_min": 4, "max_failed_logins": 100})
    await r.start_all()
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{r.port}") as h:
            codes = [(await h.post("/api/login", json={"username": "x", "password": "y"})).status_code for _ in range(7)]
        assert codes[:4] == [401] * 4 and codes[-1] == 429
    finally:
        await r.stop_all()


async def test_origen_ajeno_se_rechaza_en_peticiones_que_cambian_estado(grig):
    grig.add_user("ana", "student")
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{grig.port}") as h:
        r = await h.post("/api/login", json={"username": "ana", "password": PW}, headers={"Origin": "https://evil.example"})
        assert r.status_code == 403


async def test_reservas_traslape_y_duracion(grig):
    u1, u2 = grig.add_user("ana", "student"), grig.add_user("beto", "student")
    h1, h2 = await grig.client("ana"), await grig.client("beto")
    s = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=2)
    ok = await h1.post("/api/bookings", json={"start": s.isoformat(), "end": (s + dt.timedelta(minutes=60)).isoformat()})
    assert ok.status_code == 201
    clash = await h2.post("/api/bookings", json={"start": (s + dt.timedelta(minutes=30)).isoformat(), "end": (s + dt.timedelta(minutes=90)).isoformat()})
    assert clash.status_code == 409
    long = await h2.post("/api/bookings", json={"start": (s + dt.timedelta(hours=5)).isoformat(), "end": (s + dt.timedelta(hours=9)).isoformat()})
    assert long.status_code == 422
    other = await h2.post("/api/bookings", json={"user_id": u1["id"], "start": (s + dt.timedelta(hours=5)).isoformat(), "end": (s + dt.timedelta(hours=6)).isoformat()})
    assert other.status_code == 403                                  # solo la administración reserva a nombre de otra persona
    mine = (await h1.get("/api/bookings")).json()["bookings"]
    assert len(mine) == 1 and mine[0]["user"] == "ana"


async def test_administracion(grig):
    grig.add_user("root", "admin")
    grig.add_user("ana", "student")
    admin, st = await grig.client("root"), await grig.client("ana")
    assert (await st.get("/api/admin/users")).status_code == 403
    r = await admin.post("/api/admin/users", json={"username": "nuevo", "password": "corta", "role": "student"})
    assert r.status_code == 422
    r = await admin.post("/api/admin/users", json={"username": "nuevo", "password": "una-clave-larga-2", "role": "student"})
    assert r.status_code == 201
    r = await admin.post("/api/admin/users", json={"username": "nuevo", "password": "una-clave-larga-2", "role": "student"})
    assert r.status_code == 409
    uid = (await admin.get("/api/admin/users")).json()["users"][-1]["id"]
    assert (await admin.patch(f"/api/admin/users/{uid}", json={"active": False})).status_code == 200
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{grig.port}") as h:
        assert (await h.post("/api/login", json={"username": "nuevo", "password": "una-clave-larga-2"})).status_code == 401
    audit = (await admin.get("/api/admin/audit")).json()["audit"]
    assert any(a["action"] == "user.create" for a in audit) and any(a["action"] == "login" and not a["ok"] for a in audit)
    # el administrador no opera el banco
    w = await grig.ws(admin)
    a = await w.cmd("session.start", {"role": "student"})
    assert not a["ok"] and "administración" in a["reason"]


async def test_auth_check_para_las_camaras(grig):
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{grig.port}") as h:
        assert (await h.get("/api/auth/check")).status_code == 401
    grig.add_user("ana", "student")
    h = await grig.client("ana")
    assert (await h.get("/api/auth/check")).status_code == 200


async def test_el_puente_vigila_a_la_pasarela(grig):
    """Mientras la pasarela vive, el puente acepta comandos; al apagarla, el PLC va a posición segura."""
    assert grig.app.gateway_ok
    grig.server.should_exit = True
    await asyncio.wait_for(grig.server_task, 5)
    await asyncio.sleep(1.5)
    assert not grig.app.gateway_ok and grig.bank.comms_stow
    grig.server_task = asyncio.create_task(asyncio.sleep(0))
