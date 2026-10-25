import asyncio
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from labsolar import contract, db
from labsolar.bus import MemoryBus
from labsolar.recorder.app import RecorderApp
from labsolar.repo import Repo
from labsolar.runs_csv import CSV_HEAD, VALUE_COLS, run_to_csv
from tests.conftest import BANK, Rig

SIM = Path(__file__).resolve().parents[2] / "laboratorio-solar-3d"


@pytest.fixture
async def rec():
    rig = Rig()
    engine = db.make_engine("sqlite://")
    db.init_db(engine)
    repo = Repo(engine)
    repo.create_user("ana", "x", "student", "Ana")
    app = RecorderApp(rig.bus, repo, BANK, flush_every_s=0.2)
    await rig.start()
    await app.start()
    yield rig, app, repo
    await app.stop()
    await rig.stop()


async def settle(app, n=0.5):
    await asyncio.sleep(n)
    await app.flush()


async def test_guarda_toda_la_telemetria_aun_sin_corrida(rec):
    rig, app, repo = rec
    await asyncio.sleep(1.0)
    await settle(app)
    n = repo.count(db.samples)
    assert n >= 5
    assert repo.count(db.samples, db.samples.c.run_id.isnot(None)) == 0


async def test_corrida_con_inicio_parada_y_segmentos(rec):
    rig, app, repo = rec
    assert (await rig.login())["ok"]
    assert (await rig.cmd("acq.newRun", {"label": "prueba", "practiceId": "b1"}))["ok"]
    assert (await rig.cmd("acq.start"))["ok"]
    await asyncio.sleep(1.0)
    assert (await rig.cmd("acq.stop"))["ok"]
    await settle(app)
    run = repo.list_runs({"id": 1, "role": "admin"})[0]
    rows = list(repo.run_rows(run["id"]))
    assert run["status"] == "stopped" and 5 <= len(rows) <= 20
    assert [r["n"] for r in rows] == list(range(len(rows)))
    csv = run_to_csv(run, rows)
    lines = csv.splitlines()
    assert lines[5] == ",".join(CSV_HEAD) and len(lines) == 6 + len(rows)
    # tras detener, ya no se agregan filas a la corrida
    await asyncio.sleep(0.5)
    await settle(app)
    assert len(list(repo.run_rows(run["id"]))) == len(rows)


async def test_huecos_de_seq_se_registran_como_evento(rec):
    rig, app, repo = rec
    rig.tasks[0].cancel()                                   # detiene el banco virtual: la telemetría la inyecta la prueba
    await rig.app.stop()
    await asyncio.sleep(0.2)
    _, base = await rig.teles.get(timeout=1.0)
    await rig.bus.publish(contract.topic(BANK, "tele"), {**base, "seq": 999, "ts": base["ts"] + 999})
    await settle(app, 0.2)
    g0 = app.stats["gaps"]
    for seq in (1000, 1001, 1002, 1013, 1014):
        await rig.bus.publish(contract.topic(BANK, "tele"), {**base, "seq": seq, "ts": base["ts"] + seq})
    await settle(app)
    assert app.stats["gaps"] - g0 == 1 and app.stats["lost"] >= 10


async def test_24_horas_de_telemetria_dan_86400_filas_con_huecos_detectados(rec):
    rig, app, repo = rec
    rig.tasks[0].cancel()
    await rig.app.stop()
    await asyncio.sleep(0.2)
    _, base = await rig.teles.get(timeout=1.0)
    t0 = base["ts"]
    sub_n = 0
    lost = 0
    for k in range(86_400):
        if k in (10_000, 50_000):                           # dos cortes de 7 muestras
            lost += 7
            continue
        await rig.bus.publish(contract.topic(BANK, "tele"), {**base, "seq": 5000 + k, "ts": t0 + k * 1000})
        sub_n += 1
        if k % 100 == 0:                                    # la cola del registrador es acotada y descarta lo más viejo: se espera a que drene
            while app._sub.queue.qsize() > 300:
                await asyncio.sleep(0.005)
    for _ in range(100):
        await asyncio.sleep(0.2)
        await app.flush()
        if repo.count(db.samples) >= sub_n:
            break
    n = repo.count(db.samples)
    assert abs(n - 86_400) <= 20 + lost, n
    assert app.stats["gaps"] >= 2 and app.stats["lost"] >= lost


def test_encabezado_y_fila_csv_son_iguales_a_los_del_simulador(tmp_path):
    node = shutil.which("node")
    if not node or not SIM.exists():
        pytest.skip("node o el simulador no están disponibles")
    sample = {"n": 3, "segmentId": "s1", "simMs": 1792825800000, "realMs": 1792825803250, "gA": 812.345, "gB": 905.5, "tcA": 51.23, "tcB": 49.5, "ta": 30.1, "rh": 55.4,
              "wind": 2.25, "windDir": 123.4, "vA": 30.123, "iA": 7.4567, "pA": 224.6, "eA": 3.456, "vB": 31.2, "iB": 8.123, "pB": 253.4, "eB": 4.5, "azB": 183.25,
              "tiltB": 20.75, "trMode": "astro", "loadMode": "mppt", "safety": "NORMAL", "cloud": 30.4, "shA": 0.0, "shB": 0.125}
    js = f"""
    const {{ loadSim }} = require({json.dumps(str(SIM / 'tools/lib/loadsim.js'))});
    const LAB = loadSim();
    const cols = LAB.core.RUN_COLS, s = {json.dumps(sample)};
    const run = {{ id: 'run_x', sessionId: 's', samples: [cols.map((c) => s[c])], events: [{{ n: 3, text: 'hola, "mundo"' }}], segments: [], status: 'stopped', limit: 1, schemaVersion: 1 }};
    process.stdout.write(LAB.core.runToCsv(run));
    """
    script = tmp_path / "csv_sim.js"                       # como archivo, no con -e: así el cargador del simulador define LAB global
    script.write_text(js)
    out = subprocess.run([node, str(script)], capture_output=True, text=True, check=True).stdout.splitlines()
    head, row = out[7], out[8]
    py = run_to_csv({"id": "run_x", "status": "stopped"}, [sample], {3: ['hola, "mundo"']}).splitlines()
    assert head == py[5] == ",".join(CSV_HEAD)
    assert row == py[6]
    script.write_text(js.replace("process.stdout.write(LAB.core.runToCsv(run));", "process.stdout.write(JSON.stringify(cols));"))
    cols = json.loads(subprocess.run([node, str(script)], capture_output=True, text=True, check=True).stdout)
    assert VALUE_COLS == cols[4:]


async def test_eventos_de_la_pasarela_se_guardan_sin_error(rec, caplog):
    """event/gw es un tópico aparte del puente: el registrador debe consumirlo igual que a event (antes lanzaba AttributeError)."""
    rig, app, repo = rec
    ev = contract.event(1_700_000_000_000, "info", "pasarela", "gw.test", "evento propio de la pasarela", {})
    n0 = repo.count(db.events)
    await rig.bus.publish_msg(BANK, "event/gw", ev)
    await settle(app)
    assert repo.count(db.events) == n0 + 1
    assert "AttributeError" not in caplog.text
