"""Concurrencia real: clientes WebSocket contra pasarela + puente + banco virtual (sin simular el bus)."""
import asyncio

import pytest

from tests.conftest import GatewayRig


@pytest.fixture
async def crig():
    r = GatewayRig(settings_over={"session_reconcile_s": 0.6}, bridge_cfg={"session_reconcile_s": 0.6})
    await r.start_all()
    yield r
    await r.stop_all()


async def tab(grig, name):
    w = await grig.ws(await grig.client(name))
    await w.wait(lambda m: m["t"] == "hello")
    return w


def consistent(grig):
    hub = grig.api.state.hub
    return hub.control_session == grig.app.control_session


async def test_dos_pestanas_de_la_misma_cuenta_inician_sesion_a_la_vez(crig):
    u = crig.add_user("ana", "student")
    crig.book(u)
    h = await crig.client("ana")
    w1, w2 = await crig.ws(h), await crig.ws(h)
    await w1.wait(lambda m: m["t"] == "hello"); await w2.wait(lambda m: m["t"] == "hello")
    a1, a2 = await asyncio.gather(w1.cmd("session.start", {"role": "student"}), w2.cmd("session.start", {"role": "student"}))
    assert sorted([a1["ok"], a2["ok"]]) == [False, True]
    await asyncio.sleep(0.5)
    hub = crig.api.state.hub
    assert hub.control_session is not None and consistent(crig)
    winner, loser = (w1, w2) if a1["ok"] else (w2, w1)
    assert hub.control is not None
    # la pestaña ganadora termina y la otra puede tomar el control: el banco no queda bloqueado
    assert (await winner.cmd("session.end"))["ok"]
    assert (await loser.cmd("session.start", {"role": "student"}))["ok"]
    assert consistent(crig)


async def test_rafaga_de_inicios_de_varias_cuentas_deja_un_solo_control(crig):
    ws = []
    for n in ("a1", "a2", "a3", "a4"):
        crig.book(crig.add_user(n, "student"))
        ws.append(await tab(crig, n))
    acks = await asyncio.gather(*(w.cmd("session.start", {"role": "student"}) for w in ws))
    assert sum(a["ok"] for a in acks) == 1
    await asyncio.sleep(0.5)
    assert consistent(crig) and crig.app.control_session is not None


async def test_sesion_huerfana_en_el_puente_se_libera_sola(crig):
    crig.book(crig.add_user("ana", "student"))
    w = await tab(crig, "ana")
    crig.app.control_session, crig.app.control_role = "ses_huerfana", "student"      # lo que queda tras reiniciar la pasarela con alguien operando
    a = await w.cmd("session.start", {"role": "student"})
    assert not a["ok"]
    await asyncio.sleep(2.2)                                                         # expiración por reconciliación con el latido
    assert crig.app.control_session is None
    a = await w.cmd("session.start", {"role": "student"})
    assert a["ok"], a.get("reason")
    assert consistent(crig)


async def test_la_pasarela_suelta_un_control_que_el_puente_no_reconoce(crig):
    crig.book(crig.add_user("ana", "student"))
    w = await tab(crig, "ana")
    assert (await w.cmd("session.start", {"role": "student"}))["ok"]
    crig.app.control_session = None                                                  # el puente perdió la sesión (reinicio)
    await crig.app._publish_state(force=True)
    ev = await w.wait(lambda m: m["t"] == "event" and m["d"]["code"] == "session.lost", timeout=4)
    assert "no reconoce" in ev["d"]["msg"]
    assert crig.api.state.hub.control is None
    assert (await w.cmd("session.start", {"role": "student"}))["ok"]
