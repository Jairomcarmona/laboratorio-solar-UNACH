/* Regresion de la auditoria H01, H03, H04, H08 y H10 (sin navegador).  Ejecutar: node tools/test_audit_fixes.js */
const { T } = require('./lib/harness.js');
const { loadSim } = require('./lib/loadsim.js');
const LAB = loadSim();
const t = new T('Auditoría H01/H03/H04/H08/H10');
const T0 = () => LAB.fromLocal(2026, 10, 23, 9, 0);
const login = (e) => e.send({ type: 'session.start', role: 'student', user: 'Ana', profileId: 'p1' });
const scen = (e, extra = {}) => e.send({ type: 'scenario.apply', scenario: { id: 'aud', simMs: T0(), cloud: 0.4, windBase: 3.2, seed: 42, az: 180, tilt: 17, ...extra } });
const mk = (extra) => { const e = new LAB.sim.Engine(); login(e); scen(e, extra); e.send({ type: 'tracker.mode', mode: 'astro' }); return e; };

// ---- H01: la fisica no depende de la velocidad de presentacion
{
  const res = [1, 60, 600].map((speed) => { const e = mk({ speed }); const n = Math.round(900 / speed / 0.1); for (let i = 0; i < n; i++) e.step(0.1); return { A: e.A.energyWh, B: e.B.energyWh, M: e.motorWh }; });
  const rel = (k) => (Math.max(...res.map((r) => r[k])) - Math.min(...res.map((r) => r[k]))) / Math.max(...res.map((r) => r[k]));
  t.ok('H01 energía del módulo B igual a ×1, ×60 y ×600 (<1 %)', rel('B') < 0.01, `dispersión ${(rel('B') * 100).toFixed(3)} %`);
  t.ok('H01 energía de motores independiente de la velocidad (<5 %)', rel('M') < 0.05, `dispersión ${(rel('M') * 100).toFixed(2)} %`);
}
{   // el reloj en pausa congela Sol y energía, pero el banco sigue a ritmo real
  const e = mk({ speed: 60 }); for (let i = 0; i < 20; i++) e.step(0.1);
  e.send({ type: 'sim.play', on: false });
  const ms = e.simMs, wh = e.B.energyWh; for (let i = 0; i < 20; i++) e.step(0.1);
  t.ok('H01 en pausa el tiempo simulado y la energía no avanzan', e.simMs === ms && e.B.energyWh === wh);
}

// ---- H04: muestreo por instantes objetivo y cierre atómico del segmento
{
  const e = mk({ speed: 1 }); e.send({ type: 'acq.newRun', label: 'h04' }); e.send({ type: 'acq.start' });
  for (let i = 0; i < 1430; i++) e.step(0.07);       // 100.1 s reales en pasos que no dividen el periodo
  const run = e.getRun(e.acq.runId);
  t.eq('H04 una muestra por periodo, sin deriva (100,1 s -> 100 muestras)', run.samples.length, 100);
  const wh = e.B.energyWh; e.send({ type: 'acq.stop' });
  const seg = run.segments[run.segments.length - 1];
  t.ok('H04 el segmento cierra con la energía vigente al detener', seg.end && Math.abs(seg.end.eB - wh) < 1e-9 && seg.end.n === run.samples.length, JSON.stringify(seg.end));
}

// ---- H10: escenario inválido se rechaza completo y no muta nada
{
  const e = mk({ speed: 1 }); for (let i = 0; i < 20; i++) e.step(0.1);
  const snap = () => JSON.stringify({ tr: [e.tracker.az, e.tracker.tilt, e.tracker.targetAz], w: [e.weather.cloud, e.weather.windBase], ms: e.simMs, seed: e.seed, wh: e.A.energyWh, sc: e.scenario && e.scenario.id });
  const before = snap();
  const bad = [{ az: 500 }, { az: 10 }, { tilt: 120 }, { tilt: -5 }, { az: NaN }, { tilt: '17' }, { cloud: 3 }, { seed: 1.5 }, { speed: 7 }];
  const rejected = bad.filter((s) => !e.send({ type: 'scenario.apply', scenario: { id: 'malo', cloud: 0.2, ...s } }).ok).length;
  t.eq('H10 escenarios con az/tilt/forma inválidos se rechazan', rejected, bad.length);
  t.eq('H10 el estado no cambia tras los rechazos', snap(), before);
  t.ok('H10 el validador puro coincide con el motor', !LAB.core.validateCmd({ type: 'scenario.apply', scenario: { az: 500 } }).ok && LAB.core.validateCmd({ type: 'scenario.apply', scenario: { id: 'ok', az: 180, tilt: 17 } }) === null);
  t.ok('H10 un escenario válido se aplica', e.send({ type: 'scenario.apply', scenario: { id: 'bueno', az: 200, tilt: 30 } }).ok);
}

