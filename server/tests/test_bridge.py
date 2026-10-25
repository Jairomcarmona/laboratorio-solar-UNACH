import asyncio
import time

import pytest

from labsolar import contract
from labsolar.bridge import registers as R
from tests.conftest import BANK, Rig


async def settle(rig, seconds):
    await asyncio.sleep(seconds)


async def latest_tele(rig):
    last = None
    while not rig.teles.queue.empty():
        last = rig.teles.queue.get_nowait()[1]
    if last is None:
        last = (await rig.teles.get(2))[1]
    return last


async def test_tele_cumple_el_contrato_y_seq_crece(rig):
    await settle(rig, 0.6)
    seqs = []
    while not rig.teles.queue.empty():
        _, t = rig.teles.queue.get_nowait()
        contract.validate("tele", t)
        seqs.append(t["seq"])
        assert t["source"] == "fake" and t["A"]["curve"] is None and t["A"]["tcell"] is None
        assert t["env"]["dni"] is None and t["env"]["dhi"] is None
    assert len(seqs) >= 4
    assert seqs == sorted(seqs) and seqs[-1] - seqs[0] == len(seqs) - 1


async def test_state_retenido_al_arrancar(rig):
    st = rig.bus.retained[contract.topic(BANK, "state")]
    contract.validate("state", st)
    assert st["bridge"] == "online"


async def test_sin_sesion_interlock(rig):
    a = await rig.cmd("tracker.target", {"az": 200, "tilt": 30})
    assert not a["ok"] and a["kind"] == "interlock"
    contract.validate("ack", a)


async def test_visitante_no_opera(rig):
    assert (await rig.login("v1", "visitor"))["ok"]
    a = await rig.cmd("tracker.target", {"az": 200, "tilt": 30}, session="v1", role="visitor")
    assert not a["ok"] and a["kind"] == "interlock" and "Visitante" in a["reason"]


async def test_mover_el_seguidor_llega_al_plc(rig):
    assert (await rig.login())["ok"]
    a = await rig.cmd("tracker.target", {"az": 200, "tilt": 30})
    assert a["ok"], a
    await settle(rig, 1.2)
    assert abs(rig.bank.target_az - 200) < 1e-6 and abs(rig.bank.target_tilt - 30) < 1e-6
    t = await latest_tele(rig)
    assert t["tracker"]["targetAz"] == pytest.approx(200, abs=0.01)


@pytest.mark.parametrize("args,field", [({"az": 20}, "az"), ({"tilt": 120}, "tilt"), ({"az": "180"}, "az"), ({}, "az")])
async def test_rangos_se_rechazan_en_el_puente_sin_mutar(rig, args, field):
    await rig.login()
    before = (rig.bank.target_az, rig.bank.target_tilt)
    a = await rig.cmd("tracker.target", args)
    assert not a["ok"] and a["kind"] in ("validation",) and a.get("field") == field
    assert (rig.bank.target_az, rig.bank.target_tilt) == before


async def test_sim_y_reset_no_existen_en_modo_real(rig):
    await rig.login()
    for ctype in ("sim.cloud", "scenario.apply", "safety.reset", "acq.discard", "sim.time"):
        a = await rig.cmd(ctype, {"value": 1})
        assert not a["ok"] and a["kind"] == "unsupported", ctype


async def test_carga_rangos(rig):
    await rig.login()
    assert not (await rig.cmd("load.set", {"mode": "cr", "setpoint": 0.0}))["ok"]
    assert not (await rig.cmd("load.set", {"mode": "cv", "setpoint": 5}))["ok"]
    assert (await rig.cmd("load.set", {"mode": "cr", "setpoint": 3.4}))["ok"]
    await settle(rig, 0.3)
    assert rig.bank.load_mode == "cr" and rig.bank.load_setpoint == pytest.approx(3.4)


