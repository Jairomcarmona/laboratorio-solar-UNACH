/* S13: funciones puras de analisis con corridas sinteticas de pendiente conocida (error de pendiente <= 0.5 %). */
const { T } = require('./lib/harness.js');
const { loadSim } = require('./lib/loadsim.js');
const LAB = loadSim();
const t = new T('Analisis (S13)');
const COLS = LAB.core.RUN_COLS;
const T0 = LAB.fromLocal(2026, 10, 23, 9, 0);
function run(rows) {
  const samples = rows.map((r, n) => COLS.map((c) => (c === 'n' ? n : c === 'segmentId' ? (r.seg || 's1') : c === 'simMs' ? (r.simMs != null ? r.simMs : T0 + n * 1000) : c === 'realMs' ? T0 + n * 1000 : r[c] != null ? r[c] : (c === 'loadMode' ? 'mppt' : c === 'trMode' ? 'astro' : c === 'safety' ? 'NORMAL' : 0))));
  return { id: 'r', samples, segments: [], events: [] };
}
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.abs(b);

{ // iscVsG: Isc = 0.0129*G + 0.01
  const rows = []; for (let g = 100; g <= 1000; g += 10) rows.push({ loadMode: 'sc', gB: g, iB: 0.0129 * g + 0.01 });
  rows.push({ loadMode: 'mppt', gB: 500, iB: 99 });                       // fuera de cortocircuito: no entra
  const r = LAB.core.iscVsG(run(rows), 'B');
  t.ok('iscVsG: pendiente exacta dentro de 0.5 %', near(r.fit.slope, 0.0129, 0.005) && Math.abs(r.fit.intercept - 0.01) < 1e-9 && r.fit.r2 > 0.999999 && r.points.length === 91, JSON.stringify(r.fit));
}
{ // vocVsT: Voc = 49.5 - 0.1287 (T-25), con ruido determinista pequeno
  const rows = []; for (let i = 0; i < 200; i++) { const T_ = 25 + i * 0.25; rows.push({ loadMode: 'oc', tcB: T_, vB: 49.5 - 0.1287 * (T_ - 25) + 0.01 * Math.sin(i) }); }
  const r = LAB.core.vocVsT(run(rows), 'B');
  t.ok('vocVsT: pendiente = coeficiente de Voc dentro de 0.5 %', near(r.fit.slope, -0.1287, 0.005) && r.fit.r2 > 0.999, JSON.stringify(r.fit));
}
{ // thermalVsWind: y = 0.04 - 0.002 v con G estable; una parte con G variable debe quedar fuera
  const rows = []; let k = 0;
  for (let s = 0; s < 1800; s++) { const v = 1 + (s % 600) / 100; rows.push({ gB: 800, tcB: 30 + 800 * (0.04 - 0.002 * v), ta: 30, wind: v }); k++; }
  for (let s = 0; s < 600; s++) rows.push({ gB: 500 + 400 * Math.sin(s / 20), tcB: 60, ta: 30, wind: 3 });          // inestable
  for (let s = 0; s < 600; s++) rows.push({ gB: 300, tcB: 60, ta: 30, wind: 3 });                                  // G < 400
  const r = LAB.core.thermalVsWind(run(rows), 'B');
  t.ok('thermalVsWind: pendiente -0.002 dentro de 0.5 %', near(r.fit.slope, -0.002, 0.005) && near(r.fit.intercept, 0.04, 0.005), JSON.stringify(r.fit));
  t.ok('thermalVsWind: excluye G inestable, G < 400 y los primeros 5 min', r.points.length > 1400 && r.points.length <= 1500 && r.points.every((p) => p.n >= 300 && p.n < 1800), `n=${r.points.length}`);
}
{ // dailyPR: P = P0 * PR0 * G/1000 constante => PR = PR0; PR_T = PR0/(1+gamma(T-25)) con T=45
  const P0 = LAB.config.module.Wp, rows = [];
  for (let s = 0; s <= 3600; s++) rows.push({ gB: 800, pB: P0 * 0.8 * 0.8, tcB: 45 });
  const r = LAB.core.dailyPR(run(rows), 'B');
  const d = r.days[0], gam = r.gamma;
  t.ok('dailyPR: PR = 0.8 y H = 0.8 kWh/m2 en 1 h', Math.abs(d.PR - 0.8) < 0.002 && Math.abs(d.H - 0.8) < 0.002, JSON.stringify(d));
  t.ok('dailyPR: PR_T corrige por temperatura', Math.abs(d.PRT - 0.8 / (1 + gam * 20)) < 0.002, `PRT=${d.PRT}`);
  const gap = rows.slice(); gap.push({ simMs: T0 + 5 * 3600000, gB: 800, pB: 300, tcB: 45 });
  t.ok('dailyPR: un salto del reloj no se integra', Math.abs(LAB.core.dailyPR(run(gap), 'B').days[0].H - d.H) < 1e-9);
}
{ // S14: k = sum(PB)/sum(PA) con muestras validas; ganancia corregida
  const mk = (n, gA, gB, pA, pB) => { const r = []; for (let i = 0; i < n; i++) r.push({ gA, gB, pA, pB }); return r; };
  const ok = LAB.core.calibration.fromRun(run(mk(700, 800, 800, 200, 206)));
  t.ok('calibracion: k = 1.03 con 700 muestras validas', ok.ok && Math.abs(ok.k - 1.03) < 1e-9 && ok.nValid === 700 && /pendiente/.test(ok.uncertaintyNote), JSON.stringify(ok));
  const few = LAB.core.calibration.fromRun(run(mk(500, 800, 800, 200, 206).concat(mk(300, 100, 100, 50, 60))));
  t.ok('calibracion: G<=300 no cuenta y con <600 validas no hay k', !few.ok && few.nValid === 500 && few.k === null && /500 de 600/.test(few.reason), few.reason);
  const unsafe = LAB.core.calibration.fromRun(run(mk(700, 800, 800, 200, 206).map((r, i) => (i < 200 ? { ...r, safety: 'WIND_STOW' } : r))));
  t.eq('calibracion: muestras con seguridad distinta de NORMAL se excluyen', unsafe.nValid, 500);
  LAB.core.calibration.save({ k: 1.03, nValid: 700, dateIso: '2026-10-23T12:00:00Z' });
  const g = LAB.core.calibration.correctedGainPct(100, 118.5, LAB.core.calibration.get());
  t.ok('ganancia corregida = E_B/(k E_A) - 1', Math.abs(g.v - (118.5 / 1.03 / 100 - 1) * 100) < 1e-9 && g.v < 18.5, String(g.v));
  LAB.core.calibration.clear();
  t.ok('sin calibracion la ganancia corregida es null y lo dice', LAB.core.calibration.correctedGainPct(100, 118, null).v === null);
}
t.ok('linfit: <2 puntos o x constante => null', LAB.core.linfit([{ x: 1, y: 1 }]) === null && LAB.core.linfit([{ x: 1, y: 1 }, { x: 1, y: 2 }]) === null);
t.done();
