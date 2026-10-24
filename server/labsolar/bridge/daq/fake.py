from __future__ import annotations

import asyncio
from typing import Any

from ..fakebank import FakeBank
from .base import DaqDriver


class FakeDaq(DaqDriver):
    name = "fake"

    def __init__(self, bank: FakeBank, latency_ms: float | None = None) -> None:
        self.bank = bank
        self.latency_ms = bank.cfg["latency_ms"] if latency_ms is None else latency_ms

    async def read(self) -> dict[str, Any]:
        if self.latency_ms:
            await asyncio.sleep(self.latency_ms / 1000.0)
        return self.bank.read_daq()
