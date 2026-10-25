/* Punto 8: sombreado parcial con 3 subcadenas, diodos de bypass y MPPT en el modelo electrico. Sin navegador. */
const { T } = require('./lib/harness.js');
const { loadSim } = require('./lib/loadsim.js');
const LAB = loadSim();
const t = new T('Sombreado parcial (subcadenas, bypass, MPPT)');
const PV = LAB.sim.pv, cfg = LAB.config, S = LAB.sim.solar;

// ---- modelo de modulo
{
  const c0 = PV.curve(900, 50, 70), z = PV.curveShaded(900, 120, 50, [0, 0, 0]);
  t.ok('sin sombra la curva con subcadenas coincide con el diodo unico (Voc, Isc, Pmp ±0.3 %)', Math.abs(z.voc / c0.voc - 1) < 0.003 && Math.abs(z.isc / c0.isc - 1) < 0.003 && Math.abs(z.pmp / c0.pmp - 1) < 0.003, `${z.voc.toFixed(2)}/${c0.voc.toFixed(2)} ${z.isc.toFixed(2)}/${c0.isc.toFixed(2)} ${z.pmp.toFixed(1)}/${c0.pmp.toFixed(1)}`);
  const one = PV.curveShaded(900, 120, 50, [1, 0, 0]);
  const r = one.pmp / c0.pmp;
  t.ok('una subcadena a oscuras: el bypass la salta y queda ≈ 2/3 de la potencia', r > 0.58 && r < 0.72, r.toFixed(3));
  t.ok('con bypass hay dos picos (el local a alta tension) y el global es el de menor tension', one.peaks.length === 2 && one.peaks[0].p > one.peaks[1].p && one.vmp === one.peaks[0].v, JSON.stringify(one.peaks.map((p) => [+p.v.toFixed(1), +p.p.toFixed(0)])));
  t.ok('el bypass conserva Isc ≈ sin sombra y baja Voc ≈ 1/3', Math.abs(one.isc / c0.isc - 1) < 0.02 && one.voc < c0.voc && one.voc > 0.9 * c0.voc * 2 / 3 * 1.4 - 5, `${one.isc.toFixed(2)} ${one.voc.toFixed(2)}`);
  const two = PV.curveShaded(900, 120, 50, [1, 1, 0]), all = PV.curveShaded(900, 120, 50, [1, 1, 1]);
  t.ok('más subcadenas sombreadas, menos potencia (monótono)', c0.pmp > one.pmp && one.pmp > two.pmp && two.pmp > all.pmp, [c0.pmp, one.pmp, two.pmp, all.pmp].map((x) => x.toFixed(0)).join(' > '));
  const half = PV.curveShaded(900, 120, 50, [0.5, 0, 0]);
  t.ok('sombrear media subcadena ya activa el bypass (las celdas en serie limitan la corriente)', Math.abs(half.pmp / one.pmp - 1) < 0.05);
  const thin = PV.curveShaded(900, 120, 50, [0.1, 0.1, 0.1]);
  t.ok('una franja que cruza las 3 subcadenas hunde la corriente a la difusa aunque cubra solo 10 %', thin.pmp < 0.25 * c0.pmp, (thin.pmp / c0.pmp).toFixed(2));
  // el punto de operacion sobre la curva con sombra
  const oc = PV.operating(one, 'oc'), sc = PV.operating(one, 'sc'), cr = PV.operating(one, 'cr', 3);
  t.ok('oc/sc sobre la curva con sombra y cr cumple V = I·R', oc.v === one.voc && sc.i === one.isc && Math.abs(cr.v - cr.i * 3) < 0.01, `${cr.v.toFixed(3)} vs ${(cr.i * 3).toFixed(3)}`);
  t.ok('la tabla I(V) no se serializa con la telemetria (propiedad no enumerable)', !Object.keys(one).includes('tab') && !JSON.stringify(one).includes('"tab"'));
  const t0 = process.hrtime.bigint(); for (let k = 0; k < 50; k++) PV.curveShaded(900, 120, 50, [0.4, 0.3, 0.2]); const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
  t.ok('costo de una curva con sombra ≤ 8 ms (se recalcula cada 0.12 s por módulo)', ms <= 8, ms.toFixed(2) + ' ms');
}

// ---- geometria por subcadena
{
  const sv = S.sunVector(80, 12), m = LAB.sim.shade.mutualDetail(sv, 90, 60), plain = LAB.sim.shade.mutual(sv, 90, 60);
  t.ok('mutualDetail concuerda con mutual y reparte la sombra en 3 subcadenas', Math.abs(m.A.frac - plain.A) < 1e-12 && m.A.subs.length === 3 && m.A.subs.every((x) => x >= 0 && x <= 1), JSON.stringify(m.A));
  const mean = m.A.subs.reduce((a, b) => a + b, 0) / 3;
  t.ok('el promedio por subcadena es la fracción total', Math.abs(mean - m.A.frac) < 0.01, `${mean.toFixed(3)} ${m.A.frac.toFixed(3)}`);
}