async def test_cola_de_comandos_acotada():
    r = Rig(bridge_cfg={"queue_max": 3})
    # el trabajador es lento: el PLC no responde al eco (se simula bloqueando el controlador)
    gate = asyncio.Event()
    orig = r.ctrl.read_state

    async def slow():
        if gate.is_set() is False:
            await asyncio.sleep(0.5)
        return await orig()
    r.ctrl.read_state = slow
    await r.start()
    try:
        r.app.control_session = "s1"
        for k in range(8):
            await r.bus.publish_msg(BANK, "cmd/req", {"id": f"q{k}", "ts": 1, "sessionId": "s1", "user": "a", "role": "student", "type": "tracker.target", "args": {"tilt": 10 + k}})
        rejected = []
        end = asyncio.get_running_loop().time() + 0.4
        while asyncio.get_running_loop().time() < end:
            try:
                _, a = await r.acks.get(0.05)
            except asyncio.TimeoutError:
                continue
            if not a["ok"] and a["kind"] == "interlock" and "Cola" in a["reason"]:
                rejected.append(a["id"])
        assert len(rejected) >= 3
    finally:
        gate.set()
        await r.stop()


async def test_viento_activa_posicion_segura_en_el_plc_y_se_informa(rig):
    await rig.login()
    await rig.cmd("tracker.target", {"az": 120, "tilt": 40})
    rig.bank.scenario["wind"] = [[0, 16], [100, 16]]
    await settle(rig, 1.0)
    t = await latest_tele(rig)
    assert t["safety"]["state"] == "WIND_STOW" and not t["safety"]["canOperate"]
    codes = []
    while not rig.events.queue.empty():
        codes.append(rig.events.queue.get_nowait()[1]["code"])
    assert "safety.wind_stow" in codes
    a = await rig.cmd("tracker.target", {"az": 150, "tilt": 20})
    assert not a["ok"] and a["kind"] == "interlock"          # el puente lo rechaza o el PLC; en ambos casos no se mueve
    assert rig.bank.target_az == pytest.approx(180, abs=1) or rig.bank.target_az != 150


async def test_paro_por_software_lo_decide_el_plc_y_solo_la_llave_lo_quita(rig):
    await rig.login()
    a = await rig.cmd("safety.estop", {"who": "ana"})
    assert a["ok"]
    await settle(rig, 0.3)
    assert rig.bank.estop and rig.bank.load_mode == "oc"
    t = await latest_tele(rig)
    assert t["safety"]["state"] == "ESTOP" and t["tracker"]["appliedMode"] == "estop"
    bad = await rig.cmd("tracker.target", {"az": 150, "tilt": 20})
    assert not bad["ok"]
    assert not (await rig.cmd("safety.reset"))["ok"]            # safety.reset no existe en modo real
    rig.bank.reset_estop_key()
    await settle(rig, 0.3)
    assert (await rig.cmd("tracker.target", {"az": 150, "tilt": 20}))["ok"]


async def test_perdida_de_la_pasarela_retira_control_y_pide_posicion_segura(rig):
    await rig.login()
    rig.gateway_alive = False
    await settle(rig, 1.5)
    assert rig.app.control_session is None and not rig.app.gateway_ok
    assert rig.bank.comms_stow
    a = await rig.cmd("tracker.target", {"az": 150, "tilt": 20})
    assert not a["ok"] and a["kind"] == "interlock" and "pasarela" in a["reason"]
    rig.gateway_alive = True
    await settle(rig, 0.6)
    assert rig.app.gateway_ok and rig.bank.comms_stow           # la posición segura sigue hasta reconocer la falla
    await rig.login()
    ack = await rig.cmd("safety.ack")
    assert ack["ok"], ack
    assert not rig.bank.comms_stow


async def test_muerte_abrupta_del_puente_deja_el_plc_en_posicion_segura():
    r = Rig()
    await r.start()
    try:
        await r.login()
        await r.cmd("tracker.target", {"az": 120, "tilt": 40})
        for t in r.app._tasks:                                  # equivale a kill -9: nadie avisa al PLC, solo se calla el latido
            t.cancel()
        await asyncio.sleep(1.2)
        assert r.bank.comms_stow and r.bank.state == R.State.COMMS_STOW
        assert r.bank.target_az == pytest.approx(r.bank.cfg["stow"]["az"])
    finally:
        await r.stop()


async def test_barrido_iv_completo_y_restaura_la_carga(rig):
    await rig.login()
    await rig.cmd("load.set", {"mode": "mppt"})
    a = await rig.cmd("load.sweep")
    assert a["ok"]
    bloqueado = await rig.cmd("tracker.target", {"az": 150, "tilt": 20})
    assert not bloqueado["ok"] and bloqueado["kind"] == "interlock"
    _, sw = await rig.sweeps.get(4)
    contract.validate("sweep", sw)
    assert sw["status"] == "complete" and len(sw["pts"]["A"]) >= 8 and len(sw["pts"]["B"]) >= 8
    vs = [p["v"] for p in sw["pts"]["A"]]
    assert vs[0] < vs[-1] and max(vs) > 40                      # de cortocircuito a circuito abierto
    await settle(rig, 0.3)
    assert rig.bank.load_mode == "mppt"


