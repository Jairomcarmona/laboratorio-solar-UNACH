#!/usr/bin/env python3
"""Genera data/pvlib_tuxtla.js con pvlib.

Salida (cargada por el navegador como <script>, sin fetch, asi funciona abriendo index.html):
  LAB.data.pvlib.clearsky : tabla de cielo despejado (GHI, DNI, DHI) por dia del ano y hora local
  LAB.data.pvlib.sdm      : parametros del modelo de un diodo (De Soto) del modulo de ~500 Wp
  LAB.data.pvlib.check    : posiciones solares de referencia para validar solar.js

Uso:  python3 tools/gen_pvlib_data.py
"""
import json
import pathlib

import numpy as np
import pandas as pd
import pvlib
from pvlib import clearsky, location, pvsystem

SITE = dict(name="FCFM-UNACH, Tuxtla Gutierrez", lat=16.7516, lon=-93.1161, alt=530.0)
TZ = "Etc/GMT+6"  # UTC-6 fijo (Chiapas ya no usa horario de verano)
YEAR = 2026

# Atmosfera tropical humeda: agua precipitable ~3 cm, AOD@700nm bajo-moderado.
PRECIP_WATER_CM = 3.0
AOD700 = 0.08

# Modulo comercial tipico de ~500 Wp, 132 medias celdas = 2 ramas en paralelo de 66 en serie
MODULE = dict(v_mp=41.4, i_mp=12.08, v_oc=49.5, i_sc=12.9,
              alpha_sc=0.00048 * 12.9, beta_voc=-0.0026 * 49.5, cells_in_series=66)

# Parametros provisionales (ver docs/FISICA.md): cada uno lleva su fuente y quien los recalibra
THERMAL = {"u0": 25.0, "u1": 6.84, "C": 9300.0, "deltaT": 3.0,
           "fuente": "Faiman (coeficientes por defecto de pvlib, temperatura de MODULO); C = 11.1 kg/m2 x 840 J/(kg K) (masa por defecto de "
                     "pvlib.temperature.prilliman x calor especifico del vidrio), PROVISIONAL: la recalibra O2; deltaT = tabla Sandia, vidrio/polimero estructura abierta"}
IAM = {"model": "martin_ruiz", "ar": 0.16, "fuente": "pvlib.iam.martin_ruiz, a_r = 0.16 (valor tipico), PROVISIONAL hasta medir"}
ALBEDO = {"value": 0.3, "fuente": "supuesto de azotea de concreto claro, PROVISIONAL (S28 lo calibra con datos)"}
SENSORS = {"poaA": {"type": "refcell", "epsCal": 0.0, "alpha": 0.0005, "noise": 0.004},
           "poaB": {"type": "refcell", "epsCal": 0.0, "alpha": 0.0005, "noise": 0.004},
           "fuente": "PROVISIONAL sin hoja de datos de sensor (alpha 0.05 %/K, ruido 0.4 %); O1 los reemplaza"}

DAY_STEP = 15          # una muestra cada 15 dias
MINUTES_STEP = 15      # resolucion horaria de la tabla


def build_clearsky():
    loc = location.Location(SITE["lat"], SITE["lon"], tz=TZ, altitude=SITE["alt"])
    days = list(range(1, 366, DAY_STEP))
    n_t = 24 * 60 // MINUTES_STEP
    table = {"ghi": [], "dni": [], "dhi": []}
    for doy in days:
        day = pd.Timestamp(f"{YEAR}-01-01", tz=TZ) + pd.Timedelta(days=doy - 1)
        times = pd.date_range(day, periods=n_t, freq=f"{MINUTES_STEP}min")
        sp = loc.get_solarposition(times)
        pressure = pvlib.atmosphere.alt2pres(SITE["alt"])
        dni_extra = pvlib.irradiance.get_extra_radiation(times)
        cs = clearsky.simplified_solis(
            sp["apparent_elevation"], aod700=AOD700, precipitable_water=PRECIP_WATER_CM,
            pressure=pressure, dni_extra=dni_extra)
        for k in ("ghi", "dni", "dhi"):
            table[k].append([int(round(v)) for v in cs[k].fillna(0).clip(lower=0).values])
    return {"days": days, "minutesStep": MINUTES_STEP, **table}


