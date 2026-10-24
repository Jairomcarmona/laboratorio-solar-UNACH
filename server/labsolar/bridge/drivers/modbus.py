"""Controlador Modbus TCP (pymodbus 3.11+). Funciona contra el banco virtual y contra cualquier PLC con el mapa de registers.py.

Para un PLC concreto (p. ej. Siemens S7-1200) se cambian las direcciones en registers.py o en el YAML ('offsets'); la lógica no cambia.
"""
from __future__ import annotations

import asyncio
import logging

from .. import registers as R
from .base import RegisterController

log = logging.getLogger("labsolar.bridge.modbus")


class ModbusController(RegisterController):
    name = "modbus"

    def __init__(self, host: str, port: int = 502, unit: int = R.UNIT, timeout: float = 1.0, ir_offset: int = 0, hr_offset: int = 0) -> None:
        super().__init__()
        self.host, self.port, self.unit, self.timeout = host, port, unit, timeout
        self.ir_offset, self.hr_offset = ir_offset, hr_offset
        self._client = None
        self._lock = asyncio.Lock()

    async def connect(self) -> None:
        from pymodbus.client import AsyncModbusTcpClient
        self._client = AsyncModbusTcpClient(self.host, port=self.port, timeout=self.timeout, retries=1)
        await self._client.connect()

    async def close(self) -> None:
        if self._client:
            self._client.close()

    async def _ensure(self) -> None:
        if self._client is None or not self._client.connected:
            await self.connect()

    async def _read_ir(self) -> list[int]:
        async with self._lock:
            await self._ensure()
            rr = await self._client.read_input_registers(self.ir_offset, count=R.IR_COUNT, device_id=self.unit)
            if rr.isError():
                raise ConnectionError(f"Modbus: error al leer registros de entrada: {rr}")
            return list(rr.registers)

    async def _write_hr(self, address: int, values: list[int]) -> None:
        async with self._lock:
            await self._ensure()
            wr = await self._client.write_registers(self.hr_offset + address, values, device_id=self.unit)
            if wr.isError():
                raise ConnectionError(f"Modbus: error al escribir registros de retención: {wr}")
