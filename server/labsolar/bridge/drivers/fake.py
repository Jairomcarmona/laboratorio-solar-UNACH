"""Controlador fake: habla directamente con FakeBank por los mismos registros que el controlador Modbus (sin red)."""
from __future__ import annotations

from .. import registers as R
from ..fakebank import FakeBank
from .base import RegisterController


class FakeController(RegisterController):
    name = "fake"

    def __init__(self, bank: FakeBank) -> None:
        super().__init__()
        self.bank = bank
        self._hr = [0] * R.HR_COUNT

    async def _read_ir(self) -> list[int]:
        return self.bank.input_registers()

    async def _write_hr(self, address: int, values: list[int]) -> None:
        for k, v in enumerate(values):
            self._hr[address + k] = int(v) & 0xFFFF
        self.bank.on_holding_write(self._hr)