def build_sdm():
    """Ajusta el modelo de un diodo (De Soto) a los datos de placa con pvlib.ivtools.sdm.fit_desoto.

    132 medias celdas = 2 ramas de 66 en paralelo: electricamente el modulo se comporta como 66 celdas en serie.
    (Con 132 el ajuste no converge y obligaba a forzar EgRef = 0.818 eV; con 66 converge con EgRef = 1.121 eV del silicio.)
    """
    from pvlib import ivtools

    m = MODULE
    res, _ = ivtools.sdm.fit_desoto(
        v_mp=m["v_mp"], i_mp=m["i_mp"], v_oc=m["v_oc"], i_sc=m["i_sc"],
        alpha_sc=m["alpha_sc"], beta_voc=m["beta_voc"], cells_in_series=m["cells_in_series"])
    il, io, a, rs, rsh = (float(res[k]) for k in ("I_L_ref", "I_o_ref", "a_ref", "R_s", "R_sh_ref"))
    eg, deg_dt = float(res["EgRef"]), float(res["dEgdT"])

    def point(g, tc):
        p = pvsystem.calcparams_desoto(g, tc, m["alpha_sc"], a, il, io, rsh, rs, EgRef=eg, dEgdT=deg_dt)
        o = pvsystem.singlediode(*p)
        return float(o["v_oc"]), float(o["p_mp"]), float(o["i_sc"])

    gamma = (point(1000, 45)[1] / point(1000, 25)[1] - 1) / 20 * 100
    beta = (point(1000, 45)[0] / point(1000, 25)[0] - 1) / 20 * 100
    eff200 = point(200, 25)[1] / 200 / (point(1000, 25)[1] / 1000)
    return {"IL": il, "Io": io, "a": a, "Rs": rs, "Rsh": rsh, "EgRef": eg, "dEgdT": deg_dt,
            "Vmp": m["v_mp"], "Imp": m["i_mp"], "Voc": m["v_oc"], "Isc": m["i_sc"],
            "alphaIsc": m["alpha_sc"], "betaVoc": m["beta_voc"], "gammaPmp": gamma, "betaVocPct": beta,
            "effRel200": eff200, "cellsEff": 66, "Wp": round(m["v_mp"] * m["i_mp"])}


def build_ivcheck(sdm):
    """Tabla singlediode de pvlib para G x T: la prueba tools/test_pv_vs_pvlib.js la compara con LAB.sim.pv.curve."""
    gs = [100, 200, 400, 600, 800, 1000, 1100]
    ts = [10, 25, 45, 65]
    rows = []
    for g in gs:
        for t in ts:
            p = pvsystem.calcparams_desoto(g, t, sdm["alphaIsc"], sdm["a"], sdm["IL"], sdm["Io"], sdm["Rsh"], sdm["Rs"],
                                           EgRef=sdm["EgRef"], dEgdT=sdm["dEgdT"])
            o = pvsystem.singlediode(*p)
            rows.append({"g": g, "t": t, "pmp": float(o["p_mp"]), "voc": float(o["v_oc"]), "isc": float(o["i_sc"])})
    return rows


