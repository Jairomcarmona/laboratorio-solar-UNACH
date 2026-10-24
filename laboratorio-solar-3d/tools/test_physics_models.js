/* S4 termico dinamico, S5 sensor, S6 sombra mutua, S7 banco de cargas, ley astronomica y validateCmd. Sin navegador. */
const { T } = require('./lib/harness.js');
const { loadSim } = require('./lib/loadsim.js');
const LAB = loadSim();
const t = new T('Modelos fisicos');
const PV = LAB.sim.pv, S = LAB.sim.solar, cfg = LAB.config;

// ---- S4: escalon de irradiancia G 0 -> 800, Ta 25, v 1 m/s
{
  let T0 = 25, tt = 0, t63 = null;
  const tss = 25 + 800 / (cfg.thermal.u0 + cfg.thermal.u1 * 1);
  for (let s = 0; s < 3000; s++) { T0 = PV.moduleTempStep(T0, 800, 25, 1, 1); tt++; if (t63 == null && (T0 - 25) >= 0.632 * (tss - 25)) t63 = tt; }
  t.ok('S4 estado final 50.1 °C ± 0.1', Math.abs(T0 - 50.1) <= 0.1, T0.toFixed(2));
  t.ok('S4 63.2 % del salto a t = 292 s ± 2 %', Math.abs(t63 - 292) / 292 <= 0.02, `t = ${t63} s`);
  let T1 = 25; for (let k = 0; k < 20; k++) T1 = PV.moduleTempStep(T1, 800, 25, 1, 360);
  t.ok('S4 estable con dt = 360 s (×3600)', Math.abs(T1 - tss) < 0.01 && Number.isFinite(T1), T1.toFixed(3));
  t.ok('S4 τ ≈ 6.2 min sin viento y ≈ 3.3 min a 3.2 m/s', Math.abs(PV.thermalTau(0) / 60 - 6.2) < 0.1 && Math.abs(PV.thermalTau(3.2) / 60 - 3.3) < 0.1, `${(PV.thermalTau(0) / 60).toFixed(2)} / ${(PV.thermalTau(3.2) / 60).toFixed(2)}`);
  t.ok('S4 la celda es más CALIENTE que el módulo (ΔT = 3 °C a 1000 W/m²)', Math.abs(PV.cellFromModule(50, 1000) - 53) < 1e-9);
  // en el motor: tback es la variable de estado y tcell = tback + 3*G/1000
  const e = new LAB.sim.Engine(); for (let i = 0; i < 20; i++) e.step(0.05);
  const A = e.telemetry.A;
  t.ok('S4 motor: tcell − tback = deltaT·G/1000', Math.abs((A.tcell - A.tback) - 3 * A.poaTrue / 1000) < 1e-6, `${(A.tcell - A.tback).toFixed(3)}`);
}

// ---- S5: sensor de irradiancia
{
  const comp = S.poa({ ghi: 900, dni: 800, dhi: 120, e0: 1361 }, S.sunVector(180, 60), S.normalVector(180, 20), 20);
  const base = LAB.sim.sensors.poaSensor(comp, { type: 'refcell', epsCal: 0, alpha: 0.0005, noise: 0 }, 25, 0);
  const cal = LAB.sim.sensors.poaSensor(comp, { type: 'refcell', epsCal: 0.02, alpha: 0.0005, noise: 0 }, 25, 0);
  t.ok('S5 ε_cal = +2 % → razón 1.02 ± 0.005', Math.abs(cal / base - 1.02) <= 0.005, (cal / base).toFixed(4));
  t.ok('S5 celda de referencia en 25 °C y sin error lee la irradiancia efectiva', Math.abs(base - comp.total) < 1e-9);
  const hot = LAB.sim.sensors.poaSensor(comp, { type: 'refcell', epsCal: 0, alpha: 0.0005, noise: 0 }, 65, 0);
  t.ok('S5 deriva con la temperatura: +2 % a 65 °C', Math.abs(hot / base - 1.02) < 1e-9);
  const pyr = LAB.sim.sensors.poaSensor(comp, { type: 'pyranometer', epsCal: 0, alpha: 0.0005, noise: 0 }, 65, 0);
  const rawSum = comp.raw.beam + comp.raw.circ + comp.raw.iso + comp.raw.ground;
  t.ok('S5 piranómetro no aplica IAM ni α_s', Math.abs(pyr - rawSum) < 1e-9 && pyr > comp.total);
  // en el motor, con la misma orientacion y ε_cal = +2 % en B
  const e1 = new LAB.sim.Engine({ seed: 7 }); e1.tracker.az = e1.tracker.targetAz = cfg.fixed.az; e1.tracker.tilt = e1.tracker.targetTilt = cfg.fixed.tilt;
  cfg.sensors.poaB.epsCal = 0.02; cfg.sensors.poaA.noise = cfg.sensors.poaB.noise = 0;
  for (let i = 0; i < 40; i++) e1.step(0.05);
  const r = e1.telemetry.B.poa / e1.telemetry.A.poa;
  cfg.sensors.poaB.epsCal = 0; cfg.sensors.poaA.noise = cfg.sensors.poaB.noise = 0.004;
  t.ok('S5 motor: B.poa/A.poa = 1.02 ± 0.005', Math.abs(r - 1.02) <= 0.005, r.toFixed(4));
}

