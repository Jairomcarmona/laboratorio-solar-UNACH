/* Modulo fotovoltaico: modelo de un diodo con escalado De Soto (parametros ajustados con pvlib.ivtools.sdm.fit_desoto con 66 celdas en serie, ver tools/gen_pvlib_data.py).
 * Resuelve la curva I-V, el punto de maxima potencia y puntos de operacion para distintos tipos de carga. */
(function () {
  'use strict';
  const K_EV = 8.617333262e-5;   // eV/K
  const T_REF = 298.15;

  // Parametros por defecto (respaldo si falta data/pvlib_tuxtla.js)
  const FALLBACK = {
    IL: 12.9188, Io: 7.5557e-12, a: 1.7590, Rs: 0.2107, Rsh: 144.51, EgRef: 1.121, dEgdT: -0.0002677,
    Vmp: 41.4, Imp: 12.08, Voc: 49.5, Isc: 12.9, alphaIsc: 0.006192, betaVoc: -0.1287, gammaPmp: -0.305, cellsEff: 66, Wp: 500,
  };
  const sdm = () => (LAB.data.pvlib && LAB.data.pvlib.sdm) || FALLBACK;

  /** Parametros del diodo a irradiancia G (W/m2) y temperatura de celda Tc (C) */
  function diodeParams(G, Tc) {
    const p = sdm();
    const g = Math.max(G, 0.5);
    const Tk = Tc + 273.15;
    const Eg = p.EgRef * (1 + p.dEgdT * (Tk - T_REF));
    return {
      IL: Math.max(0, (g / 1000) * (p.IL + p.alphaIsc * (Tc - 25))),
      Io: p.Io * Math.pow(Tk / T_REF, 3) * Math.exp(p.EgRef / (K_EV * T_REF) - Eg / (K_EV * Tk)),
      a: p.a * Tk / T_REF,
      Rs: p.Rs,
      Rsh: p.Rsh * 1000 / g,
    };
  }

  /** Corriente a tension V (Newton con salvaguarda de biseccion; f es monotona decreciente en I) */
  function currentAt(V, d) {
    let lo = -3, hi = d.IL + 1;
    let I = Math.min(Math.max(d.IL - V / d.Rsh, lo), hi);
    for (let k = 0; k < 40; k++) {
      const x = (V + I * d.Rs) / d.a;
      const e = Math.exp(Math.min(x, 80));
      const f = d.IL - d.Io * (e - 1) - (V + I * d.Rs) / d.Rsh - I;
      if (f > 0) lo = I; else hi = I;
      const df = -d.Io * e * d.Rs / d.a - d.Rs / d.Rsh - 1;
      let nI = I - f / df;
      if (!(nI > lo && nI < hi)) nI = 0.5 * (lo + hi);
      if (Math.abs(nI - I) < 1e-9) { I = nI; break; }
      I = nI;
    }
    return I;
  }

  /** Tension para la que la corriente vale 'target' (I decrece con V) */
  function voltageAtCurrent(target, d, vMax) {
    let lo = -2, hi = vMax;
    for (let k = 0; k < 50; k++) {
      const mid = 0.5 * (lo + hi);
      if (currentAt(mid, d) > target) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  /** Curva I-V/P-V completa y puntos caracteristicos */
  function curve(G, Tc, n = 90) {
    const d = diodeParams(G, Tc);
    if (G < 2) return { d, voc: 0, isc: 0, vmp: 0, imp: 0, pmp: 0, v: [0], i: [0], p: [0] };
    const vmax = sdm().Voc * 1.35;
    const voc = Math.max(0.1, voltageAtCurrent(0, d, vmax));
    const isc = currentAt(0, d);
    const v = [], i = [], p = [];
    for (let k = 0; k < n; k++) {
      // mas puntos cerca de Voc donde la curva se dobla
      const s = k / (n - 1);
      const V = voc * (1 - Math.pow(1 - s, 1.6));
      const I = Math.max(0, currentAt(V, d));
      v.push(V); i.push(I); p.push(V * I);
    }
    // MPP por seccion aurea
    let a = 0, b = voc;
    const phi = 0.6180339887;
    let c = b - phi * (b - a), e = a + phi * (b - a);
    let fc = c * currentAt(c, d), fe = e * currentAt(e, d);
    for (let k = 0; k < 40; k++) {
      if (fc > fe) { b = e; e = c; fe = fc; c = b - phi * (b - a); fc = c * currentAt(c, d); }
      else { a = c; c = e; fc = fe; e = a + phi * (b - a); fe = e * currentAt(e, d); }
    }
    const vmp = 0.5 * (a + b), imp = currentAt(vmp, d);
    return { d, voc, isc, vmp, imp, pmp: vmp * imp, v, i, p };
  }

  /** Punto de operacion segun el tipo de carga:
   *  oc, sc, cv (tension fija), cr (resistencia fija), mppt (tension dada por el seguidor del punto) */
  function operating(cv, mode, setpoint, vTrack) {
    const d = cv.d;
    if (cv.pmp <= 0) return { v: 0, i: 0, p: 0 };
    switch (mode) {
      case 'oc': return { v: cv.voc, i: 0, p: 0 };
      case 'sc': return { v: 0, i: cv.isc, p: 0 };
      case 'cr': {   // setpoint = resistencia en ohm: V = I*R
        let lo = 0, hi = cv.voc;
        for (let k = 0; k < 40; k++) {
          const mid = 0.5 * (lo + hi);
          if (currentAt(mid, d) > mid / setpoint) lo = mid; else hi = mid;
        }
        const V = 0.5 * (lo + hi), I = Math.max(0, currentAt(V, d));
        return { v: V, i: I, p: V * I };
      }
      case 'mppt': {
        const V = Math.min(Math.max(vTrack, 0), cv.voc), I = Math.max(0, currentAt(V, d));
        return { v: V, i: I, p: V * I };
      }
      case 'cv':
      default: {     // setpoint = fraccion de Voc
        const V = cv.voc * Math.min(Math.max(setpoint, 0), 1), I = Math.max(0, currentAt(V, d));
        return { v: V, i: I, p: V * I };
      }
    }
  }

  /** Temperatura de MODULO (cara posterior) en regimen estacionario: Faiman con los valores por defecto de pvlib,
   *  que se obtuvieron para temperatura de modulo (no de celda). La de celda es tback + deltaT*G/1000 (ver engine._module). */
  function moduleTempSteady(poa, Ta, wind, u0 = LAB.config.thermal.u0, u1 = LAB.config.thermal.u1) {
    return Ta + poa / (u0 + u1 * Math.max(wind, 0));
  }
  /** Constante de tiempo (s) del modulo: C / (U0 + U1 v) */
  function thermalTau(wind, th = LAB.config.thermal) {
    return th.C / (th.u0 + th.u1 * Math.max(wind, 0));
  }
  /** Un paso exacto de C dT/dt = (U0+U1 v)(Tss - T): estable para cualquier dt */
  function moduleTempStep(T, poa, Ta, wind, dt, th = LAB.config.thermal) {
    const tss = Ta + poa / (th.u0 + th.u1 * Math.max(wind, 0));
    return tss + (T - tss) * Math.exp(-dt / thermalTau(wind, th));
  }
  /** Temperatura de celda a partir de la del modulo (tabla Sandia: deltaT a 1000 W/m2) */
  const cellFromModule = (tMod, poa, th = LAB.config.thermal) => tMod + th.deltaT * poa / 1000;

  LAB.sim.pv = { diodeParams, currentAt, curve, operating, moduleTempSteady, thermalTau, moduleTempStep, cellFromModule, sdm };
})();
