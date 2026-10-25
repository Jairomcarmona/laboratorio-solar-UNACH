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
    if (G < 2) return { d, voc: 0, isc: 0, vmp: 0, imp: 0, pmp: 0, v: [0], i: [0], p: [0], shaded: false };
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
    return { d, voc, isc, vmp, imp, pmp: vmp * imp, v, i, p, shaded: false };
  }

  /** Tension del modulo completo para la corriente I (Newton en V con biseccion de respaldo). Admite I mayor que IL: tension negativa (polarizacion inversa por la derivacion). */
  function voltageAt(I, d) {
    let lo = -3000, hi = d.a * 60;
    let V = d.IL - I > 0 ? d.a * Math.log((d.IL - I) / d.Io + 1) - I * d.Rs : -(I - d.IL) * d.Rsh - I * d.Rs;
    for (let k = 0; k < 60; k++) {
      const x = (V + I * d.Rs) / d.a, e = Math.exp(Math.min(x, 80));
      const f = d.IL - d.Io * (e - 1) - (V + I * d.Rs) / d.Rsh - I;
      if (f > 0) lo = V; else hi = V;
      const df = -d.Io * e / d.a - 1 / d.Rsh;
      let nV = V - f / df;
      if (!(nV > lo && nV < hi)) nV = 0.5 * (lo + hi);
      if (Math.abs(nV - V) < 1e-9) { V = nV; break; }
      V = nV;
    }
    return V;
  }

  /** Curva I-V con sombra parcial. El modulo son 3 subcadenas en serie (un diodo de bypass cada una); 'subs' es la fraccion sombreada
   *  de cada subcadena (0-1). Las celdas sombreadas reciben solo Gsh (difusa, sin haz); en serie comparten corriente, asi que
   *  V_sub(I) = ((1-s)·V(I;G) + s·V(I;Gsh))/3 (las celdas de un grupo escalan a, Rs y Rsh por igual) y el bypass fija V_sub ≥ -Vd.
   *  El resultado puede tener varios maximos locales. Mismo formato que curve() + peaks, subs y la tabla I(V) para interpolar. */
  function curveShaded(G, Gsh, Tc, subs, n = 160) {
    const dU = diodeParams(G, Tc), dS = diodeParams(Math.min(Gsh, G), Tc), Vd = (LAB.config.shading && LAB.config.shading.bypassV) || 0.5;
    const Imax = dU.IL + 0.05;
    const volt = (I) => { const vu = voltageAt(I, dU), vs = voltageAt(I, dS); let V = 0; for (let k = 0; k < 3; k++) V += Math.max(((1 - subs[k]) * vu + subs[k] * vs) / 3, -Vd); return V; };
    const Is = [], Vs = [];
    for (let j = 0; j < n; j++) { const I = Imax * j / (n - 1); Is.push(I); Vs.push(volt(I)); }
    const voc = Math.max(0.1, Vs[0]);
    // Isc: la corriente donde V(I) cruza cero (V decrece con I)
    let isc = 0;
    for (let j = 1; j < n; j++) if (Vs[j] <= 0) { let a = Is[j - 1], b = Is[j]; for (let k = 0; k < 40; k++) { const m = 0.5 * (a + b); if (volt(m) > 0) a = m; else b = m; } isc = 0.5 * (a + b); break; }
    if (isc === 0) isc = Imax;
    const v = [0], i = [isc], p = [0];
    for (let j = n - 1; j >= 0; j--) if (Vs[j] > 0 && Is[j] < isc) { v.push(Vs[j]); i.push(Is[j]); p.push(Vs[j] * Is[j]); }
    // maximos locales de P(I) (refinados) y el global
    const P = (I) => I * volt(I), peaks = [];
    for (let j = 1; j < n - 1; j++) {
      const pj = Is[j] * Math.max(Vs[j], 0);
      if (pj > Is[j - 1] * Math.max(Vs[j - 1], 0) && pj >= Is[j + 1] * Math.max(Vs[j + 1], 0) && pj > 0) {
        let a = Is[j - 1], b = Is[j + 1]; const phi = 0.6180339887;
        let c = b - phi * (b - a), e = a + phi * (b - a), fc = P(c), fe = P(e);
        for (let k = 0; k < 30; k++) { if (fc > fe) { b = e; e = c; fe = fc; c = b - phi * (b - a); fc = P(c); } else { a = c; c = e; fc = fe; e = a + phi * (b - a); fe = P(e); } }
        const I = 0.5 * (a + b); peaks.push({ v: volt(I), i: I, p: P(I) });
      }
    }
    peaks.sort((x, y) => x.v - y.v);
    const best = peaks.reduce((m, x) => (x.p > m.p ? x : m), { v: 0, i: 0, p: 0 });
    const cv = { d: dU, voc, isc, vmp: best.v, imp: best.i, pmp: best.p, v, i, p, shaded: true, peaks, subs: subs.slice() };
    Object.defineProperty(cv, 'tab', { value: { v, i }, enumerable: false });     // tabla I(V) para interpolar; no se serializa con la telemetria
    return cv;
  }

  /** Corriente a tension V sobre la curva (exacta sin sombra; interpolada en la tabla con sombra) */
  function currentOn(cv, V) {
    if (!cv.tab) return currentAt(V, cv.d);
    const tv = cv.tab.v, ti = cv.tab.i, n = tv.length;
    if (V <= tv[0]) return ti[0];
    if (V >= tv[n - 1]) return 0;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tv[m] <= V) lo = m; else hi = m; }
    const f = (V - tv[lo]) / Math.max(tv[hi] - tv[lo], 1e-12);
    return ti[lo] + f * (ti[hi] - ti[lo]);
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
          if (currentOn(cv, mid) > mid / setpoint) lo = mid; else hi = mid;
        }
        const V = 0.5 * (lo + hi), I = Math.max(0, currentOn(cv, V));
        return { v: V, i: I, p: V * I };
      }
      case 'mppt': {
        const V = Math.min(Math.max(vTrack, 0), cv.voc), I = Math.max(0, currentOn(cv, V));
        return { v: V, i: I, p: V * I };
      }
      case 'cv':
      default: {     // setpoint = fraccion de Voc
        const V = cv.voc * Math.min(Math.max(setpoint, 0), 1), I = Math.max(0, currentOn(cv, V));
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

  LAB.sim.pv = { diodeParams, currentAt, voltageAt, curve, curveShaded, currentOn, operating, moduleTempSteady, thermalTau, moduleTempStep, cellFromModule, sdm };
})();
