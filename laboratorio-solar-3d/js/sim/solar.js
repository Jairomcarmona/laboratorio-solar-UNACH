/* Geometria solar y recurso solar.
 * - position(): algoritmo NOAA (equivalente a pvlib 'nrel_numpy' a ~0.01 deg; se valida contra pvlib en tools/test_solar.js)
 * - clearsky(): tabla de cielo despejado generada con pvlib (Solis simplificado) para Tuxtla
 * - poa(): irradiancia en el plano del modulo (haz + Hay-Davies + albedo, con IAM de Martin-Ruiz)
 */
(function () {
  'use strict';
  const { D2R, R2D, clamp } = LAB.util;
  const cfg = LAB.config;

  /** Posicion solar. ms = milisegundos UTC. Devuelve azimut (desde el norte, horario), elevacion y cenit en grados. */
  function position(ms, lat = cfg.site.lat, lon = cfg.site.lon) {
    const jd = ms / 86400000 + 2440587.5;
    const T = (jd - 2451545.0) / 36525.0;
    const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const Mr = M * D2R;
    const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
      Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289;
    const trueLong = L0 + C;
    const omega = 125.04 - 1934.136 * T;
    const lambda = (trueLong - 0.00569 - 0.00478 * Math.sin(omega * D2R)) * D2R;
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = (eps0 + 0.00256 * Math.cos(omega * D2R)) * D2R;
    const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
    const y = Math.tan(eps / 2) ** 2;
    const L0r = L0 * D2R;
    const eqTime = 4 * R2D * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));
    const utcMin = ((ms % 86400000) + 86400000) % 86400000 / 60000;
    const tst = (((utcMin + eqTime + 4 * lon) % 1440) + 1440) % 1440;
    const H = (tst / 4 - 180) * D2R;
    const latr = lat * D2R;
    const cosZ = clamp(Math.sin(latr) * Math.sin(decl) + Math.cos(latr) * Math.cos(decl) * Math.cos(H), -1, 1);
    const zenith = Math.acos(cosZ) * R2D;
    const az = ((Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(latr) - Math.tan(decl) * Math.cos(latr)) * R2D + 180) % 360 + 360) % 360;
    const el = 90 - zenith;
    return { az, el, zenith, declination: decl * R2D, eqTime };
  }

  /** Vector unitario hacia el Sol en ejes de la escena (+X este, +Y arriba, -Z norte) */
  function sunVector(az, el) {
    const a = az * D2R, e = el * D2R;
    return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
  }

  /** Normal de un plano con inclinacion 'tilt' orientado hacia 'az' (mismos ejes de escena) */
  function normalVector(az, tilt) {
    const a = az * D2R, b = tilt * D2R;
    return [Math.sin(b) * Math.sin(a), Math.cos(b), -Math.sin(b) * Math.cos(a)];
  }

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /** Cielo despejado interpolado de la tabla pvlib. Devuelve {ghi, dni, dhi} en W/m2 */
  function clearsky(localT, sunEl) {
    const tab = LAB.data.pvlib && LAB.data.pvlib.clearsky;
    if (sunEl <= 0) return { ghi: 0, dni: 0, dhi: 0 };
    if (!tab) return clearskyFallback(sunEl);
    const days = tab.days, nT = tab.ghi[0].length, step = tab.minutesStep;
    const doy = localT.dayOfYear;
    // dia: interpolacion circular entre muestras cada 15 dias
    let i1 = days.findIndex((d) => d > doy);
    let i0, w;
    if (i1 === -1) { i0 = days.length - 1; i1 = 0; w = (doy - days[i0]) / (days[0] + 365 - days[i0]); }
    else if (i1 === 0) { i0 = days.length - 1; w = (doy + 365 - days[i0]) / (days[0] + 365 - days[i0]); }
    else { i0 = i1 - 1; w = (doy - days[i0]) / (days[i1] - days[i0]); }
    // hora
    const f = localT.hours * 60 / step;
    const k0 = Math.floor(f) % nT, k1 = (k0 + 1) % nT, wt = f - Math.floor(f);
    const out = {};
    for (const key of ['ghi', 'dni', 'dhi']) {
      const row0 = tab[key][i0], row1 = tab[key][i1];
      const a = row0[k0] * (1 - wt) + row0[k1] * wt;
      const b = row1[k0] * (1 - wt) + row1[k1] * wt;
      out[key] = a * (1 - w) + b * w;
    }
    return out;
  }

  function clearskyFallback(el) {
    const s = Math.sin(el * D2R);
    const ghi = 1098 * s * Math.exp(-0.057 / Math.max(s, 0.02));
    const dni = 900 * Math.exp(-0.2 / Math.max(s, 0.05));
    return { ghi, dni, dhi: Math.max(0, ghi - dni * s) };
  }

  /** Efecto de las nubes (Kasten-Czeplak para GHI; DNI cae mas rapido). cloud en [0,1]; flicker anade pasos de nube */
  function applyClouds(cs, cloud, sunEl, flicker = 0) {
    const s = Math.max(Math.sin(sunEl * D2R), 0.02);
    const c = clamp(cloud, 0, 1);
    const ghiK = 1 - 0.75 * Math.pow(c, 3.4);
    const dniK = clamp(Math.pow(1 - c, 1.7) + flicker * 4 * c * (1 - c), 0, 1);
    const ghi = cs.ghi * ghiK;
    const dni = cs.dni * dniK;
    const dhi = Math.max(ghi - dni * s, 0);
    return { ghi: Math.max(ghi, dni * s + dhi), dni, dhi };
  }

  /** Irradiancia extraterrestre normal (W/m2), metodo Spencer como pvlib (constante solar 1366.1 W/m2) */
  function extraRadiation(dayOfYear) {
    const B = 2 * Math.PI * (dayOfYear - 1) / 365;
    return 1366.1 * (1.00011 + 0.034221 * Math.cos(B) + 0.00128 * Math.sin(B) + 0.000719 * Math.cos(2 * B) + 0.000077 * Math.sin(2 * B));
  }

  /** IAM de Martin-Ruiz para la componente directa (y circunsolar), igual que pvlib.iam.martin_ruiz */
  function iam(cosAoi, ar = cfg.module.iamAr) {
    if (!(cosAoi > 0)) return 0;
    return (1 - Math.exp(-cosAoi / ar)) / (1 - Math.exp(-1 / ar));
  }

  /** IAM de Martin-Ruiz para la difusa de cielo y la reflejada por el suelo, igual que pvlib.iam.martin_ruiz_diffuse */
  function iamDiffuse(tiltDeg, ar = cfg.module.iamAr) {
    const c1 = 0.4244, c2 = 0.5 * ar - 0.154;
    const tilt = tiltDeg === 0 ? 1e-6 : tiltDeg === 180 ? 180 - 1e-6 : tiltDeg;
    const beta = tilt * D2R;
    const sinB = tilt < 90 ? Math.sin(beta) : Math.sin(Math.PI - beta);
    const tSky = sinB + (Math.PI - beta - sinB) / (1 + Math.cos(beta));
    const tGnd = sinB + (beta - sinB) / (1 - Math.cos(beta));
    return { sky: 1 - Math.exp(-(c1 + c2 * tSky) * tSky / ar), ground: 1 - Math.exp(-(c1 + c2 * tGnd) * tGnd / ar) };
  }

  /** Irradiancia en el plano (W/m2) y desglose: transposicion Hay-Davies (como pvlib.irradiance.haydavies) + IAM de Martin-Ruiz.
   *  irr = {ghi, dni, dhi, e0?}; sunVec/normal en ejes de escena. 'raw' son los componentes sin IAM; el resto, con IAM. */
  function poa(irr, sunVec, normal, tilt, albedo = cfg.site.albedo) {
    const cosAoi = Math.max(0, dot(sunVec, normal));
    const aoi = Math.acos(Math.min(1, cosAoi)) * R2D;
    const cosZ = Math.max(sunVec[1], 0.01745);
    const e0 = irr.e0 || 1361;
    const A = clamp(irr.dni / e0, 0, 1);
    const cb = Math.cos(tilt * D2R);
    const rb = cosAoi / cosZ;
    const raw = {
      beam: irr.dni * cosAoi,
      circ: Math.max(irr.dhi * A * rb, 0),
      iso: Math.max(irr.dhi * (1 - A) * (1 + cb) / 2, 0),
      ground: irr.ghi * albedo * (1 - cb) / 2,
    };
    const ib = iam(cosAoi), id = iamDiffuse(tilt);
    const beam = raw.beam * ib, circ = raw.circ * ib, iso = raw.iso * id.sky, ground = raw.ground * id.ground;
    return { total: beam + circ + iso + ground, beam, circ, iso, sky: circ + iso, ground, raw, iamBeam: ib, iamSky: id.sky, iamGround: id.ground, aoi, cosAoi };
  }

  LAB.sim.solar = { position, sunVector, normalVector, clearsky, applyClouds, poa, iam, iamDiffuse, extraRadiation, dot };
})();
