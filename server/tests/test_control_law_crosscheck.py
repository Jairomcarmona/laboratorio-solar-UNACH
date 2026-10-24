"""La ley astronómica de Python (puente) y la de JavaScript (simulador) deben dar lo mismo, incluida la histéresis del lado norte."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from labsolar.bridge.control_law import AstroLaw

SIM = Path(__file__).resolve().parents[2] / "laboratorio-solar-3d"


def trajectory():
    """Una secuencia que cruza el norte varias veces, con azimuts dentro y fuera de 90-270, y alturas variadas."""
    seq = []
    for i in range(0, 360, 3):
        seq.append((float(i), 10.0 + (i % 70)))
    for az in (350, 355, 359, 1, 3, 5, 3, 1, 359, 356, 1, 2.5, 358, 90, 270, 89.9, 270.1, 180):
        seq.append((float(az), 55.0))
    seq += [(a / 2.0, 40.0) for a in range(700, 720)] + [(a / 2.0, 40.0) for a in range(0, 20)]
    return seq


def test_python_y_javascript_dan_las_mismas_consignas(tmp_path):
    node = shutil.which("node")
    if not node or not SIM.exists():
        pytest.skip("node o el simulador no están disponibles")
    seq = trajectory()
    js = f"""
    const {{ loadSim }} = require({json.dumps(str(SIM / 'tools/lib/loadsim.js'))});
    const LAB = loadSim();
    const tr = new LAB.sim.Tracker();
    const out = [];
    for (const [az, el] of {json.dumps(seq)}) {{
      const o = tr.astroOrientation({{ az, el, zenith: 90 - el }});
      tr.az = o.tAz;                                    // el seguidor alcanza la consigna antes de la siguiente muestra
      out.push([o.tAz, o.tTilt]);
    }}
    process.stdout.write(JSON.stringify(out));
    """
    script = tmp_path / "law.js"
    script.write_text(js)
    got = json.loads(subprocess.run([node, str(script)], capture_output=True, text=True, check=True).stdout)
    law = AstroLaw()
    current = 180.0                                  # el Tracker de JS arranca en 180°
    for (az, el), (jaz, jtilt) in zip(seq, got):
        paz, ptilt = law.orientation(az, el, current)
        current = paz
        assert paz == pytest.approx(jaz, abs=1e-9), (az, el)
        assert ptilt == pytest.approx(jtilt, abs=1e-6), (az, el)
