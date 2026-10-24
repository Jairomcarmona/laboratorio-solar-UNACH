"""Prueba de contrato de la frontera de acople: modo real/staged, plantillas de hardware, ACL y etiqueta de origen (H1, H2)."""
import copy
import datetime as dt
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from labsolar import contract
from labsolar.bridge import hardware as H
from labsolar.bridge import registers as R
from labsolar.bridge.app import BridgeApp, BridgeConfig
from labsolar.bridge.main import run

DEPLOY = Path(__file__).resolve().parent.parent / "deploy"
HW = DEPLOY / "hardware"
TODAY = dt.date(2026, 10, 24)


def dump(d: Path, name: str, doc: dict) -> None:
    (d / H.FILES[name]).write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")


def channel(**kw):
    c = {"phys": "cDAQ1Mod1/ai0", "type": "voltage", "scale": 2.0, "offset": 0.0, "unit": "V",
         "uncertainty": {"value": 0.05, "coverage_k": 2, "unit": "V"}, "sensor_id": "S1", "cal_certificate": "C-1",
         "cal_date": "2026-01-10", "cal_due": "2099-01-10"}
    c.update(kw)
    return c


def good_docs() -> dict:
    """Juego completo y coherente con valores de PRUEBA (no son datos del banco)."""
    prov = H.register_names()
    regs = lambda d: {n: {"address": a, "type": "uint16"} for n, a in d.items()}      # noqa: E731
    return {
        "plc_spec": {"plc": {"model": "m", "firmware": "1"}, "watchdog": {"heartbeat_period_s": 1.0, "timeout_s": 5.0},
                     "ramps": {"az_deg_s": 2.0, "tilt_deg_s": 2.0}, "limits": {"az_min": 90, "az_max": 270, "tilt_min": 0, "tilt_max": 80},
                     "wind": {"stow_ms": 12.0, "resume_ms": 9.0, "resume_hold_s": 30.0}, "restart_behavior": "posición segura", "estop_reset": "técnico con llave",
                     "reject_codes": {i: "t" for i in range(1, 8)}, "fault_codes": {1: "x"}, "signed_off_by": "Ing. X", "signed_off_date": "2026-10-01"},
        "plc_registers": {"confirmed": True, "confirmed_by": "Ing. X", "confirmed_date": "2026-10-01", "ir_offset": 0, "hr_offset": 0,
                          "byte_order": "big", "word_order": "big", "input_registers": regs(prov["input"]), "holding_registers": regs(prov["holding"])},
        "calibration": {"sampling": {"read_hz": 10, "tele_hz": 1, "timestamp": "bridge"},
                        "channels": {n: channel() for n in H.CORE_CHANNELS if "tback" not in n}
                        | {n: {k: v for k, v in channel(type="thermocouple", tc="K").items() if k not in ("scale", "offset")} for n in H.CORE_CHANNELS if "tback" in n}},
        "load_limits": {"v_max_v": 50, "i_max_a": 12, "p_max_w": 400, "sweep_s_min": 5, "sweep_s_max": 60, "on_exceed": "open_circuit", "signed_off_by": "Ing. X"},
        "network": {"plc_ip": "192.168.50.10", "cdaq_ip": "192.168.50.11", "cam1_ip": "192.168.60.11", "cam2_ip": "192.168.60.12",
                    "vlan_field": "VLAN 50", "vpn": "WireGuard"},
    }


REAL = {"mode": "real", "bank": "t", "tele_period_s": 1.0, "bus": {"kind": "mqtt", "tls": True},
        "controller": {"driver": "modbus", "host": "192.168.50.10", "ir_offset": 0, "hr_offset": 0},
        "daq": {"driver": "nidaqmx"}}


@pytest.fixture
def hw(tmp_path):
    docs = good_docs()
    for n, d in docs.items():
        dump(tmp_path, n, d)
    return tmp_path, docs


def problems(tmp, cfg=REAL):
    return H.validate(cfg, tmp, TODAY)


def test_juego_completo_y_coherente_pasa(hw):
    assert problems(hw[0]) == []


def test_plantillas_son_yaml_y_todo_lo_desconocido_esta_marcado():
    for n, f in H.FILES.items():
        doc = yaml.safe_load((HW / f.replace(".yaml", ".template.yaml")).read_text(encoding="utf-8"))
        assert H._pending_paths(doc), f"{f}: la plantilla no debe traer valores inventados"


def test_plantilla_de_registros_igual_a_registers_py():
    t = yaml.safe_load((HW / "plc_registers.template.yaml").read_text(encoding="utf-8"))
    prov = H.register_names()
    assert {n: v["address"] for n, v in t["input_registers"].items()} == prov["input"]
    assert {n: v["address"] for n, v in t["holding_registers"].items()} == prov["holding"]
    assert t["confirmed"] is False


