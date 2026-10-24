/* Pruebas de dominio (sin navegador): motor, sesiones, adquisicion, validacion, almacenamiento.
 * Ejecutar: node tools/test_domain.js   (codigo de salida distinto de cero si algo falla) */
const vm = require('vm'), fs = require('fs'), path = require('path');
const { T } = require('./lib/harness.js');
const ROOT = path.resolve(__dirname, '..');
global.window = global;
const fakeLS = { _d: {}, full: false, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { if (this.full && !k.includes('__t')) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
global.localStorage = fakeLS;
for (const f of ['js/config.js', 'data/pvlib_tuxtla.js', 'js/sim/solar.js', 'js/sim/pvmodel.js', 'js/sim/sensors.js', 'js/sim/shade.js', 'js/sim/weather.js', 'js/sim/control.js', 'js/sim/safety.js', 'js/core/validate.js', 'js/core/exporters.js', 'js/core/calibration.js', 'js/core/analysis.js', 'js/core/store.js', 'js/sim/engine.js']) vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });

const t = new T('Dominio');
const mk = () => { const e = new LAB.sim.Engine(); return e; };
const run = (e, n, dt = 0.05) => { for (let i = 0; i < n; i++) e.step(dt); };
const login = (e, role = 'student', user = 'Ana') => e.send({ type: 'session.start', role, user, profileId: LAB.core.store.profileId(role, user) });

// ---- T19 validacion sin mutar el modelo
{
  const e = mk(); login(e); run(e, 20);
  const snap = JSON.stringify({ tr: [e.tracker.targetAz, e.tracker.targetTilt, e.tracker.mode], w: [e.weather.cloud, e.weather.windBase], l: e.load, sp: e.speed, ms: e.simMs });
  const bad = [{ type: 'tracker.target', az: NaN }, { type: 'tracker.target', az: Infinity, tilt: 10 }, { type: 'tracker.target', az: '180' }, { type: 'tracker.target', az: 20 }, { type: 'tracker.target', tilt: 120 },
    { type: 'sim.cloud', value: 2 }, { type: 'sim.cloud', value: NaN }, { type: 'sim.wind', value: -1 }, { type: 'sim.wind', value: 99 }, { type: 'sim.speed', speed: 7 }, { type: 'sim.time', ms: NaN },
    { type: 'load.set', mode: 'cv', setpoint: 5 }, { type: 'load.set', mode: 'cr', setpoint: 0 }, { type: 'load.set', mode: 'xx' }, { type: 'tracker.mode', mode: 'raro' }, { type: 'nope' }, { type: 'sim.gust', peak: NaN, seconds: 5 }];
  const rejected = bad.filter((c) => !e.send(c).ok).length;
  t.eq('T19 todos los comandos inválidos se rechazan', rejected, bad.length);
  t.eq('T19 el estado del modelo no cambia', JSON.stringify({ tr: [e.tracker.targetAz, e.tracker.targetTilt, e.tracker.mode], w: [e.weather.cloud, e.weather.windBase], l: e.load, sp: e.speed, ms: e.simMs }), snap);
  t.ok('T19 un valor válido sí se acepta', e.send({ type: 'tracker.target', az: 150, tilt: 30 }).ok);
}

// ---- T09 exportar sin muestras
{
  const e = mk(); login(e); run(e, 20);
  let r = e.exportCsv(); t.ok('T09 sin corrida: rechazo con mensaje', !r.ok && /adquisición|corrida/i.test(r.reason), r.reason);
  e.send({ type: 'acq.newRun' }); r = e.exportCsv(); t.ok('T09 corrida vacía: rechazo, sin filas', !r.ok && r.rows === 0, r.reason);
  e.send({ type: 'acq.start' }); run(e, 100); r = e.exportCsv(); t.ok('T09 con muestras: exporta', r.ok && r.rows >= 4, `${r.rows} filas`);
}