def build_poacheck(n=200, seed=20261024):
    """Vectores de transposicion Hay-Davies y IAM Martin-Ruiz generados por pvlib (validan solar.js, S2 y S3)."""
    from pvlib import iam as piam, irradiance as pirr
    rng = np.random.default_rng(seed)
    rows = []
    while len(rows) < n:
        tilt = float(rng.uniform(0, 90)); az = float(rng.uniform(0, 360))
        zen = float(rng.uniform(0, 88)); saz = float(rng.uniform(0, 360))
        dni = float(rng.uniform(0, 1000)); dhi = float(rng.uniform(0, 400))
        doy = int(rng.integers(1, 366))
        ghi = dni * np.cos(np.radians(zen)) + dhi
        e0 = float(pirr.get_extra_radiation(pd.DatetimeIndex([pd.Timestamp("2026-01-01") + pd.Timedelta(days=doy - 1)]),
                                            solar_constant=1366.1, method="spencer").iloc[0])
        comp = pirr.haydavies(tilt, az, dhi, dni, e0, zen, saz, return_components=True)
        aoi = float(pirr.aoi(tilt, az, zen, saz))
        ground = float(pirr.get_ground_diffuse(tilt, ghi, albedo=ALBEDO["value"]))
        ib = float(piam.martin_ruiz(aoi, a_r=IAM["ar"]))
        dif = piam.martin_ruiz_diffuse(tilt, a_r=IAM["ar"])
        rows.append({"tilt": tilt, "az": az, "zen": zen, "saz": saz, "dni": dni, "dhi": dhi, "ghi": float(ghi), "doy": doy, "e0": e0,
                     "aoi": aoi, "circ": float(comp["poa_circumsolar"]), "iso": float(comp["poa_isotropic"]), "ground": ground,
                     "iamBeam": ib, "iamSky": float(dif["sky"]), "iamGround": float(dif["ground"])})
    return rows


def build_params(sdm):
    """Parametros fisicos compartidos con el servidor Python (server/contract/v1/physics.json). Fuente unica."""
    return {
        "version": 1, "pvlibVersion": pvlib.__version__, "site": SITE, "tz": TZ,
        "sdm": sdm,
        "thermal": THERMAL, "iam": IAM, "albedo": ALBEDO, "sensors": SENSORS,
        "module": {"areaM2": 2.278 * 1.134, "Wp": sdm["Wp"]},
    }


def build_check():
    """Posiciones solares de pvlib en instantes de referencia (UTC) para validar el JS."""
    loc = location.Location(SITE["lat"], SITE["lon"], tz="UTC", altitude=SITE["alt"])
    stamps = pd.DatetimeIndex([
        "2026-03-20 18:00", "2026-06-21 17:00", "2026-06-21 22:30",
        "2026-09-23 19:15", "2026-12-21 16:00", "2026-12-21 20:40", "2026-05-04 15:30",
    ], tz="UTC")
    sp = loc.get_solarposition(stamps)
    return [{"utc": ts.isoformat(), "ms": int(ts.value // 10**6), "zenith": float(z), "azimuth": float(a)}
            for ts, z, a in zip(stamps, sp["zenith"], sp["azimuth"])]


def main():
    sdm = build_sdm()
    data = {"site": SITE, "pvlibVersion": pvlib.__version__, "tz": TZ,
            "clearsky": build_clearsky(), "sdm": sdm, "ivcheck": build_ivcheck(sdm), "check": build_check(),
            "thermal": THERMAL, "iam": IAM, "albedo": ALBEDO, "sensors": SENSORS, "poacheck": build_poacheck()}
    out = pathlib.Path(__file__).resolve().parent.parent / "data" / "pvlib_tuxtla.js"
    out.parent.mkdir(exist_ok=True)
    js = ("/* Generado por tools/gen_pvlib_data.py con pvlib %s. No editar a mano. */\n"
          "window.LAB = window.LAB || {}; LAB.data = LAB.data || {};\n"
          "LAB.data.pvlib = %s;\n") % (pvlib.__version__, json.dumps(data, separators=(",", ":")))
    out.write_text(js)
    phys = pathlib.Path(__file__).resolve().parent.parent.parent / "server" / "contract" / "v1" / "physics.json"
    phys.parent.mkdir(parents=True, exist_ok=True)
    phys.write_text(json.dumps(build_params(sdm), indent=2, ensure_ascii=False) + "\n")
    print("OK", phys)
    c = data["clearsky"]
    peak = max(max(r) for r in c["ghi"])
    print("OK", out, f"{out.stat().st_size/1024:.1f} KB; GHI max {peak} W/m2; SDM:", data["sdm"])


if __name__ == "__main__":
    main()