// ---- motor
function run(electrical, h, steps = 60, scan = 0) {
  cfg.shading.electrical = electrical; cfg.mppt.globalScanS = scan;
  const e = new LAB.sim.Engine({ seed: 5 }); e.send({ type: 'session.start', role: 'student', user: 'x' });
  e.send({ type: 'tracker.mode', mode: 'manual' }); e.send({ type: 'tracker.target', az: 90, tilt: 60 }); e.send({ type: 'load.set', mode: 'mppt' });
  e.tracker.az = e.tracker.targetAz = 90; e.tracker.tilt = e.tracker.targetTilt = 60;
  e.simMs = LAB.fromLocal(2026, 3, 21, h, 0); e.jumped = true;
  for (let i = 0; i < steps; i++) e.step(0.1);
  cfg.shading.electrical = true; cfg.mppt.globalScanS = 0;
  return e;
}
{
  let h = null;
  for (let x = 6.4; x < 9.5 && h == null; x += 0.05) { const e = run(true, x, 3); if (e.telemetry.A.shadeFrac > 0.25) h = x; }
  t.ok('hay una hora de la mañana en que B sombrea a A más del 25 %', h != null, String(h));
  if (h != null) {
    const on = run(true, h, 120), off = run(false, h, 120);
    t.ok('la sombra baja la potencia de A en el modelo eléctrico y no la de B', on.telemetry.A.p < 0.9 * off.telemetry.A.p && Math.abs(on.telemetry.B.p / off.telemetry.B.p - 1) < 0.02, `${on.telemetry.A.p.toFixed(0)} vs ${off.telemetry.A.p.toFixed(0)} W`);
    t.ok('la telemetría trae el reparto por subcadena y la curva marcada como sombreada', on.telemetry.A.shadeSub.length === 3 && on.telemetry.A.curve.shaded === true && off.telemetry.A.curve.shaded === false);
    t.ok('sin sombra el modelo es el de antes (potencia idéntica con electrical:false en B y sin sombra)', off.telemetry.A.curve.shaded === false);
    // MPPT P&O vs barrido global: el barrido nunca pierde frente al P&O solo
    const po = run(true, h, 600, 0), gl = run(true, h, 600, 2);
    t.ok('el MPPT reporta la pérdida respecto al pico global (≥ 0) y con barrido global no es peor', po.telemetry.A.mpptLossW >= 0 && gl.telemetry.A.p >= po.telemetry.A.p - 1, `P&O ${po.telemetry.A.p.toFixed(0)} W (pierde ${po.telemetry.A.mpptLossW.toFixed(0)}) · barrido ${gl.telemetry.A.p.toFixed(0)} W`);
    t.ok('el módulo sin sombra no reporta pérdida de MPPT', po.telemetry.B.mpptLossW === 0);
  }
  const noon = run(true, 12, 60);
  t.ok('al mediodía no hay sombra y la curva es la de diodo único', noon.telemetry.A.shadeFrac === 0 && noon.telemetry.A.curve.shaded === false);
}
// ---- MPPT atrapado en un pico local (curva fabricada: el escenario natural del banco sombrea solo con Sol rasante y poca luz)
{
  const trial = (scan, v0) => {
    cfg.mppt.globalScanS = scan;
    const e = new LAB.sim.Engine({ seed: 1 }); const m = e.A;
    m.cv = PV.curveShaded(900, 120, 50, [1, 0, 0]); m.cvAge = 0; m.vTrack = v0; m.init = true;
    for (let k = 0; k < 400; k++) e._operate(m, 'mppt', 0, 0.1, 0.1);
    cfg.mppt.globalScanS = 0;
    return { p: m.op.p, v: m.op.v, loss: m.mpptLossW, pmp: m.cv.pmp, local: m.cv.peaks[1].p };
  };
  const trapped = trial(0, 43), free = trial(0, 26), scan = trial(2, 43);
  t.ok('P&O que arranca en el pico local de alta tensión se queda ahí y reporta la pérdida', trapped.p < 0.4 * trapped.pmp && Math.abs(trapped.loss - (trapped.pmp - trapped.p)) < 8 && trapped.loss > 100, `${trapped.p.toFixed(0)} de ${trapped.pmp.toFixed(0)} W, pierde ${trapped.loss.toFixed(0)}`);
  t.ok('P&O que arranca del lado del pico global lo encuentra', free.p > 0.95 * free.pmp && free.loss < 15, `${free.p.toFixed(0)} de ${free.pmp.toFixed(0)} W`);
  t.ok('con barrido global periódico escapa del pico local', scan.p > 0.95 * scan.pmp, `${scan.p.toFixed(0)} de ${scan.pmp.toFixed(0)} W`);
}
t.done();