// ---- T12 iniciar / detener
{
  const e = mk(); login(e); run(e, 20);
  t.eq('T12 sin iniciar no hay muestras', e.telemetry.acq.samples, 0);
  e.send({ type: 'acq.start' }); run(e, 100); const n1 = e.telemetry.acq.samples;
  t.ok('T12 grabando: muestras crecen (1/s real)', n1 >= 4 && n1 <= 6, `n=${n1}`);
  t.eq('T12 estado grabando', e.telemetry.acq.status, 'recording');
  e.send({ type: 'acq.stop' }); const pa = e.telemetry.A.p; run(e, 100); const n2 = e.telemetry.acq.samples;
  t.eq('T12 detenida: las muestras no crecen', n2, n1);
  t.ok('T12 la telemetría sigue viva con la adquisición detenida', e.telemetry.A.p >= 0 && e.telemetry.acq.status === 'stopped' && Number.isFinite(pa));
  e.send({ type: 'acq.start' }); run(e, 60); t.ok('T12 reanudar continúa la misma corrida', e.telemetry.acq.samples > n2 && e.runs.length === 1, `runs=${e.runs.length}`);
  t.ok('T12 reanudar abre un segmento nuevo', e.activeRun().segments.length === 2);
}

// ---- T10 energia a cero
{
  const e = mk(); login(e); e.send({ type: 'sim.rain', level: 2 }); e.send({ type: 'acq.start' }); run(e, 200);
  const run0 = e.activeRun(), n = run0.samples.length, rain = e.weather.rainMm, wh = e.telemetry.A.wh;
  e.send({ type: 'sim.resetEnergy' }); run(e, 2);
  t.ok('T10 conserva las muestras', run0.samples.length >= n && n > 0, `${n}→${run0.samples.length}`);
  t.ok('T10 energía a cero', e.telemetry.A.wh < wh && e.telemetry.A.wh < 0.5, `${wh}→${e.telemetry.A.wh}`);
  t.ok('T10 crea un segmento', run0.segments.length === 2 && run0.segments[1].reason === 'energia_a_cero');
  t.ok('T10 la lluvia acumulada no se toca', e.weather.rainMm >= rain && e.weather.rainLevel === 2);
  e.send({ type: 'sim.resetRain' }); t.eq('T10 la lluvia se pone a cero por separado', e.weather.rainMm, 0);
  t.ok('T10 las muestras siguen ahí tras poner la lluvia a cero', run0.samples.length >= n);
}

// ---- T11 sesiones separadas  /  T29 terminar sesion
{
  const e = mk(); const a = login(e, 'student', 'Ana'); e.send({ type: 'acq.start' }); run(e, 200);
  const runA = e.activeRun(), nA = runA.samples.length;
  t.ok('T11 la sesión A tiene id', !!a.sessionId);
  e.send({ type: 'tracker.target', az: 140, tilt: 40 }); run(e, 4);
  const end = e.send({ type: 'session.end' }); run(e, 1);
  t.ok('T29 la adquisición se detiene al terminar la sesión', e.telemetry.acq.status === 'stopped' && runA.status === 'closed', runA.status);
  t.ok('T29 las muestras se conservan', runA.samples.length === nA && nA > 0);
  t.ok('T29 el estado final se informa y no afirma haber llegado', end.final && /aún no se alcanzó/.test(end.final.note) && end.final.trackerMoving === true, JSON.stringify({ mov: end.final.trackerMoving }));
  const b = login(e, 'teacher', 'Beto'); run(e, 20);
  t.ok('T11 sesión B con identidad distinta', b.sessionId !== a.sessionId && e.telemetry.session.user === 'Beto');
  t.eq('T11 la sesión B no hereda corridas', e.telemetry.acq.runs, 0);
  t.eq('T11 no hay corrida activa heredada', e.telemetry.acq.runId, null);
  e.send({ type: 'acq.start' }); run(e, 100);
  t.ok('T11 la corrida de B es otra y A no cambió', e.activeRun().id !== runA.id && e.activeRun().sessionId === b.sessionId && runA.samples.length === nA);
  t.ok('T11 las exportaciones llevan la identidad de su sesión', /Beto/.test(e.exportCsv().text) && !/Beto/.test(LAB.core.runToCsv(runA)));
  t.ok('T11 archivo de sesiones con ambas', e.sessionsArchive.length === 2 && e.sessionsArchive[0].endedReal);
  t.ok('T29 rechaza comandos tras terminar', (e.send({ type: 'session.end' }), !e.send({ type: 'tracker.target', az: 160 }).ok));
}

