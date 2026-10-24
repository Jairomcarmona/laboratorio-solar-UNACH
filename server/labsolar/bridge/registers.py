"""Mapa de registros PROVISIONAL del PLC (Modbus TCP, unidad 1). Ver server/bridge/REGISTROS.md.

La especificación definitiva la entrega O5 (control y seguridad para el PLC) y la firma el ingeniero responsable. Hasta
entonces el banco virtual y el controlador Modbus usan este mapa; cambiar de PLC (S7-1200 u otro) es cambiar este
archivo o el YAML de direcciones, no el puente.

Tipos: enteros de 16 bits sin signo. Ángulos y velocidades en centésimas (×100). Las escrituras que el PLC rechaza se
reportan en REJECT_CODE junto con CMD_SEQ_ECHO.
"""
from __future__ import annotations

from enum import IntEnum

UNIT = 1
SCALE_ANGLE = 100.0

# ---- registros de entrada (FC4, solo lectura desde el puente)
IR_HB_ECHO = 0
IR_STATE = 1
IR_APPLIED_MODE = 2
IR_AZ = 3
IR_TILT = 4
IR_TARGET_AZ = 5
IR_TARGET_TILT = 6
IR_FLAGS = 7
IR_FAULT_CODE = 8
IR_WIND = 9
IR_CMD_SEQ_ECHO = 10
IR_AZ_MIN = 11
IR_AZ_MAX = 12
IR_TILT_MIN = 13
IR_TILT_MAX = 14
IR_REJECT_CODE = 15
IR_LOAD_MODE = 16
IR_LOAD_SETPOINT = 17
IR_SWEEP_STATE = 18
IR_COUNT = 24

# ---- registros de retención (FC3/FC6/FC16, escritos por el puente)
HR_HB = 0
HR_CMD_SEQ = 1
HR_REQ_AZ = 2
HR_REQ_TILT = 3
HR_REQ_MASK = 4
HR_REQ_MODE = 5
HR_REQ_LOCKS = 6
HR_LOAD_MODE = 10
HR_LOAD_SETPOINT = 11
HR_LOAD_SEQ = 12         # el PLC aplica la carga solo cuando este contador cambia
HR_COUNT = 16


# Máscara de campos válidos en una solicitud (HR_REQ_MASK): el puente escribe los campos y luego incrementa HR_CMD_SEQ
REQ_AZ = 1 << 0
REQ_TILT = 1 << 1
REQ_MODE = 1 << 2
REQ_LOCKS = 1 << 3
REQ_STOP = 1 << 4        # paro por software (el paro físico es el botón y no pasa por aquí)
REQ_ACK = 1 << 5         # reconocer falla de enlace
REQ_LINK_LOST = 1 << 6   # el puente perdió a la pasarela: el PLC aplica su modo de pérdida de enlace


class State(IntEnum):
    NORMAL = 0
    WIND_STOW = 1
    COMMS_STOW = 2
    ESTOP = 3
    FAULT = 4


class Mode(IntEnum):
    manual = 0
    astro = 1
    sensor = 2
    fixed = 3
    night = 4
    stow = 5
    estop = 6


class Flag(IntEnum):
    MOVING_AZ = 0
    MOVING_TILT = 1
    LOCK_AZ = 2
    LOCK_TILT = 3
    LIMIT_AZ_MIN = 4
    LIMIT_AZ_MAX = 5
    LIMIT_TILT_MIN = 6
    LIMIT_TILT_MAX = 7
    ESTOP = 8
    WIND_STOW = 9
    COMMS_STOW = 10


class Reject(IntEnum):
    NONE = 0
    AZ_RANGE = 1
    TILT_RANGE = 2
    ESTOP = 3
    WIND_STOW = 4
    COMMS_STOW = 5
    LOCKED_AXIS = 6
    BAD_VALUE = 7


REJECT_TEXT = {
    Reject.AZ_RANGE: "Azimut fuera del rango autorizado por el controlador.",
    Reject.TILT_RANGE: "Inclinación fuera del rango autorizado por el controlador.",
    Reject.ESTOP: "Paro de emergencia activo: solo el personal en sitio puede restablecerlo.",
    Reject.WIND_STOW: "Posición segura por viento activa.",
    Reject.COMMS_STOW: "Posición segura por pérdida de enlace.",
    Reject.LOCKED_AXIS: "El eje está inmovilizado.",
    Reject.BAD_VALUE: "Valor no válido para el controlador.",
}

LOAD_MODES = ["mppt", "cv", "cr", "oc", "sc"]
TRACKER_MODES = ["manual", "astro", "sensor", "fixed"]
MODE_NAMES = [m.name for m in Mode]
STATE_NAMES = [s.name for s in State]


def to_raw(deg: float) -> int:
    return max(0, min(65535, int(round(deg * SCALE_ANGLE))))


def from_raw(raw: int) -> float:
    return raw / SCALE_ANGLE


def flag(flags: int, f: Flag) -> bool:
    return bool(flags >> int(f) & 1)


def pack_flags(**kw: bool) -> int:
    v = 0
    for name, on in kw.items():
        if on:
            v |= 1 << int(Flag[name.upper()])
    return v
