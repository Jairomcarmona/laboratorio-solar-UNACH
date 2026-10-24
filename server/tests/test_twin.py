import asyncio
import copy

import pytest

from labsolar import contract
from labsolar.twin.app import TwinApp
from tests.conftest import BANK, Rig


async def base_tele(rig):
    await rig.login()
    assert (await rig.cmd("load.set", {"mode": "mppt"}))["ok"]
    await asyncio.sleep(1.0)
    _, t = await rig.teles.get(timeout=1.0)
    return t


async def test_banco_sano_no_marca_bajo_desempeno_y_publica_en_el_contrato():
    rig = Rig()
    await rig.start()
    twin = TwinApp(rig.bus, BANK, hold_s=1.0)
    out_q = rig.bus.subscribe(contract.topic(BANK, "twin"))
    await twin.start()
    try:
        await base_tele(rig)
        outs = []
        for _ in range(15):
            _, o = await out_q.get(timeout=1.0)
            contract.validate("twin", o)
            outs.append(o)
        o = outs[-1]
        assert o["A"]["pExp"] > 50 and o["B"]["pExp"] > 50
        assert abs(o["A"]["resPct"]) < 5 and abs(o["B"]["resPct"]) < 5, o
        assert not any(f.startswith("underperform") for x in outs for f in x["flags"])
    finally:
        await twin.stop()
        await rig.stop()


async def test_bandera_tras_diez_minutos_bajo_el_umbral_y_se_retira_al_recuperarse():
    rig = Rig()
    await rig.start()
    try:
        t = await base_tele(rig)
        twin = TwinApp(rig.bus, BANK)
        t["load"]["mode"], t["load"]["sweeping"] = "mppt", False
        for m in "AB":
            t[m]["shadeFrac"], t[m]["poa"] = 0.0, 900.0
        def at(sec, factor_b):
            x = copy.deepcopy(t)
            x["ts"] = 1_800_000_000_000 + sec * 1000
            x["A"]["p"] = twin.expected(x["A"])
            x["B"]["p"] = twin.expected(x["B"]) * factor_b
            return twin.evaluate(x)
        assert "underperform_B" not in at(0, 0.90)["flags"]
        assert "underperform_B" not in at(599, 0.90)["flags"]
        f = at(601, 0.90)["flags"]
        assert "underperform_B" in f and "underperform_A" not in f
        assert "underperform_B" not in at(700, 1.0)["flags"]            # se recupera
        assert "underperform_B" not in at(710, 0.90)["flags"]           # el conteo empieza de nuevo
        assert "underperform_B" not in at(1000, 0.97)["flags"]          # -3 %: dentro de la tolerancia
    finally:
        await rig.stop()


async def test_no_se_evalua_con_sombra_poca_luz_ni_fuera_de_mppt():
    rig = Rig()
    await rig.start()
    try:
        t = await base_tele(rig)
        twin = TwinApp(rig.bus, BANK, hold_s=0.0)
        def go(**over):
            x = copy.deepcopy(t)
            x["load"]["mode"], x["load"]["sweeping"] = "mppt", False
            for m in "AB":
                x[m]["shadeFrac"], x[m]["poa"] = 0.0, 900.0
            x["B"]["p"] = twin.expected(x["B"]) * 0.5
            for path, v in over.items():
                a, b = path.split("__")
                x[a][b] = v
            x["ts"] += 1000
            twin.evaluate(x)
            return twin.evaluate({**x, "ts": x["ts"] + 5000})["flags"]
        assert "underperform_B" in go()                                  # control: sin excusas sí se marca
        assert "underperform_B" not in go(B__shadeFrac=0.3)              # sombra mutua
        assert "underperform_B" not in go(B__poa=80.0)                   # poca irradiancia
        assert "underperform_B" not in go(load__mode="cr")               # carga que no es de máxima potencia
        assert "underperform_B" not in go(load__sweeping=True)
    finally:
        await rig.stop()
