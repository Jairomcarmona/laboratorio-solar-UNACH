"""Frontera de acople con el hardware real: carga y validación de los archivos de configuración del banco.

Nada de esto cambia la física ni la lógica del puente: solo decide si la configuración está completa y es coherente
antes de arrancar con un PLC o una adquisición reales. Los valores que aún no se conocen se escriben POR_DEFINIR en las
plantillas (deploy/hardware/*.template.yaml) y la validación falla mientras quede alguno.

Modos (clave `mode` de bridge.yaml):
  sim     (o ausente) no se valida nada: banco virtual.
  staged  puesta en marcha por etapas: se valida solo lo que corresponde a las piezas reales (PLC y/o adquisición).
  real    PLC y adquisición reales: se exige todo y ninguna pieza puede ser fake.
"""
from __future__ import annotations

import datetime as dt
import ipaddress
import math
from pathlib import Path
from typing import Any

import yaml

from . import registers as R

PENDING = "POR_DEFINIR"
FILES = {"plc_spec": "plc_spec.yaml", "plc_registers": "plc_registers.yaml", "calibration": "calibration.yaml",
         "load_limits": "load_limits.yaml", "network": "network.yaml"}
CORE_CHANNELS = ["A.v", "A.i", "A.poa", "A.tback", "B.v", "B.i", "B.poa", "B.tback", "env.ghi", "env.ta"]
OPTIONAL_CHANNELS = ["env.rh", "env.wind", "env.windDir", "env.rainRate"]
CHANNEL_TYPES = {"voltage", "thermocouple", "rtd"}
ON_EXCEED = {"open_circuit", "abort_sweep"}


def register_names() -> dict[str, dict[str, int]]:
    """Nombres y direcciones provisionales de registers.py (la plantilla de registros se compara con esto)."""
    ir = {n: v for n, v in vars(R).items() if n.startswith("IR_") and n != "IR_COUNT"}
    hr = {n: v for n, v in vars(R).items() if n.startswith("HR_") and n != "HR_COUNT"}
    return {"input": ir, "holding": hr}


