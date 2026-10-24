/* S14: la calibracion A = B completa contra el motor del simulador (sin navegador). */
const { T } = require('./lib/harness.js');
const { loadSim } = require('./lib/loadsim.js');
const LAB = loadSim();
const t = new T('Calibracion A=B (flujo)');
const e = new LAB.sim.Engine();
e.send({ type: 'session.start', role: 'student' });
e.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, 10, 0) });
e.send({ type: 'sim.cloud', value: 0 });
e.send({ type: 'sim.speed', speed: 10 });
e.send({ type: 'tracker.mode', mode: 'astro' });
for (let i = 0; i < 300; i++) e.step(0.1);                       // B se aleja de la orientacion de A
const cal = new LAB.core.calibration.Calibrator(e);
const st = cal.start();
t.ok('arranca con sesion, Sol alto y sistema NORMAL', st.ok, st.reason);
let phases = [cal.phase], guard = 0;
while (cal.active && guard++ < 30000) {
  e.step(0.1);
  cal.update(0.1 * e.telemetry.speed);
  if (cal.phase !== phases[phases.length - 1]) phases.push(cal.phase);
}
t.eq('fases: moving -> settling -> recording -> done', phases.join('>'), 'moving>settling>recording>done');
const c = LAB.core.calibration.get();
t.ok('k guardado, cercano a 1 (modulos identicos en el simulador) y con >= 600 muestras', c && c.nValid >= 600 && Math.abs(c.k - 1) < 0.01, JSON.stringify(c));
t.ok('marcada «incertidumbre pendiente»', c && c.uncertainty === null && /pendiente/.test(c.uncertaintyNote));
const run = e.getRun(c.runId);
t.ok('la corrida de calibracion existe, se cerro y B estuvo a la orientacion de A', run && run.samples.length >= 600 && Math.abs(e.telemetry.B.az - LAB.config.fixed.az) < 0.5, run && run.samples.length);
e.step(0.1);
t.eq('corrida de calibracion detenida', e.telemetry.acq.status, 'stopped');
const sum = LAB.core.runSummary(run);
t.ok('el resumen trae ganancia cruda y corregida por k', sum.calK === c.k && sum.correctedPct !== undefined && sum.calDate);
// bloqueos
const night = new LAB.sim.Engine(); night.send({ type: 'session.start', role: 'student' }); night.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, 2, 0) }); night.step(0.1);
t.ok('de noche no arranca y explica por que', /Sol/.test(new LAB.core.calibration.Calibrator(night).start().reason));
const vis = new LAB.sim.Engine(); vis.send({ type: 'session.start', role: 'visitor' }); vis.step(0.1);
t.ok('un visitante no puede calibrar', !new LAB.core.calibration.Calibrator(vis).start().ok);
const ab = new LAB.sim.Engine(); ab.send({ type: 'session.start', role: 'student' }); ab.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, 11, 0) }); ab.step(0.1);
const c2 = new LAB.core.calibration.Calibrator(ab); c2.start(); ab.send({ type: 'safety.estop' }); ab.step(0.1); c2.update(0.1);
t.eq('un paro de emergencia aborta la calibracion', c2.phase, 'failed');
LAB.core.calibration.clear();
t.done();