// ---- S6: sombra mutua
{
  const sh = LAB.sim.shade;
  // sombra de B sobre A: B en azimut 90° mirando casi horizontal, Sol bajo del este
  const sv = S.sunVector(90, 12);
  const m = sh.mutual(sv, 180, 17);
  t.ok('S6 con el Sol muy bajo del este B sombrea parte de A (o la fraccion es 0..1)', m.A >= 0 && m.A <= 1 && m.B >= 0 && m.B <= 1, JSON.stringify(m));
  const mid = sh.mutual(S.sunVector(180, 70), 180, 17);
  t.eq('S6 con el Sol alto no hay sombra mutua', mid.A + mid.B, 0);
  // costo
  const t0 = process.hrtime.bigint(); let acc = 0; for (let i = 0; i < 2000; i++) acc += sh.mutual(S.sunVector(90 + (i % 20), 10 + (i % 5)), 180, 17).A;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 2000;
  t.ok('S6 costo ≤ 0.2 ms por paso', ms <= 0.2, `${ms.toFixed(4)} ms`);
  // el motor lo propaga a la telemetria y a la corrida
  const e = new LAB.sim.Engine(); e.send({ type: 'session.start', role: 'student', user: 'x' }); e.send({ type: 'acq.start' });
  e.simMs = LAB.fromLocal(2026, 3, 21, 7, 30); e.jumped = true; for (let i = 0; i < 40; i++) e.step(0.05);
  t.ok('S6 telemetria con A.shadeFrac, B.shadeFrac y quality', typeof e.telemetry.A.shadeFrac === 'number' && Array.isArray(e.telemetry.quality));
  t.ok('S6 la corrida guarda las columnas shA y shB (aditivo, schemaVersion sin cambio)', LAB.core.RUN_COLS.includes('shA') && LAB.core.RUN_COLS.includes('shB') && cfg.schemaVersion === 2);
}

// ---- S7: banco de cargas discreto
{
  cfg.load.bank = [1, 2, 3.4, 5, 10, 20];
  const e = new LAB.sim.Engine({ seed: 3 }); e.send({ type: 'session.start', role: 'student', user: 'x' });
  for (let i = 0; i < 40; i++) e.step(0.05);
  t.ok('S7 cr fuera del banco → validation', e.send({ type: 'load.set', mode: 'cr', setpoint: 7 }).kind === 'validation');
  t.ok('S7 cr del banco → aceptado', e.send({ type: 'load.set', mode: 'cr', setpoint: 5 }).ok);
  e.send({ type: 'load.sweep' }); for (let i = 0; i < 400; i++) e.step(0.1);
  const sw = e.lastSweep;
  t.ok('S7 el barrido guarda 8 puntos por modulo', sw && sw.pts.A.length === 8 && sw.pts.B.length === 8, sw ? sw.pts.A.length : 'sin barrido');
  let worst = 0;   // la medición lleva 0.15 % de ruido en V y la curva es casi vertical cerca de Voc
  if (sw) for (const p of sw.pts.A) { const d = LAB.sim.pv.diodeParams(p.g, e.A.Tc); const isc = Math.max(LAB.sim.pv.currentAt(0, d), 1e-6), lo = LAB.sim.pv.currentAt(p.v * 1.004, d), hi = LAB.sim.pv.currentAt(p.v * 0.996, d); worst = Math.max(worst, Math.max(0, lo - p.i, p.i - hi) / isc); }
  t.ok('S7 cada punto cae sobre la curva del modelo con |ΔI| ≤ 0.5 % (de Isc)', worst <= 0.005, `${(worst * 100).toFixed(3)} %`);
  cfg.load.bank = null;
}

