"""CSV de corridas y barridos con las mismas columnas y el mismo escapado que el simulador (js/core/exporters.js).

La prueba tests/test_csv_header.py compara el encabezado con el que produce LAB.core.runToCsv para que no diverjan.
"""
from __future__ import annotations

import datetime as dt
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Iterable

CSV_HEAD = ["n", "segmento", "utc_iso_simulado", "hora_local_sitio", "utc_iso_registro_real", "G_A_Wm2", "G_B_Wm2", "Tcel_A_C", "Tcel_B_C", "Tamb_C",
            "HR_pct", "viento_ms", "dir_viento_deg", "V_A_V", "I_A_A", "P_A_W", "E_A_Wh", "V_B_V", "I_B_A", "P_B_W", "E_B_Wh", "azimut_B_deg",
            "inclinacion_B_deg", "modo_seguidor_aplicado", "modo_carga", "estado_seguridad", "nubes_consigna_pct", "sombra_mutua_A_frac",
            "sombra_mutua_B_frac", "evento"]
# columnas de muestra (después de n, segmentId, simMs, realMs) en el orden del simulador y sus decimales
VALUE_COLS = ["gA", "gB", "tcA", "tcB", "ta", "rh", "wind", "windDir", "vA", "iA", "pA", "eA", "vB", "iB", "pB", "eB", "azB", "tiltB", "trMode", "loadMode",
              "safety", "cloud", "shA", "shB"]
DEC = {"gA": 1, "gB": 1, "tcA": 1, "tcB": 1, "ta": 1, "rh": 0, "wind": 1, "windDir": 0, "vA": 2, "iA": 3, "pA": 1, "eA": 2, "vB": 2, "iB": 3, "pB": 1,
       "eB": 2, "azB": 1, "tiltB": 1, "cloud": 0, "shA": 2, "shB": 2}
TZ = dt.timezone(dt.timedelta(hours=-6))          # Chiapas ya no usa horario de verano


def csv_cell(v: Any) -> str:
    s = "" if v is None else str(v)
    if any(c in s for c in ',"\n\r'):
        s = '"' + s.replace('"', '""') + '"'
    return s


def iso(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(ms) % 1000:03d}Z"


def local(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, TZ).strftime("%Y-%m-%d %H:%M:%S")


def fmt(col: str, v: Any) -> str:
    if isinstance(v, bool):
        return csv_cell(v)
    if isinstance(v, (int, float)):
        if v != v or abs(v) == float("inf"):
            return ""
        # Number.prototype.toFixed del navegador redondea el empate exacto «hacia afuera»; format() de Python lo hace al par
        d = DEC.get(col, 2)
        return str(Decimal(v).quantize(Decimal(1).scaleb(-d), rounding=ROUND_HALF_UP)) if d else str(Decimal(v).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    return csv_cell(v)


def run_to_csv(run: dict, rows: Iterable[dict], events_by_n: dict[int, list[str]] | None = None) -> str:
    """run: metadatos; rows: dicts con n, segmentId, simMs, realMs y VALUE_COLS."""
    rows = list(rows)
    ev = events_by_n or {}
    lines = [
        "# Laboratorio Remoto Solar UNACH - DATOS MEDIDOS DEL BANCO (registrador del servidor)",
        f"# corrida={run['id']} sesion={run.get('session_id') or '-'} practica={run.get('practice_id') or '-'} etiqueta={csv_cell(run.get('label') or '')}",
        f"# usuario={csv_cell(run.get('username') or '')}",
        f"# muestreo=una muestra por segundo del reloj del borde; estado={run.get('status')}; muestras={len(rows)}; descartada={'si' if run.get('discarded') else 'no'}",
        "# E_A_Wh y E_B_Wh son contadores de energia integrados por el puente desde su arranque. Un cambio de segmento marca una discontinuidad: no unir con lineas.",
        ",".join(CSV_HEAD),
    ]
    for r in rows:
        out = [r["n"], r.get("segmentId") or "s1", iso(r["simMs"]), local(r["simMs"]), iso(r["realMs"])]
        for c in VALUE_COLS:
            out.append(fmt(c, r.get(c)))
        out.append(csv_cell(" | ".join(ev.get(r["n"], []))))
        lines.append(",".join(str(x) for x in out))
    return "\n".join(lines) + "\n"


def sweep_to_csv(sw: dict) -> str:
    start, end = (sw.get("cond") or {}).get("start") or {}, (sw.get("cond") or {}).get("end") or {}
    f = lambda v, d=0: "-" if v is None else f"{v:.{d}f}"   # noqa: E731
    L = [
        "# Laboratorio Remoto Solar UNACH - BARRIDO I-V MEDIDO DEL BANCO",
        f"# barrido={sw['id']} sesion={sw.get('sessionId') or '-'} corrida={sw.get('runId') or '-'} estado={sw['status']}{' (' + sw['cause'] + ')' if sw.get('cause') else ''}",
        f"# inicio_local={local(sw.get('startSimMs', 0))} G_A_inicio={f(start.get('gA'))} G_B_inicio={f(start.get('gB'))} W/m2 Tback_A={f(start.get('tA'), 1)} C",
        f"# fin: G_A={f(end.get('gA'))} G_B={f(end.get('gB'))} W/m2 (si difieren del inicio, las condiciones cambiaron durante el barrido)",
        "modulo,punto,V_V,I_A,P_W,G_Wm2",
    ]
    for k in ("A", "B"):
        for i, p in enumerate(sw["pts"][k]):
            L.append(f"{k},{i},{p['v']:.3f},{p['i']:.4f},{p['p']:.2f},{'' if p.get('g') is None else format(p['g'], '.1f')}")
    return "\n".join(L) + "\n"