def test_con_las_plantillas_sin_llenar_el_modo_real_falla(tmp_path):
    for f in H.FILES.values():
        (tmp_path / f).write_text((HW / f.replace(".yaml", ".template.yaml")).read_text(encoding="utf-8"), encoding="utf-8")
    errs = problems(tmp_path)
    for f in H.FILES.values():
        assert any(e.startswith(f) and "por definir" in e for e in errs), f


def test_falta_un_archivo_es_error(hw):
    (hw[0] / "calibration.yaml").unlink()
    assert any("calibration.yaml" in e for e in problems(hw[0]))


CASES = {
    "falta canal obligatorio": ("calibration", lambda d: d["channels"].pop("A.poa"), "A.poa"),
    "escala cero": ("calibration", lambda d: d["channels"]["A.v"].update(scale=0), "scale"),
    "calibración vencida": ("calibration", lambda d: d["channels"]["B.i"].update(cal_due="2026-01-11"), "vencida"),
    "sin incertidumbre": ("calibration", lambda d: d["channels"]["B.v"].pop("uncertainty"), "uncertainty"),
    "tele_hz distinto del puente": ("calibration", lambda d: d["sampling"].update(tele_hz=2), "tele_hz"),
    "watchdog corto": ("plc_spec", lambda d: d["watchdog"].update(timeout_s=2.0), "watchdog"),
    "latido distinto del puente": ("plc_spec", lambda d: d["watchdog"].update(heartbeat_period_s=0.5, timeout_s=5), "hb_period_s"),
    "sin histéresis de viento": ("plc_spec", lambda d: d["wind"].update(resume_ms=15), "histéresis"),
    "faltan códigos de rechazo": ("plc_spec", lambda d: d["reject_codes"].pop(7), "reject_codes"),
    "sin firma": ("plc_spec", lambda d: d.update(signed_off_by=""), "signed_off_by"),
    "registros sin confirmar": ("plc_registers", lambda d: d.update(confirmed=False), "confirmed"),
    "registro faltante": ("plc_registers", lambda d: d["input_registers"].pop("IR_WIND"), "IR_WIND"),
    "dirección repetida": ("plc_registers", lambda d: d["input_registers"]["IR_AZ"].update(address=0), "repetidas"),
    "offset distinto del puente": ("plc_registers", lambda d: d.update(ir_offset=10), "ir_offset"),
    "barrido fuera de límites": ("load_limits", lambda d: d.update(sweep_s_max=8), "sweep.seconds"),
    "límite negativo": ("load_limits", lambda d: d.update(i_max_a=-1), "i_max_a"),
    "acción desconocida": ("load_limits", lambda d: d.update(on_exceed="ignorar"), "on_exceed"),
    "IP inválida": ("network", lambda d: d.update(plc_ip="192.168.50.999"), "plc_ip"),
    "IP repetida": ("network", lambda d: d.update(cdaq_ip=d["plc_ip"]), "repetidas"),
    "PLC distinto del puente": ("network", lambda d: d.update(plc_ip="192.168.50.77"), "controller.host"),
}


@pytest.mark.parametrize("name", CASES)
def test_cada_dato_invalido_hace_fallar_el_modo_real(hw, name):
    tmp, docs = hw
    which, mutate, needle = CASES[name]
    mutate(docs[which])
    dump(tmp, which, docs[which])
    errs = problems(tmp)
    assert errs and any(needle in e for e in errs), errs


def test_modo_real_exige_pieza_real_y_tls(hw):
    cfg = copy.deepcopy(REAL)
    cfg["daq"] = {"driver": "fake"}
    assert any("daq.driver" in e for e in problems(hw[0], cfg))
    cfg = copy.deepcopy(REAL)
    cfg["bus"]["tls"] = False
    assert any("tls" in e for e in problems(hw[0], cfg))
    assert problems(hw[0], {**REAL, "mode": "otro"})


def test_staged_solo_valida_lo_que_es_real(tmp_path):
    docs = good_docs()
    for n in ("plc_spec", "plc_registers", "load_limits", "network"):
        dump(tmp_path, n, docs[n])
    cfg = {**REAL, "mode": "staged", "daq": {"driver": "fake"}}       # PLC real, adquisición virtual: no pide calibración
    docs["network"].pop("cdaq_ip")
    dump(tmp_path, "network", docs["network"])
    assert problems(tmp_path, cfg) == []
    assert H.validate({**REAL, "mode": "sim"}, tmp_path / "no-existe") == []


async def test_el_puente_no_arranca_en_modo_real_con_datos_incompletos(tmp_path):
    with pytest.raises(SystemExit) as e:
        await run({**REAL, "hardware": {"dir": str(tmp_path)}})
    assert "no arranca" in str(e.value)