// ---- T13 limite de registro
{
  const e = mk(); login(e); LAB.config.acq.limit = 8; e.send({ type: 'acq.start' }); const logs = []; e.on('log', (l) => logs.push(l));
  run(e, 400);
  const r = e.activeRun();
  t.eq('T13 se detiene exactamente en el límite', r.samples.length, 8);
  t.eq('T13 estado detenido por límite', e.telemetry.acq.reason, 'limite');
  t.ok('T13 advertencia visible en la bitácora', logs.some((l) => l.level === 'warn' && /límite/.test(l.msg)));
  const before = r.samples.length; run(e, 200); t.eq('T13 no hay truncamiento silencioso (no se descarta ni se sigue)', r.samples.length, before);
  e.send({ type: 'acq.start' }); t.ok('T13 reanudar crea otra corrida', e.activeRun().id !== r.id && r.status === 'limit', r.status);
  LAB.config.acq.limit = 20000;
}

// ---- T14 pausar reloj  /  T15 salto hacia atras
{
  const e = mk(); login(e); e.send({ type: 'acq.start' }); run(e, 100);
  const ms0 = e.simMs, n0 = e.activeRun().samples.length;
  e.send({ type: 'sim.play', on: false }); e.send({ type: 'tracker.target', az: 120, tilt: 50 }); run(e, 200);
  t.eq('T14 el reloj solar no avanza en pausa', e.simMs, ms0);
  t.ok('T14 el seguidor se mueve con el reloj en pausa', Math.abs(e.tracker.az - 120) < Math.abs(180 - 120) && e.tracker.az < 179);
  t.ok('T14 la adquisición sigue grabando con el reloj en pausa', e.activeRun().samples.length > n0);
  t.eq('T14 la telemetría informa clock.playing=false', e.telemetry.clock.playing, false);
  e.send({ type: 'sim.play', on: true });
  const segs = e.activeRun().segments.length;
  e.send({ type: 'sim.time', ms: e.simMs - 3 * 3600 * 1000 }); run(e, 40);
  const r = e.activeRun();
  t.ok('T15 el salto abre un segmento', r.segments.length === segs + 1 && r.segments[segs].reason === 'salto_de_tiempo');
  t.ok('T15 queda un evento de discontinuidad', r.events.some((x) => x.type === 'segmento' && /Salto del reloj/.test(x.text)));
  t.ok('T15 el historial de la gráfica contiene un corte (NaN) y no une puntos', e.history.t.some((x) => Number.isNaN(x)));
  t.ok('T15 la energía NO se pone a cero con el salto', e.telemetry.energy.resets === 0);
  // arrastre continuo: un solo segmento
  const sg = r.segments.length; for (let i = 0; i < 20; i++) e.send({ type: 'sim.time', ms: e.simMs - 600000 * (i + 1) }); t.ok('T15 arrastrar el control de hora no crea un segmento por pixel', r.segments.length <= sg + 1, `${sg}→${r.segments.length}`);
}

// ---- T28 viento / watchdog / paro
{
  const e = mk(); login(e); e.send({ type: 'load.set', mode: 'mppt' }); run(e, 20);
  e.send({ type: 'sim.wind', value: 3 }); e.send({ type: 'sim.gust', peak: 20, seconds: 16 }); run(e, 120, 0.1);
  t.eq('T28 la ráfaga lleva a posición segura', e.telemetry.safety.state, 'WIND_STOW');
  t.eq('T28 el viento medio configurado no quedó en 16', e.telemetry.settings.windBase, 3);
  const r = e.send({ type: 'tracker.target', az: 150 }); t.ok('T28 en posición segura se rechazan movimientos', !r.ok && r.kind === 'interlock', r.reason);
  t.ok('T28 telemetría explica el bloqueo', /Posición segura/.test(e.telemetry.safety.blockReason));
  run(e, 1500, 0.1); t.eq('T28 se levanta al normalizarse el viento', e.telemetry.safety.state, 'NORMAL');
  e.send({ type: 'sim.comms', connected: false }); run(e, 100, 0.1); t.eq('T28 watchdog', e.telemetry.safety.state, 'COMMS_STOW');
  e.send({ type: 'sim.comms', connected: true }); t.eq('T28 sigue bloqueado hasta reconocer', e.telemetry.safety.state, 'COMMS_STOW');
  t.ok('T28 reconocer la falla', e.send({ type: 'safety.ack' }).ok && (run(e, 2), e.telemetry.safety.state === 'NORMAL'));
  e.send({ type: 'safety.estop', who: 'prueba' }); run(e, 5); t.eq('T28 paro de emergencia', e.telemetry.safety.state, 'ESTOP');
  t.eq('T28 el paro desconecta la carga', e.telemetry.load.mode, 'oc');
  t.ok('T28 no se puede mover durante el paro', !e.send({ type: 'tracker.target', az: 150 }).ok);
  const sc = e.send({ type: 'scenario.apply', scenario: { id: 'x', cloud: 0.1 } }); t.ok('T28 no se aplica un escenario durante el paro', !sc.ok);
  t.ok('T28 restablecer (intervención simulada)', e.send({ type: 'safety.reset' }).ok && (run(e, 2), e.telemetry.safety.state === 'NORMAL') && e.logs.some((l) => /SIMULADA/.test(l.msg)));
}

