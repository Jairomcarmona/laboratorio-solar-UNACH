"""Contrato de mensajes v1: esquemas JSON, validación estricta y tópicos MQTT.

Fuente de verdad: server/contract/v1/*.schema.json (draft 2020-12). Tanto el puente como la pasarela y el simulador del
navegador se prueban contra los mismos esquemas y ejemplos.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

VERSION = 1
PREFIX = "labsolar/v1"

# Tópicos internos (relativos a PREFIX/<banco>/), con QoS y retención del plan (sección «Contrato de mensajes v1»)
TOPICS: dict[str, dict[str, Any]] = {
    "tele": {"qos": 0, "retain": False, "publisher": "bridge"},
    "state": {"qos": 1, "retain": True, "publisher": "bridge"},
    "event": {"qos": 1, "retain": False, "publisher": "bridge"},
    "event/gw": {"qos": 1, "retain": False, "publisher": "gateway"},      # eventos propios de la pasarela: tópico aparte para que no pueda suplantar al puente
    "cmd/req": {"qos": 1, "retain": False, "publisher": "gateway"},
    "cmd/ack": {"qos": 1, "retain": False, "publisher": "bridge"},
    "sweep": {"qos": 1, "retain": False, "publisher": "bridge"},
    "twin": {"qos": 0, "retain": False, "publisher": "twin"},
    "hb/gateway": {"qos": 0, "retain": False, "publisher": "gateway"},
}

# Esquema que valida el payload de cada tópico
TOPIC_SCHEMA = {"tele": "tele", "state": "state", "event": "event", "event/gw": "event", "cmd/req": "req", "cmd/ack": "ack",
                "sweep": "sweep", "twin": "twin", "hb/gateway": "hb"}


def topic(bank: str, name: str) -> str:
    if name not in TOPICS:
        raise KeyError(f"tópico desconocido: {name}")
    return f"{PREFIX}/{bank}/{name}"


def contract_dir() -> Path:
    env = os.environ.get("LABSOLAR_CONTRACT_DIR")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for cand in (here.parent.parent / "contract" / "v1", Path("/app/contract/v1"), Path("contract/v1")):
        if cand.is_dir():
            return cand
    raise FileNotFoundError("No se encontró server/contract/v1 (define LABSOLAR_CONTRACT_DIR)")


@lru_cache(maxsize=1)
def _registry() -> Registry:
    reg = Registry()
    for p in sorted(contract_dir().glob("*.schema.json")):
        doc = json.loads(p.read_text(encoding="utf-8"))
        reg = reg.with_resource(doc["$id"], Resource.from_contents(doc, default_specification=DRAFT202012))
    return reg


@lru_cache(maxsize=None)
def validator(name: str) -> Draft202012Validator:
    path = contract_dir() / f"{name}.schema.json"
    schema = json.loads(path.read_text(encoding="utf-8"))
    return Draft202012Validator(schema, registry=_registry())


class ContractError(ValueError):
    def __init__(self, schema: str, errors: list[str]):
        super().__init__(f"{schema}: " + "; ".join(errors[:3]))
        self.schema = schema
        self.errors = errors


def errors(name: str, payload: Any) -> list[str]:
    out = []
    for e in sorted(validator(name).iter_errors(payload), key=lambda e: list(e.absolute_path)):
        loc = "/".join(str(x) for x in e.absolute_path) or "(raíz)"
        out.append(f"{loc}: {e.message}")
    return out


def validate(name: str, payload: Any) -> None:
    errs = errors(name, payload)
    if errs:
        raise ContractError(name, errs)


def is_valid(name: str, payload: Any) -> bool:
    return not errors(name, payload)


def _reject_constant(c: str):
    raise ValueError(f"constante JSON no permitida: {c}")


def loads(text: str | bytes) -> Any:
    """json.loads estricto: rechaza NaN e Infinity (no son JSON) y claves duplicadas."""
    def pairs(items):
        d = {}
        for k, v in items:
            if k in d:
                raise ValueError(f"clave duplicada: {k}")
            d[k] = v
        return d
    return json.loads(text, parse_constant=_reject_constant, object_pairs_hook=pairs)


def dumps(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def ack(cmd_id: str, ts: int, ok: bool = True, kind: str | None = None, reason: str | None = None, field: str | None = None) -> dict:
    a: dict[str, Any] = {"id": cmd_id, "ok": ok, "ts": ts}
    if not ok:
        a["kind"] = kind or "internal"
        a["reason"] = reason or "Rechazado."
        if field:
            a["field"] = field
    return a


def event(ts: int, level: str, src: str, code: str, msg: str, data: dict | None = None) -> dict:
    e: dict[str, Any] = {"ts": ts, "level": level, "src": src, "code": code, "msg": msg}
    if data:
        e["data"] = data
    return e


@lru_cache(maxsize=1)
def cmd_types() -> tuple[frozenset, frozenset]:
    """(admitidos en modo real, rechazados con kind 'unsupported') según defs.schema.json."""
    d = json.loads((contract_dir() / "defs.schema.json").read_text(encoding="utf-8"))["$defs"]
    return frozenset(d["cmdType"]["enum"]), frozenset(d["unsupportedCmdType"]["enum"])
