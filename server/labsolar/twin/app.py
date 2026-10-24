"""Gemelo digital (S24): publica la potencia esperada (modelo de physics.json) contra la medida, en labsolar/v1/<bank>/twin.

Para cada módulo: pExp = Pmp(G_poa, T_celda), con T_celda = T_posterior + 3·G/1000. Se marca «underperform_A|B» cuando el residuo
queda por debajo de -5 % durante 10 minutos seguidos. No se evalúa con sombra mutua ni con G < 100 W/m², ni si la carga no es de
máxima potencia (con otra carga la potencia medida no es la máxima y el residuo no significa nada). La bandera se retira al volver
a una muestra evaluable dentro del umbral.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from .. import contract, physics
from ..bus import Bus

log = logging.getLogger("labsolar.twin")

UNDERPERFORM_PCT = -5.0
UNDERPERFORM_HOLD_S = 600.0
MIN_G = 100.0
MPPT_MODES = ("mppt",)


class TwinApp:
    def __init__(self, bus: Bus, bank: str, hold_s: float = UNDERPERFORM_HOLD_S, pct: float = UNDERPERFORM_PCT) -> None:
        self.bus, self.bank, self.hold_s, self.pct = bus, bank, hold_s, pct
        self._since: dict[str, float | None] = {"A": None, "B": None}       # ts (s) desde el que el residuo está bajo el umbral
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        self._sub = self.bus.subscribe(contract.topic(self.bank, "tele"))
        self._task = asyncio.create_task(self._run(), name="twin")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        self._sub.close()

    async def _run(self) -> None:
        async for _, tele in self._sub:
            try:
                out = self.evaluate(tele)
                await self.bus.publish_msg(self.bank, "twin", out)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("no se pudo evaluar la telemetría")

    def expected(self, m: dict[str, Any]) -> float | None:
        g, tb = m.get("poa"), m.get("tback")
        if g is None or tb is None:
            return None
        return physics.module_power(float(g), physics.cell_from_module(float(tb), float(g)))["pmp"]

    def evaluate(self, tele: dict) -> dict:
        ts = tele["ts"]
        flags: list[str] = []
        out: dict[str, Any] = {"ts": ts, "flags": flags}
        mppt = (tele.get("load") or {}).get("mode") in MPPT_MODES and not (tele.get("load") or {}).get("sweeping")
        for k in ("A", "B"):
            m = tele[k]
            p_exp = self.expected(m)
            p = m.get("p")
            res = res_pct = None
            if p_exp is not None and p is not None:
                res = p - p_exp
                res_pct = 100.0 * res / p_exp if p_exp > 1.0 else None
            out[k] = {"pExp": p_exp, "res": res, "resPct": res_pct}
            shaded = (m.get("shadeFrac") or 0) > 0
            evaluable = mppt and res_pct is not None and (m.get("poa") or 0) >= MIN_G and not shaded
            if shaded:
                flags.append(f"shade_mutual_{k}")
            if not evaluable:
                self._since[k] = None               # sin datos válidos no se acumula tiempo bajo el umbral
                continue
            if res_pct < self.pct:
                if self._since[k] is None:
                    self._since[k] = ts / 1000.0
                if ts / 1000.0 - self._since[k] >= self.hold_s:
                    flags.append(f"underperform_{k}")
            else:
                self._since[k] = None
        return out