// ---- H03: el comparador exige mismo inicio, duración, modo de carga y variable estable
{
  const runOf = (setup, secs, tweak) => { const e = mk({ speed: 1 }); if (setup) setup(e); e.send({ type: 'acq.newRun', label: 'r' }); e.send({ type: 'acq.start' });
    for (let i = 0; i < secs * 10; i++) { e.step(0.1); if (tweak) tweak(e, i); } e.send({ type: 'acq.stop' }); return e.getRun(e.acq.runId); };
  const base = runOf(null, 120), same = runOf(null, 120);
  t.ok('H03 dos corridas iguales son comparables', LAB.core.compareRuns([base, same]).comparable);
  const longer = runOf(null, 240);
  t.ok('H03 distinta duración no es comparable', LAB.core.compareRuns([base, longer]).differs.includes('duración'));
  const later = runOf((e) => e.send({ type: 'sim.time', ms: T0() + 3600e3 }), 120);
  t.ok('H03 distinta hora de inicio no es comparable', LAB.core.compareRuns([base, later]).differs.includes('hora de inicio'));
  const cv = runOf((e) => e.send({ type: 'load.set', mode: 'cv', setpoint: 0.8 }), 120);
  t.ok('H03 distinto modo de carga no es comparable', LAB.core.compareRuns([base, cv]).differs.includes('modo de carga'));
  const flip = runOf(null, 120, (e, i) => { if (i === 600) e.send({ type: 'tracker.mode', mode: 'fixed' }); });
  t.ok('H03 cambiar el modo de seguimiento a mitad de corrida la altera', LAB.core.runAlterations(flip).some((r) => /seguimiento/.test(r)) && !LAB.core.compareRuns([base, flip]).comparable);
  const shortRun = runOf(null, 30);
  t.ok('H03 una corrida de menos de 60 s no sirve para comparar', LAB.core.runAlterations(shortRun).some((r) => /menos de/.test(r)));
}

// ---- H08: el barrido incluye cortocircuito (V=0) y circuito abierto (I=0)
{
  const e = mk({ speed: 1 }); for (let i = 0; i < 30; i++) e.step(0.1);
  t.ok('H08 el barrido arranca', e.send({ type: 'load.sweep' }).ok);
  for (let i = 0; i < 400 && e.sweep.active; i++) e.step(0.05);
  const sw = e.lastSweep, P = sw && sw.pts.B;
  t.ok('H08 el barrido completa', sw && sw.status === 'complete');
  t.ok('H08 primer punto en cortocircuito (V=0, I=Isc)', P && P[0].v === 0 && P[0].i > 1, JSON.stringify(P && P[0]));
  t.ok('H08 último punto en circuito abierto (I=0, V=Voc)', P && P[P.length - 1].i === 0 && P[P.length - 1].v > 20, JSON.stringify(P && P[P.length - 1]));
  t.ok('H08 el barrido interrumpido no inventa el extremo abierto', (() => { const e2 = mk({ speed: 1 }); for (let i = 0; i < 30; i++) e2.step(0.1); e2.send({ type: 'load.sweep' }); for (let i = 0; i < 20; i++) e2.step(0.05); e2.send({ type: 'load.sweep.abort' }); const q = e2.lastSweep.pts.B; return q[q.length - 1].i > 0; })());
}
t.done();
