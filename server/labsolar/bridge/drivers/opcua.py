"""Controlador OPC UA (asyncua). Los nodos se mapean a los mismos registros lógicos de registers.py.

Config: ir_nodes / hr_nodes = {índice_de_registro: {"node": "ns=2;s=...", "scale": 0.01}}; valor_ingeniería = crudo * scale.
Un PLC con servidor OPC UA (Siemens S7-1200 con firmware >= 4.4 o S7-1500) expone variables en unidades de ingeniería; la escala las
vuelve a los enteros del mapa común, de modo que la lógica de ack/rechazo es idéntica a la del controlador Modbus.
"""
from __future__ import annotations

import asyncio
import logging

from .. import registers as R
from .base import RegisterController

log = logging.getLogger("labsolar.bridge.opcua")

# escalas por defecto: ángulos y viento en grados/m/s (crudo en centésimas), el resto enteros
_ANGLE_IR = {R.IR_AZ, R.IR_TILT, R.IR_TARGET_AZ, R.IR_TARGET_TILT, R.IR_WIND, R.IR_AZ_MIN, R.IR_AZ_MAX, R.IR_TILT_MIN, R.IR_TILT_MAX}
_ANGLE_HR = {R.HR_REQ_AZ, R.HR_REQ_TILT}
_NAMES_IR = {v: k[3:].lower() for k, v in vars(R).items() if k.startswith("IR_") and k != "IR_COUNT"}
_NAMES_HR = {v: k[3:].lower() for k, v in vars(R).items() if k.startswith("HR_") and k != "HR_COUNT"}


def default_nodes(namespace: int = 2) -> tuple[dict, dict]:
    """Mapa por omisión ns=<namespace>;s=Lab.in.<nombre> (lectura) y Lab.out.<nombre> (escritura). Cada instalación lo sustituye por sus nodos reales."""
    ir = {i: {"node": f"ns={namespace};s=Lab.in.{n}", "scale": 0.01 if i in _ANGLE_IR else 1.0} for i, n in _NAMES_IR.items()}
    hr = {i: {"node": f"ns={namespace};s=Lab.out.{n}", "scale": 0.01 if i in _ANGLE_HR else 1.0} for i, n in _NAMES_HR.items()}
    return ir, hr


class OpcUaController(RegisterController):
    name = "opcua"

    def __init__(self, url: str, ir_nodes: dict | None = None, hr_nodes: dict | None = None, timeout: float = 2.0,
                 username: str | None = None, password: str | None = None) -> None:
        super().__init__()
        d_ir, d_hr = default_nodes()
        self.url, self.timeout, self.username, self.password = url, timeout, username, password
        self.ir_nodes = {int(k): v for k, v in (ir_nodes or d_ir).items()}
        self.hr_nodes = {int(k): v for k, v in (hr_nodes or d_hr).items()}
        self._client = None
        self._nodes: dict[str, object] = {}

    async def connect(self) -> None:
        from asyncua import Client
        self._client = Client(self.url, timeout=self.timeout)
        if self.username:
            self._client.set_user(self.username)
            self._client.set_password(self.password or "")
        await self._client.connect()
        self._vtypes: dict[str, object] = {}
        for spec in list(self.ir_nodes.values()) + list(self.hr_nodes.values()):
            self._nodes[spec["node"]] = self._client.get_node(spec["node"])
        for spec in self.hr_nodes.values():          # el tipo del nodo lo manda el PLC: se escribe con ese mismo tipo
            self._vtypes[spec["node"]] = await self._nodes[spec["node"]].read_data_type_as_variant_type()

    async def close(self) -> None:
        if self._client:
            await self._client.disconnect()

    async def _read_ir(self) -> list[int]:
        out = [0] * R.IR_COUNT
        keys = list(self.ir_nodes)
        vals = await self._client.read_values([self._nodes[self.ir_nodes[k]["node"]] for k in keys])
        for k, v in zip(keys, vals):
            out[k] = int(round(float(v) / self.ir_nodes[k]["scale"])) & 0xFFFF
        return out

    async def _write_hr(self, address: int, values: list[int]) -> None:
        from asyncua import ua
        for k, v in enumerate(values):
            spec = self.hr_nodes.get(address + k)
            if spec is None:
                continue
            node, vt = self._nodes[spec["node"]], self._vtypes[spec["node"]]
            eng = float(v) * spec["scale"]
            integer = vt in (ua.VariantType.Int16, ua.VariantType.UInt16, ua.VariantType.Int32, ua.VariantType.UInt32,
                             ua.VariantType.Int64, ua.VariantType.UInt64, ua.VariantType.Byte, ua.VariantType.SByte)
            await node.write_value(ua.DataValue(ua.Variant(int(round(eng)) if integer else eng, vt)))