def load_yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _pending_paths(node: Any, prefix: str = "") -> list[str]:
    out: list[str] = []
    if isinstance(node, dict):
        for k, v in node.items():
            out += _pending_paths(v, f"{prefix}{k}." if isinstance(v, (dict, list)) else f"{prefix}{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out += _pending_paths(v, f"{prefix}[{i}].")
    elif node is None or (isinstance(node, str) and (node.strip() == PENDING or not node.strip())):
        out.append(prefix.rstrip("."))
    return out


def _num(v: Any, lo: float | None = None, hi: float | None = None, positive: bool = False) -> bool:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return False
    if positive and v <= 0:
        return False
    return (lo is None or v >= lo) and (hi is None or v <= hi)


def _date(v: Any) -> dt.date | None:
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    try:
        return dt.date.fromisoformat(str(v))
    except ValueError:
        return None


def _ip(v: Any) -> bool:
    try:
        ipaddress.IPv4Address(str(v))
        return True
    except ValueError:
        return False


def _needs(doc: Any, name: str, errs: list[str]) -> dict | None:
    if not isinstance(doc, dict):
        errs.append(f"{FILES[name]}: falta el archivo o no es un diccionario YAML")
        return None
    pend = _pending_paths(doc)
    errs += [f"{FILES[name]}: «{p}» está por definir" for p in pend]
    return None if pend else doc          # con valores pendientes no se revisa el resto: solo añadiría ruido


def check_plc_spec(d: dict, bridge: dict, errs: list[str]) -> None:
    f = "plc_spec.yaml"
    wd, ramps, wind, lim = d.get("watchdog") or {}, d.get("ramps") or {}, d.get("wind") or {}, d.get("limits") or {}
    for key, v in (("watchdog.timeout_s", wd.get("timeout_s")), ("watchdog.heartbeat_period_s", wd.get("heartbeat_period_s")),
                   ("ramps.az_deg_s", ramps.get("az_deg_s")), ("ramps.tilt_deg_s", ramps.get("tilt_deg_s")),
                   ("wind.stow_ms", wind.get("stow_ms")), ("wind.resume_ms", wind.get("resume_ms")), ("wind.resume_hold_s", wind.get("resume_hold_s"))):
        if not _num(v, positive=True):
            errs.append(f"{f}: «{key}» debe ser un número positivo")
    if _num(wind.get("stow_ms"), positive=True) and _num(wind.get("resume_ms"), positive=True) and wind["resume_ms"] >= wind["stow_ms"]:
        errs.append(f"{f}: wind.resume_ms debe ser menor que wind.stow_ms (histéresis de viento)")
    if _num(wd.get("timeout_s"), positive=True) and _num(wd.get("heartbeat_period_s"), positive=True):
        if wd["timeout_s"] < 3 * wd["heartbeat_period_s"]:
            errs.append(f"{f}: watchdog.timeout_s debe ser al menos 3 veces el periodo del latido")
        hb = float(bridge.get("hb_period_s", 1.0))
        if abs(wd["heartbeat_period_s"] - hb) > 1e-9:
            errs.append(f"{f}: watchdog.heartbeat_period_s ({wd['heartbeat_period_s']}) no coincide con hb_period_s del puente ({hb})")
    az, tl = (lim.get("az_min"), lim.get("az_max")), (lim.get("tilt_min"), lim.get("tilt_max"))
    if not all(_num(x, 0, 360) for x in az) or not az[0] < az[1]:
        errs.append(f"{f}: limits.az_min/az_max deben estar en [0, 360] con min < max")
    if not all(_num(x, 0, 90) for x in tl) or not tl[0] < tl[1]:
        errs.append(f"{f}: limits.tilt_min/tilt_max deben estar en [0, 90] con min < max")
    expected = {r.name for r in R.Reject if r != R.Reject.NONE}
    got = d.get("reject_codes") or {}
    if not isinstance(got, dict) or {str(k) for k in got} != {str(int(r)) for r in R.Reject if r != R.Reject.NONE}:
        errs.append(f"{f}: reject_codes debe definir exactamente los códigos 1 a {len(expected)} de registers.Reject")
    faults = d.get("fault_codes")
    if not isinstance(faults, dict) or not faults:
        errs.append(f"{f}: fault_codes debe listar al menos un código de falla con su texto")
    if str(d.get("estop_reset", "")).strip() in ("", PENDING):
        errs.append(f"{f}: estop_reset debe decir quién y cómo restablece el paro")
    if not d.get("signed_off_by") or not _date(d.get("signed_off_date")):
        errs.append(f"{f}: falta signed_off_by / signed_off_date (la especificación la firma la persona responsable de ingeniería)")


def check_registers(d: dict, bridge: dict, errs: list[str]) -> None:
    f = "plc_registers.yaml"
    if d.get("confirmed") is not True:
        errs.append(f"{f}: confirmed debe ser true cuando el mapa coincide con el programa real del PLC")
    if d.get("byte_order") not in ("big", "little") or d.get("word_order") not in ("big", "little"):
        errs.append(f"{f}: byte_order y word_order deben ser big o little")
    if not d.get("confirmed_by") or not _date(d.get("confirmed_date")):
        errs.append(f"{f}: falta confirmed_by / confirmed_date")
    ctl = bridge.get("controller", {})
    for k in ("ir_offset", "hr_offset"):
        if k in d and int(d[k]) != int(ctl.get(k, 0)):
            errs.append(f"{f}: {k} ({d[k]}) no coincide con controller.{k} de bridge.yaml ({ctl.get(k, 0)})")
    prov = register_names()
    for kind, key in (("input", "input_registers"), ("holding", "holding_registers")):
        regs = d.get(key) or {}
        missing = sorted(set(prov[kind]) - set(regs))
        if missing:
            errs.append(f"{f}: en {key} faltan {', '.join(missing)}")
        addrs = [v.get("address") if isinstance(v, dict) else v for v in regs.values()]
        if any(not isinstance(a, int) or isinstance(a, bool) or a < 0 for a in addrs):
            errs.append(f"{f}: {key} tiene direcciones no válidas")
        elif len(set(addrs)) != len(addrs):
            errs.append(f"{f}: {key} tiene direcciones repetidas")
        else:
            drift = [n for n, a in prov[kind].items() if n in regs and (regs[n]["address"] if isinstance(regs[n], dict) else regs[n]) != a]
            if drift:
                errs.append(f"{f}: {', '.join(drift)} difieren de registers.py; el controlador Modbus solo admite un corrimiento constante (ir_offset/hr_offset). "
                            f"Si el PLC real usa otro orden, hay que actualizar server/labsolar/bridge/registers.py y regenerar docs/REGISTROS.md")


def check_calibration(d: dict, daq: dict, bridge: dict, errs: list[str], today: dt.date | None = None) -> None:
    f, today = "calibration.yaml", today or dt.date.today()
    ch = d.get("channels") or {}
    for name in CORE_CHANNELS:
        if name not in ch:
            errs.append(f"{f}: falta el canal obligatorio «{name}»")
    for name, c in ch.items():
        if name not in CORE_CHANNELS + OPTIONAL_CHANNELS:
            errs.append(f"{f}: canal desconocido «{name}»")
            continue
        if not isinstance(c, dict):
            errs.append(f"{f}: el canal «{name}» debe ser un diccionario")
            continue
        if c.get("type", "voltage") not in CHANNEL_TYPES:
            errs.append(f"{f}: «{name}».type debe ser uno de {sorted(CHANNEL_TYPES)}")
        if daq.get("driver") == "nidaqmx" and not str(c.get("phys", "")).strip():
            errs.append(f"{f}: «{name}».phys (canal físico del cDAQ) es obligatorio con nidaqmx")
        if c.get("type", "voltage") == "voltage":
            if not _num(c.get("scale")) or c.get("scale") == 0:
                errs.append(f"{f}: «{name}».scale debe ser un número distinto de cero")
            if not _num(c.get("offset")):
                errs.append(f"{f}: «{name}».offset debe ser un número")
        u = c.get("uncertainty") or {}
        if not _num(u.get("value"), positive=True) or not _num(u.get("coverage_k"), positive=True) or not str(u.get("unit", "")).strip():
            errs.append(f"{f}: «{name}».uncertainty necesita value > 0, coverage_k > 0 y unit")
        cal, due = _date(c.get("cal_date")), _date(c.get("cal_due"))
        if not cal or not due:
            errs.append(f"{f}: «{name}» necesita cal_date y cal_due en formato AAAA-MM-DD")
        else:
            if cal > today:
                errs.append(f"{f}: «{name}».cal_date está en el futuro")
            if due < today:
                errs.append(f"{f}: «{name}» tiene la calibración vencida ({due})")
            if due <= cal:
                errs.append(f"{f}: «{name}».cal_due debe ser posterior a cal_date")
        if not str(c.get("sensor_id", "")).strip() or not str(c.get("cal_certificate", "")).strip():
            errs.append(f"{f}: «{name}» necesita sensor_id y cal_certificate")
    s = d.get("sampling") or {}
    if not _num(s.get("tele_hz"), positive=True) or not _num(s.get("read_hz"), positive=True):
        errs.append(f"{f}: sampling.read_hz y sampling.tele_hz deben ser positivos")
    else:
        if s["read_hz"] < s["tele_hz"]:
            errs.append(f"{f}: sampling.read_hz no puede ser menor que tele_hz")
        period = float(bridge.get("tele_period_s", 1.0))
        if abs(1.0 / s["tele_hz"] - period) > 1e-6:
            errs.append(f"{f}: sampling.tele_hz ({s['tele_hz']}) no coincide con tele_period_s del puente ({period})")
    if s.get("timestamp") not in ("bridge", "device"):
        errs.append(f"{f}: sampling.timestamp debe ser bridge o device")


def check_load(d: dict, bridge: dict, errs: list[str]) -> None:
    f = "load_limits.yaml"
    for k in ("v_max_v", "i_max_a", "p_max_w", "sweep_s_min", "sweep_s_max"):
        if not _num(d.get(k), positive=True):
            errs.append(f"{f}: «{k}» debe ser un número positivo")
    if _num(d.get("sweep_s_min"), positive=True) and _num(d.get("sweep_s_max"), positive=True):
        if d["sweep_s_min"] > d["sweep_s_max"]:
            errs.append(f"{f}: sweep_s_min no puede superar a sweep_s_max")
        sec = float(bridge.get("sweep", {}).get("seconds", 10.0))
        if not d["sweep_s_min"] <= sec <= d["sweep_s_max"]:
            errs.append(f"{f}: sweep.seconds de bridge.yaml ({sec}) queda fuera de [{d['sweep_s_min']}, {d['sweep_s_max']}]")
    if d.get("on_exceed") not in ON_EXCEED:
        errs.append(f"{f}: on_exceed debe ser uno de {sorted(ON_EXCEED)}")
    if not d.get("signed_off_by"):
        errs.append(f"{f}: falta signed_off_by (límites aprobados por ingeniería)")


def check_network(d: dict, bridge: dict, need: set[str], errs: list[str]) -> None:
    f = "network.yaml"
    ips = {}
    for k in ("plc_ip", "cdaq_ip", "cam1_ip", "cam2_ip"):
        if k == "plc_ip" and "plc" not in need or k == "cdaq_ip" and "daq" not in need:
            continue
        if not _ip(d.get(k)):
            errs.append(f"{f}: «{k}» no es una dirección IPv4 válida")
        else:
            ips[k] = d[k]
    if len(set(ips.values())) != len(ips):
        errs.append(f"{f}: hay direcciones IP repetidas")
    for k in ("vlan_field", "vpn"):
        if str(d.get(k, "")).strip() in ("", PENDING):
            errs.append(f"{f}: «{k}» debe describirse (VLAN de campo y acceso remoto)")
    host = bridge.get("controller", {}).get("host")
    if "plc" in need and "plc_ip" in ips and bridge.get("controller", {}).get("driver") == "modbus" and host != ips["plc_ip"]:
        errs.append(f"{f}: plc_ip ({ips['plc_ip']}) no coincide con controller.host de bridge.yaml ({host}); revisa PLC_HOST en .env")


def needs(cfg: dict) -> set[str]:
    mode = cfg.get("mode", "sim")
    if mode == "sim":
        return set()
    n = set()
    if cfg.get("controller", {}).get("driver", "fake") != "fake":
        n.add("plc")
    if cfg.get("daq", {}).get("driver", "fake") != "fake":
        n.add("daq")
    return n


def validate(cfg: dict, hw_dir: Path, today: dt.date | None = None) -> list[str]:
    """Devuelve la lista de problemas (vacía si el banco puede arrancar en el modo pedido)."""
    mode = cfg.get("mode", "sim")
    if mode not in ("sim", "staged", "real"):
        return [f"mode debe ser sim, staged o real (es {mode!r})"]
    if mode == "sim":
        return []
    errs: list[str] = []
    need = needs(cfg)
    if mode == "real":
        for part, key in (("controller", "plc"), ("daq", "daq")):
            if cfg.get(part, {}).get("driver", "fake") == "fake":
                errs.append(f"mode real exige {part}.driver real (no fake)")
        bus = cfg.get("bus", {})
        if bus.get("kind", "mqtt") != "mqtt" or not bus.get("tls"):
            errs.append("mode real exige bus.kind mqtt con tls: true")
    if not need:
        return errs or ["mode staged sin ninguna pieza real: usa mode sim"]
    docs: dict[str, Any] = {}
    wanted = {"network"} | ({"plc_spec", "plc_registers", "load_limits"} if "plc" in need else set()) | ({"calibration"} if "daq" in need else set())
    for name in sorted(wanted):
        p = hw_dir / FILES[name]
        docs[name] = _needs(load_yaml(p) if p.is_file() else None, name, errs)
    if docs.get("plc_spec"):
        check_plc_spec(docs["plc_spec"], cfg, errs)
    if docs.get("plc_registers"):
        check_registers(docs["plc_registers"], cfg, errs)
    if docs.get("load_limits"):
        check_load(docs["load_limits"], cfg, errs)
    if docs.get("calibration"):
        check_calibration(docs["calibration"], cfg.get("daq", {}), cfg, errs, today)
    if docs.get("network"):
        check_network(docs["network"], cfg, need, errs)
    return errs


def daq_channels(cfg: dict, hw_dir: Path) -> dict[str, dict]:
    """Canales de nidaqmx desde calibration.yaml (escala y desfase); así hay una sola fuente de calibración."""
    ch = (load_yaml(hw_dir / FILES["calibration"]) or {}).get("channels", {})
    keep = ("phys", "type", "scale", "offset", "tc", "min", "max")
    return {n: {k: v for k, v in c.items() if k in keep} for n, c in ch.items()}
