"""Interfaz de adquisición (V, I, G, temperaturas, estación). Implementaciones: fake, nidaqmx, mqtt."""
from __future__ import annotations

import abc
from typing import Any


class DaqDriver(abc.ABC):
    name = "base"

    async def connect(self) -> None: ...
    async def close(self) -> None: ...

    @abc.abstractmethod
    async def read(self) -> dict[str, Any]:
        """Devuelve {A:{poa,tback,v,i}, B:{...}, env:{ghi?,ta,rh,wind,windDir,rainRate}}; lo que no se mide es None.
        Levanta TimeoutError/ConnectionError si no hay lectura (el puente marca la muestra como 'stale')."""
