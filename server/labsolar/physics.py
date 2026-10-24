"""Parámetros físicos compartidos (server/contract/v1/physics.json, generado por tools/gen_pvlib_data.py) y modelos en pvlib.

Nadie copia números a mano: el banco virtual y el gemelo leen este archivo.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import numpy as np
from pvlib import pvsystem

from .contract import contract_dir


@lru_cache(maxsize=1)
def params() -> dict[str, Any]:
    return json.loads((contract_dir() / "physics.json").read_text(encoding="utf-8"))


def sdm() -> dict[str, float]:
    return params()["sdm"]


def module_power(g: float, t_cell: float) -> dict[str, float]:
    """Punto de máxima potencia, Voc e Isc con el diodo de physics.json (calcparams_desoto + singlediode)."""
    s = sdm()
    if g < 2:
        return {"pmp": 0.0, "vmp": 0.0, "imp": 0.0, "voc": 0.0, "isc": 0.0}
    iph, i0, rs, rsh, nnsvth = pvsystem.calcparams_desoto(g, t_cell, s["alphaIsc"], s["a"], s["IL"], s["Io"], s["Rsh"], s["Rs"],
                                                          EgRef=s["EgRef"], dEgdT=s["dEgdT"])
    o = pvsystem.singlediode(iph, i0, rs, rsh, nnsvth)
    return {"pmp": float(o["p_mp"]), "vmp": float(o["v_mp"]), "imp": float(o["i_mp"]), "voc": float(o["v_oc"]), "isc": float(o["i_sc"])}


def iv_at_voltage(g: float, t_cell: float, v: float) -> float:
    """Corriente del módulo a tensión v."""
    s = sdm()
    iph, i0, rs, rsh, nnsvth = pvsystem.calcparams_desoto(g, t_cell, s["alphaIsc"], s["a"], s["IL"], s["Io"], s["Rsh"], s["Rs"],
                                                          EgRef=s["EgRef"], dEgdT=s["dEgdT"])
    return float(max(0.0, pvsystem.i_from_v(v, iph, i0, rs, rsh, nnsvth)))


def current_at_resistance(g: float, t_cell: float, r_ohm: float) -> tuple[float, float]:
    """Punto de operación con carga resistiva: devuelve (v, i) resolviendo I(V) = V/R por bisección."""
    mp = module_power(g, t_cell)
    if mp["voc"] <= 0:
        return 0.0, 0.0
    lo, hi = 0.0, mp["voc"]
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if iv_at_voltage(g, t_cell, mid) > mid / r_ohm:
            lo = mid
        else:
            hi = mid
    v = 0.5 * (lo + hi)
    return v, v / r_ohm


# ---- térmico (S4): mismo esquema exacto que js/sim/pvmodel.js
def thermal_tau(wind: float) -> float:
    th = params()["thermal"]
    return th["C"] / (th["u0"] + th["u1"] * max(wind, 0.0))


def module_temp_step(t_mod: float, g: float, ta: float, wind: float, dt: float) -> float:
    th = params()["thermal"]
    tss = ta + g / (th["u0"] + th["u1"] * max(wind, 0.0))
    return tss + (t_mod - tss) * math.exp(-dt / thermal_tau(wind))


def cell_from_module(t_mod: float, g: float) -> float:
    return t_mod + params()["thermal"]["deltaT"] * g / 1000.0


@dataclass
class Plane:
    tilt: float
    az: float


def solar_position(ms: int) -> tuple[float, float]:
    """(azimut, elevación) con pvlib para el sitio de physics.json."""
    import pandas as pd
    from pvlib import solarposition
    site = params()["site"]
    t = pd.DatetimeIndex([pd.Timestamp(ms, unit="ms", tz="UTC")])
    sp = solarposition.get_solarposition(t, site["lat"], site["lon"], altitude=site["alt"])
    return float(sp["azimuth"].iloc[0]), float(sp["apparent_elevation"].iloc[0])


def clear_sky(ms: int) -> dict[str, float]:
    """GHI, DNI, DHI de cielo despejado (Solis simplificado) con los mismos parámetros del generador."""
    import pandas as pd
    from pvlib import atmosphere, clearsky, irradiance, solarposition
    site = params()["site"]
    t = pd.DatetimeIndex([pd.Timestamp(ms, unit="ms", tz="UTC")])
    sp = solarposition.get_solarposition(t, site["lat"], site["lon"], altitude=site["alt"])
    cs = clearsky.simplified_solis(sp["apparent_elevation"], aod700=0.08, precipitable_water=3.0,
                                   pressure=atmosphere.alt2pres(site["alt"]), dni_extra=irradiance.get_extra_radiation(t))
    return {k: float(max(cs[k].iloc[0], 0.0)) for k in ("ghi", "dni", "dhi")}


def poa_effective(ghi: float, dni: float, dhi: float, sun_az: float, sun_el: float, plane_az: float, plane_tilt: float, doy: int) -> float:
    """Irradiancia efectiva en el plano (Hay-Davies + IAM Martin-Ruiz) con pvlib; misma cadena que js/sim/solar.js."""
    import pandas as pd
    from pvlib import iam as piam, irradiance as pirr
    p = params()
    e0 = float(pirr.get_extra_radiation(pd.DatetimeIndex([pd.Timestamp("2026-01-01") + pd.Timedelta(days=doy - 1)]),
                                        solar_constant=1366.1, method="spencer").iloc[0])
    zen = 90.0 - sun_el
    comp = pirr.haydavies(plane_tilt, plane_az, dhi, dni, e0, zen, sun_az, return_components=True)
    aoi = float(pirr.aoi(plane_tilt, plane_az, zen, sun_az))
    ar = p["iam"]["ar"]
    ib = float(piam.martin_ruiz(aoi, a_r=ar)) if aoi < 90 else 0.0
    dif = piam.martin_ruiz_diffuse(plane_tilt, a_r=ar)
    ground = float(pirr.get_ground_diffuse(plane_tilt, ghi, albedo=p["albedo"]["value"]))
    beam = dni * max(math.cos(math.radians(aoi)), 0.0) if aoi < 90 else 0.0
    return float(beam * ib + float(comp["poa_circumsolar"]) * ib + float(comp["poa_isotropic"]) * float(dif["sky"]) + ground * float(dif["ground"]))
