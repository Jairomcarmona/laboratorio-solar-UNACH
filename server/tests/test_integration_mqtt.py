"""Integración con Mosquitto real: autenticación y ACL por servicio (deploy/mosquitto/acl) y flujo puente <-> pasarela por MQTT."""
import asyncio
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import pytest

from labsolar import contract
from labsolar.bus import MqttBus
from tests.conftest import BANK

pytestmark = pytest.mark.integration
DEPLOY = Path(__file__).resolve().parent.parent / "deploy" / "mosquitto"


@pytest.fixture(scope="module")
def broker():
    exe = shutil.which("mosquitto")
    if not exe:
        pytest.skip("mosquitto no está instalado")
    d = Path(tempfile.mkdtemp(prefix="mq-"))
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    pw = d / "passwd"
    d.chmod(0o755)
    for i, u in enumerate(("bridge", "gateway", "recorder", "twin")):
        subprocess.run(["mosquitto_passwd", "-b"] + (["-c"] if i == 0 else []) + [str(pw), u, f"pw-{u}"], check=True)
    acl = d / "acl"                                    # copia dentro del directorio temporal, junto a passwd
    shutil.copy(DEPLOY / "acl", acl)
    conf = d / "m.conf"
    conf.write_text(f"allow_anonymous false\npassword_file {pw}\nacl_file {acl}\nlistener {port} 127.0.0.1\n")
    for f in (pw, acl):
        f.chmod(0o700)
        if os.geteuid() == 0:                          # como root, Mosquitto cede privilegios y exige que estos archivos sean suyos
            shutil.chown(f, "mosquitto")
    log = open(d / "mosquitto.log", "wb")
    p = subprocess.Popen([exe, "-c", str(conf)], stdout=log, stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    else:
        p.terminate()
        pytest.fail("Mosquitto no abrió el puerto: " + (d / "mosquitto.log").read_text(errors="replace")[-800:])
    yield port
    p.terminate()
    p.wait(5)
    shutil.rmtree(d, ignore_errors=True)


def bus(port, user, pw=None, cid=None):
    return MqttBus("127.0.0.1", port, username=user, password=pw if pw is not None else f"pw-{user}", client_id=cid or user)


async def test_sin_credenciales_o_con_clave_mala_no_se_conecta(broker):
    b = bus(broker, "gateway", "mala")
    t = asyncio.create_task(b.start())
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(asyncio.shield(t), 3)
    await b.close()
    t.cancel()


async def test_acl_cada_servicio_solo_publica_lo_suyo(broker):
    br, gw, rec = bus(broker, "bridge"), bus(broker, "gateway"), bus(broker, "recorder")
    for b in (br, gw, rec):
        await b.start()
    try:
        tele_topic, req_topic = contract.topic(BANK, "tele"), contract.topic(BANK, "cmd/req")
        got_gw, got_br, got_rec = gw.subscribe(tele_topic), br.subscribe(req_topic), rec.subscribe(tele_topic, req_topic)
        await asyncio.sleep(0.5)
        await br.publish(tele_topic, {"ts": 1, "ok": "bridge"}, qos=1)
        _, m = await got_gw.get(timeout=3)
        assert m["ok"] == "bridge"
        await gw.publish(req_topic, {"id": "1", "from": "gateway"}, qos=1)
        _, m = await got_br.get(timeout=3)
        assert m["from"] == "gateway"
        # suplantación: la pasarela intenta publicar telemetría falsa y el registrador intenta dar una orden. Mosquitto las descarta en silencio.
        await gw.publish(tele_topic, {"ts": 2, "ok": "FALSA"}, qos=1)
        await rec.publish(req_topic, {"id": "2", "from": "recorder"}, qos=1)
        await asyncio.sleep(0.8)
        seen_gw = []
        while True:
            try:
                seen_gw.append((await got_gw.get(timeout=0.2))[1])
            except Exception:
                break
        seen_br = []
        while True:
            try:
                seen_br.append((await got_br.get(timeout=0.2))[1])
            except Exception:
                break
        assert not any(x.get("ok") == "FALSA" for x in seen_gw)
        assert not any(x.get("from") == "recorder" for x in seen_br)
    finally:
        for b in (br, gw, rec):
            await b.close()
