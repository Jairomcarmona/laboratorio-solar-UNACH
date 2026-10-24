/* Sombra mutua entre los modulos A y B (S6): oclusion GEOMETRICA analitica, sin Three.js.
 * Para un modulo receptor se toma una malla de 7x5 puntos sobre su cara, se lanza el rayo hacia el Sol y se comprueba si
 * cruza el rectangulo del otro modulo. Mide solo geometria: NO entra al modelo electrico (eso es O4).
 * Ejes de escena: +X este, +Y arriba, -Z norte (igual que solar.js). Las posiciones salen de LAB.config.shadeSites(). */
(function () {
  'use strict';
  const { D2R } = LAB.util;
  const S = LAB.sim.solar;
  const NX = 7, NZ = 5, EDGE = 0.96;      // misma malla y margen que tools/shade_scan.js

  /** Rectangulo de un modulo: centro, normal, eje largo e (hacia abajo de la pendiente) eje corto */
  function rect(center, az, tilt) {
    const m = LAB.config.module;
    const a = az * D2R, b = tilt * D2R;
    return {
      c: center, n: S.normalVector(az, tilt),
      e1: [Math.cos(a), 0, Math.sin(a)],
      e2: [Math.cos(b) * Math.sin(a), -Math.sin(b), -Math.cos(b) * Math.cos(a)],
      hl: m.long / 2, hs: m.short / 2,
    };
  }

  /** Centros de los modulos segun la distribucion y la orientacion actual (B: sobre el eje de inclinacion) */
  function rectA() {
    const L = LAB.config.shadeSites(), f = LAB.config.fixed, m = LAB.config.module;
    const yc = 0.58 + (m.short / 2) * Math.sin(f.tilt * D2R);
    return rect([L.moduleA[0], L.moduleA[1] + yc, L.moduleA[2]], f.az, f.tilt);
  }
  function rectB(az, tilt) {
    const L = LAB.config.shadeSites(), E = { axisY: L.axisY };
    const n = S.normalVector(az, tilt), off = 0.1;     // 0.062 + 0.02 + espesor/2 sobre los rieles
    return rect([L.moduleB[0] + off * n[0], E.axisY + off * n[1], L.moduleB[2] + off * n[2]], az, tilt);
  }

  /** Fraccion (0-1) de la cara de 'target' sombreada por 'caster'. sunVec unitario hacia el Sol. */
  function fraction(sunVec, target, caster) {
    const sn = S.dot(sunVec, target.n);
    if (sn <= 0.02) return 0;                          // la cara no ve el Sol: no hay sombra que medir
    const den = S.dot(sunVec, caster.n);
    if (Math.abs(den) < 1e-9) return 0;
    let shaded = 0;
    for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
      const u = (i / (NX - 1) - 0.5) * 2 * target.hl * EDGE, v = (j / (NZ - 1) - 0.5) * 2 * target.hs * EDGE;
      const p = [0, 1, 2].map((k) => target.c[k] + u * target.e1[k] + v * target.e2[k] + 0.03 * target.n[k]);
      const d = [0, 1, 2].map((k) => caster.c[k] - p[k]);
      const t = S.dot(d, caster.n) / den;
      if (t <= 0.02) continue;
      const q = [0, 1, 2].map((k) => p[k] + t * sunVec[k] - caster.c[k]);
      if (Math.abs(S.dot(q, caster.e1)) <= caster.hl && Math.abs(S.dot(q, caster.e2)) <= caster.hs) shaded++;
    }
    return shaded / (NX * NZ);
  }

  /** Fracciones mutuas {A: sombra de B sobre A, B: sombra de A sobre B} para la orientacion actual de B */
  function mutual(sunVec, azB, tiltB) {
    const a = rectA(), b = rectB(azB, tiltB);
    return { A: fraction(sunVec, a, b), B: fraction(sunVec, b, a) };
  }

  LAB.sim.shade = { rect, rectA, rectB, fraction, mutual, GRID: NX * NZ };
})();
