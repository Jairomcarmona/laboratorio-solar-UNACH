"""Genera contract/v1/examples/{valid,invalid}/*.json a partir de casos escritos aquí (se versionan; la prueba test_contract_examples los valida).

Uso: python tools/gen_examples.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

OUT = ROOT / "contract" / "v1" / "examples"
T0 = 1_792_825_800_000


def cmd(type_, args=None, **extra):
    d = {"t": "cmd", "v": 1, "id": "c1", "type": type_, **({"args": args} if args is not None else {})}
    d.update(extra)
    return d


VALID_CMDS = {
    "session.start": {"role": "student", "user": "ana", "profileId": "p1"}, "session.end": {"why": "fin de práctica"}, "acq.start": {}, "acq.stop": {"reason": "listo"},
    "acq.newRun": {"label": "B1 mañana", "practiceId": "b1"}, "tracker.target": {"az": 180, "tilt": 20}, "tracker.mode": {"mode": "astro"},
    "tracker.locks": {"lockAz": True, "lockTilt": False}, "load.set": {"mode": "cr", "setpoint": 3.4}, "load.sweep": {}, "load.sweep.abort": {}, "safety.estop": {"who": "ana"},
    "safety.ack": {},
}

# 17 comandos inválidos: (nombre, mensaje)
INVALID_CMDS = [
    ("tipo_desconocido", cmd("tracker.explode", {})),
    ("sin_id", {"t": "cmd", "v": 1, "type": "safety.ack"}),
    ("id_vacio", cmd("safety.ack", {}, id="")),
    ("id_demasiado_largo", cmd("safety.ack", {}, id="x" * 65)),
    ("version_incorrecta", cmd("safety.ack", {}, v=2)),
    ("campo_extra_en_el_comando", cmd("safety.ack", {}, role="teacher")),
    ("campo_extra_en_args", cmd("tracker.target", {"az": 180, "extra": 1})),
    ("azimut_fuera_de_rango", cmd("tracker.target", {"az": 400})),
    ("inclinacion_negativa", cmd("tracker.target", {"tilt": -1})),
    ("target_sin_ejes", cmd("tracker.target", {})),
    ("azimut_texto", cmd("tracker.target", {"az": "180"})),
    ("modo_seguidor_desconocido", cmd("tracker.mode", {"mode": "turbo"})),
    ("carga_modo_desconocido", cmd("load.set", {"mode": "ohm"})),
    ("carga_consigna_fuera_de_rango", cmd("load.set", {"mode": "cr", "setpoint": 1000})),
    ("rol_desconocido", cmd("session.start", {"role": "hacker"})),
    ("sesion_sin_rol", cmd("session.start", {})),
    ("bloqueos_no_booleanos", cmd("tracker.locks", {"lockAz": "si"})),
]


def write(kind: str, name: str, obj) -> None:
    d = OUT / kind
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{name}.json").write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> None:
    for k in ("valid", "invalid"):
        for f in (OUT / k).glob("*.json"):
            f.unlink()
    for t, a in VALID_CMDS.items():
        write("valid", "cmd_" + t.replace(".", "_"), cmd(t, a))
    write("valid", "cmd_sin_args", cmd("safety.ack"))
    for n, m in INVALID_CMDS:
        write("invalid", "cmd_" + n, m)
    write("valid", "ack_ok", {"id": "c1", "ok": True, "ts": T0})
    write("valid", "ack_rechazo", {"id": "c1", "ok": False, "ts": T0, "kind": "interlock", "reason": "Azimut fuera de rango", "field": "az"})
    write("valid", "event", {"ts": T0, "level": "warn", "src": "bridge", "code": "wind.stow", "msg": "Viento alto: posición segura"})
    write("valid", "req", {"id": "c1", "ts": T0, "sessionId": "ses_1", "user": "ana", "role": "student", "type": "tracker.target", "args": {"az": 180}})
    write("valid", "hb", {"ts": T0, "sessionId": None})
    write("valid", "twin", {"ts": T0, "A": {"pExp": 250.0, "res": -3.0, "resPct": -1.2}, "B": {"pExp": None, "res": None, "resPct": None}, "flags": ["underperform_B"]})
    write("invalid", "ack_sin_ok", {"id": "c1", "ts": T0})
    write("invalid", "event_nivel_desconocido", {"ts": T0, "level": "panic", "src": "bridge", "code": "x", "msg": "x"})
    write("invalid", "req_sin_sesion", {"id": "c1", "ts": T0, "user": "ana", "role": "student", "type": "safety.ack"})
    write("invalid", "twin_campo_extra", {"ts": T0, "A": {"pExp": 1, "res": 1, "resPct": 1, "x": 1}, "B": {"pExp": 1, "res": 1, "resPct": 1}, "flags": []})
    print("ejemplos escritos en", OUT)


if __name__ == "__main__":
    main()