// ---- barridos (T21: base) y semilla
{
  const e = mk(); login(e); run(e, 20); e.send({ type: 'load.sweep' }); run(e, 230);
  e.send({ type: 'sim.cloud', value: 0.9 }); run(e, 120); e.send({ type: 'load.sweep' }); run(e, 230);
  t.eq('T21 ambos barridos se conservan', e.sweeps.length, 2);
  t.ok('T21 con condiciones distintas identificadas', e.sweeps[0].cond.start.gA > e.sweeps[1].cond.start.gA * 1.2, `${e.sweeps[0].cond.start.gA.toFixed(0)} vs ${e.sweeps[1].cond.start.gA.toFixed(0)}`);
  t.ok('T21 cada barrido con id propio y estado', e.sweeps[0].id !== e.sweeps[1].id && e.sweeps[1].status === 'complete');
  e.send({ type: 'load.sweep' }); run(e, 30); e.send({ type: 'safety.estop' }); t.ok('T21 un barrido interrumpido se conserva marcado', e.sweeps.length === 3 && e.sweeps[2].status === 'interrupted' && e.sweeps[2].pts.A.length > 0);
  const a = mk(), b = mk(); [a, b].forEach((x) => { login(x); x.send({ type: 'acq.start' }); }); run(a, 200); run(b, 200);
  t.eq('semilla: dos motores con la misma semilla dan las mismas muestras', JSON.stringify(a.activeRun().samples.map((r) => r.slice(5))), JSON.stringify(b.activeRun().samples.map((r) => r.slice(5))));
}

// ---- T20 base: escenario comparable
{
  const res = [];
  for (const [mode, lockTilt] of [['astro', false], ['astro', true], ['sensor', false]]) {
    const e = mk(); login(e); const sc = { id: 'p3', simMs: LAB.fromLocal(2026, 10, 23, 7, 0), cloud: 0.1, windBase: 3.2, seed: 20261023, az: 180, tilt: 17, speed: 600 };
    const r = e.send({ type: 'scenario.apply', scenario: sc }); if (!r.ok) { t.ok('T20 aplicar escenario', false, r.reason); continue; }
    e.send({ type: 'tracker.locks', lockAz: false, lockTilt }); e.send({ type: 'tracker.mode', mode });
    let guard = 0; while (e.telemetry.local.hours < 17.5 && guard++ < 20000) e.step(0.1);
    res.push({ EA: e.telemetry.A.wh, EB: e.telemetry.B.wh, gain: e.telemetry.comparison.energyGainPct, net: e.telemetry.comparison.netGainPct, cloud: e.telemetry.settings.cloud, seed: e.telemetry.settings.seed, sc: e.telemetry.settings.scenarioId });
  }
  t.ok('T20 el módulo A (referencia) produce la misma energía en las tres corridas', res.length === 3 && Math.abs(res[0].EA - res[1].EA) < 1 && Math.abs(res[0].EA - res[2].EA) < 1, res.map((r) => r.EA.toFixed(1)).join(' / '));
  t.ok('T20 metadatos comunes (nubes, semilla, escenario)', res.every((r) => r.cloud === 0.1 && r.seed === 20261023 && r.sc === 'p3'));
  t.ok('T20 fórmula de ganancia consistente: E_B/E_A−1', res.every((r) => Math.abs(r.gain - (r.EB / r.EA - 1) * 100) < 1e-9), res.map((r) => r.gain.toFixed(1)).join(' / '));
  t.ok('T20 dos ejes ≥ un eje en un día claro', res[0].EB >= res[1].EB * 0.98, `${res[0].EB.toFixed(0)} vs ${res[1].EB.toFixed(0)}`);
}

// ---- comparacion sin referencia
{
  const e = mk(); login(e); e.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, 2, 0) }); run(e, 10);
  t.ok('C13 sin referencia: null y motivo, nunca "-0.0"', e.telemetry.comparison.powerDiffPct === null && e.telemetry.comparison.energyGainPct === null && /sin referencia/.test(e.telemetry.comparison.powerNote), JSON.stringify(e.telemetry.comparison));
  t.eq('fmt nunca produce -0.0', LAB.util.fmt(-0.04, 1), '0.0');
}