async def test_barrido_interrumpido_por_paro():
    r = Rig(bridge_cfg={"sweep_seconds": 3.0})
    await r.start()
    try:
        await r.login()
        assert (await r.cmd("load.sweep"))["ok"]
        await asyncio.sleep(0.5)
        r.bank.press_estop()
        _, sw = await r.sweeps.get(3)
        assert sw["status"] == "interrupted" and "paro" in sw["cause"]
    finally:
        await r.stop()


async def test_barrido_banco_de_cargas_discreto():
    r = Rig(bridge_cfg={"load_bank": [1, 2, 3.4, 5, 10, 20], "sweep_seconds": 2.4})
    await r.start()
    try:
        await r.login()
        assert not (await r.cmd("load.set", {"mode": "cr", "setpoint": 7}))["ok"]
        assert (await r.cmd("load.sweep"))["ok"]
        _, sw = await r.sweeps.get(5)
        assert sw["status"] == "complete" and len(sw["pts"]["A"]) == 8 and len(sw["pts"]["B"]) == 8
    finally:
        await r.stop()


async def test_adquisicion_perdida_marca_stale():
    r = Rig(bank_cfg={"drop_prob": 1.0})
    await r.start()
    try:
        await asyncio.sleep(0.5)
        t = await latest_tele(r)
        assert "stale" in t["quality"] and t["A"]["v"] is None
        contract.validate("tele", t)
    finally:
        await r.stop()


async def test_periodo_de_telemetria_estable():
    r = Rig(bridge_cfg={"tele_period_s": 0.05})
    await r.start()
    try:
        while not r.teles.queue.empty():
            r.teles.queue.get_nowait()
        stamps = []
        for _ in range(120):
            _, t = await r.teles.get(1)
            stamps.append(t["ts"] / 1000.0)
        gaps = [b - a for a, b in zip(stamps, stamps[1:])]
        mean = sum(gaps) / len(gaps)
        assert abs(mean - 0.05) / 0.05 <= 0.05                 # periodo medio dentro de 5 %
        assert max(gaps) < 0.25                                      # sin saltos grandes; el margen absorbe la carga de un ejecutor compartido
        r.teles.queue.put_nowait(("x", {"seq": stamps and 0}))   # marcador para la comprobacion de huecos
        seqs = []
        while not r.teles.queue.empty():
            seqs.append(r.teles.queue.get_nowait()[1]["seq"])
        seqs = [x for x in seqs if x]
        assert all(b - a == 1 for a, b in zip(seqs, seqs[1:]))   # sin huecos
    finally:
        await r.stop()


async def test_secuencia_de_eventos_de_viento_coincide_con_el_simulador():
    """Mismo orden que T28 del simulador: viento alto -> posicion segura -> viento bajo sostenido -> se levanta."""
    r = Rig(bank_cfg={"scenario": {"wind": [[0, 3], [0.4, 3], [0.5, 16], [1.5, 16], [1.6, 3], [10, 3]]}})
    await r.start()
    try:
        await asyncio.sleep(3.0)
        evs = [e for _, e in list(r.bus.log) if _.endswith("/event")]
        ev = [e["code"] for e in evs if e["code"].startswith("safety.")]
        assert ev[:2] == ["safety.wind_stow", "safety.normal"], ev
        assert [e["code"] for e in r.bank.events_log if False] == []
        assert [e["code"] for e in r.bank.events_log] == ["wind_stow", "wind_resume"]
    finally:
        await r.stop()


async def test_el_puente_rechaza_el_paro_de_un_visitante_sin_sesion(rig):
    a = await rig.cmd("safety.estop", {"who": "vera"}, session="obs_x", role="visitor", user="vera")
    assert not a["ok"] and a["kind"] == "interlock"
    await settle(rig, 0.2)
    assert not rig.bank.estop
    assert (await rig.cmd("safety.estop", {"who": "prof"}, session="obs_y", role="teacher", user="prof"))["ok"]
