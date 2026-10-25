/* Motor de simulacion. Implementa la interfaz de fuente de datos (ver js/data/dataSource.js y docs/CONTRATO_DATOS.md):
 *   engine.telemetry     -> instantanea del estado (la escena 3D y la interfaz solo leen esto)
 *   engine.send(cmd)     -> comando validado y autorizado por la logica de seguridad; devuelve {ok, reason?, kind?}
 *                           Una solicitud rechazada NO muta el estado.
 *   engine.on(evt, fn)   -> eventos: 'log', 'sweep', 'acq', 'run', 'session'
 *   engine.step(dt)      -> avanza la simulacion
 * Una fuente real (MQTT/API) entregara el mismo objeto de telemetria y recibira los mismos comandos.
 *
 * Conceptos de datos (ver C07-C09 de la propuesta de correcciones):
 *   sesion      una identidad de demostracion local y su periodo de trabajo (id propio)
 *   corrida     un conjunto de muestras adquiridas (id propio); una sesion puede tener varias
 *   segmento    tramo continuo dentro de una corrida: cambia al reiniciar energia, aplicar un escenario,
 *               reanudar la adquisicion o saltar el reloj (discontinuidad)
 *   adquisicion grabar muestras; es independiente de que la telemetria sea visible
 */
(function () {
  'use strict';
  const { clamp, isNum, uid, hashNoise } = LAB.util;
  const S = LAB.sim.solar;
  const PV = LAB.sim.pv;
  const cfg = LAB.config;
  const PO_PERIOD_S = 0.15, PO_MAX_ITERS = 12;     // MPPT perturbar-y-observar: periodo fisico y tope de iteraciones por paso
  const MODES = ['manual', 'astro', 'sensor', 'fixed'];
  const LOAD_MODES = ['mppt', 'cv', 'cr', 'oc', 'sc'];
  const { CR_MIN, CR_MAX, CV_MIN, CV_MAX } = LAB.core.CMD;   // consignas de carga (cv: fraccion de Voc, cr: ohm)

  class Module {
    constructor(id, ch) {
      this.id = id; this.ch = ch;       // ch: canales de ruido (g, v, i)
      this.Tm = 25; this.Tc = 25; this.init = false;      // Tm: temperatura de modulo (estado termico); Tc: de celda = Tm + deltaT*G/1000
      this.energyWh = 0;
      this.vTrack = 36; this.dir = 1; this.lastP = 0; this.poTimer = 0;
      this.cv = null; this.cvAge = 99;
      this.op = { v: 0, i: 0, p: 0 };
      this.poa = { total: 0, beam: 0, circ: 0, iso: 0, sky: 0, ground: 0, aoi: 90, cosAoi: 0 };
      this.shade = 0;
      this.gMeas = 0;
    }
    restart() { this.init = false; this.vTrack = 36; this.dir = 1; this.lastP = 0; this.poTimer = 0; this.cvAge = 99; }
  }

  const sanitizeName = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);

  class Engine {
    constructor(opts = {}) {
      this.listeners = {};
      this.kind = 'sim'; this.mode = 'sim';
      this.simMs = LAB.fromLocal(2026, 10, 23, 10, 30);
      this.speed = 1;
      this.playing = true;              // reloj solar (no congela el banco: el seguidor y los enclavamientos siguen)
      this.realT = 0; this.physT = 0;
      this.seed = opts.seed != null ? opts.seed >>> 0 : 20261023;
      this.scenario = null;
      this.weather = new LAB.sim.Weather();
      this.tracker = new LAB.sim.Tracker();
      this.safety = new LAB.sim.Safety((lvl, msg, src) => this.log(lvl, msg, src));
      this.A = new Module('A', { g: 1, v: 3, i: 4 });
      this.B = new Module('B', { g: 2, v: 5, i: 6 });
      this.load = { mode: 'mppt', setpoint: 0.82 };
      this.sweep = { active: false, t: 0, prevMode: 'mppt', prevSetpoint: 0.82, prevSpeed: 1, pts: { A: [], B: [] }, nextPt: 0, rec: null };
      this.sweeps = [];                 // barridos conservados (completos o interrumpidos)
      this.lastSweep = null;
      this.motorWh = 0;
      this.energy = { startedSimMs: this.simMs, resets: 0 };
      this.logs = [];
      this.history = { t: [], pA: [], pB: [], gA: [], gB: [], tA: [], tB: [], az: [], tilt: [], wind: [], ta: [], motor: [] };
      this.histTimer = 0;
      this.day = { key: '', t: [], pA: [], pB: [], eA: [], eB: [], lastT: 0 };
      this._breakPending = false;
      // sesiones, corridas y adquisicion
      this.sessionsArchive = [];
      this.runs = [];
      this.acq = { status: 'stopped', runId: null, reason: '', timer: 0, elapsedReal: 0, startedReal: 0 };
      this.sunPos = S.position(this.simMs);
      this.telemetry = {};
      this.latency = 45;
      this.jumped = true;
      this.step(0);
    }

    // ------------------------------------------------------------ eventos y bitacora
    on(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); }
    emit(evt, data) { (this.listeners[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error('listener', evt, e); } }); }
    log(level, msg, src = 'Sistema') {
      const entry = { simMs: this.simMs, real: Date.now(), level, msg, src, local: LAB.localTime(this.simMs), sessionId: this.safety.session.id };
      this.logs.push(entry);
      if (this.logs.length > 500) this.logs.shift();
      if (level !== 'info' && (src === 'Seguridad' || src === 'Red' || level === 'bad')) this._event('seguridad', msg);
      this.emit('log', entry);
    }

    // ------------------------------------------------------------ comandos
    send(cmd) {
      let res;
      try { res = this._exec(cmd || {}, this.safety); } catch (e) { console.error(e); res = { ok: false, reason: 'Error interno al ejecutar el comando.', kind: 'internal' }; }
      if (res.log !== false && cmd && cmd.type !== 'noop') {
        if (res.ok && res.msg) { this.log('cmd', res.msg, 'Comando'); this._event('comando', res.msg); }
        if (!res.ok) this.log('warn', `Comando rechazado: ${res.reason}`, res.kind === 'validation' ? 'Validación' : 'Interlock');
      }
      return res;
    }

    _bad(reason, kind = 'validation', field) { return { ok: false, reason, kind, field }; }

    /** Valida tipos, rangos y modos ANTES de tocar el estado (T19). Funcion pura compartida: LAB.core.validateCmd. */
    _validate(cmd) { return LAB.core.validateCmd(cmd, cfg); }

    _exec(cmd, sf) {
      const tr = this.tracker;
      const bad = this._validate(cmd); if (bad) return bad;
      switch (cmd.type) {
        // ----- entorno (solo simulador) -----
        case 'sim.speed': if (this.sweep.active) return this._bad('Hay un barrido en curso: la velocidad se fija en ×1 hasta que termine.', 'interlock'); this.speed = cmd.speed; return { ok: true, log: false };
        case 'sim.play': { if (cmd.toggle === true) cmd = { ...cmd, on: !this.playing }; } this.playing = cmd.on; this._event('reloj', cmd.on ? 'Reloj solar reanudado' : 'Reloj solar en pausa'); return { ok: true, log: false };
        case 'sim.time': {
          if (this.sweep.active) return this._bad('Hay un barrido en curso: espera a que termine o interrúmpelo antes de mover el reloj.', 'interlock');
          const from = this.simMs;
          this.simMs = cmd.ms; this.jumped = true; this._breakPending = true;
          if (this._recording() && Math.abs(cmd.ms - from) > 1500) this._newSegment('salto_de_tiempo', `Salto del reloj: ${LAB.core.localStr(from)} → ${LAB.core.localStr(cmd.ms)}`, from);
          return { ok: true, log: false };
        }
        case 'sim.cloud': this.weather.cloud = cmd.value; return { ok: true, log: false };
        case 'sim.wind': this.weather.windBase = cmd.value; return { ok: true, log: false };
        case 'sim.gust': this.weather.triggerGust(cmd.peak, cmd.seconds); this.log('info', `Ráfaga de viento generada en el simulador (pico ${cmd.peak} m/s, ${cmd.seconds} s). El viento medio configurado no cambia.`, 'Entorno'); return { ok: true, log: false };
        case 'sim.rain': {
          const lvl = cmd.level != null ? cmd.level : cmd.on ? 2 : 0;
          this.weather.setRain(lvl);
          const R = LAB.sim.RAIN_LEVELS[this.weather.rainLevel];
          this.log('info', R.mmh ? `Lluvia ${R.name.toLowerCase()} (${R.mmh} mm/h, simulada).` : 'Termina la lluvia.', 'Entorno');
          return { ok: true, log: false };
        }
        case 'sim.seed': this.seed = cmd.seed; this.log('info', `Semilla del ruido de medición: ${cmd.seed}.`, 'Entorno'); return { ok: true, log: false };
        case 'sim.comms': sf.setComms(cmd.connected); return { ok: true, log: false };
        case 'sim.resetEnergy': {
          // Nuevo segmento de integracion: NO borra muestras, lluvia ni otras sesiones (C07)
          if (this._recording()) this._closeSegment();      // H04: el segmento termina con la energia que llevaba, ANTES de ponerla a cero
          this.A.energyWh = 0; this.B.energyWh = 0; this.motorWh = 0;
          this.energy.startedSimMs = this.simMs; this.energy.resets++;
          this.log('info', 'Contadores de energía puestos a cero: empieza un nuevo segmento de integración. Las muestras registradas se conservan.', 'Sistema');
          if (this._recording()) this._newSegment('energia_a_cero', 'Contadores de energía puestos a cero', undefined, true);
          return { ok: true, log: false };
        }
        case 'sim.resetRain': this.weather.rainMm = 0; this.log('info', 'Acumulado de lluvia puesto a cero.', 'Sistema'); return { ok: true, log: false };
        case 'scenario.apply': return this._applyScenario(cmd);
        // ----- seguridad local -----
        case 'safety.estop': sf.pressEstop(cmd.who); if (this.sweep.active) this.abortSweep('paro de emergencia'); return { ok: true, log: false };
        case 'safety.reset': return sf.resetEstop() ? { ok: true, log: false } : this._bad('No hay paro de emergencia activo.', 'interlock');
        case 'safety.ack': {
          const a = sf.allow('ack'); if (!a.ok) return a;
          return sf.acknowledgeFault() ? { ok: true, log: false } : this._bad('No hay falla de comunicación por reconocer, o el enlace sigue caído.', 'interlock');
        }
        // ----- sesion -----
        case 'session.start': return this._startSession(cmd);
        case 'session.end': return this._endSession(cmd.why || 'terminada por el usuario');
        // ----- adquisicion -----
        case 'acq.start': return this._acqStart();
        case 'acq.stop': return this._acqStop(cmd.reason || 'detenida por el usuario');
        case 'acq.newRun': return this._acqNewRun(cmd);
        case 'acq.discard': return this._acqDiscard(cmd.runId);
      }
      // ----- comandos operativos: pasan por el interlock -----
      if (cmd.type === 'tracker.target') {
        const a = sf.allow('move', { az: cmd.az, tilt: cmd.tilt }); if (!a.ok) return { ...a, kind: 'interlock' };
        const ign = [cmd.az != null && tr.lockAz ? 'azimut' : '', cmd.tilt != null && tr.lockTilt ? 'inclinación' : ''].filter(Boolean);
        if (ign.length && ign.length === (cmd.az != null) + (cmd.tilt != null)) return this._bad(`El eje de ${ign.join(' y ')} está inmovilizado (modo de un solo eje). Elige "Dos ejes" o el eje correcto.`, 'interlock');
        if (tr.mode !== 'manual') tr.setMode('manual');
        tr.setTarget(cmd.az, cmd.tilt);
        if (ign.length) this.log('warn', `Se ignoró el ${ign.join(' y ')}: eje inmovilizado.`, 'Comando');
        return { ok: true, msg: `Mover módulo B a ${cmd.az != null ? 'azimut ' + cmd.az.toFixed(0) + '°' : ''}${cmd.az != null && cmd.tilt != null ? ', ' : ''}${cmd.tilt != null ? 'inclinación ' + cmd.tilt.toFixed(0) + '°' : ''}.` };
      }
      if (cmd.type === 'tracker.mode') {
        const a = sf.allow('mode'); if (!a.ok) return { ...a, kind: 'interlock' };
        tr.setMode(cmd.mode);
        return { ok: true, msg: `Modo del seguidor: ${LAB.sim.TRACKER_MODES[cmd.mode]}.` };
      }
      if (cmd.type === 'tracker.locks') {
        const a = sf.allow('mode'); if (!a.ok) return { ...a, kind: 'interlock' };
        tr.setLocks(!!cmd.lockAz, !!cmd.lockTilt);
        const txt = cmd.lockAz && cmd.lockTilt ? 'ambos ejes bloqueados' : cmd.lockAz ? 'un eje: solo inclinación (azimut inmovilizado)' : cmd.lockTilt ? 'un eje: solo azimut (inclinación inmovilizada)' : 'dos ejes libres';
        return { ok: true, msg: `Configuración de ejes: ${txt}.` };
      }
      if (cmd.type === 'load.set') {
        const a = sf.allow('load'); if (!a.ok) return { ...a, kind: 'interlock' };
        if (this.sweep.active) return this._bad('Hay un barrido I-V en curso.', 'interlock');
        this.load.mode = cmd.mode;
        if (cmd.setpoint != null) this.load.setpoint = cmd.setpoint;
        const names = { oc: 'circuito abierto', sc: 'cortocircuito controlado', cv: 'tensión constante', cr: 'resistencia constante', mppt: 'seguimiento del punto de máxima potencia' };
        return { ok: true, msg: `Carga programable: ${names[cmd.mode] || cmd.mode}.` };
      }
      if (cmd.type === 'load.sweep') {
        const a = sf.allow('load'); if (!a.ok) return { ...a, kind: 'interlock' };
        if (this.sweep.active) return this._bad('Ya hay un barrido en curso.', 'interlock');
        this.startSweep();
        return { ok: true, msg: `Barrido I-V iniciado (${cfg.sweepSeconds} s). El tiempo del simulador se fija en ×1.` };
      }
      if (cmd.type === 'load.sweep.abort') {
        if (!this.sweep.active) return this._bad('No hay barrido en curso.', 'interlock');
        this.abortSweep('interrumpido por el usuario');
        return { ok: true, log: false };
      }
      return this._bad(`Comando desconocido: ${cmd.type}`, 'validation');
    }

    // ------------------------------------------------------------ sesiones
    _startSession(cmd) {
      if (this.safety.session.active) return this._bad('Ya hay una sesión activa: termínala antes de iniciar otra.', 'interlock');
      const user = sanitizeName(cmd.user);
      const id = uid('ses');
      this.safety.startSession(cmd.role, user || undefined, id, cmd.profileId ? String(cmd.profileId).slice(0, 64) : null);
      const entry = { id, profileId: this.safety.session.profileId, user: this.safety.session.user, role: cmd.role, startedReal: Date.now(), startedSimMs: this.simMs, endedReal: null, final: null, runIds: [], simulated: true };
      this.sessionsArchive.push(entry);
      this.acq = { status: 'stopped', runId: null, reason: '', timer: 0, elapsedReal: 0, startedReal: 0 };   // la sesion nueva no hereda corridas
      this.emit('session', { phase: 'start', entry });
      return { ok: true, log: false, sessionId: id };
    }
    _endSession(why) {
      const s = this.safety.session; if (!s.active) return this._bad('No hay sesión activa.', 'interlock');
      if (this.sweep.active) this.abortSweep('sesión terminada');
      if (this._recording()) this._acqStop('sesión terminada');
      const entry = this.sessionsArchive.find((e) => e.id === s.id);
      const t = this.telemetry, tr = this.tracker;
      const final = {
        safety: this.safety.state, trackerAz: tr.az, trackerTilt: tr.tilt, trackerMoving: Math.abs(tr.az - tr.targetAz) > 0.05 || Math.abs(tr.tilt - tr.targetTilt) > 0.05,
        trackerMode: t.tracker.appliedMode, loadMode: this.load.mode, runs: this.runs.filter((r) => r.sessionId === s.id).length,
        note: 'Estado en el instante de cerrar la sesión. Si el seguidor seguía en movimiento, la posición final aún no se alcanzó.',
      };
      this.runs.filter((r) => r.sessionId === s.id).forEach((r) => { r.status = r.status === 'limit' ? 'limit' : 'closed'; r.closedAtUtc = new Date().toISOString(); this.emit('run', r); });
      if (entry) { entry.endedReal = Date.now(); entry.final = final; entry.why = why; }
      this.log('info', `Sesión finalizada (${why}). Adquisición detenida y resultados conservados. Seguidor ${final.trackerAz.toFixed(0)}°/${final.trackerTilt.toFixed(0)}°${final.trackerMoving ? ' (aún en movimiento)' : ''}; carga ${final.loadMode}; seguridad ${final.safety}.`, 'Acceso');
      this.safety.endSession();
      this.acq = { status: 'stopped', runId: null, reason: '', timer: 0, elapsedReal: 0, startedReal: 0 };
      this.emit('session', { phase: 'end', entry });
      return { ok: true, log: false, final };
    }

    // ------------------------------------------------------------ adquisicion y corridas
    _recording() { return this.acq.status === 'recording'; }
    activeRun() { return this.runs.find((r) => r.id === this.acq.runId) || null; }
    getRun(id) { return this.runs.find((r) => r.id === id) || null; }
    _canAcquire() {
      const s = this.safety.session;
      if (!s.active) return 'No hay sesión: inicia una sesión de demostración para adquirir datos.';
      if (!LAB.sim.ROLES[s.role].canOperate) return 'Tu rol (Visitante) es de solo observación y no puede adquirir datos.';
      return '';
    }
    _makeRun(label, practiceId) {
      const s = this.safety.session;
      const run = {
        schemaVersion: cfg.schemaVersion, kind: 'labsolar-run', id: uid('run'), sessionId: s.id, profileId: s.profileId, user: s.user, role: s.role,
        practiceId: practiceId || null, label: label || '', createdAtUtc: new Date().toISOString(), closedAtUtc: null, status: 'open',
        site: cfg.site.name, appVersion: cfg.appVersion, source: 'sim', sampling: { basis: cfg.acq.basis, everyS: cfg.acq.sampleEveryS }, limit: cfg.acq.limit,
        seed: this.seed, scenario: this.scenario ? { id: this.scenario.id, seed: this.scenario.seed } : null,
        cols: LAB.core.RUN_COLS.slice(), samples: [], segments: [], events: [],
      };
      this.runs.push(run);
      const entry = this.sessionsArchive.find((e) => e.id === s.id); if (entry) entry.runIds.push(run.id);
      return run;
    }
    _acqNewRun(cmd) {
      const why = this._canAcquire(); if (why) return this._bad(why, 'interlock');
      if (this._recording()) return this._bad('Detén la adquisición antes de crear una corrida nueva.', 'interlock');
      const run = this._makeRun(cmd.label, cmd.practiceId);
      this.acq.runId = run.id; this.acq.elapsedReal = 0; this.acq.reason = '';
      this.log('info', `Corrida nueva creada (${run.id}). Aún no está grabando.`, 'Adquisición');
      this.emit('acq', { status: 'stopped', runId: run.id });
      return { ok: true, log: false, runId: run.id };
    }
    _acqStart() {
      const why = this._canAcquire(); if (why) return this._bad(why, 'interlock');
      if (this._recording()) return this._bad('La adquisición ya está grabando.', 'interlock');
      let run = this.activeRun();
      if (run && run.samples.length >= run.limit) { this.log('warn', 'La corrida anterior llegó a su límite: se crea una corrida nueva.', 'Adquisición'); run = null; }
      if (run && run.status === 'closed') run = null;
      const resumed = !!run;
      if (!run) { run = this._makeRun('', null); this.acq.runId = run.id; this.acq.elapsedReal = 0; }
      run.status = 'open';
      this.acq.status = 'recording'; this.acq.reason = ''; this.acq.timer = 0; this.acq.startedReal = Date.now();
      this._newSegment(resumed ? 'reanudacion' : 'inicio', resumed ? 'Adquisición reanudada (el reloj pudo avanzar mientras estaba detenida)' : 'Inicio de la adquisición', undefined, true);   // el segmento anterior ya se cerro al detener
      this._event('adquisicion', resumed ? 'Adquisición reanudada' : 'Adquisición iniciada');
      this.log('ok', `${resumed ? 'Adquisición reanudada' : 'Adquisición iniciada'} · corrida ${run.id} · una muestra por segundo (${cfg.acq.basis}).`, 'Adquisición');
      this.emit('acq', { status: 'recording', runId: run.id });
      return { ok: true, log: false, runId: run.id };
    }
    _acqStop(reason) {
      if (!this._recording()) return this._bad('La adquisición no está grabando.', 'interlock');
      const run = this.activeRun();
      this._closeSegment();
      this._event('adquisicion', `Adquisición detenida (${reason})`);
      this.acq.status = 'stopped'; this.acq.reason = reason;
      if (run) run.status = run.samples.length >= run.limit ? 'limit' : 'stopped';
      this.log(reason === 'limite' ? 'warn' : 'info', `Adquisición detenida (${reason}). ${run ? run.samples.length : 0} muestras conservadas; puedes exportarlas o reanudar.`, 'Adquisición');
      this.emit('acq', { status: 'stopped', runId: run ? run.id : null, reason });
      if (run) this.emit('run', run);
      return { ok: true, log: false };
    }
    _acqDiscard(runId) {
      const i = this.runs.findIndex((r) => r.id === runId); if (i < 0) return this._bad('No existe esa corrida.', 'validation');
      if (this._recording() && this.acq.runId === runId) return this._bad('Detén la adquisición antes de descartar la corrida.', 'interlock');
      const r = this.runs[i]; this.runs.splice(i, 1);
      if (this.acq.runId === runId) this.acq.runId = null;
      this.log('warn', `Corrida ${r.id} descartada (${r.samples.length} muestras). Los archivos ya descargados no se tocan.`, 'Adquisición');
      this.emit('run', { ...r, status: 'discarded' });
      return { ok: true, log: false };
    }
    /** H04: cierra el segmento vigente con los acumuladores FISICOS de este instante (antes solo se actualizaban al muestrear y se perdia la energia final) */
    _closeSegment(endSimMs) {
      const run = this.activeRun(); if (!run) return;
      const seg = run.segments[run.segments.length - 1]; if (!seg) return;
      seg.end = { ...this._acc(), n: run.samples.length };
      if (endSimMs != null) seg.end.simMs = endSimMs;
    }
    _newSegment(reason, text, prevEndSimMs, alreadyClosed = false) {
      const run = this.activeRun(); if (!run) return;
      const last = run.segments[run.segments.length - 1];
      if (reason === 'salto_de_tiempo' && last && last.reason === reason && last.firstSample === run.samples.length) { last.startedSimMs = this.simMs; return; }   // arrastre continuo del control de hora: un solo segmento
      if (!alreadyClosed) this._closeSegment(prevEndSimMs);
      const seg = { id: 's' + (run.segments.length + 1), startedSimMs: this.simMs, startedAtUtc: new Date().toISOString(), reason, firstSample: run.samples.length,
        start: this._acc(), ctx: this._ctx() };
      run.segments.push(seg);
      this._event('segmento', `${text || reason} → segmento ${seg.id}`);
    }
    /** Acumuladores de energia en este instante (para que cada segmento sepa cuanto aporto: C12) */
    _acc() { return { eA: this.A.energyWh, eB: this.B.energyWh, motorWh: this.motorWh, simMs: this.simMs }; }
    /** Condiciones en las que corre un segmento: lo que se compara entre corridas y lo que difiere a proposito (C12) */
    _ctx() {
      const tr = this.tracker, w = this.weather;
      return { trackerMode: tr.mode, lockAz: !!tr.lockAz, lockTilt: !!tr.lockTilt, loadMode: this.load.mode, cloud: w.cloud, windBase: w.windBase,
        speed: this.speed, scenarioId: this.scenario ? this.scenario.id : null, seed: this.seed };
    }
    _event(type, text) {
      const run = this.activeRun(); if (!run || !this._recording() && type !== 'adquisicion') return;
      run.events.push({ n: run.samples.length, simMs: this.simMs, realMs: Date.now(), segmentId: run.segments.length ? run.segments[run.segments.length - 1].id : null, type, text });
      if (run.events.length > 5000) run.events.shift();
    }
    _record(dtReal, t) {
      if (!this._recording()) return;
      const run = this.activeRun(); if (!run) return;
      // H04: instantes objetivo. El residuo del cronometro se conserva (antes se ponia a 0 y el redondeo retrasaba la muestra: 90 en 100 s)
      this.acq.elapsedReal += dtReal; this.acq.timer += dtReal;
      const period = cfg.acq.sampleEveryS, due = Math.floor((this.acq.timer + 1e-9) / period);
      if (due < 1) return;
      this.acq.timer = Math.max(0, this.acq.timer - due * period);
      if (due > 1) run.missedSamples = (run.missedSamples || 0) + (due - 1);     // vencidas y no inventadas: se informan, no se rellenan
      if (run.samples.length >= run.limit) { this._acqStop('limite'); return; }
      const seg = run.segments[run.segments.length - 1];
      if (seg) seg.end = { ...this._acc(), n: run.samples.length };
      run.samples.push([run.samples.length, seg ? seg.id : 's1', t.simMs, Date.now(), t.A.poa, t.B.poa, t.A.tcell, t.B.tcell, t.env.ta, t.env.rh, t.env.wind, t.env.windDir,
        t.A.v, t.A.i, t.A.p, t.A.wh, t.B.v, t.B.i, t.B.p, t.B.wh, t.B.az, t.B.tilt, t.tracker.appliedMode, t.load.mode, t.safety.state, t.settings.cloud * 100, t.A.shadeFrac, t.B.shadeFrac]);
      if (run.samples.length >= run.limit) {
        this.log('warn', `La corrida llegó al límite de ${run.limit} muestras: la adquisición se detiene (no se descarta nada). Exporta o crea una corrida nueva.`, 'Adquisición');
        this._acqStop('limite');
      }
    }

    // ------------------------------------------------------------ escenario reproducible (C12)
    _applyScenario(cmd) {
      const why = this.safety.blockReason();
      if (why) return { ok: false, reason: `No se puede preparar el escenario: ${why}`, kind: 'interlock', resolve: why };
      if (this.safety.commsCut) return this._bad('No se puede preparar el escenario con el enlace cortado: restablécelo primero.', 'interlock');
      if (this.sweep.active) return this._bad('Hay un barrido en curso.', 'interlock');
      const sc = cmd.scenario || {};
      for (const [k, lo, hi] of [['simMs', 9.46e11, 4.1e12], ['cloud', 0, 1], ['windBase', 0, cfg.limits.windMax], ['seed', 0, 4294967295], ['az', cfg.tracker.azMin, cfg.tracker.azMax], ['tilt', cfg.tracker.tiltMin, cfg.tracker.tiltMax]]) {   // H10: az/tilt tambien, antes de mutar
        if (sc[k] != null && (!isNum(sc[k]) || sc[k] < lo || sc[k] > hi)) return this._bad(`Escenario con ${k} no válido.`, 'validation');
      }
      if (sc.speed != null && !cfg.speeds.includes(sc.speed)) return this._bad('Escenario con velocidad no válida.', 'validation');
      const tr = this.tracker;
      if (this._recording()) this._closeSegment();      // H04: cerrar con la energia vigente antes de reiniciar contadores y reloj
      this.weather.windBase = sc.windBase != null ? sc.windBase : this.weather.windBase;
      this.weather.cloud = sc.cloud != null ? sc.cloud : this.weather.cloud;
      this.weather.setRain(0);
      if (sc.simMs != null) { this.simMs = sc.simMs; this.jumped = true; this._breakPending = true; }
      this.seed = sc.seed != null ? sc.seed >>> 0 : this.seed;
      this.realT = 0; this.physT = 0;
      this.weather.reset(LAB.localTime(this.simMs));
      this.A.restart(); this.B.restart();
      tr.az = tr.targetAz = tr.holdAz = (sc.az != null ? sc.az : cfg.fixed.az); tr.tilt = tr.targetTilt = tr.holdTilt = (sc.tilt != null ? sc.tilt : cfg.fixed.tilt);
      tr.vAz = tr.vTilt = 0; tr.lockAz = tr.lockTilt = false; tr.mode = 'manual';
      this.load = { mode: 'mppt', setpoint: 0.82 };
      if (sc.speed != null) this.speed = sc.speed;
      this.playing = true;
      this.A.energyWh = 0; this.B.energyWh = 0; this.motorWh = 0; this.energy.startedSimMs = this.simMs; this.energy.resets++;
      this.history = { t: [], pA: [], pB: [], gA: [], gB: [], tA: [], tB: [], az: [], tilt: [], wind: [], ta: [], motor: [] };
      this.scenario = { id: sc.id || 'sin-id', seed: this.seed, appliedAtReal: Date.now(), simMs: this.simMs, cloud: this.weather.cloud, windBase: this.weather.windBase };
      this.log('info', `Escenario "${this.scenario.id}" aplicado (simulador): ${LAB.core.localStr(this.simMs)}, nubes ${(this.weather.cloud * 100).toFixed(0)} %, viento medio ${this.weather.windBase} m/s, semilla ${this.seed}, seguidor ${tr.az}°/${tr.tilt}°, energía a cero.`, 'Escenario');
      if (this._recording()) this._newSegment('escenario', `Escenario ${this.scenario.id} aplicado`, undefined, true);
      return { ok: true, log: false, scenario: this.scenario };
    }

    // ------------------------------------------------------------ barridos
    startSweep() {
      const s = this.sweep, t = this.telemetry;
      s.active = true; s.t = 0; s.nextPt = 0;
      s.prevMode = this.load.mode; s.prevSetpoint = this.load.setpoint; s.prevSpeed = this.speed;
      s.pts = { A: [], B: [] };
      s.rec = {
        id: uid('sw'), sessionId: this.safety.session.id, profileId: this.safety.session.profileId, createdAtUtc: new Date().toISOString(), schemaVersion: cfg.schemaVersion, kind: 'labsolar-sweep', runId: this._recording() ? this.acq.runId : null, segmentId: null,
        startSimMs: this.simMs, startReal: Date.now(), source: 'simulador', status: 'running', cause: '',
        cond: { start: this._cond(t), end: null },
      };
      this.speed = 1;
      if (!this._bankSlot()) this._sweepEndpoint('sc');
    }
    _cond(t) {
      return { gA: t.A.poaTrue, gB: t.B.poaTrue, tA: t.A.tcell, tB: t.B.tcell, ghi: t.env.ghi, dni: t.env.dni, ta: t.env.ta, cloud: t.settings.cloud, wind: t.env.wind, azB: t.B.az, tiltB: t.B.tilt };
    }
    /** H08: punto extremo del barrido continuo ('sc' = V=0, 'oc' = I=0) con la curva vigente; el barrido por tension nunca llega exactamente a ellos. */
    _sweepEndpoint(kind) {
      const pt = (m) => { const o = PV.operating(m.cv, kind, 0, 0); return { v: o.v, i: o.i, p: o.v * o.i, g: m.poa.total }; };
      this.sweep.pts.A.push(pt(this.A)); this.sweep.pts.B.push(pt(this.B));
    }
    _finishSweep(status, cause) {
      const s = this.sweep, t = this.telemetry;
      if (status === 'complete' && !this._bankSlot()) this._sweepEndpoint('oc');
      s.active = false;
      this.load.mode = s.prevMode; this.load.setpoint = s.prevSetpoint; this.speed = s.prevSpeed;
      const rec = s.rec; rec.status = status; rec.cause = cause || ''; rec.cond.end = this._cond(t); rec.endSimMs = this.simMs;
      rec.pts = { A: s.pts.A.slice(), B: s.pts.B.slice() };
      rec.model = { A: { v: this.A.cv.v.slice(), i: this.A.cv.i.slice(), p: this.A.cv.p.slice() }, B: { v: this.B.cv.v.slice(), i: this.B.cv.i.slice(), p: this.B.cv.p.slice() } };   // curva calculada al terminar, SOLO como referencia
      const run = rec.runId ? this.getRun(rec.runId) : null;
      rec.segmentId = run && run.segments.length ? run.segments[run.segments.length - 1].id : null;
      rec.label = `Barrido ${this.sweeps.length + 1}`;
      this.sweeps.push(rec);
      this.lastSweep = rec;
      s.rec = null;
      const pa = Math.max(0, ...rec.pts.A.map((p) => p.p)), pb = Math.max(0, ...rec.pts.B.map((p) => p.p));
      if (status === 'complete') this.log('ok', `Barrido I-V completado: Pmax A = ${pa.toFixed(0)} W, Pmax B = ${pb.toFixed(0)} W (puntos del simulador).`, 'Carga');
      else this.log('warn', `Barrido I-V interrumpido (${cause}): se conservan ${rec.pts.A.length} puntos parciales y el modo de carga se restauró.`, 'Carga');
      this._event('barrido', `Barrido ${status === 'complete' ? 'completo' : 'interrumpido (' + cause + ')'}`);
      this.emit('sweep', rec);
    }
    abortSweep(cause) { if (this.sweep.active) this._finishSweep('interrupted', cause); }

    // ------------------------------------------------------------ paso de simulacion
    _noise(m, k) { return hashNoise(this.seed, Math.floor(this.physT * 20), m.ch[k]); }

    /**
     * Un cuadro de la aplicacion (dtReal s reales). H01: el mundo se avanza en pasos FISICOS (_physicsStep) y el cuadro solo decide
     * cuantos; acelerar el reloj calcula mas pasos con la misma historia fisica, no motores ni controles mas rapidos.
     * Con el reloj en pausa los procesos del banco (motores, viento, MPPT) siguen a ritmo real (modo didactico), y el Sol, la
     * temperatura y la energia quedan congelados. Si el cuadro necesita mas de physics.maxSubsteps pasos, el paso crece (tope de calculo).
     */
    step(dtReal) {
      dtReal = clamp(dtReal, 0, 0.1);
      this.realT += dtReal;
      const speed = this.sweep.active ? 1 : this.speed;
      const dtPhys = this.playing ? dtReal * speed : dtReal;
      const n = clamp(Math.ceil(dtPhys / cfg.physics.stepS - 1e-9), 1, cfg.physics.maxSubsteps);
      const h = dtPhys / n, hSim = this.playing ? h : 0;
      let last = null;
      for (let k = 0; k < n; k++) last = this._physicsStep(h, hSim, dtReal / n);
      const { lt, irr, sun, sunVec, mode } = last;
      this._snapshot(lt, irr, sun, sunVec, mode);
      this._history(dtReal, lt);
      this._record(dtReal, this.telemetry);
      const run = this.activeRun(); this.telemetry.acq.samples = run ? run.samples.length : 0; this.telemetry.acq.status = this.acq.status;
    }

    /** h = segundos fisicos del paso, hSim = lo que avanza el reloj solar en el (0 en pausa), dtComms = parte del cuadro real (watchdog de enlace) */
    _physicsStep(h, hSim, dtComms) {
      this.physT += h;
      const sf = this.safety, tr = this.tracker, w = this.weather;
      this.simMs += hSim * 1000;
      const lt = LAB.localTime(this.simMs);

      // sol y recurso
      const sun = S.position(this.simMs);
      this.sunPos = sun;
      const sunVec = S.sunVector(sun.az, sun.el);
      w.update(h, hSim, lt);
      const cs = S.clearsky(lt, sun.el);
      const irr = S.applyClouds(cs, w.cloud, sun.el, w.flicker);
      irr.e0 = S.extraRadiation(lt.dayOfYear);
      if (sun.el <= 0) { irr.ghi = irr.dni = irr.dhi = 0; }
      if (this.envOverride) this._applyEnvOverride(w, irr);

      // seguridad y seguidor
      sf.update(h, hSim, w.wind, this.simMs, dtComms);
      tr.enabled = !sf.estop;
      tr.update(h, { sun, irr, stow: sf.stowRequired });
      if (this.followPose) { tr.az = this.followPose.az; tr.tilt = this.followPose.tilt; tr.vAz = tr.vTilt = 0; }
      if (tr.limitHit.az || tr.limitHit.tilt) {
        if (!this._limitLogged) { this.log('info', 'Final de carrera alcanzado en el seguidor (el movimiento se detiene).', 'Seguidor'); this._limitLogged = true; }
      } else this._limitLogged = false;
      if (this.sweep.active && (sf.estop || sf.stowRequired)) this.abortSweep(sf.estop ? 'paro de emergencia' : 'posición segura');

      // modulos
      this._module(this.A, cfg.fixed, sunVec, irr, w, hSim, h);
      this._module(this.B, { az: tr.az, tilt: tr.tilt }, sunVec, irr, w, hSim, h);
      const sh = sun.el > 0 ? LAB.sim.shade.mutual(sunVec, tr.az, tr.tilt) : { A: 0, B: 0 };
      this.A.shade = sh.A; this.B.shade = sh.B;
      this.jumped = false;

      // carga (la carga se desconecta con el paro de emergencia)
      const mode = sf.estop ? 'oc' : this.load.mode;
      let setpoint = this.load.setpoint;
      if (this.sweep.active) this._stepSweep(h, this.sweep);
      const sweeping = this.sweep.active;
      let mm = sweeping ? 'cv' : mode;
      if (sweeping) {
        const slot = this._bankSlot();
        if (slot) { mm = slot.mode; setpoint = slot.setpoint; } else setpoint = clamp(this.sweep.t / cfg.sweepSeconds, 0, 1);
      }
      for (const m of [this.A, this.B]) this._operate(m, mm, setpoint, h, hSim);
      if (sweeping) this._recordSweep();

      // energia
      this.motorWh += tr.powerW * hSim / 3600;
      return { lt, irr, sun, sunVec, mode };
    }

    /** Modo gemelo: el modelo corre con el ambiente MEDIDO (override) para compararlo con lo que mide el banco. null/undefined = ambiente simulado. */
    setEnvOverride(env, pose) {
      this.envOverride = env || null;
      this.followPose = env && pose && Number.isFinite(pose.az) && Number.isFinite(pose.tilt) ? { az: pose.az, tilt: pose.tilt } : null;
    }
    _applyEnvOverride(w, irr) {
      const o = this.envOverride, n = (v, d) => (Number.isFinite(v) ? v : d);
      irr.ghi = n(o.ghi, irr.ghi); irr.dni = n(o.dni, irr.dni); irr.dhi = n(o.dhi, irr.dhi);
      w.Ta = n(o.ta, w.Ta); w.RH = n(o.rh, w.RH); w.wind = n(o.wind, w.wind); w.windDir = n(o.windDir, w.windDir);
    }

    _module(m, orient, sunVec, irr, w, dtSim, dtReal) {
      const normal = S.normalVector(orient.az, orient.tilt);
      m.poa = S.poa(irr, sunVec, normal, orient.tilt, cfg.site.albedo);
      m.az = orient.az; m.tilt = orient.tilt;
      // temperatura de MODULO (cara posterior) dinamica; la de celda se deriva (S4)
      if (!m.init || this.jumped) { m.Tm = PV.moduleTempStep(w.Ta, m.poa.total, w.Ta, w.wind, 1e9); m.init = true; }
      else m.Tm = PV.moduleTempStep(m.Tm, m.poa.total, w.Ta, w.wind, dtSim);
      m.Tc = PV.cellFromModule(m.Tm, m.poa.total);
      m.tBack = m.Tm;
      // lo que MIDE el sensor del plano (S5), no la verdad
      m.gMeas = LAB.sim.sensors.poaSensor(m.poa, cfg.sensors[m.id === 'A' ? 'poaA' : 'poaB'], m.tBack, this._noise(m, 'g'));
      m.cvAge += dtReal;
      if (!m.cv || m.cvAge > 0.12) { m.cv = PV.curve(m.poa.total, m.Tc, 70); m.cvAge = 0; }
    }

    _operate(m, mode, setpoint, dtReal, dtSim) {
      const cv = m.cv;
      if (mode === 'mppt') {
        // perturbar y observar cada PO_PERIOD_S de tiempo fisico (H01); en un paso largo se hacen varias iteraciones, con tope
        m.poTimer += dtReal;
        let iters = Math.floor(m.poTimer / PO_PERIOD_S + 1e-9);
        if (iters > 0) {
          m.poTimer = Math.max(0, m.poTimer - iters * PO_PERIOD_S);
          iters = Math.min(iters, PO_MAX_ITERS);
          for (let k = 0; k < iters; k++) {
            if (k > 0) { const o = PV.operating(cv, mode, setpoint, m.vTrack); m.op = { v: o.v, i: o.i, p: o.v * o.i }; }
            if (m.op.p < m.lastP) m.dir *= -1;
            m.lastP = m.op.p;
            m.vTrack = clamp(m.vTrack + m.dir * 0.45, 2, Math.max(cv.voc, 5));
          }
        }
        if (cv.pmp <= 0) m.vTrack = 0.8 * (cv.voc || 40);
      }
      const op = PV.operating(cv, mode, setpoint, m.vTrack);
      const v = op.v * (1 + 0.0015 * this._noise(m, 'v')), i = Math.max(0, op.i * (1 + 0.0015 * this._noise(m, 'i')));
      m.op = { v, i, p: v * i };
      m.energyWh += m.op.p * dtSim / 3600;
    }

    _stepSweep(dtReal, s) {
      s.t += dtReal;
      if (s.t >= cfg.sweepSeconds) this._finishSweep('complete');
    }

    /** Banco de cargas discreto (S7): circuito abierto, cada resistencia de mayor a menor y cortocircuito, sweepSeconds/(N+2) por punto.
     *  null si la carga es continua (barrido por tension). */
    _bankSlot() {
      const bank = cfg.load && cfg.load.bank;
      if (!bank || !bank.length) return null;
      const list = bank.slice().sort((a, b) => b - a), n = list.length + 2, slotLen = cfg.sweepSeconds / n;
      const k = Math.min(n - 1, Math.floor(this.sweep.t / slotLen));
      const frac = this.sweep.t / slotLen - k;
      const mode = k === 0 ? 'oc' : k === n - 1 ? 'sc' : 'cr';
      return { k, n, frac, mode, setpoint: mode === 'cr' ? list[k - 1] : undefined };
    }

    _recordSweep() {
      const s = this.sweep;
      const slot = this._bankSlot();
      if (slot) {                               // un punto por resistencia, ya estabilizado (al 70 % de su tramo)
        if (slot.frac < 0.7 || s.bankDone === slot.k + ':' + s.rec.id) return;
        s.bankDone = slot.k + ':' + s.rec.id;
      } else {
        if (!s.active || s.t < s.nextPt) return;
        s.nextPt = s.t + 0.14;
      }
      s.pts.A.push({ v: this.A.op.v, i: this.A.op.i, p: this.A.op.p, g: this.A.poa.total });
      s.pts.B.push({ v: this.B.op.v, i: this.B.op.i, p: this.B.op.p, g: this.B.poa.total });
    }

    _snapshot(lt, irr, sun, sunVec, loadMode) {
      const tr = this.tracker, sf = this.safety, w = this.weather;
      this.latency += (45 + 30 * Math.abs(LAB.util.noise1(this.realT / 3, 2)) - this.latency) * 0.05;
      const mod = (m) => ({
        az: m.az, tilt: m.tilt, poa: m.gMeas, poaTrue: m.poa.total, beam: m.poa.beam, circ: m.poa.circ, aoi: m.poa.aoi, shadeFrac: m.shade,
        tcell: m.Tc, tback: m.tBack, v: m.op.v, i: m.op.i, p: m.op.p, wh: m.energyWh,
        voc: m.cv.voc, isc: m.cv.isc, vmp: m.cv.vmp, imp: m.cv.imp, pmp: m.cv.pmp,
        eff: m.poa.total > 20 ? m.op.p / (m.poa.total * cfg.module.area) * 100 : 0,
        curve: m.cv,
      });
      const A = mod(this.A), B = mod(this.B);
      // Comparacion: potencia instantanea y energia son magnitudes distintas (C13). null = sin referencia suficiente.
      const comparison = {
        powerDiffBandPct: 1,        // banda de incertidumbre (~±1 %): dentro de ella A y B no se distinguen del ruido de medida
        powerDiffPct: A.p >= 5 ? (B.p / A.p - 1) * 100 : null,
        energyGainPct: A.wh >= 1 ? (B.wh / A.wh - 1) * 100 : null,
        netGainPct: A.wh >= 1 ? ((B.wh - this.motorWh) / A.wh - 1) * 100 : null,
        powerNote: A.p >= 5 ? '' : 'P_A < 5 W: sin referencia',
        energyNote: A.wh >= 1 ? '' : 'E_A < 1 Wh: sin referencia suficiente',
      };
      const role = sf.role;
      const effective = sf.estop ? 'estop' : sf.watchdogTrip || sf.windStow ? 'stow' : ((tr.mode === 'astro' || tr.mode === 'sensor') && sun.el < 2 ? 'night' : tr.mode);
      const run = this.activeRun();
      this.telemetry = {
        simMs: this.simMs, local: lt, speed: this.sweep.active ? 1 : this.speed, playing: this.playing, source: 'sim',
        clock: { playing: this.playing, speed: this.sweep.active ? 1 : this.speed, simMs: this.simMs, tzHours: cfg.site.tzHours },
        settings: { cloud: w.cloud, windBase: w.windBase, rainLevel: w.rainLevel, speed: this.speed, clockPlaying: this.playing, seed: this.seed, scenarioId: this.scenario ? this.scenario.id : null },
        sun: { az: sun.az, el: sun.el, zenith: sun.zenith, vec: sunVec },
        env: { ghi: irr.ghi, dni: irr.dni, dhi: irr.dhi, ta: w.Ta, rh: w.RH, wind: w.wind, windDir: w.windDir, cloud: w.cloud, rain: w.rainOn, rainLevel: w.rainLevel, rainRate: w.rainRate, rainMm: w.rainMm },
        A, B, comparison,
        energy: { A: A.wh, B: B.wh, motor: this.motorWh, startedSimMs: this.energy.startedSimMs, resets: this.energy.resets },
        load: { mode: loadMode, setpoint: this.load.setpoint, sweeping: this.sweep.active, sweepT: this.sweep.t, sweepSeconds: cfg.sweepSeconds },
        tracker: {
          mode: tr.mode, requestedMode: tr.mode, appliedMode: effective, blockCause: sf.estop ? 'paro de emergencia' : sf.watchdogTrip ? 'watchdog de enlace' : sf.windStow ? 'viento' : '',
          lockAz: tr.lockAz, lockTilt: tr.lockTilt, az: tr.az, tilt: tr.tilt,
          targetAz: tr.targetAz, targetTilt: tr.targetTilt, vAz: tr.vAz, vTilt: tr.vTilt, moving: tr.moving,
          powerW: tr.powerW, motorWh: this.motorWh, sensor: tr.sensor, stowing: tr.stowing, limits: tr.limits,
        },
        safety: {
          state: sf.state, lamp: sf.lamp, estop: sf.estop, windStow: sf.windStow, watchdog: sf.watchdogTrip,
          commsCut: sf.commsCut, commsAge: sf.commsAge, session: sf.session, role, resumeIn: sf.windStow ? sf.resumeIn : 0, resumeText: sf.windStow ? sf.windResumeText() : '',
          canOperate: !sf.blockReason(), blockReason: sf.blockReason(),
        },
        session: { active: sf.session.active, id: sf.session.id, user: sf.session.user, role: sf.session.role, roleLabel: role ? role.label : null, profileId: sf.session.profileId, startedReal: sf.session.since, demo: true },
        acq: {
          status: this.acq.status, runId: this.acq.runId, segmentId: run && run.segments.length ? run.segments[run.segments.length - 1].id : null, samples: run ? run.samples.length : 0, limit: run ? run.limit : cfg.acq.limit,
          elapsedReal: this.acq.elapsedReal, startedReal: this.acq.startedReal, reason: this.acq.reason, everyS: cfg.acq.sampleEveryS, basis: cfg.acq.basis, runs: this.runs.filter((r) => r.sessionId === sf.session.id).length,
        },
        comms: { latency: this.latency, ok: !sf.commsCut, state: 'local' },
        quality: [A.shadeFrac > 0.05 || B.shadeFrac > 0.05 ? 'shade_mutual' : null].filter(Boolean),
      };
    }

    _history(dtReal, lt) {
      this.histTimer += dtReal;
      const t = this.telemetry, h = this.history;
      const push = (k, v) => { h[k].push(v); if (h[k].length > 480) h[k].shift(); };
      if (this._breakPending) {            // discontinuidad del reloj: se corta la linea en lugar de unir puntos no consecutivos
        this._breakPending = false;
        for (const k of Object.keys(h)) push(k, NaN);
        const d0 = this.day; if (d0.key === `${lt.year}-${lt.month}-${lt.day}`) { d0.t.push(NaN); d0.pA.push(NaN); d0.pB.push(NaN); d0.eA.push(NaN); d0.eB.push(NaN); d0.lastT = -1; }
      }
      if (this.histTimer >= 0.25 && this.playing) {
        this.histTimer = 0;
        push('t', t.simMs); push('pA', t.A.p); push('pB', t.B.p); push('gA', t.A.poaTrue); push('gB', t.B.poaTrue);
        push('tA', t.A.tcell); push('tB', t.B.tcell); push('az', t.B.az); push('tilt', t.B.tilt);
        push('wind', t.env.wind); push('ta', t.env.ta); push('motor', t.tracker.powerW);
      }
      // perfil del dia (un punto por minuto simulado)
      const key = `${lt.year}-${lt.month}-${lt.day}`;
      const d = this.day;
      if (d.key !== key) { d.key = key; d.t = []; d.pA = []; d.pB = []; d.eA = []; d.eB = []; d.lastT = -1; }
      if (this.playing && (d.lastT < 0 || lt.hours - d.lastT >= 1 / 60 || lt.hours < d.lastT)) {
        if (d.lastT >= 0 && lt.hours < d.lastT) { d.t.push(NaN); d.pA.push(NaN); d.pB.push(NaN); d.eA.push(NaN); d.eB.push(NaN); }   // recorrido hacia atras: no unir
        d.lastT = lt.hours;
        d.t.push(lt.hours); d.pA.push(t.A.p); d.pB.push(t.B.p); d.eA.push(t.A.wh); d.eB.push(t.B.wh);
      }
    }

    // ------------------------------------------------------------ exportacion
    /** Resultado de aplicacion: {ok, reason?, filename, text, rows}. Nunca finge datos si no los hay. */
    exportCsv(runId) {
      const run = runId ? this.getRun(runId) : this.activeRun() || this.runs.filter((r) => r.sessionId === this.safety.session.id).slice(-1)[0] || null;
      if (!run) return { ok: false, reason: 'Todavía no hay corrida: inicia la adquisición para registrar muestras.', rows: 0 };
      if (!run.samples.length) return { ok: false, reason: 'La corrida aún no tiene muestras (se registra una por segundo mientras la adquisición graba).', rows: 0, runId: run.id };
      const lt = LAB.localTime(run.samples[0][2]);
      return { ok: true, rows: run.samples.length, runId: run.id, filename: `lab-solar-unach_${run.id}_${lt.year}${LAB.util.pad2(lt.month)}${LAB.util.pad2(lt.day)}_${run.samples.length}muestras.csv`, text: LAB.core.runToCsv(run), mime: 'text/csv;charset=utf-8' };
    }
    exportSweepCsv(id) {
      const sw = this.sweeps.find((s) => s.id === id) || this.lastSweep;
      if (!sw) return { ok: false, reason: 'Todavía no hay barridos registrados.' };
      return { ok: true, filename: `lab-solar-unach_${sw.id}.csv`, text: LAB.core.sweepToCsv(sw), mime: 'text/csv;charset=utf-8', rows: sw.pts.A.length + sw.pts.B.length };
    }
  }

  LAB.sim.Engine = Engine;
  LAB.sim.limits = { CR_MIN, CR_MAX, CV_MIN, CV_MAX };
})();
