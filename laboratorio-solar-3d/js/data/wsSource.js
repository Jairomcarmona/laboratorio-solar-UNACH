/* Fuentes de datos de red (S16-S19): WsSource (banco real por WebSocket a la pasarela), ReplaySource (corrida registrada) y
 * TwinSource (modelo del simulador alimentado con el ambiente medido). Las tres exponen la misma interfaz que el Engine:
 *   telemetry, step(dt), send(cmd), on(evt, fn), log(), logs, history, day, runs, sweeps, lastSweep, sweep, exportCsv(), exportSweepCsv()
 *
 * Diferencias con el simulador, por honestidad del banco real:
 *  - send() no devuelve el resultado final: devuelve {ok:true, pending:true, id} y el acuse llega despues por el evento 'ack'.
 *    Las validaciones previas (LAB.core.validateCmd) son comodidad; la autoridad es la pasarela, el puente y el PLC.
 *  - Los comandos de simulador (sim.*, scenario.*) se rechazan con kind 'unsupported'.
 *  - Sin telemetria por mas de staleMs, la telemetria queda marcada como obsoleta (quality 'stale'); nunca se inventan datos.
 */
(function () {
  'use strict';
  const { clamp } = LAB.util;
  const S = LAB.sim.solar;
  const cfg = LAB.config;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nan = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);   // para lo que dibuja la interfaz: «sin dato» es NaN, que no revienta toFixed()
  const LAMP = { NORMAL: 'green', WIND_STOW: 'amber', COMMS_STOW: 'amber', ESTOP: 'red', FAULT: 'red' };
  const OPERATE_ROLES = ['student', 'teacher', 'tech'];

  // ---------------------------------------------------------------- telemetria del contrato -> telemetria de la interfaz
  const emptyCurve = () => ({ d: { IL: null, Io: null, a: null, Rs: null, Rsh: null }, voc: null, isc: null, vmp: null, imp: null, pmp: null, v: [], i: [], p: [] });

  function mapModule(m, fixed) {
    m = m || {};
    const poa = num(m.poa), poaTrue = num(m.poaTrue);
    const c = m.curve && typeof m.curve === 'object' ? m.curve : emptyCurve();
    const p = num(m.p);
    return {
      az: num(m.az) != null ? m.az : fixed ? fixed.az : NaN, tilt: num(m.tilt) != null ? m.tilt : fixed ? fixed.tilt : NaN,
      poa: nan(poa), poaTrue: nan(poaTrue != null ? poaTrue : poa), beam: nan(m.beam), circ: NaN, aoi: NaN, shadeFrac: num(m.shadeFrac) || 0,
      tcell: nan(m.tcell), tback: nan(m.tback), v: nan(m.v), i: nan(m.i), p: nan(p), wh: num(m.wh) || 0,
      voc: nan(c.voc), isc: nan(c.isc), vmp: nan(c.vmp), imp: nan(c.imp), pmp: nan(c.pmp),
      eff: poa != null && poa > 20 && p != null ? p / (poa * cfg.module.area) * 100 : 0,
      curve: { ...emptyCurve(), ...c },
    };
  }

  /** t: telemetria del contrato (tele.schema.json). ctx: {state, hello, control, sessionId, acq, prev, now, link, source, latency, profileId} */
  function mapTele(t, ctx = {}) {
    const ts = t.ts, lt = LAB.localTime(ts);
    const sun = S.position(ts), sunVec = S.sunVector(sun.az, sun.el);
    const A = mapModule(t.A, cfg.fixed), B = mapModule(t.B);
    const tr = t.tracker || {}, sf = t.safety || {}, e = t.env || {}, ld = t.load || {};
    const prev = ctx.prev, dts = prev ? (ts - prev.ts) / 1000 : 0;
    const vAz = prev && dts > 0 ? clamp((tr.az - prev.az) / dts, -20, 20) : 0, vTilt = prev && dts > 0 ? clamp((tr.tilt - prev.tilt) / dts, -20, 20) : 0;
    const moving = tr.moving || { az: Math.abs(vAz) > 0.05, tilt: Math.abs(vTilt) > 0.05 };
    const role = ctx.hello ? ctx.hello.role : null;
    const hasControl = !!(ctx.control && ctx.sessionId);
    const stale = !!ctx.stale;
    const state = sf.state || 'FAULT';
    const canOperate = !!sf.canOperate && hasControl && OPERATE_ROLES.includes(role) && !stale;
    let blockReason = '';
    if (stale) blockReason = 'Sin telemetría reciente del banco: los comandos están bloqueados.';
    else if (!ctx.hello) blockReason = 'No hay conexión con la pasarela del laboratorio.';
    else if (!OPERATE_ROLES.includes(role)) blockReason = role === 'admin' ? 'Las cuentas de administración no operan el banco.' : 'Tu cuenta es de solo observación.';
    else if (!hasControl) blockReason = ctx.control === false && ctx.hello && !ctx.sessionId ? 'Vista de solo lectura: toma el control del banco con tu reserva vigente.' : 'No tienes el control del banco.';
    else if (!sf.canOperate) blockReason = sf.blockReason || 'El controlador del banco no admite comandos ahora.';
    const roleObj = ctx.hello && LAB.sim.ROLES[role] ? LAB.sim.ROLES[role] : null;
    const session = { active: hasControl, id: hasControl ? ctx.sessionId : null, user: ctx.hello ? ctx.hello.user : null, role: hasControl ? role : null,
      roleLabel: roleObj ? roleObj.label : null, profileId: ctx.profileId || null, startedReal: ctx.sessionSince || null, demo: false };
    const acq = ctx.acq || { status: 'stopped', runId: null, samples: 0, elapsedReal: 0, startedReal: 0, reason: '', runs: 0 };
    const out = {
      simMs: ts, local: lt, speed: ctx.source === 'replay' && ctx.speed ? ctx.speed : 1, playing: ctx.source === 'replay' ? ctx.playing !== false : true, source: ctx.source === 'replay' ? 'replay' : (t.source === 'fake' ? 'fake' : ctx.source || 'real'),
      clock: { playing: ctx.source === 'replay' ? ctx.playing !== false : true, speed: ctx.speed || 1, simMs: ts, tzHours: cfg.site.tzHours },
      settings: { cloud: null, windBase: null, rainLevel: 0, speed: 1, clockPlaying: true, seed: null, scenarioId: null },
      sun: { az: sun.az, el: sun.el, zenith: sun.zenith, vec: sunVec },
      env: { ghi: nan(e.ghi), dni: nan(e.dni), dhi: nan(e.dhi), ta: nan(e.ta), rh: nan(e.rh), wind: nan(e.wind), windDir: nan(e.windDir), cloud: NaN,
        rain: (num(e.rainRate) || 0) > 0, rainLevel: 0, rainRate: num(e.rainRate) || 0, rainMm: 0 },
      A, B,
      comparison: {
        powerDiffPct: Number.isFinite(A.p) && Number.isFinite(B.p) && A.p >= 5 ? (B.p / A.p - 1) * 100 : null,
        energyGainPct: A.wh >= 1 ? (B.wh / A.wh - 1) * 100 : null,
        netGainPct: A.wh >= 1 ? (B.wh / A.wh - 1) * 100 : null,
        powerNote: Number.isFinite(A.p) && A.p >= 5 ? '' : 'P_A < 5 W: sin referencia',
        energyNote: A.wh >= 1 ? '' : 'E_A < 1 Wh: sin referencia suficiente',
      },
      energy: { A: A.wh, B: B.wh, motor: 0, startedSimMs: ctx.energyStart || ts, resets: 0 },
      load: { mode: ld.mode || 'oc', setpoint: num(ld.setpoint), sweeping: !!ld.sweeping, sweepT: num(ld.sweepT) || 0, sweepSeconds: num(ld.sweepSeconds) || cfg.sweepSeconds },
      tracker: {
        mode: tr.mode || 'manual', requestedMode: tr.mode || 'manual', appliedMode: tr.appliedMode || 'manual', blockCause: tr.blockCause || '',
        lockAz: !!tr.lockAz, lockTilt: !!tr.lockTilt, az: nan(tr.az), tilt: nan(tr.tilt), targetAz: num(tr.targetAz) != null ? tr.targetAz : nan(tr.az),
        targetTilt: num(tr.targetTilt) != null ? tr.targetTilt : nan(tr.tilt), vAz, vTilt, moving: { az: !!moving.az, tilt: !!moving.tilt }, powerW: 0, motorWh: 0,
        sensor: { lock: false, state: 'IDLE', errX: 0, errY: 0 }, stowing: state === 'WIND_STOW' || state === 'COMMS_STOW', limits: { azMin: cfg.tracker.azMin, azMax: cfg.tracker.azMax, tiltMin: cfg.tracker.tiltMin, tiltMax: cfg.tracker.tiltMax },
      },
      safety: {
        state, lamp: LAMP[state] || 'red', estop: state === 'ESTOP' || !!sf.estop, windStow: state === 'WIND_STOW' || !!sf.windStow, watchdog: state === 'COMMS_STOW' || !!sf.watchdog,
        commsCut: !!stale, commsAge: ctx.age || 0, session: { active: hasControl, id: session.id, profileId: session.profileId, role: session.role, user: session.user, since: session.startedReal },
        role: hasControl && roleObj ? roleObj : (roleObj ? { ...roleObj, canOperate: false } : { label: 'Sin sesión', canOperate: false }), resumeIn: 0, resumeText: '', canOperate, blockReason,
      },
      session,
      acq: { status: acq.status, runId: acq.runId, segmentId: acq.segmentId || null, samples: acq.samples || 0, limit: cfg.acq.limit, elapsedReal: acq.elapsedReal || 0, startedReal: acq.startedReal || 0,
        reason: acq.reason || '', everyS: cfg.acq.sampleEveryS, basis: 'tiempo real', runs: acq.runs || 0 },
      comms: { latency: ctx.latency != null ? ctx.latency : 0, ok: !stale && ctx.link === 'open' },
      quality: Array.from(new Set([...(t.quality || []), ...(stale ? ['stale'] : [])])),
      link: ctx.link || 'open', control: hasControl, twin: ctx.twin || null,
    };
    return out;
  }

  /** Telemetria inicial (antes del primer mensaje): todo en null y bloqueado, para que la interfaz pueda construirse sin errores. */
  function skeleton(ctx) {
    const t = { ts: Date.now(), source: 'real', quality: ['stale'], env: { ta: null, wind: null }, A: { poa: null, tback: null, v: null, i: null, p: null, wh: 0 },
      B: { poa: null, tback: null, v: null, i: null, p: null, wh: 0 }, tracker: { az: cfg.tracker.stow.az, tilt: cfg.tracker.stow.tilt, appliedMode: 'manual' }, safety: { state: 'FAULT', canOperate: false }, load: { mode: 'oc' } };
    return mapTele(t, { ...ctx, stale: true, link: (ctx && ctx.link) || 'connecting' });
  }

  // ---------------------------------------------------------------- comandos de la interfaz -> comandos del contrato
  const pick = (o, keys) => { const a = {}; keys.forEach((k) => { if (o[k] !== undefined && o[k] !== null) a[k] = o[k]; }); return a; };
  const ARGS = {
    'session.start': ['role', 'user', 'profileId'], 'session.end': ['why'], 'acq.stop': ['reason'], 'acq.newRun': ['label', 'practiceId'], 'tracker.target': ['az', 'tilt'],
    'tracker.mode': ['mode'], 'tracker.locks': ['lockAz', 'lockTilt'], 'load.set': ['mode', 'setpoint'], 'safety.estop': ['who'],
  };
  function toWire(cmd, id) {
    const keys = ARGS[cmd.type];
    const args = keys ? pick(cmd, keys) : {};
    return { t: 'cmd', v: 1, id, type: cmd.type, args };
  }

  // ---------------------------------------------------------------- base comun (bitacora, eventos, historial)
  class SourceBase {
    constructor() {
      this.listeners = {};
      this.logs = []; this.runs = []; this.sweeps = []; this.lastSweep = null;
      this.sweep = { active: false, pts: { A: [], B: [] } };
      this.history = { t: [], pA: [], pB: [], gA: [], gB: [], tA: [], tB: [], az: [], tilt: [], wind: [], ta: [], motor: [] };
      this.day = { key: '', t: [], pA: [], pB: [], eA: [], eB: [], lastT: 0 };
      this._histT = 0;
      this.telemetry = null;
    }
    on(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); }
    emit(evt, data) { (this.listeners[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error('listener', evt, e); } }); }
    log(level, msg, src = 'Sistema') {
      const ms = this.telemetry ? this.telemetry.simMs : Date.now();
      const entry = { simMs: ms, real: Date.now(), level, msg, src, local: LAB.localTime(ms), sessionId: this.telemetry && this.telemetry.session ? this.telemetry.session.id : null };
      this.logs.push(entry); if (this.logs.length > 500) this.logs.shift();
      this.emit('log', entry);
      return entry;
    }
    _pushHistory(dt) {
      const t = this.telemetry; if (!t) return;
      this._histT += dt;
      if (this._histT < 0.25) return;
      this._histT = 0;
      const h = this.history, push = (k, v) => { h[k].push(v == null ? NaN : v); if (h[k].length > 480) h[k].shift(); };
      push('t', t.simMs); push('pA', t.A.p); push('pB', t.B.p); push('gA', t.A.poaTrue); push('gB', t.B.poaTrue); push('tA', Number.isFinite(t.A.tcell) ? t.A.tcell : t.A.tback);
      push('tB', Number.isFinite(t.B.tcell) ? t.B.tcell : t.B.tback); push('az', Number.isFinite(t.B.az) ? t.B.az : t.tracker.az); push('tilt', Number.isFinite(t.B.tilt) ? t.B.tilt : t.tracker.tilt);
      push('wind', t.env.wind); push('ta', t.env.ta); push('motor', 0);
      const lt = t.local, key = `${lt.year}-${lt.month}-${lt.day}`, d = this.day;
      if (d.key !== key) { d.key = key; d.t = []; d.pA = []; d.pB = []; d.eA = []; d.eB = []; d.lastT = -1; }
      if (d.lastT < 0 || lt.hours - d.lastT >= 1 / 60 || lt.hours < d.lastT) {
        d.lastT = lt.hours; d.t.push(lt.hours); d.pA.push(t.A.p); d.pB.push(t.B.p); d.eA.push(t.A.wh); d.eB.push(t.B.wh);
      }
    }
    getRun(id) { return this.runs.find((r) => r.id === id) || null; }
    activeRun() { return this.runs.find((r) => r.id === (this.telemetry && this.telemetry.acq.runId)) || null; }
    exportSweepCsv(id) {
      const sw = this.sweeps.find((s) => s.id === id) || this.lastSweep;
      if (!sw) return { ok: false, reason: 'Todavía no hay barridos registrados.' };
      return { ok: true, filename: `lab-solar-unach_${sw.id}.csv`, text: LAB.core.sweepToCsv(sw), mime: 'text/csv;charset=utf-8', rows: sw.pts.A.length + sw.pts.B.length };
    }
  }

  // ---------------------------------------------------------------- WsSource
  class WsSource extends SourceBase {
    /** opts: {apiBase:'', wsUrl?, staleMs:3000, hbMs:1000, reconnectMs:[500,1000,2000,5000,10000], WebSocketImpl, fetchImpl, setInterval/clearInterval, now} */
    constructor(opts = {}) {
      super();
      this.opts = { apiBase: '', staleMs: 3000, hbMs: 1000, reconnectMs: [500, 1000, 2000, 5000, 10000], ...opts };
      this.WS = opts.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
      this.fetch = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
      this.now = opts.now || (() => Date.now());
      this.mode = 'real';
      this.kind = 'ws';
      this.link = 'connecting';
      this.hello = null; this.state = null; this.control = false; this.sessionId = null; this.sessionSince = null; this.profileId = null;
      this.acq = { status: 'stopped', runId: null, samples: 0, elapsedReal: 0, startedReal: 0, reason: '', runs: 0 };
      this.pending = new Map(); this._n = 0; this.entry = null;
      this.lastRx = 0; this.prev = null; this.latency = 0; this.twin = null; this.attempts = 0; this.closing = false;
      this.telemetry = skeleton(this._ctx());
      this._hbTimer = null; this._staleLogged = false;
    }

    _ctx(extra) {
      return { state: this.state, hello: this.hello, control: this.control, sessionId: this.sessionId, sessionSince: this.sessionSince, acq: this.acq, prev: this.prev, link: this.link,
        source: this.sourceKind || 'real', latency: this.latency, profileId: this.profileId, stale: this._isStale(), twin: this.twin, ...extra };
    }
    _isStale() { return !this.lastRx || this.now() - this.lastRx > this.opts.staleMs || this.link !== 'open'; }
    available() { return this.link === 'open'; }

    // ------------------------------------------------------------ conexion
    async connect() {
      this.closing = false;
      this.link = this.attempts ? 'reconnecting' : 'connecting';
      try {
        const r = await this.fetch(this.opts.apiBase + '/api/ws-ticket', { method: 'POST', credentials: 'same-origin' });
        if (r.status === 401) { this.link = 'unauthorized'; this.log('bad', 'Tu sesión de acceso venció. Vuelve a iniciar sesión.', 'Red'); this.emit('auth', { ok: false }); return; }
        if (!r.ok) throw new Error('ticket ' + r.status);
        const { ticket } = await r.json();
        this._open(ticket);
      } catch (e) {
        this._retry(String(e && e.message || e));
      }
    }
    _url(ticket) {
      if (this.opts.wsUrl) return this.opts.wsUrl + '?ticket=' + encodeURIComponent(ticket);
      const l = typeof location !== 'undefined' ? location : { protocol: 'http:', host: 'localhost' };
      return (l.protocol === 'https:' ? 'wss://' : 'ws://') + l.host + '/ws?ticket=' + encodeURIComponent(ticket);
    }
    _open(ticket) {
      const ws = new this.WS(this._url(ticket));
      this.ws = ws;
      ws.onopen = () => {
        this.link = 'open'; this.attempts = 0;
        this.log('ok', 'Conectado con la pasarela del laboratorio.', 'Red');
        this._startHb();
      };
      ws.onmessage = (ev) => this._onMessage(ev.data);
      ws.onclose = (ev) => {
        this._stopHb();
        const was = this.link;
        this.link = 'closed';
        this._dropPending('Se perdió la conexión antes de recibir el acuse.');
        if (this.closing) return;
        if (ev && ev.code === 4401) { this.link = 'unauthorized'; this.log('bad', 'La pasarela rechazó la conexión (sesión vencida).', 'Red'); this.emit('auth', { ok: false }); return; }
        if (was === 'open') this.log('warn', 'Se perdió la conexión con la pasarela. Reintentando…', 'Red');
        this._retry('cerrado');
      };
      ws.onerror = () => {};
    }
    _retry() {
      const d = this.opts.reconnectMs, ms = d[Math.min(this.attempts, d.length - 1)];
      this.attempts++; this.link = 'reconnecting';
      this._retryTimer = setTimeout(() => { if (!this.closing) this.connect(); }, ms);
    }
    close() { this.closing = true; clearTimeout(this._retryTimer); this._stopHb(); if (this.ws) { try { this.ws.close(); } catch (e) { /* ya cerrado */ } } this.link = 'closed'; }
    _startHb() { this._stopHb(); this._hbTimer = setInterval(() => this._sendRaw({ t: 'hb', v: 1 }), this.opts.hbMs); this._sendRaw({ t: 'hb', v: 1 }); }
    _stopHb() { if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; } }
    _sendRaw(o) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(o)); return true; } return false; }

    // ------------------------------------------------------------ mensajes
    _onMessage(text) {
      let m;
      try { m = JSON.parse(text); } catch (e) { return; }
      if (!m || m.v !== 1) return;
      switch (m.t) {
        case 'hello': this.hello = m; this.control = !!m.control; this.state = m.state || null; this.emit('hello', m); break;
        case 'tele': this._onTele(m.d); break;
        case 'state': this.state = m.d; this._onState(m.d); break;
        case 'event': this._onEvent(m.d); break;
        case 'ack': this._onAck(m.d); break;
        case 'sweep': this._onSweep(m.d); break;
        case 'twin': this.twin = m.d; this.emit('twin', m.d); break;
        case 'bye': this.log('warn', 'La pasarela cerró la sesión: ' + (m.d && m.d.reason || ''), 'Red'); break;
        default: break;
      }
    }
    _onTele(t) {
      const now = this.now();
      this.latency = clamp(now - t.ts, 0, 60000);
      this.lastRx = now;
      if (this._staleLogged) { this._staleLogged = false; this.log('ok', 'Se reanudó la telemetría del banco.', 'Red'); }
      const tr = t.tracker || {};
      this.telemetry = mapTele(t, this._ctx({ stale: false, link: 'open' }));
      this.prev = { ts: t.ts, az: tr.az, tilt: tr.tilt };
      if (this.acq.status === 'recording') this.acq.samples++;
      this.emit('tele', this.telemetry);
    }
    _onState(s) { this.emit('state', s); }
    _onEvent(e) {
      const lvl = { info: 'info', ok: 'ok', warn: 'warn', bad: 'bad', error: 'bad' }[e.level] || 'info';
      if (e.code === 'session.granted') { this.sessionId = e.data && e.data.sessionId || this.sessionId; this.control = true; this.sessionSince = this.now(); }
      if (e.code === 'session.lost' || e.code === 'session.expired' || e.code === 'session.ended') this._endSession(e.msg);
      this.log(lvl, e.msg, e.src === 'pasarela' ? 'Acceso' : e.src === 'bridge' || e.src === 'puente' ? 'Seguridad' : e.src || 'Banco');
    }
    _onAck(a) {
      const p = this.pending.get(a.id);
      if (!p) return;
      this.pending.delete(a.id);
      const res = { ok: !!a.ok, id: a.id, kind: a.kind, reason: a.reason, field: a.field, cmd: p.cmd, ms: this.now() - p.t0 };
      if (a.ok) this._applyAck(p.cmd);
      else {
        if (p.cmd.type === 'session.start') { this.control = false; this.sessionId = null; }
        this.log('warn', `Comando rechazado: ${a.reason || a.kind}`, a.kind === 'validation' ? 'Validación' : 'Interlock');
      }
      this.emit('ack', res);
    }
    _applyAck(cmd) {
      const a = this.acq;
      switch (cmd.type) {
        case 'session.start': this.control = true; this.sessionSince = this.sessionSince || this.now(); this.log('ok', 'Tienes el control del banco.', 'Acceso'); this._beginSession(); break;
        case 'session.end': this._endSession('terminada por el usuario'); break;
        case 'acq.newRun': a.status = 'open'; a.samples = 0; a.runs++; a.startedReal = 0; this._refreshRuns(true); break;
        case 'acq.start': a.status = 'recording'; a.startedReal = this.now(); if (!a.runId) this._refreshRuns(true); break;
        case 'acq.stop': a.status = 'stopped'; this._refreshRuns(); this.emit('acq', { status: 'stopped', runId: a.runId }); break;
        default: break;
      }
    }
    _beginSession() {
      const u = this.hello || {};
      this.entry = { id: this.sessionId, profileId: this.profileId, user: u.user, role: u.role, startedReal: this.now(), startedSimMs: this.telemetry.simMs, endedReal: null, final: null, runIds: [], simulated: false };
      this.acq = { status: 'stopped', runId: null, samples: 0, elapsedReal: 0, startedReal: 0, reason: '', runs: 0 };
      this.emit('session', { phase: 'start', entry: this.entry });
    }
    _endSession(why) {
      const entry = this.entry, had = this.control || this.sessionId;
      this.control = false; this.sessionId = null; this.entry = null;
      if (this.acq.status === 'recording') this.emit('acq', { status: 'stopped', runId: this.acq.runId });
      this.acq = { status: 'stopped', runId: null, samples: 0, elapsedReal: 0, startedReal: 0, reason: '', runs: 0 };
      if (!had) return;
      this.log('info', 'Sesión finalizada' + (why ? `: ${why}` : '.'), 'Acceso');
      if (entry) { entry.endedReal = this.now(); entry.why = why; this.emit('session', { phase: 'end', entry }); }
    }
    _onSweep(sw) {
      const i = this.sweeps.findIndex((s) => s.id === sw.id);
      if (i >= 0) this.sweeps[i] = sw; else this.sweeps.push(sw);
      this.sweep = { active: sw.status === 'running', pts: sw.pts };
      if (sw.status !== 'running') { this.lastSweep = sw; this.emit('sweep', sw); }
    }
    _dropPending(why) {
      for (const [id, p] of this.pending) { this.pending.delete(id); this.emit('ack', { ok: false, id, kind: 'timeout', reason: why, cmd: p.cmd }); }
    }

    // ------------------------------------------------------------ comandos
    send(cmd) {
      cmd = cmd || {};
      if (!LAB.core.cmdAdmits('real', cmd.type)) {
        const r = { ok: false, kind: 'unsupported', reason: /^(sim|scenario)\./.test(cmd.type || '') ? 'Esta acción es del simulador: el banco real no tiene un reloj, un clima ni una falla que se puedan fijar a voluntad.' : `El banco real no admite «${cmd.type}».` };
        return r;
      }
      const bad = LAB.core.validateCmd(cmd, cfg);
      if (bad) return bad;
      if (cmd.type !== 'safety.estop') {
        const t = this.telemetry;
        if (this.link !== 'open') return { ok: false, kind: 'interlock', reason: 'Sin conexión con la pasarela: el comando no se envió.' };
        if (cmd.type !== 'session.start' && t && !this.control) return { ok: false, kind: 'interlock', reason: 'Interlock: no tienes el control del banco (vista de solo lectura).' };
      }
      const id = 'w' + (++this._n) + '_' + this.now().toString(36);
      const wire = toWire(cmd, id);
      if (wire.type === 'session.start' && !wire.args.role && this.hello) wire.args.role = this.hello.role;
      if (!this._sendRaw(wire)) return { ok: false, kind: 'interlock', reason: 'Sin conexión con la pasarela: el comando no se envió.' };
      this.pending.set(id, { cmd, t0: this.now() });
      this.log('cmd', `Comando enviado: ${cmd.type}`, 'Comando');
      return { ok: true, pending: true, id };
    }

    step(dt) {
      const stale = this._isStale();
      if (stale && this.telemetry && !this.telemetry.quality.includes('stale')) {
        this.telemetry = mapTele(this._lastTele || this._rebuildLast(), this._ctx({ stale: true }));
      }
      if (stale && this.lastRx && !this._staleLogged) { this._staleLogged = true; this.log('warn', `Sin telemetría del banco desde hace más de ${this.opts.staleMs / 1000} s; los datos mostrados son los últimos recibidos.`, 'Red'); }
      this.telemetry.comms.latency = this.latency;
      this._pushHistory(dt);
    }
    _rebuildLast() { return { ts: this.telemetry.simMs, source: 'real', quality: [], env: this.telemetry.env, A: this.telemetry.A, B: this.telemetry.B, tracker: this.telemetry.tracker,
      safety: { state: this.telemetry.safety.state, canOperate: false }, load: this.telemetry.load }; }

    // ------------------------------------------------------------ corridas del servidor
    async _refreshRuns(setActive) {
      try {
        const r = await this.fetch(this.opts.apiBase + '/api/runs', { credentials: 'same-origin' });
        if (!r.ok) return;
        const { runs } = await r.json();
        this.runs = runs.map((x) => ({ id: x.id, sessionId: this.sessionId, label: x.label, status: x.status, practiceId: x.practiceId, samples: new Array(x.samples || 0), serverSide: true }));
        if (setActive && runs.length) {
          const live = runs.find((x) => x.status === 'open' || x.status === 'recording') || runs[0];
          this.acq.runId = live.id;
        }
        this.emit('runs', this.runs);
      } catch (e) { /* sin red: se reintenta en la siguiente accion */ }
    }
    /** Asincrono: la corrida vive en el servidor. Devuelve una promesa con {ok, filename, text, mime, rows} o {ok:false, reason}. */
    async exportCsv(runId) {
      const id = runId || this.acq.runId || (this.runs.length ? this.runs[0].id : null);
      if (!id) return { ok: false, reason: 'Todavía no hay corrida: inicia la adquisición para registrar muestras.', rows: 0 };
      try {
        const r = await this.fetch(`${this.opts.apiBase}/api/runs/${encodeURIComponent(id)}.csv`, { credentials: 'same-origin' });
        if (!r.ok) return { ok: false, reason: r.status === 404 ? 'No hay datos de esa corrida en el servidor.' : 'El servidor no pudo entregar la corrida.', rows: 0 };
        const text = await r.text();
        const rows = text.split('\n').filter((l) => l && !l.startsWith('#')).length - 1;
        return { ok: rows > 0, reason: rows > 0 ? undefined : 'La corrida aún no tiene muestras.', rows, runId: id, filename: `lab-solar-unach_${id}_${rows}muestras.csv`, text, mime: 'text/csv;charset=utf-8' };
      } catch (e) { return { ok: false, reason: 'Sin conexión con el servidor.', rows: 0 }; }
    }
    async loginState() {
      try { const r = await this.fetch(this.opts.apiBase + '/api/me', { credentials: 'same-origin' }); if (!r.ok) return null; const { user } = await r.json(); this.profileId = user.profile_id || ('u' + user.id); return user; } catch (e) { return null; }
    }
  }

  // ---------------------------------------------------------------- ReplaySource
  /** Reproduce una corrida registrada (CSV del servidor o del simulador). Solo lectura: acepta replay.* y rechaza lo demas. */
  function parseRunCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.length);
    const head = lines.findIndex((l) => !l.startsWith('#'));
    if (head < 0) return { meta: lines, rows: [] };
    const cols = lines[head].split(',');
    const rows = lines.slice(head + 1).map((l) => {
      const cells = []; let cur = '', q = false;
      for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ',') { cells.push(cur); cur = ''; } else cur += c; }
      cells.push(cur);
      const o = {}; cols.forEach((c, k) => { o[c] = cells[k]; }); return o;
    });
    return { meta: lines.slice(0, head), rows };
  }
  const fnum = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : null; };
  function rowToTele(r) {
    const ms = Date.parse(r.utc_iso_simulado);
    const mod = (k) => ({ poa: fnum(r['G_' + k + '_Wm2']), poaTrue: fnum(r['G_' + k + '_Wm2']), tcell: fnum(r['Tcel_' + k + '_C']), tback: null, v: fnum(r['V_' + k + '_V']), i: fnum(r['I_' + k + '_A']), p: fnum(r['P_' + k + '_W']), wh: fnum(r['E_' + k + '_Wh']) || 0,
      shadeFrac: fnum(r['sombra_mutua_' + k + '_frac']) || 0 });
    const st = r.estado_seguridad || 'NORMAL';
    return { ts: ms, source: 'replay', quality: [], env: { ta: fnum(r.Tamb_C), rh: fnum(r.HR_pct), wind: fnum(r.viento_ms), windDir: fnum(r.dir_viento_deg), ghi: null, dni: null, dhi: null },
      A: mod('A'), B: { ...mod('B'), az: fnum(r.azimut_B_deg), tilt: fnum(r.inclinacion_B_deg) }, tracker: { az: fnum(r.azimut_B_deg), tilt: fnum(r.inclinacion_B_deg), appliedMode: r.modo_seguidor_aplicado || 'manual', mode: r.modo_seguidor_aplicado || 'manual' },
      safety: { state: st, canOperate: false }, load: { mode: r.modo_carga || 'oc' } };
  }

  class ReplaySource extends SourceBase {
    constructor(csvText, opts = {}) {
      super();
      this.kind = 'replay'; this.mode = 'replay';
      this.idx = 0; this.playing = opts.autoplay !== false; this.speed = opts.speed || 1; this.acc = 0; this.prev = null;
      this.sourceKind = 'replay';
      this.teles = []; this.meta = [];
      this.telemetry = skeleton({ source: 'replay', link: 'open' });
      if (csvText) this.load(csvText);
    }
    /** Carga (o reemplaza) la corrida a reproducir. */
    load(csvText) {
      const p = parseRunCsv(csvText);
      this.meta = p.meta; this.teles = p.rows.map(rowToTele).filter((t) => Number.isFinite(t.ts));
      this.idx = 0; this.acc = 0; this.prev = null; this.ended = false;
      if (this.teles.length) this.telemetry = this._map(0);
      else this.log('warn', 'La corrida no tiene muestras que reproducir.', 'Reproducción');
      this.emit('loaded', { samples: this.teles.length });
    }
    async loadFromServer(runId, opts = {}) {
      const f = opts.fetchImpl || fetch.bind(globalThis);
      const r = await f(`${opts.apiBase || ''}/api/runs/${encodeURIComponent(runId)}.csv`, { credentials: 'same-origin' });
      if (r.status === 401) { this.emit('auth', { ok: false }); return false; }
      if (!r.ok) { this.log('bad', 'No se pudo cargar esa corrida del servidor.', 'Reproducción'); return false; }
      this.load(await r.text());
      return true;
    }
    available() { return true; }
    get duration() { return this.teles.length ? (this.teles[this.teles.length - 1].ts - this.teles[0].ts) / 1000 : 0; }
    _map(i) {
      const t = this.teles[i];
      const tel = mapTele(t, { source: 'replay', link: 'open', playing: this.playing, speed: this.speed, prev: this.prev, hello: { user: 'reproducción', role: 'visitor' }, control: false, stale: false });
      tel.replay = { index: i, count: this.teles.length, positionS: (t.ts - this.teles[0].ts) / 1000, durationS: this.duration, ended: this.ended };
      tel.safety.blockReason = 'Reproducción de una corrida registrada: solo lectura.';
      this.prev = { ts: t.ts, az: t.tracker.az, tilt: t.tracker.tilt };
      return tel;
    }
    seek(ms) {
      if (!this.teles.length) return;
      let lo = 0, hi = this.teles.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (this.teles[mid].ts < ms) lo = mid + 1; else hi = mid; }
      this.idx = lo; this.ended = false; this.prev = null; this.acc = 0; this.telemetry = this._map(lo);
    }
    send(cmd) {
      cmd = cmd || {};
      const bad = LAB.core.validateCmd(cmd, cfg);
      if (bad) return bad;
      switch (cmd.type) {
        case 'replay.play': this.playing = true; if (this.ended) this.seek(this.teles[0].ts); return { ok: true };
        case 'replay.pause': this.playing = false; return { ok: true };
        case 'replay.seek': this.seek(cmd.ms); return { ok: true };
        case 'replay.speed': this.speed = cmd.speed; return { ok: true };
        default: return { ok: false, kind: 'unsupported', reason: 'Estás viendo una corrida registrada: solo se puede reproducir, pausar o mover la posición.' };
      }
    }
    step(dt) {
      if (this.playing && !this.ended && this.teles.length > 1) {
        this.acc += dt * this.speed * 1000;
        const t0 = this.teles[this.idx].ts;
        let k = this.idx;
        while (k + 1 < this.teles.length && this.teles[k + 1].ts - t0 <= this.acc) k++;
        if (k !== this.idx) { this.acc -= this.teles[k].ts - t0; this.idx = k; this.telemetry = this._map(k); this.emit('tele', this.telemetry); }
        if (this.idx >= this.teles.length - 1) { this.ended = true; this.playing = false; this.telemetry = this._map(this.idx); this.log('info', 'Fin de la corrida registrada.', 'Reproducción'); }
      }
      this._pushHistory(dt);
    }
  }

  // ---------------------------------------------------------------- TwinSource
  /** El modelo del simulador corre con el ambiente MEDIDO y la posicion real del seguidor; se compara contra lo que mide el banco. */
  class TwinSource extends LAB.sim.Engine {
    constructor(ws) {
      super();
      this.kind = 'twin'; this.mode = 'twin';
      this.ws = ws; this.playing = true; this.speed = 1;
      this.safety.startSession('visitor', 'gemelo', null, null);
    }
    send(cmd) { return this.ws.send(cmd); }       // los comandos van al banco real, nunca al modelo
    step(dt) {
      if (!this.ws) return super.step(dt);               // el constructor del Engine llama a step(0) antes de asignar ws
      const r = this.ws.telemetry;
      if (r && this.ws.lastRx) { this.simMs = r.simMs; this.setEnvOverride(r.env, { az: r.tracker.az, tilt: r.tracker.tilt }); }
      super.step(dt);
      const m = this.telemetry;
      m.source = 'twin';
      m.real = r;
      m.twin = { ws: this.ws.twin };
      m.residual = r ? { A: resid(m.A.p, r.A.p), B: resid(m.B.p, r.B.p) } : null;
    }
    on(evt, fn) { super.on(evt, fn); if (evt !== 'log') this.ws.on(evt, fn); }
  }
  const resid = (model, real) => (model != null && real != null ? { model, real, diff: real - model, pct: model > 1 ? (real / model - 1) * 100 : null } : null);

  LAB.data.mapTele = mapTele;
  LAB.data.skeleton = skeleton;
  LAB.data.parseRunCsv = parseRunCsv;
  LAB.data.WsSource = WsSource;
  LAB.data.ReplaySource = ReplaySource;
  LAB.data.TwinSource = TwinSource;
})();
