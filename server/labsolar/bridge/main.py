"""Punto de entrada del puente: labsolar-bridge --config bridge.yaml

controller.driver: fake | modbus | opcua      daq.driver: fake | nidaqmx | mqtt
Con fake, el banco virtual corre en el mismo proceso (y opcionalmente sirve Modbus TCP para probar el controlador real contra él).
"""
from __future__ import annotations

import argparse
import os
import asyncio
import logging
import signal
from pathlib import Path
from typing import Any

import yaml

from .. import contract
from ..bus import Bus, bus_from_config
from .app import BridgeApp, BridgeConfig
from .daq.base import DaqDriver
from .drivers.base import ControllerDriver

log = logging.getLogger("labsolar.bridge")


def build(cfg: dict, bus: Bus) -> tuple[ControllerDriver, DaqDriver, Any, Any]:
    """Devuelve (controlador, adquisición, banco virtual|None, servidor modbus virtual|None)."""
    c, d = cfg.get("controller", {"driver": "fake"}), cfg.get("daq", {"driver": "fake"})
    bank = server = None
    if c.get("driver") == "fake" or d.get("driver") == "fake" or cfg.get("fake", {}).get("serve_modbus"):
        from .fakebank import FakeBank, FakeModbusServer
        bank = FakeBank(cfg.get("fake"))
        sm = cfg.get("fake", {}).get("serve_modbus")
        if sm:
            server = FakeModbusServer(bank, sm.get("host", "127.0.0.1"), int(sm.get("port", 5020)), speed=float(cfg.get("fake", {}).get("speed", 1.0)) if False else 1.0)
    if c["driver"] == "fake":
        from .drivers.fake import FakeController
        ctrl: ControllerDriver = FakeController(bank)
    elif c["driver"] == "modbus":
        from .drivers.modbus import ModbusController
        ctrl = ModbusController(c["host"], int(c.get("port", 502)), int(c.get("unit", 1)), float(c.get("timeout", 1.0)),
                                int(c.get("ir_offset", 0)), int(c.get("hr_offset", 0)))
    elif c["driver"] == "opcua":
        from .drivers.opcua import OpcUaController
        ctrl = OpcUaController(c["url"], c.get("ir_nodes"), c.get("hr_nodes"), float(c.get("timeout", 2.0)), c.get("username"), c.get("password"))
    else:
        raise ValueError(f"controller.driver desconocido: {c['driver']}")
    if d["driver"] == "fake":
        from .daq.fake import FakeDaq
        daq: DaqDriver = FakeDaq(bank)
    elif d["driver"] == "nidaqmx":
        from .daq.nidaqmx import NidaqmxDaq
        daq = NidaqmxDaq(d["channels"], float(d.get("sample_rate", 1000.0)), int(d.get("samples", 100)))
    elif d["driver"] == "mqtt":
        from .daq.mqtt import MqttDaq
        daq = MqttDaq(bus, d["topic"], float(d.get("max_age_s", 3.0)))
    else:
        raise ValueError(f"daq.driver desconocido: {d['driver']}")
    return ctrl, daq, bank, server


def bridge_config(cfg: dict) -> BridgeConfig:
    keys = {k: cfg[k] for k in ("bank", "tele_period_s", "hb_period_s", "gateway_timeout_s", "ack_timeout_s", "queue_max", "fixed",
                                "daq_timeout_s", "require_gateway_hb") if k in cfg}
    sw = cfg.get("sweep", {})
    if "seconds" in sw:
        keys["sweep_seconds"] = float(sw["seconds"])
    if "bank" in sw:
        keys["load_bank"] = sw["bank"]
    return BridgeConfig(**keys)


async def run(cfg: dict) -> None:
    bc = bridge_config(cfg)
    will_state = {"ts": 0, "safety": "FAULT", "appliedMode": "estop", "controlSession": None, "bridge": "offline", "plc": "offline"}
    bus = bus_from_config(cfg.get("bus", {"kind": "mqtt"}), client_id=f"bridge-{bc.bank}", will=(contract.topic(bc.bank, "state"), will_state, 1, True))
    await bus.start()
    ctrl, daq, bank, server = build(cfg, bus)
    if server:
        await server.start()
    app = BridgeApp(bus, ctrl, daq, bc)
    await app.start()
    log.info("Puente en marcha (banco %s, controlador %s, adquisición %s)", bc.bank, ctrl.name, daq.name)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:                       # Windows
            pass
    await stop.wait()
    await app.stop()
    if server:
        await server.stop()
    await bus.close()


def main() -> None:
    ap = argparse.ArgumentParser(description="Puente del Laboratorio Solar Remoto")
    ap.add_argument("--config", required=True)
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = yaml.safe_load(os.path.expandvars(Path(a.config).read_text(encoding="utf-8")))       # ${VAR} del entorno: los secretos no van en el archivo
    bus = cfg.setdefault("bus", {"kind": "mqtt"})
    if bus.get("kind", "mqtt") == "mqtt":
        bus.setdefault("username", os.environ.get("MQTT_USER"))
        bus.setdefault("password", os.environ.get("MQTT_PASSWORD"))
    asyncio.run(run(cfg))


if __name__ == "__main__":
    main()
