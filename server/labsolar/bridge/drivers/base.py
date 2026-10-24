"""Interfaces de los controladores de campo (S21). Cada una tiene una implementación fake y una real.

ControllerDriver  : PLC (seguidor, seguridad, carga). Implementaciones: fake (directo), modbus (TCP), opcua.
El puente NUNCA decide seguridad más allá de rechazar: el PLC valida de nuevo y es el único que puede mover los ejes.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any

from .. import registers as R


@dataclass
class PlcState:
    az: float
    tilt: float
    target_az: float
    target_tilt: float
    state: str                       # NORMAL | WIND_STOW | COMMS_STOW | ESTOP | FAULT
    applied_mode: str                # manual | astro | sensor | fixed | night | stow | estop
    moving_az: bool = False
    moving_tilt: bool = False
    lock_az: bool = False
    lock_tilt: bool = False
    limit_az: int = 0                # -1 mínimo, 0 libre, 1 máximo
    limit_tilt: int = 0
    fault_code: int = 0
    wind: float | None = None
    cmd_seq_echo: int = 0
    reject_code: int = 0
    limits: dict[str, float] = field(default_factory=dict)       # copia de SOLO LECTURA de los límites del PLC
    load_mode: str = "mppt"
    load_setpoint: float | None = None
    hb_echo: int = 0


@dataclass
class Request:
    az: float | None = None
    tilt: float | None = None
    mode: str | None = None
    locks: tuple[bool, bool] | None = None
    stop: bool = False
    ack: bool = False
    link_lost: bool = False

    def empty(self) -> bool:
        return not (self.az is not None or self.tilt is not None or self.mode or self.locks or self.stop or self.ack or self.link_lost)


@dataclass
class Result:
    ok: bool
    reject_code: int = 0
    reason: str = ""
    timeout: bool = False

    @property
    def kind(self) -> str:
        return "ok" if self.ok else ("timeout" if self.timeout else "interlock")


def result_from_reject(code: int) -> Result:
    if code == 0:
        return Result(True)
    try:
        r = R.Reject(code)
        return Result(False, code, R.REJECT_TEXT.get(r, f"Rechazado por el PLC (código {code})."))
    except ValueError:
        return Result(False, code, f"Rechazado por el PLC (código {code}).")


class ControllerDriver(abc.ABC):
    name = "base"

    async def connect(self) -> None: ...
    async def close(self) -> None: ...

    @abc.abstractmethod
    async def read_state(self) -> PlcState: ...

    @abc.abstractmethod
    async def send_request(self, req: Request, timeout: float = 2.0) -> Result:
        """Escribe la solicitud, espera el eco de secuencia (hasta 'timeout') y devuelve lo que decidió el PLC."""

    @abc.abstractmethod
    async def heartbeat(self) -> None:
        """Alterna el registro de latido hacia el PLC."""

    @abc.abstractmethod
    async def set_load(self, mode: str, setpoint: float | None) -> None: ...

    # --- interfaz del plan, sobre send_request
    async def write_targets(self, az: float | None, tilt: float | None) -> Result:
        return await self.send_request(Request(az=az, tilt=tilt))

    async def set_mode(self, mode: str) -> Result:
        return await self.send_request(Request(mode=mode))

    async def set_locks(self, lock_az: bool, lock_tilt: bool) -> Result:
        return await self.send_request(Request(locks=(lock_az, lock_tilt)))

    async def request_stop(self) -> Result:
        return await self.send_request(Request(stop=True))

    async def request_ack(self) -> Result:
        return await self.send_request(Request(ack=True))

    async def request_link_lost(self) -> Result:
        return await self.send_request(Request(link_lost=True))


def state_from_registers(ir: list[int]) -> PlcState:
    fl = ir[R.IR_FLAGS]
    state = R.STATE_NAMES[ir[R.IR_STATE]] if ir[R.IR_STATE] < len(R.STATE_NAMES) else "FAULT"
    mode = R.MODE_NAMES[ir[R.IR_APPLIED_MODE]] if ir[R.IR_APPLIED_MODE] < len(R.MODE_NAMES) else "manual"
    lm = R.LOAD_MODES[ir[R.IR_LOAD_MODE]] if ir[R.IR_LOAD_MODE] < len(R.LOAD_MODES) else "mppt"
    return PlcState(
        az=R.from_raw(ir[R.IR_AZ]), tilt=R.from_raw(ir[R.IR_TILT]),
        target_az=R.from_raw(ir[R.IR_TARGET_AZ]), target_tilt=R.from_raw(ir[R.IR_TARGET_TILT]),
        state=state, applied_mode=mode,
        moving_az=R.flag(fl, R.Flag.MOVING_AZ), moving_tilt=R.flag(fl, R.Flag.MOVING_TILT),
        lock_az=R.flag(fl, R.Flag.LOCK_AZ), lock_tilt=R.flag(fl, R.Flag.LOCK_TILT),
        limit_az=-1 if R.flag(fl, R.Flag.LIMIT_AZ_MIN) else 1 if R.flag(fl, R.Flag.LIMIT_AZ_MAX) else 0,
        limit_tilt=-1 if R.flag(fl, R.Flag.LIMIT_TILT_MIN) else 1 if R.flag(fl, R.Flag.LIMIT_TILT_MAX) else 0,
        fault_code=ir[R.IR_FAULT_CODE], wind=R.from_raw(ir[R.IR_WIND]),
        cmd_seq_echo=ir[R.IR_CMD_SEQ_ECHO], reject_code=ir[R.IR_REJECT_CODE],
        limits={"azMin": R.from_raw(ir[R.IR_AZ_MIN]), "azMax": R.from_raw(ir[R.IR_AZ_MAX]),
                "tiltMin": R.from_raw(ir[R.IR_TILT_MIN]), "tiltMax": R.from_raw(ir[R.IR_TILT_MAX])},
        load_mode=lm, load_setpoint=ir[R.IR_LOAD_SETPOINT] / 1000.0, hb_echo=ir[R.IR_HB_ECHO])


class RegisterController(ControllerDriver):
    """Lógica común de los controladores con mapa de registros (fake directo y Modbus TCP)."""

    def __init__(self) -> None:
        self._seq = 0
        self._hb = 0
        self._load_seq = 0

    @abc.abstractmethod
    async def _read_ir(self) -> list[int]: ...

    @abc.abstractmethod
    async def _write_hr(self, address: int, values: list[int]) -> None: ...

    async def read_state(self) -> PlcState:
        return state_from_registers(await self._read_ir())

    async def heartbeat(self) -> None:
        self._hb = (self._hb + 1) & 0xFFFF or 1
        await self._write_hr(R.HR_HB, [self._hb])

    async def set_load(self, mode: str, setpoint: float | None) -> None:
        self._load_seq = (self._load_seq + 1) & 0xFFFF or 1
        sp = int(round((setpoint if setpoint is not None else 0.0) * 1000))
        await self._write_hr(R.HR_LOAD_MODE, [R.LOAD_MODES.index(mode), max(0, min(65535, sp)), self._load_seq])

    async def send_request(self, req: Request, timeout: float = 2.0) -> Result:
        import asyncio
        if req.empty():
            return Result(True)
        mask = 0
        az = tilt = 0.0
        mode = 0
        locks = 0
        if req.az is not None:
            mask |= R.REQ_AZ; az = req.az
        if req.tilt is not None:
            mask |= R.REQ_TILT; tilt = req.tilt
        if req.mode is not None:
            if req.mode not in R.TRACKER_MODES:
                return Result(False, int(R.Reject.BAD_VALUE), R.REJECT_TEXT[R.Reject.BAD_VALUE])
            mask |= R.REQ_MODE; mode = R.TRACKER_MODES.index(req.mode)
        if req.locks is not None:
            mask |= R.REQ_LOCKS; locks = (1 if req.locks[0] else 0) | (2 if req.locks[1] else 0)
        if req.stop:
            mask |= R.REQ_STOP
        if req.ack:
            mask |= R.REQ_ACK
        if req.link_lost:
            mask |= R.REQ_LINK_LOST
        if not (0 <= az <= 655.35 and 0 <= tilt <= 655.35):
            return Result(False, int(R.Reject.BAD_VALUE), R.REJECT_TEXT[R.Reject.BAD_VALUE])
        self._seq = (self._seq + 1) & 0xFFFF or 1
        seq = self._seq
        # campos primero, secuencia al final: el PLC actúa cuando cambia HR_CMD_SEQ
        await self._write_hr(R.HR_REQ_AZ, [R.to_raw(az), R.to_raw(tilt), mask, mode, locks])
        await self._write_hr(R.HR_CMD_SEQ, [seq])
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            st = await self.read_state()
            if st.cmd_seq_echo == seq:
                return result_from_reject(st.reject_code)
            if loop.time() >= deadline:
                return Result(False, 0, "El PLC no confirmó la orden a tiempo.", timeout=True)
            await asyncio.sleep(0.05)
