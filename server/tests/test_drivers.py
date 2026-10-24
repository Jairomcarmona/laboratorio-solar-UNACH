"""El mismo conjunto de órdenes contra los tres controladores: fake (directo), Modbus TCP y OPC UA, y los drivers de adquisición."""
import asyncio
import socket
import sys
import types

import pytest

from labsolar.bridge import registers as R
from labsolar.bridge.daq.mqtt import MqttDaq
from labsolar.bridge.daq.nidaqmx import NidaqmxDaq
from labsolar.bridge.drivers.fake import FakeController
from labsolar.bridge.drivers.modbus import ModbusController
from labsolar.bridge.drivers.opcua import OpcUaController
from labsolar.bridge.fakebank import FakeBank, FakeModbusServer, FakeOpcUaServer, run_bank
from labsolar.bus import MemoryBus
from tests.conftest import SOLAR_NOON


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture(params=["fake", "modbus", "opcua"])
async def plc(request):
    bank = FakeBank({"solar_start": SOLAR_NOON, "hb_timeout_s": 0.8, "wind": {"stow_delay_s": 0.2}})
    cleanup = []
    if request.param == "fake":
        ctrl = FakeController(bank)
        runner = asyncio.create_task(run_bank(bank, 50.0))
        cleanup.append(lambda: runner.cancel())
    elif request.param == "modbus":
        port = free_port()
        srv = FakeModbusServer(bank, "127.0.0.1", port, tick_hz=50.0)
        await srv.start()
        ctrl = ModbusController("127.0.0.1", port)
        cleanup.append(srv.stop)
    else:
        port = free_port()
        srv = FakeOpcUaServer(bank, f"opc.tcp://127.0.0.1:{port}/labsolar", tick_hz=50.0)
        await srv.start()
        ctrl = OpcUaController(f"opc.tcp://127.0.0.1:{port}/labsolar")
        cleanup.append(srv.stop)
    await ctrl.connect()
    await ctrl.heartbeat()
    yield ctrl, bank
    await ctrl.close()
    for c in cleanup:
        r = c()
        if asyncio.iscoroutine(r):
            await r


async def test_lectura_de_estado(plc):
    ctrl, bank = plc
    await asyncio.sleep(0.15)
    st = await ctrl.read_state()
    assert st.state == "NORMAL" and st.az == pytest.approx(180, abs=0.01) and st.tilt == pytest.approx(17, abs=0.01)
    assert st.limits == {"azMin": 90.0, "azMax": 270.0, "tiltMin": 0.0, "tiltMax": 90.0}


async def test_orden_aceptada_y_rechazada_con_codigo_del_plc(plc):
    ctrl, bank = plc
    r = await ctrl.write_targets(210.0, 35.0)
    assert r.ok, r
    await asyncio.sleep(0.2)
    assert bank.target_az == pytest.approx(210, abs=0.01)
    r = await ctrl.write_targets(20.0, None)               # fuera de rango: lo rechaza el PLC aunque el puente no lo hubiera filtrado
    assert not r.ok and r.reject_code == R.Reject.AZ_RANGE and "rango" in r.reason
    assert bank.target_az == pytest.approx(210, abs=0.01)  # no mutó


async def test_modo_candados_y_paro(plc):
    ctrl, bank = plc
    assert (await ctrl.set_mode("astro")).ok
    assert bank.mode == R.Mode.astro
    assert (await ctrl.set_locks(True, False)).ok
    await asyncio.sleep(0.1)
    st = await ctrl.read_state()
    assert st.lock_az and not st.lock_tilt
    r = await ctrl.request_stop()
    assert r.ok
    await asyncio.sleep(0.15)
    st = await ctrl.read_state()
    assert st.state == "ESTOP"
    r = await ctrl.write_targets(150.0, 20.0)
    assert not r.ok and r.reject_code == R.Reject.ESTOP


async def test_latido_perdido_lleva_al_plc_a_posicion_segura(plc):
    ctrl, bank = plc
    await ctrl.heartbeat()
    await asyncio.sleep(1.5)                               # sin más latidos
    st = await ctrl.read_state()
    assert st.state == "COMMS_STOW"
    await ctrl.heartbeat()
    r = await ctrl.request_ack()
    assert r.ok
    assert (await ctrl.read_state()).state == "NORMAL"


async def test_carga(plc):
    ctrl, bank = plc
    await ctrl.set_load("cr", 3.4)
    await asyncio.sleep(0.2)
    st = await ctrl.read_state()
    assert st.load_mode == "cr" and st.load_setpoint == pytest.approx(3.4)


async def test_nidaqmx_con_modulo_simulado():
    """Sin hardware: se inyecta un 'nidaqmx' de mentira y se comprueban la configuración de canales y el escalado."""
    calls = []

    class Chans:
        def add_ai_voltage_chan(self, phys, **kw): calls.append(("v", phys, kw))
        def add_ai_thrmcpl_chan(self, phys, **kw): calls.append(("tc", phys, kw))
        def add_ai_rtd_chan(self, phys, **kw): calls.append(("rtd", phys, kw))

    class Task:
        def __init__(self): self.ai_channels = Chans()
        def read(self, number_of_samples_per_channel=1): return [[0.41] * 4, [2.4] * 4, [0.0085] * 4, [21.5] * 4, [3.2] * 4][:5]
        def close(self): calls.append(("close",))

    mod = types.SimpleNamespace(Task=Task, constants=types.SimpleNamespace(ThermocoupleType=types.SimpleNamespace(K="K")))
    ch = {"A.v": {"phys": "cDAQ1Mod1/ai0", "scale": 100.0}, "A.i": {"phys": "cDAQ1Mod1/ai1", "scale": 5.0},
          "A.poa": {"phys": "cDAQ1Mod2/ai0", "scale": 100000.0 / 100}, "A.tback": {"phys": "cDAQ1Mod3/ai0", "type": "thermocouple", "tc": "K"},
          "env.wind": {"phys": "cDAQ1Mod2/ai1", "scale": 3.0}}
    daq = NidaqmxDaq(ch, samples=4, module=mod)
    await daq.connect()
    d = await daq.read()
    assert d["A"]["v"] == pytest.approx(41.0) and d["A"]["i"] == pytest.approx(12.0)
    assert d["A"]["poa"] == pytest.approx(8.5) and d["A"]["tback"] == pytest.approx(21.5) and d["env"]["wind"] == pytest.approx(9.6)
    assert d["B"]["v"] is None and d["env"]["ta"] is None
    assert [c[0] for c in calls] == ["v", "v", "v", "tc", "v"]
    await daq.close()
    assert calls[-1] == ("close",)


async def test_daq_por_mqtt_y_obsolescencia():
    bus = MemoryBus()
    daq = MqttDaq(bus, "labsolar/field/t1/daq", max_age_s=0.3)
    await daq.connect()
    with pytest.raises(TimeoutError):
        await daq.read()
    await bus.publish("labsolar/field/t1/daq", {"A": {"v": 40.0, "i": 10.0}, "B": {"v": 39.0, "i": 10.5}, "env": {"ta": 25.0}})
    assert (await daq.read())["A"]["v"] == 40.0
    await asyncio.sleep(0.4)
    with pytest.raises(TimeoutError):
        await daq.read()
