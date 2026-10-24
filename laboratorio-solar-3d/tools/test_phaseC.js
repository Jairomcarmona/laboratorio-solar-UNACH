/* Fase C (dominio): C12 escenarios comparables, resúmenes por segmento, C13 ganancias, C14 barridos, T20/T21/T30 sin navegador.
 * Ejecutar: node tools/test_phaseC.js */
const vm = require('vm'), fs = require('fs'), path = require('path');
const { T } = require('./lib/harness.js');
const ROOT = process.env.LAB_ROOT || path.resolve(__dirname, '..');
global.window = global;
global.localStorage = { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
for (const f of ['js/config.js', 'data/pvlib_tuxtla.js', 'js/sim/solar.js', 'js/sim/pvmodel.js', 'js/sim/sensors.js', 'js/sim/shade.js', 'js/sim/weather.js', 'js/sim/control.js', 'js/sim/safety.js', 'js/core/validate.js', 'js/core/exporters.js', 'js/core/calibration.js', 'js/core/analysis.js', 'js/core/store.js', 'js/sim/engine.js'])
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
const t = new T('Fase C dominio');
const SC = () => ({ id: 'p3-claro-v1', simMs: LAB.fromLocal(2026, 10, 23, 7, 0), cloud: 0.1, windBase: 3.2, seed: 20261023, az: 180, tilt: 17, speed: 600 });
const login = (e) => e.send({ type: 'session.start', role: 'student', user: 'Ana', profileId: LAB.core.store.profileId('student', 'Ana') });
function strategy(mode, lockTilt, mutate) {
  const e = new LAB.sim.Engine(); login(e); e.send({ type: 'scenario.apply', scenario: SC() });
  e.send({ type: 'tracker.locks', lockAz: false, lockTilt }); e.send({ type: 'tracker.mode', mode });
  e.send({ type: 'acq.newRun', label: mode + (lockTilt ? '-1eje' : '') }); e.send({ type: 'acq.start' });
  let g = 0; while (e.telemetry.local.hours < 17.5 && g++ < 30000) { e.step(0.1); if (mutate) mutate(e, g); }
  e.send({ type: 'acq.stop' }); return e;
}
const runs = [strategy('astro', false), strategy('astro', true), strategy('sensor', false)].map((e) => e.runs[0]);
const sums = runs.map(LAB.core.runSummary);
t.ok('C12 cada corrida guarda acumuladores por segmento', runs.every((r) => r.segments[0].start && r.segments[0].end && r.segments[0].ctx));
t.ok('C12 resumen: E_A, E_B y motor con valores finitos', sums.every((s) => s.hasEnergy && s.EA > 100 && s.EB > 100 && s.motorWh >= 0), sums.map((s) => `${s.EA.toFixed(0)}/${s.EB.toFixed(0)}/${s.motorWh.toFixed(1)}`).join(' | '));
t.ok('C12 E_A idéntica entre estrategias (misma referencia)', Math.abs(sums[0].EA - sums[1].EA) < 1 && Math.abs(sums[0].EA - sums[2].EA) < 1);
t.ok('C13 ganancia bruta = E_B/E_A−1 y neta = (E_B−motor)/E_A−1', sums.every((s) => Math.abs(s.grossPct - (s.EB / s.EA - 1) * 100) < 1e-9 && Math.abs(s.netPct - ((s.EB - s.motorWh) / s.EA - 1) * 100) < 1e-9));
t.ok('C13 neta ≤ bruta', sums.every((s) => s.netPct <= s.grossPct + 1e-9));
const cmp = LAB.core.compareRuns(runs);
t.ok('T20 mismas condiciones comunes → comparables', cmp.comparable && cmp.differs.length === 0, JSON.stringify({ d: cmp.differs, a: cmp.altered }));
t.ok("T20 las diferencias deliberadas quedan registradas", cmp.varied.includes("modo de seguimiento") && cmp.varied.includes("eje inmovilizado"), cmp.varied.join(",") + " " + JSON.stringify(cmp.conds.map((c) => [c.trackerMode, c.lockAz, c.lockTilt])));
t.ok('T20 metadatos persistidos: escenario, semilla, fecha', cmp.conds.every((c) => c.scenarioId === 'p3-claro-v1' && c.seed === 20261023 && c.day === '2026-10-23'));
// otro clima = otro experimento
{
  const e = new LAB.sim.Engine(); login(e); e.send({ type: 'scenario.apply', scenario: { ...SC(), cloud: 0.6 } }); e.send({ type: 'acq.start' }); for (let i = 0; i < 400; i++) e.step(0.1); e.send({ type: 'acq.stop' });
  const c2 = LAB.core.compareRuns([runs[0], e.runs[0]]);
  t.ok('C12 distinto clima ⇒ no comparable y lo dice', !c2.comparable && c2.differs.includes('nubes'), c2.differs.join(','));
}
// corrida alterada (salto de reloj) no se mezcla
{
  const e = strategy('astro', false, (en, g) => { if (g === 300) en.send({ type: 'sim.time', ms: en.simMs + 3600e3 }); });
  const al = LAB.core.runAlterations(e.runs[0]);
  t.ok('C12 salto de reloj marca la corrida como alterada', al.some((x) => /salto/.test(x)), al.join('|'));
  t.ok('C12 una corrida alterada impide la comparación válida', !LAB.core.compareRuns([runs[0], e.runs[0]]).comparable);
}
// paro de emergencia
{
  const e = strategy('astro', false, (en, g) => { if (g === 300) en.send({ type: 'safety.estop' }); if (g === 350) en.send({ type: 'safety.reset' }); });
  const r = e.runs[0], al = LAB.core.runAlterations(r);
  t.ok('C12/§9 paro de emergencia durante la corrida: marcada y con anotación de seguridad', al.some((x) => /seguridad|paro/.test(x)) && LAB.core.runAnnotations(r).some((a) => a.kind === 'seguridad'), al.join('|'));
}
// C13 denominador insuficiente
{
  const r = LAB.core.ratioPct(5, 0.2, 'la energía del módulo A'); t.ok('C13 denominador insuficiente → null con motivo', r.v === null && /No disponible/.test(r.note));
  t.eq('C13 sin -0.0', Object.is(LAB.core.ratioPct(100, 100.01, 'x').v, 0), true);
}
// anotaciones y series
{
  const an = LAB.core.runAnnotations(runs[0]), se = LAB.core.runSeries(runs[0]);
  t.ok('C15 series con la misma longitud que las muestras', se.pA.length === runs[0].samples.length && se.seg.length === se.pA.length);
  t.ok('C15 rebanada CSV de una selección tiene solo esas filas', LAB.core.runSliceCsv(runs[0], 10, 19).split('\n').filter((l) => l && !l.startsWith('#') && !/^n,/.test(l)).length === 10);
  void an;
}
// T21/C14 barridos con condiciones distintas
{
  const e = new LAB.sim.Engine(); login(e); e.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, 12, 0) });
  e.send({ type: 'load.sweep' }); for (let i = 0; i < 400; i++) e.step(0.1);
  e.send({ type: 'sim.cloud', value: 0.8 }); for (let i = 0; i < 100; i++) e.step(0.1);
  e.send({ type: 'load.sweep' }); for (let i = 0; i < 400; i++) e.step(0.1);
  const [s1, s2] = e.sweeps;
  t.ok('T21 ambos barridos conservados con id, estado y condiciones', e.sweeps.length === 2 && s1.id !== s2.id && s1.status === 'complete' && s2.status === 'complete' && s1.cond.start && s2.cond.start);
  const d = LAB.core.sweepConditionDiffs(s1, s2);
  t.ok('C14 se advierte que las condiciones difieren', d.length > 0 && /irradiancia/.test(d[0]), d.join('; '));
  t.ok('C14 el barrido antiguo conserva sus condiciones originales', s1.cond.start.cloud !== s2.cond.start.cloud && s1.cond.start.gA > s2.cond.start.gA);
  const csv = e.exportSweepCsv(s1.id); t.ok('C14 CSV del barrido seleccionado marca "SIMULADO"', csv.ok && /SIMULADO/.test(csv.text));
}
// T30 evidencia congelada: cambiar el modelo no altera el resumen de una corrida ya guardada
{
  const before = JSON.stringify(LAB.core.runSummary(runs[0]));
  const e2 = new LAB.sim.Engine(); login(e2); e2.send({ type: 'sim.cloud', value: 0.9 }); for (let i = 0; i < 200; i++) e2.step(0.1);
  t.eq('T30 el resumen de una corrida guardada no depende de la telemetría actual', JSON.stringify(LAB.core.runSummary(runs[0])), before);
  const copy = JSON.parse(JSON.stringify(runs[0])); t.eq('T30 sobrevive a serializar/restaurar', JSON.stringify(LAB.core.runSummary(copy)), before);
}
// §9 cierre de sesión: conserva bitácora, detiene adquisición, no inventa la posición final
{
  const e = new LAB.sim.Engine(); login(e); e.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, 11, 0) }); e.send({ type: 'tracker.mode', mode: 'manual' });
  e.send({ type: 'acq.start' }); for (let i = 0; i < 100; i++) e.step(0.1);
  e.send({ type: 'tracker.target', az: 250, tilt: 60 }); for (let i = 0; i < 20; i++) e.step(0.1);
  const nLogs = e.logs.length; const r = e.send({ type: 'session.end' });
  const en = e.sessionsArchive[e.sessionsArchive.length - 1];
  t.ok('§9 al cerrar la sesión la adquisición queda detenida y la corrida cerrada', e.acq.status === 'stopped' && e.runs[0].status === 'closed' && e.runs[0].samples.length > 0);
  t.ok('§9 el cierre guarda estado final, modo de operación aplicado y seguridad', en.final && en.final.safety === 'NORMAL' && en.final.trackerMode && en.final.loadMode && en.final.runs === 1, JSON.stringify(en.final));
  t.ok('§9 si el seguidor seguía en movimiento no se inventa la posición final', en.final.trackerMoving === true && /aún no se alcanzó/.test(en.final.note) && e.logs.some((l) => /aún en movimiento/.test(l.msg)));
  t.ok('§9 la bitácora se conserva (no se borra al cerrar)', e.logs.length >= nLogs);
}
// §9 corte de enlace y watchdog: lo decide el controlador, no la interfaz
{
  const e = new LAB.sim.Engine(); login(e); e.send({ type: 'sim.comms', connected: false }); for (let i = 0; i < 90; i++) e.step(0.1);
  t.ok('§9 watchdog dispara tras el tiempo configurado y bloquea comandos', e.safety.watchdogTrip && !e.send({ type: 'tracker.target', az: 200, tilt: 20 }).ok);
  e.send({ type: 'sim.comms', connected: true }); e.send({ type: 'safety.ack' });
  t.ok('§9 restablecer el enlace y reconocer devuelve la operación', !e.safety.watchdogTrip && e.send({ type: 'tracker.target', az: 200, tilt: 20 }).ok);
}
// §9 salida de la posición segura por viento: se levanta sola al bajar el viento y se explica qué falta
{
  const e = new LAB.sim.Engine(); login(e); e.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, 11, 0) }); e.send({ type: 'tracker.mode', mode: 'manual' });
  e.send({ type: 'sim.wind', value: 20 }); for (let i = 0; i < 60; i++) e.step(0.1);
  t.ok('§9 viento 20 m/s: posición segura', e.telemetry.safety.windStow && /sigue por encima de 10/.test(e.telemetry.safety.resumeText), e.telemetry.safety.resumeText);
  const rej = e.send({ type: 'tracker.target', az: 200, tilt: 30 });
  t.ok('§9 el rechazo explica cuánto falta', !rej.ok && /Posición segura por viento/.test(rej.reason) && /10 m\/s/.test(rej.reason), rej.reason);
  e.send({ type: 'sim.wind', value: 3 }); for (let i = 0; i < 100; i++) e.step(0.1);
  t.ok('§9 con viento bajo la cuenta regresiva avanza y se informa', e.telemetry.safety.windStow && /se levanta en \d+ s simulados/.test(e.telemetry.safety.resumeText), e.telemetry.safety.resumeText);
  e.send({ type: 'sim.speed', speed: 60 }); for (let i = 0; i < 400 && e.safety.windStow; i++) e.step(0.1);
  t.ok('§9 tras 120 s simulados con viento < 10 m/s se levanta la posición segura', !e.safety.windStow);
  t.ok('§9 y vuelve a aceptar órdenes y a moverse', e.send({ type: 'tracker.target', az: 200, tilt: 30 }).ok && (() => { for (let i = 0; i < 400; i++) e.step(0.1); return Math.abs(e.telemetry.tracker.az - 200) < 1; })());
  // viento entre 10 y 14: no se levanta (histéresis) y lo explica
  const e2 = new LAB.sim.Engine(); login(e2); e2.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, 11, 0) }); e2.send({ type: 'sim.wind', value: 20 }); for (let i = 0; i < 60; i++) e2.step(0.1);
  e2.send({ type: 'sim.wind', value: 16 }); e2.send({ type: 'sim.speed', speed: 60 }); for (let i = 0; i < 400; i++) e2.step(0.1);
  t.ok('§9 con viento sostenido de 16 m/s sigue en seguro y lo explica', e2.safety.windStow && /sigue por encima de 10/.test(e2.telemetry.safety.resumeText));
}
t.done();
