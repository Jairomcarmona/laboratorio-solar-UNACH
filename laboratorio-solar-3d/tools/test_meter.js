/* Punto 7: multimetro virtual. Instrumento (rango, resolucion, incertidumbre, polaridad) y medida de Voc/Isc con la carga oc/sc del motor. Sin navegador. */
const { T } = require('./lib/harness.js');
const { loadSim } = require('./lib/loadsim.js');
const LAB = loadSim();
const t = new T('Multimetro virtual');
const M = LAB.core.meter;

// ---- instrumento
{
  const v = M.read('voc', 46.0734);
  t.ok('Vcc 46.0734 V: rango de 60 V, resolucion 0.01 V', v.text === '46.07' && v.range === 60 && v.res === 0.01, v.text);
  t.ok('incertidumbre ±(0.5 % + 2 dig.) = 0.25 V', Math.abs(v.unc - (0.005 * 46.07 + 0.02)) < 1e-9, v.unc.toFixed(3));
  t.ok('Icc 12.347 A: resolucion 0.01 A y ±(1.5 % + 5 dig.)', M.read('isc', 12.347).text === '12.35' && Math.abs(M.read('isc', 12.347).unc - (0.015 * 12.35 + 0.05)) < 1e-9);
  t.ok('mas de 20 A: sobrecarga OL', M.read('isc', 21).ol === true && M.read('isc', 21).text === 'OL');
  t.ok('tension negativa con las puntas invertidas conserva el signo', M.read('voc', -45.2).text === '-45.20');
  t.ok('sin dato: guion, no cero', M.read('voc', NaN).text === '—');
  t.ok('puntas: + y − del mismo modulo valida; invertidas dan signo −1', M.probes('A+', 'A-').valid && M.probes('A+', 'A-').sign === 1 && M.probes('A-', 'A+').sign === -1);
  t.ok('puntas: modulos distintos, mismo polo o falta una no son validas', ['A+,B-', 'A+,A+', 'A+,'].every((s) => { const [r, b] = s.split(','); return !M.probes(r || null, b || null).valid; }));
}

// ---- medida contra el motor
function setup(h = 12) {
  const e = new LAB.sim.Engine({ seed: 11 }); e.send({ type: 'session.start', role: 'student', user: 'x' });
  e.simMs = LAB.fromLocal(2026, 3, 21, h, 0); e.jumped = true; for (let i = 0; i < 20; i++) e.step(0.1);
  return e;
}
function run(e, fn, module, sign = 1, maxS = 60) {
  const m = new M.Measurement(fn, module, sign, { mode: e.load.mode, setpoint: e.load.setpoint }, (c) => e.send(c));
  let s = 0; while (!['done', 'aborted'].includes(m.state) && s < maxS) { e.step(0.1); m.tick(e.telemetry, 0.1); s += 0.1; }
  return { m, s };
}
{
  const e = setup(); e.send({ type: 'load.set', mode: 'cv', setpoint: 0.7 });
  const trueVoc = e.telemetry.B.voc, trueIsc = e.telemetry.B.isc;
  const rv = run(e, 'voc', 'B');
  t.ok('Voc: termina en done, dentro de la incertidumbre del instrumento y restituye la carga anterior', rv.m.state === 'done' && Math.abs(rv.m.result.value - trueVoc) < rv.m.result.unc && e.load.mode === 'cv' && e.load.setpoint === 0.7, `${rv.m.result && rv.m.result.text} V vs ${trueVoc.toFixed(2)} V; carga ${e.load.mode}`);
  const ri = run(e, 'isc', 'A');
  t.ok('Isc: usa el modo sc, mide ≈ Isc del modelo y restituye la carga', ri.m.state === 'done' && Math.abs(ri.m.result.value - e.telemetry.A.isc) < ri.m.result.unc && e.load.mode === 'cv', `${ri.m.result && ri.m.result.text} A vs ${e.telemetry.A.isc.toFixed(2)} A`);
  t.ok('Isc: el cortocircuito dura poco (≤ limite)', ri.s <= M.spec().scMaxS, ri.s.toFixed(1) + ' s');
  const rn = run(e, 'voc', 'A', -1);
  t.ok('puntas invertidas: Voc negativo', rn.m.result.value < 0);
  void trueIsc;
}
{
  const e = setup(); let sent = [];
  const m = new M.Measurement('isc', 'A', 1, { mode: 'mppt' }, (c) => { sent.push(c); return e.send(c); });
  let s = 0; const tel = () => e.telemetry;
  // la carga no responde (red lenta): el cortocircuito no pasa del limite y se restituye
  const stuck = new M.Measurement('isc', 'A', 1, { mode: 'mppt' }, (c) => { sent.push(c); return { ok: true }; });
  let st; for (s = 0; s < 40; s += 0.1) { e.step(0.1); st = stuck.tick(tel(), 0.1); if (st === 'aborted') break; }
  t.ok('si la carga no confirma el modo, la medida se aborta (timeout) y se restituye', st === 'aborted' && stuck.reason === 'timeout' && sent.at(-1).mode === 'mppt', stuck.reason);
  const lim = new M.Measurement('isc', 'A', 1, { mode: 'mppt' }, (c) => e.send(c));
  lim.state = 'sampling'; lim.t = M.spec().scMaxS - 0.05; e.send({ type: 'load.set', mode: 'sc' }); e.step(0.1);
  lim.tick(tel(), 0.2);
  t.ok('pasado el limite de cortocircuito se corta y vuelve a la carga anterior', lim.state === 'aborted' && lim.reason === 'limit' && e.load.mode === 'mppt');
  void m;
}
{
  const e = setup(); e.send({ type: 'safety.estop', who: 'x' }); e.step(0.1);
  const r = run(e, 'voc', 'A');
  t.ok('con paro de emergencia no mide (aborta con motivo)', r.m.state === 'aborted' && /paro|estop|emergencia/i.test(r.m.reason), r.m.reason);
  const v = new LAB.sim.Engine(); v.send({ type: 'session.start', role: 'visitor', user: 'v' }); for (let i = 0; i < 10; i++) v.step(0.1);
  const rv = run(v, 'voc', 'A');
  t.ok('un visitante no puede mover la carga: la medida se rechaza', rv.m.state === 'aborted' && /./.test(rv.m.reason), rv.m.reason);
}
{
  const e = setup(); e.send({ type: 'load.set', mode: 'cv', setpoint: 0.5 }); e.send({ type: 'load.sweep' }); e.step(0.1);
  const r = run(e, 'voc', 'A', 1, 5);
  t.ok('durante un barrido I-V no se mide', r.m.state === 'aborted');
}
t.done();
