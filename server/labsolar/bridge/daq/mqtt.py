"""Adquisición por MQTT: un concentrador de campo (PLC, pasarela IoT, estación) publica las medidas y el puente las lee.

Tópico: el que permite la ACL de Mosquitto, labsolar/v1/<banco>/daq/<nombre> (p. ej. labsolar/v1/lab1/daq/cdaq), publicado por el usuario 'daq'
con el mismo diccionario que devuelve DaqDriver.read(). En bridge.yaml: daq: {driver: mqtt, topic: labsolar/v1/lab1/daq/cdaq}.
Si la última lectura es más vieja que max_age_s, read() levanta TimeoutError y el puente marca la muestra como 'stale'.
"""
from __future__ import annotations

import time
from typing import Any

from ...bus import Bus
from .base import DaqDriver


class MqttDaq(DaqDriver):
    name = "mqtt"

    def __init__(self, bus: Bus, topic: str, max_age_s: float = 3.0) -> None:
        self.bus, self.topic, self.max_age_s = bus, topic, max_age_s
        self._last: dict | None = None
        self._at = 0.0
        self._sub = None

    async def connect(self) -> None:
        self._sub = self.bus.subscribe(self.topic)

    async def close(self) -> None:
        if self._sub:
            self._sub.close()

    def _drain(self) -> None:
        while not self._sub.queue.empty():
            _, payload = self._sub.queue.get_nowait()
            if isinstance(payload, dict) and "A" in payload and "B" in payload:
                self._last, self._at = payload, time.monotonic()

    async def read(self) -> dict[str, Any]:
        self._drain()
        if self._last is None or time.monotonic() - self._at > self.max_age_s:
            raise TimeoutError("sin medidas recientes por MQTT")
        d = self._last
        d.setdefault("env", {})
        return d