def test_check_de_la_linea_de_comandos(tmp_path, hw):
    cfg = tmp_path / "bridge.yaml"
    cfg.write_text(yaml.safe_dump({**REAL, "hardware": {"dir": str(hw[0])}}), encoding="utf-8")
    ok = subprocess.run([sys.executable, "-m", "labsolar.bridge.main", "--config", str(cfg), "--check"], capture_output=True, text=True)
    assert ok.returncode == 0 and "OK" in ok.stdout, ok.stdout + ok.stderr
    bad = tmp_path / "vacio"
    bad.mkdir()
    cfg.write_text(yaml.safe_dump({**REAL, "hardware": {"dir": str(bad)}}), encoding="utf-8")
    r = subprocess.run([sys.executable, "-m", "labsolar.bridge.main", "--config", str(cfg), "--check"], capture_output=True, text=True)
    assert r.returncode == 1 and "calibration.yaml" in r.stdout


def test_canales_de_nidaqmx_salen_de_la_calibracion(hw):
    ch = H.daq_channels(REAL, hw[0])
    assert ch["A.v"] == {"phys": "cDAQ1Mod1/ai0", "type": "voltage", "scale": 2.0, "offset": 0.0}


def test_configuracion_real_del_despliegue_si_existe():
    """Cuando Manuel copia las plantillas a deploy/hardware/*.yaml, esta prueba exige que estén completas y coherentes con bridge.yaml."""
    present = [f for f in H.FILES.values() if (HW / f).exists()]
    if not present:
        pytest.skip("deploy/hardware aún sin archivos reales (solo plantillas)")
    cfg = yaml.safe_load((DEPLOY / "bridge.yaml").read_text(encoding="utf-8").replace("${PLC_HOST}", _plc_host()))
    errs = H.validate(cfg, HW)
    assert not errs, "\n".join(errs)


def _plc_host() -> str:
    env = DEPLOY / ".env"
    if env.exists():
        m = re.search(r"^PLC_HOST=(\S+)", env.read_text(encoding="utf-8"), re.M)
        if m:
            return m.group(1)
    net = HW / "network.yaml"
    return str(yaml.safe_load(net.read_text(encoding="utf-8")).get("plc_ip", "")) if net.exists() else ""


def test_bridge_yaml_de_despliegue_declara_modo_y_ruta_de_hardware():
    cfg = yaml.safe_load((DEPLOY / "bridge.yaml").read_text(encoding="utf-8"))
    assert cfg["mode"] in ("sim", "staged", "real")
    compose = (DEPLOY / "docker-compose.yml").read_text(encoding="utf-8")
    assert "./hardware:/config/hardware:ro" in compose


# ---------------------------------------------------------------- H1: ACL de la pasarela
def acl_blocks():
    out, user = {}, None
    for line in (DEPLOY / "mosquitto" / "acl").read_text(encoding="utf-8").splitlines():
        if m := re.match(r"user (\w+)$", line):
            user = out.setdefault(m.group(1), [])
        elif m := re.match(r"topic (read|write)\s+(\S+)$", line):
            user.append((m.group(1), m.group(2)))
    return out


def test_acl_la_pasarela_solo_escribe_su_topico_de_eventos():
    b = acl_blocks()
    assert ("write", "labsolar/v1/+/event/gw") in b["gateway"]
    assert ("write", "labsolar/v1/+/event") not in b["gateway"]
    assert [u for u, rules in b.items() if ("write", "labsolar/v1/+/event") in rules] == ["bridge"]
    assert ("read", "labsolar/v1/+/event/gw") in b["recorder"]


def test_topicos_del_contrato_coinciden_con_la_acl():
    b = acl_blocks()
    for name, meta in contract.TOPICS.items():
        for pub in meta["publisher"].split(","):
            pub = {"bridge": "bridge", "gateway": "gateway", "twin": "twin"}[pub]
            assert ("write", f"labsolar/v1/+/{name}") in b[pub], f"{pub} no puede escribir {name}"


# ---------------------------------------------------------------- H2: origen de los datos
def source_of(ctrl: str, daq: str) -> str:
    app = BridgeApp.__new__(BridgeApp)
    app.ctrl, app.daq = SimpleNamespace(name=ctrl), SimpleNamespace(name=daq)
    return app._source()


@pytest.mark.parametrize("ctrl,daq,expected", [("fake", "fake", "fake"), ("modbus", "nidaqmx", "real"), ("opcua", "mqtt", "real"),
                                                ("modbus", "fake", "mixed"), ("fake", "nidaqmx", "mixed")])
def test_el_origen_es_real_solo_si_plc_y_adquisicion_lo_son(ctrl, daq, expected):
    assert source_of(ctrl, daq) == expected


def test_el_contrato_de_tele_admite_mixed():
    assert "mixed" in yaml.safe_load((Path(contract.contract_dir()) / "tele.schema.json").read_text(encoding="utf-8"))["properties"]["source"]["enum"]
