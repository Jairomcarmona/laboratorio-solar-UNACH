"""Adquisición con NI-DAQmx (cDAQ-9184 o similar) desde Python. SIN LabVIEW.

Requiere el controlador NI-DAQmx instalado y el paquete 'nidaqmx'. NI-DAQmx para Linux no se ha comprobado con el cDAQ-9184
(pendiente del inventario): si no lo reconoce, el puente corre en un PC con Windows con la misma configuración.

Config (YAML), por canal físico:
  channels:
    A.v:   {phys: cDAQ1Mod1/ai0, type: voltage, scale: 100.0, offset: 0}      # divisor: V_real = lectura*scale + offset
    A.i:   {phys: cDAQ1Mod1/ai1, type: voltage, scale: 5.0}                    # transductor/derivación
    A.poa: {phys: cDAQ1Mod2/ai0, type: voltage, scale: 100000.0}               # V -> W/m2 con la sensibilidad del sensor
    A.tback: {phys: cDAQ1Mod3/ai0, type: thermocouple, tc: K}
    env.wind: ...
La lectura es bloqueante: se ejecuta en un hilo para no detener el bucle del puente.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from .base import DaqDriver

log = logging.getLogger("labsolar.bridge.nidaqmx")


class NidaqmxDaq(DaqDriver):
    name = "nidaqmx"

    def __init__(self, channels: dict[str, dict], sample_rate: float = 1000.0, samples: int = 100, module=None) -> None:
        self.channels = channels
        self.sample_rate, self.samples = sample_rate, samples
        self._nidaqmx = module
        self._task = None
        self._order: list[str] = []

    async def connect(self) -> None:
        if self._nidaqmx is None:
            import nidaqmx
            self._nidaqmx = nidaqmx
        from_ = self._nidaqmx
        constants = getattr(self._nidaqmx, "constants", None)
        self._task = from_.Task()
        for name, ch in self.channels.items():
            kind = ch.get("type", "voltage")
            if kind == "thermocouple":
                tc = getattr(constants.ThermocoupleType, ch.get("tc", "K")) if constants else None
                self._task.ai_channels.add_ai_thrmcpl_chan(ch["phys"], thermocouple_type=tc)
            elif kind == "rtd":
                self._task.ai_channels.add_ai_rtd_chan(ch["phys"])
            else:
                self._task.ai_channels.add_ai_voltage_chan(ch["phys"], min_val=ch.get("min", -10.0), max_val=ch.get("max", 10.0))
            self._order.append(name)

    async def close(self) -> None:
        if self._task is not None:
            self._task.close()

    def _read_blocking(self) -> list[float]:
        data = self._task.read(number_of_samples_per_channel=1) if self.samples <= 1 else self._task.read(number_of_samples_per_channel=self.samples)
        if len(self._order) == 1:
            data = [data]
        out = []
        for ch in data:
            out.append(float(sum(ch) / len(ch)) if isinstance(ch, (list, tuple)) else float(ch))   # promedio de la ventana: reduce ruido de red
        return out

    async def read(self) -> dict[str, Any]:
        raw = await asyncio.to_thread(self._read_blocking)
        res: dict[str, dict[str, Any]] = {"A": {}, "B": {}, "env": {}}
        for name, value in zip(self._order, raw):
            ch = self.channels[name]
            scaled = value * ch.get("scale", 1.0) + ch.get("offset", 0.0)
            group, key = name.split(".", 1)
            res[group][key] = scaled
        for m in ("A", "B"):
            for k in ("poa", "tback", "v", "i"):
                res[m].setdefault(k, None)
        for k in ("ghi", "ta", "rh", "wind", "windDir", "rainRate"):
            res["env"].setdefault(k, None)
        return res