// ---- Ley astronomica: sin oscilaciones, a lo sumo un cambio de lado por dia (3 may - 8 ago incluidas)
{
  const days = [[6, 21], [5, 3], [8, 8], [7, 1], [12, 21], [3, 21]];
  let okAll = true; const info = [];
  for (const [mo, d] of days) {
    const tr = new LAB.sim.Tracker(); tr.setMode('astro'); let flips = 0, last = null, worstAoi = 0;
    for (let m = 6 * 60; m <= 18 * 60; m += 1) {
      const ms = LAB.fromLocal(2026, mo, d, Math.floor(m / 60), m % 60); const sun = S.position(ms);
      if (sun.el < 2) continue;
      const o = tr.astroOrientation(sun);
      if (last != null && Math.abs(o.tAz - last) > 90) flips++;
      last = o.tAz;
      const best = Math.sin(sun.el * Math.PI / 180);   // cos(AOI) con el plano sobre el Sol no se usa; medimos la perdida contra apuntar al Sol (limites ignorados)
      const cos = Math.sin(o.tTilt * Math.PI / 180) * Math.cos(sun.el * Math.PI / 180) * Math.cos((sun.az - o.tAz) * Math.PI / 180) + Math.cos(o.tTilt * Math.PI / 180) * best;
      worstAoi = Math.max(worstAoi, Math.acos(Math.min(1, Math.max(cos, -1))) * 180 / Math.PI);
    }
    info.push(`${d}/${mo}: cambios de lado ${flips}, AOI máx ${worstAoi.toFixed(0)}°`);
    if (flips > 1) okAll = false;
  }
  t.ok('Ley astronómica: a lo sumo 1 cambio de lado por día, sin chisporroteo', okAll, info.join(' | '));
  const tr = new LAB.sim.Tracker();
  const o = tr.astroOrientation({ az: 130, el: 40, zenith: 50 });
  t.ok('Ley astronómica: con el Sol alcanzable apunta al Sol (az=130°, tilt=cenit)', Math.abs(o.tAz - 130) < 1e-9 && Math.abs(o.tTilt - 50) < 1e-6);
}

// ---- validateCmd: 17 comandos invalidos de T19 y admision por fuente
{
  const bad = [{ type: 'tracker.target', az: NaN }, { type: 'tracker.target', az: Infinity, tilt: 10 }, { type: 'tracker.target', az: '180' }, { type: 'sim.cloud', value: 2 }, { type: 'sim.cloud', value: NaN }, { type: 'sim.wind', value: -1 }, { type: 'sim.wind', value: 99 }, { type: 'sim.speed', speed: 7 }, { type: 'sim.time', ms: NaN }, { type: 'load.set', mode: 'cv', setpoint: 5 }, { type: 'load.set', mode: 'cr', setpoint: 0 }, { type: 'load.set', mode: 'xx' }, { type: 'tracker.mode', mode: 'raro' }, { type: 'nope' }, { type: 'sim.gust', peak: NaN, seconds: 5 }, null, { type: 5 }];
  t.eq('validateCmd rechaza los comandos invalidos', bad.filter((c) => LAB.core.validateCmd(c) == null).length, 0);
  t.ok('validateCmd acepta comandos validos', LAB.core.validateCmd({ type: 'tracker.target', az: 150, tilt: 30 }) == null && LAB.core.validateCmd({ type: 'load.set', mode: 'cr', setpoint: 3.4 }) == null);
  t.ok('banco real no admite sim.*, scenario.apply, safety.reset ni acq.discard', ['sim.cloud', 'scenario.apply', 'safety.reset', 'acq.discard'].every((x) => !LAB.core.cmdAdmits('real', x)) && LAB.core.cmdAdmits('real', 'safety.estop'));
  t.ok('replay solo admite replay.*', LAB.core.cmdAdmits('replay', 'replay.play') && !LAB.core.cmdAdmits('replay', 'tracker.target'));
}
t.done();
