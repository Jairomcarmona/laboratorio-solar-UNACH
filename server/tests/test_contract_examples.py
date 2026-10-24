import asyncio
import json
from pathlib import Path

import pytest

from labsolar import contract
from tests.conftest import Rig

EX = Path(__file__).resolve().parent.parent / "contract" / "v1" / "examples"
SCHEMA_OF = lambda name: "cmd" if name.startswith("cmd_") else name.split("_")[0]          # noqa: E731


def files(kind):
    return sorted((EX / kind).glob("*.json"))


@pytest.mark.parametrize("f", files("valid"), ids=lambda f: f.stem)
def test_ejemplo_valido(f):
    contract.validate(SCHEMA_OF(f.stem), json.loads(f.read_text()))


@pytest.mark.parametrize("f", files("invalid"), ids=lambda f: f.stem)
def test_ejemplo_invalido(f):
    assert contract.errors(SCHEMA_OF(f.stem), json.loads(f.read_text()))


def test_hay_17_comandos_invalidos_y_todos_los_tipos_validos():
    assert len([f for f in files("invalid") if f.stem.startswith("cmd_")]) == 17
    types = {json.loads(f.read_text())["type"] for f in files("valid") if f.stem.startswith("cmd_")}
    assert types == set(contract.cmd_types()[0])


async def test_la_telemetria_viva_cumple_el_contrato_y_la_del_simulador_tambien():
    rig = Rig()
    await rig.start()
    try:
        await rig.login()
        await rig.cmd("load.sweep")
        seen = set()
        for _ in range(60):
            for q, name in ((rig.teles, "tele"), (rig.sweeps, "sweep")):
                try:
                    _, p = await q.get(timeout=0.05)
                except Exception:
                    continue
                contract.validate(name, p)
                seen.add(name)
        s = rig.app.state_msg() if hasattr(rig.app, "state_msg") else None
        assert {"tele"} <= seen
        if s:
            contract.validate("state", s)
    finally:
        await rig.stop()
