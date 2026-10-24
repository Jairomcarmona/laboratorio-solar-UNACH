"""tele (contrato v1) -> fila de muestra con las columnas del simulador (RUN_COLS)."""
from __future__ import annotations

from typing import Any


def tele_to_row(tele: dict, n: int | None = None, segment_id: str | None = None) -> dict[str, Any]:
    A, B, env, tr, sf, ld = tele["A"], tele["B"], tele["env"], tele["tracker"], tele["safety"], tele["load"]
    return {
        "n": n, "segmentId": segment_id, "simMs": tele["ts"], "realMs": tele["ts"],
        "gA": A.get("poa"), "gB": B.get("poa"), "tcA": A.get("tcell"), "tcB": B.get("tcell"),
        "ta": env.get("ta"), "rh": env.get("rh"), "wind": env.get("wind"), "windDir": env.get("windDir"),
        "vA": A.get("v"), "iA": A.get("i"), "pA": A.get("p"), "eA": A.get("wh"),
        "vB": B.get("v"), "iB": B.get("i"), "pB": B.get("p"), "eB": B.get("wh"),
        "azB": B.get("az") if B.get("az") is not None else tr.get("az"), "tiltB": B.get("tilt") if B.get("tilt") is not None else tr.get("tilt"),
        "trMode": tr.get("appliedMode"), "loadMode": ld.get("mode"), "safety": sf.get("state"), "cloud": None,
        "shA": A.get("shadeFrac"), "shB": B.get("shadeFrac"),
    }