// ---- T23 importar corrupto / version desconocida  /  T24 almacenamiento
(async () => {
  const S = LAB.core.store;
  const prog = S.emptyProgress('u1'); prog.practices.p1 = { practiceId: 'p1', status: 'in_progress', steps: { session: true }, answers: { p1q1: { draft: 'x', submitted: 'respuesta válida larga' } }, evidence: { parts: ['pyr'] } };
  S.saveProgress('u1', prog);
  const before = fakeLS.getItem(S.PREFIX + 'u1.progress');
  const bad = [null, 5, 'texto', { kind: 'otro' }, { kind: 'labsolar-backup', schemaVersion: 99, progress: prog }, { kind: 'labsolar-backup', schemaVersion: 2, progress: { kind: 'labsolar-progress', practices: { 'p<1>': {} } } },
    { kind: 'labsolar-backup', schemaVersion: 2, progress: prog, runs: [{ id: 'r1', cols: ['a', 'b'], samples: [[1]] }] }];
  const rejected = bad.filter((b) => !S.validateBackup(b).ok).length;
  t.eq('T23 se rechazan los archivos corruptos o de versión desconocida', rejected, bad.length);
  const r = await S.importBackup(bad[4], 'u1'); t.ok('T23 importBackup devuelve el rechazo', !r.ok);
  t.eq('T23 el estado válido no se sobrescribe', fakeLS.getItem(S.PREFIX + 'u1.progress'), before);
  fakeLS.setItem(S.PREFIX + 'u2.progress', '{no es json');
  const p2 = S.loadProgress('u2'); t.ok('T23 datos corruptos: arranca limpio, avisa y conserva copia', p2.warning && Object.keys(fakeLS._d).some((k) => k.includes('u2.progress.corrupt')));
  const good = await S.exportAll('u1', prog); const v = S.validateBackup(JSON.parse(JSON.stringify(good))); t.ok('T23 una copia propia es válida (ida y vuelta)', v.ok, v.errors.join(';'));
  // Set -> lista
  const withSet = S.emptyProgress('u3'); withSet.practices.p1 = { evidence: { parts: new Set(['a', 'b']) } }; S.saveProgress('u3', withSet);
  t.ok('T22 los Set se guardan como listas', JSON.parse(fakeLS.getItem(S.PREFIX + 'u3.progress')).practices.p1.evidence.parts.length === 2);
  fakeLS.full = true; const ok = S.saveProgress('u1', prog);
  t.ok('T24 cuota agotada: aviso explícito y sigue en memoria', ok === false && /lleno/i.test(S.status.error), S.status.error);
  fakeLS.full = false; t.ok('T24 se recupera cuando hay espacio', S.saveProgress('u1', prog) && !S.status.error);
  // Sin localStorage: se prueba cargando el store sin LS
  const code = fs.readFileSync(path.join(ROOT, 'js/core/store.js'), 'utf8');
  const saveLS = global.localStorage; Object.defineProperty(global, 'localStorage', { get() { throw new Error('bloqueado'); }, configurable: true });
  const old = LAB.core.store; vm.runInThisContext(code, { filename: 'store.js' }); const S2 = LAB.core.store;
  t.ok('T24 almacenamiento bloqueado: modo memoria con aviso', S2.status.mode === 'memoria' && !S2.saveProgress('u9', S2.emptyProgress('u9')) && /navegador/.test(S2.status.error), S2.status.error);
  Object.defineProperty(global, 'localStorage', { value: saveLS, configurable: true, writable: true }); LAB.core.store = old;
  // T25
  const hostile = '<img src=x onerror=alert(1)> & "comillas" `x`';
  t.eq('T25 esc() deja el texto literal', LAB.util.esc(hostile), '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;comillas&quot; &#96;x&#96;');
  const e = mk(); const rs = e.send({ type: 'session.start', role: 'student', user: '<script>alert(1)</script>Zoe' }); t.ok('T25 el nombre se sanea en el motor', rs.ok && !/[<>]/.test(e.telemetry.session.user), e.telemetry.session.user);
  t.ok('T25 el CSV de un nombre hostil no rompe la estructura', (e.send({ type: 'acq.start' }), run(e, 40), !/<script>/.test(e.exportCsv().text)));
  t.done();
})();
