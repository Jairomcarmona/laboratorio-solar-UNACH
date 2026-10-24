/* Interfaz: paneles de mando, telemetria, graficas, bitacora, ficha de componentes y controles de tiempo/entorno.
 * Solo habla con la escena a traves de LAB.app y con el banco a traves de source.send()/source.telemetry. */
(function () {
  'use strict';
  const { clamp, fmt, pad2 } = LAB.util;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const MODE_TXT = { manual: 'Manual', astro: 'Astronómico', sensor: 'Por sensores', fixed: 'Fijo' };
  const SENSOR_TXT = { TRACK: 'Sensor: enganchado', NO_SIGNAL: 'Sensor: sin señal (nube)', ACQUIRE: 'Sensor: adquiriendo Sol', NIGHT: 'Noche: estacionado' };
  const PART_VIEW = { moduleA: 'moduleA', irrA: 'moduleA', dcA: 'moduleA', moduleB: 'moduleB', irrB: 'moduleB', azAxis: 'moduleB', tiltAxis: 'moduleB', dcB: 'moduleB',
    pyr: 'station', anemo: 'station', shield: 'station', rain: 'station', load: 'load', cabinet: 'cabinet', estop: 'cabinet', cam1: 'camFocus1', cam2: 'camFocus2' };
  const VIEW_BTNS = [['general', 'Vista general'], ['moduleA', 'A'], ['moduleB', 'B'], ['station', 'Estación'], ['load', 'Carga'], ['cabinet', 'Gabinete'], ['aerial', 'Aérea']];

  const ui = LAB.ui;
  const store = LAB.core.store;
  let app, source, tel;
  let chart, chartTab = 'power';
  let infoPart = null;
  let dragging = { az: false, tilt: false, time: false, load: false };
  let lastDom = 0, lastChart = 0, lastRunView = 0;
  let logFilter = 'all', logCount = 0;
  let dayCache = { key: '', dawn: 360, noon: 720, dusk: 1080 };

  // ------------------------------------------------------------------ utilidades
  ui.toast = function (msg, level = 'info', ms = 4200) {
    const box = $('#toasts');
    const t = document.createElement('div'); t.className = 'toast ' + level; t.textContent = msg;
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => t.remove(), ms);
  };
  const send = (cmd) => {
    const r = source.send(cmd);
    if (!r.ok && r.reason) ui.toast(r.reason, 'warn', 5200);
    return r;
  };
  ui.send = send;
  const isNet = () => source && (source.kind === 'ws' || source.kind === 'twin');
  const netSrc = () => (source.kind === 'twin' ? source.ws : source);
  /** Anuncio para lectores de pantalla (region viva educada) */
  ui.announce = function (msg) { const r = $('#liveRegion'); if (r) { r.textContent = ''; setTimeout(() => { r.textContent = msg; }, 30); } };
  ui.openLogin = function () { showModal($('#loginModal')); };
  ui.openLog = function () { openLog(); };
  const fieldErr = (input, msg) => {
    const box = input.closest('.numcmd, .numrow, .field') || input.parentElement; let e = box.querySelector('.ferr[data-for="' + input.id + '"]');
    if (!e) { e = document.createElement('small'); e.className = 'ferr'; e.dataset.for = input.id; e.id = input.id + '_err'; e.setAttribute('role', 'alert'); box.appendChild(e); }
    e.textContent = msg || ''; e.hidden = !msg;
    if (msg) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', e.id); } else { input.removeAttribute('aria-invalid'); }
  };
  /** Lee un campo numerico: devuelve {empty}, {value} o {error}; en caso de error marca el campo y CONSERVA lo escrito */
  const readNum = (input, name, lo, hi, unit) => {
    const raw = input.value.trim();
    if (raw === '' && input.validity && input.validity.badInput) { fieldErr(input, `${name}: escribe un número.`); return { error: true }; }
    if (raw === '') { fieldErr(input, ''); return { empty: true }; }
    const v = Number(raw.replace(',', '.'));
    if (!Number.isFinite(v)) { fieldErr(input, `${name}: escribe un número.`); return { error: true }; }
    if (v < lo || v > hi) { fieldErr(input, `${name}: debe estar entre ${lo} y ${hi} ${unit}.`); return { error: true }; }
    fieldErr(input, ''); return { value: v };
  };
  /** Sincroniza un control con el estado del dominio sin pisar lo que la persona esta editando */
  const syncCtl = (el, value, editing) => { if (editing || document.activeElement === el) return; const v = String(value); if (el.value !== v) el.value = v; };
  const setText = (id, v) => { const e = document.getElementById(id); if (e && e.textContent !== v) e.textContent = v; };
  const timeStr = (lt, secs = true) => `${pad2(lt.hour)}:${pad2(lt.minute)}${secs ? ':' + pad2(lt.second) : ''}`;

  // ----------------------------------------------------------------------- init
  ui.init = function (api) {
    app = api; source = api.source; tel = source.telemetry;
    LAB.ui.api = api;
    if (source.kind === 'replay') bindReplay();

    // vistas
    const vs = $('#viewSeg');
    VIEW_BTNS.forEach(([id, label]) => { const b = document.createElement('button'); b.textContent = label; b.dataset.v = id; vs.appendChild(b); });
    vs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; app.rig.set(b.dataset.v); markViews(b.dataset.v); });
    markViews('general');

    if (ui.layout) ui.layout.init();
    applyRanges();
    bindTopbar(); bindTracker(); bindLoad(); bindSafety(); bindDock(); bindData(); bindInfo(); bindLog(); bindPanels(); bindKeys(); bindLogin(); bindHelp();
    chart = new ui.Chart($('#chart'));
    source.on('log', onLog);
    if (isNet()) {
      const ws = netSrc();
      ws.on('ack', (a) => {
        if (!a.ok) { if (a.reason) ui.toast(a.reason, a.kind === 'timeout' ? 'bad' : 'warn', 6000); return; }
        if (a.cmd && a.cmd.type === 'session.start') { const m = $('#loginModal'); if (!m.hidden) hideModal(m); ui.toast('Tienes el control del banco. Los comandos se validan en la pasarela, en el puente y en el PLC.', 'ok', 6000); }
      });
      ws.on('auth', () => ui.toast('Tu sesión de acceso venció. Vuelve a iniciar sesión.', 'bad', 8000));
    }
    source.on('sweep', (sw) => {
      if (sw.status === 'complete') { chartTab = 'iv'; markTab(); ui.toast('Barrido I‑V completado y guardado. Revisa la pestaña I‑V / P‑V.', 'ok'); ui.announce('Barrido I-V completado'); }
      store.putSweep(sw); if (sw.status !== 'running') { sweepSel = [sw.id]; refreshSweeps(); }
    });
    source.on('run', (r) => { if (r.status === 'discarded') store.deleteRun(r.id); else store.putRun(r); refreshRuns(); });
    source.on('acq', (e) => { if (e.status === 'stopped') { const r = source.getRun(e.runId); if (r) store.putRun(r); } ui.announce(e.status === 'recording' ? 'Adquisición iniciada' : 'Adquisición detenida'); refreshRuns(); });
    source.on('session', (e) => {
      if (e.phase === 'end') source.runs.filter((r) => r.sessionId === e.entry.id).forEach((r) => store.putRun(r));
      if (ui.practices) ui.practices.onSession(e.phase, e.entry);
      if (e.phase === 'end' && $('#loginModal').hidden && !isNet()) showModal($('#loginModal'));
    });
    if (ui.practices) ui.practices.init(app);
    if (ui.onboarding) ui.onboarding.init();
    /** Las ayudas 3D en modo «auto» aparecen cuando la tarea las necesita: práctica de orientación en curso o ficha de un módulo abierta */
    ui.aidsAuto = () => infoPart === 'moduleB' || infoPart === 'moduleA' || (() => { const st = ui.practices && ui.practices.state(); return !!(st && st.current === 'p2' && st.ps && st.ps.status === 'in_progress'); })();

    // arranque: los parametros de URL se validan; lo que no se reconoce se ignora con aviso (C17)
    const q = new URLSearchParams(location.search);
    const preRole = isNet() ? null : q.get('session');
    if (preRole) {
      if (LAB.config.roles.includes(preRole)) { startSession(preRole, 'Demostración'); }
      else { source.log('warn', `Parámetro de URL session="${String(preRole).replace(/[^\w-]/g, '?').slice(0, 20)}" no reconocido: se ignora.`, 'URL'); showModal($('#loginModal')); }
    } else if (source.kind === 'replay') { /* reproduccion: sin acceso que elegir */ } else showModal($('#loginModal'));
    const pr = q.get('practice');
    if (pr) { if (ui.practices && ui.practices.defs(pr)) setTimeout(() => ui.practices.openFromUrl(pr), 300); else source.log('warn', 'Parámetro de URL practice no reconocido: se ignora.', 'URL'); }
    const tab = q.get('tab');
    if (tab) { if (['power', 'day', 'iv', 'energy', 'run', 'analysis'].includes(tab)) { chartTab = tab; markTab(); } else source.log('warn', 'Parámetro de URL tab no reconocido: se ignora.', 'URL'); }
    if (q.get('panels') === '0') document.body.dataset.panels = '0';   // solo escena (capturas y enlaces de demostracion)
  };

  // ------------------------------------------------------------------ ventanas modales (foco atrapado y restaurado)
  const modalStack = [];
  const focusables = (root) => $$('button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])', root).filter((e) => e.offsetParent !== null);
  function showModal(m) {
    if (!m) return;
    const opener = document.activeElement;
    m.hidden = false; modalStack.push({ m, opener });
    const f = focusables(m)[0]; if (f) f.focus();
  }
  function hideModal(m) {
    const i = modalStack.findIndex((x) => x.m === m); m.hidden = true;
    if (i >= 0) { const { opener } = modalStack.splice(i, 1)[0]; const ok = opener && opener !== document.body && document.contains(opener) && !opener.disabled && !m.contains(opener) && opener.offsetParent !== null;
      const to = ok ? opener : document.getElementById('btnPractices'); if (to) to.focus(); }
  }
  ui.showModal = showModal; ui.hideModal = hideModal;
  ui.dropModal = (m) => { const i = modalStack.findIndex((x) => x.m === m); if (i >= 0) modalStack.splice(i, 1); };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !modalStack.length) return;
    const m = modalStack[modalStack.length - 1].m, f = focusables(m); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // ------------------------------------------------------------------ acceso de demostracion (se enlaza una sola vez)
  function startSession(role, name) {
    if (isNet()) return startRealSession();
    if (!LAB.config.roles.includes(role)) return;
    const clean = String(name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);
    const r = send({ type: 'session.start', role, user: clean || undefined, profileId: store.profileId(role, clean) });
    if (!r.ok) return r;
    const m = $('#loginModal'); if (!m.hidden) hideModal(m);
    if (role === 'visitor') ui.toast('Modo visitante: puedes mirar y cambiar el entorno, pero no enviar comandos al banco.', 'info', 6500);
    else ui.toast('Sesión de demostración iniciada. Prueba el modo Astronómico o abre "Prácticas".', 'ok', 6000);
    return r;
  }
  /** Banco real: el rol y la identidad vienen de la cuenta (pasarela); aqui solo se pide tomar el control con la reserva vigente. */
  function startRealSession() {
    const ws = netSrc(), h = ws.hello;
    if (!h) { ui.toast('Aún no hay conexión con la pasarela del laboratorio.', 'warn'); return { ok: false }; }
    if (!['student', 'teacher', 'tech'].includes(h.role)) { ui.toast(h.role === 'admin' ? 'Las cuentas de administración no operan el banco.' : 'Tu cuenta es de solo observación.', 'info'); const m = $('#loginModal'); if (!m.hidden) hideModal(m); return { ok: false }; }
    const r = send({ type: 'session.start', role: h.role, user: h.user, profileId: ws.profileId || undefined });
    return r;
  }
  function wsLoginModal() {
    const m = $('#loginModal'), ws = netSrc();
    const lead = $('.lead', m); const roles = $('.roles', m); const nm = $('#userName'), lbl = $('.lbl', m);
    const h = ws.hello;
    lead.innerHTML = '';
    const b1 = document.createElement('b'); b1.textContent = source.kind === 'twin' ? 'Modo gemelo' : 'Banco real';
    lead.append(b1, document.createTextNode(h ? `: has iniciado sesión como ${h.user} (${({ student: 'estudiante', teacher: 'docente', tech: 'técnico', visitor: 'visitante', admin: 'administración' })[h.role] || h.role}). Los datos son mediciones del banco; los límites de seguridad los aplica el controlador local.` : ': conectando con la pasarela…'));
    if (nm) nm.hidden = true; if (lbl) lbl.hidden = true;
    roles.textContent = '';
    const can = h && ['student', 'teacher', 'tech'].includes(h.role);
    const take = document.createElement('button'); take.className = 'role'; take.dataset.role = h ? h.role : 'student'; take.id = 'btnTakeControl'; take.disabled = !can;
    take.innerHTML = '<b>Tomar el control</b><span>Requiere una reserva vigente; solo una persona opera a la vez</span>';
    const look = document.createElement('button'); look.className = 'role'; look.id = 'btnObserve';
    look.innerHTML = '<b>Solo observar</b><span>Ver la telemetría sin enviar comandos</span>';
    look.addEventListener('click', () => hideModal(m));
    roles.append(take, look);
    take.addEventListener('click', () => { const r = startRealSession(); if (r && r.ok) { /* el modal se cierra al llegar el acuse */ } });
    const out = document.createElement('p'); out.className = 'fine'; out.id = 'wsAccessMsg'; out.setAttribute('role', 'status'); roles.after(out);
  }
  function bindLogin() {
    if (isNet()) { wsLoginModal(); netSrc().on('hello', () => wsLoginModal()); return; }
    $$('#loginModal .role').forEach((b) => b.addEventListener('click', () => startSession(b.dataset.role, $('#userName').value)));
    $('#userName').addEventListener('keydown', (e) => { if (e.key === 'Enter') startSession('student', $('#userName').value); });
  }

  // ------------------------------------------------------------------ barra de reproduccion (fuente replay)
  function bindReplay() {
    const dock = $('#dock'); if (!dock) return;
    const bar = document.createElement('div'); bar.className = 'grp'; bar.id = 'gReplay';
    const play = document.createElement('button'); play.className = 'btn icon'; play.id = 'rpPlay'; play.setAttribute('aria-label', 'Pausar'); play.textContent = '❚❚';
    const seg = document.createElement('div'); seg.className = 'seg'; seg.id = 'rpSpeed';
    [1, 10, 60, 600].forEach((v) => { const b = document.createElement('button'); b.dataset.s = v; b.textContent = '×' + v; seg.appendChild(b); });
    const pos = document.createElement('input'); pos.type = 'range'; pos.id = 'rpPos'; pos.min = 0; pos.max = 1000; pos.value = 0; pos.setAttribute('aria-label', 'Posición en la corrida');
    const out = document.createElement('output'); out.id = 'rpOut'; out.setAttribute('aria-live', 'off');
    bar.append(play, seg, pos, out); dock.prepend(bar);
    play.addEventListener('click', () => send({ type: source.playing ? 'replay.pause' : 'replay.play' }));
    seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) send({ type: 'replay.speed', speed: +b.dataset.s }); });
    pos.addEventListener('input', () => { const t0 = source.teles[0], t1 = source.teles[source.teles.length - 1]; if (t0) send({ type: 'replay.seek', ms: t0.ts + (t1.ts - t0.ts) * pos.value / 1000 }); });
    ui.replayTick = (rp) => {
      play.textContent = source.playing ? '❚❚' : '▶'; play.setAttribute('aria-label', source.playing ? 'Pausar' : 'Reproducir');
      $$('#rpSpeed button').forEach((b) => b.classList.toggle('on', +b.dataset.s === source.speed));
      if (rp && document.activeElement !== pos) pos.value = rp.durationS > 0 ? Math.round(rp.positionS / rp.durationS * 1000) : 0;
      out.textContent = rp ? `${Math.round(rp.positionS)} s de ${Math.round(rp.durationS)} s · muestra ${rp.index + 1}/${rp.count}` : '';
    };
  }

  // ------------------------------------------------------------------ ayuda central (limites del modelo, atajos)
  function bindHelp() {
    const h = $('#helpDlg');
    $('#btnHelp').addEventListener('click', () => showModal(h));
    $$('.x, [data-close]', h).forEach((b) => b.addEventListener('click', () => hideModal(h)));
  }

  // ------------------------------------------------------------------ rangos desde la configuracion (una sola fuente)
  function applyRanges() {
    const T = LAB.config.tracker, L = LAB.sim.limits;
    const set = (id, o) => { const e = $(id); Object.entries(o).forEach(([k, v]) => e.setAttribute(k, v)); };
    set('#azSlider', { min: T.azMin, max: T.azMax }); set('#tiltSlider', { min: T.tiltMin, max: T.tiltMax });
    set('#numAz', { min: T.azMin, max: T.azMax }); set('#numTilt', { min: T.tiltMin, max: T.tiltMax });
    set('#windSlider', { min: 0, max: LAB.config.limits.windMax });
    set('#cloudSlider', { min: 0, max: 100 });
    $('#trHint').textContent = `Rango autorizado: azimut ${T.azMin}°–${T.azMax}°, inclinación ${T.tiltMin}°–${T.tiltMax}°. Los comandos fuera de rango se rechazan.`;
    void L;
  }

  function markViews(v) { $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }

  // ------------------------------------------------------------------ barra superior
  const BADGE = {
    sim: ['SIMULACIÓN', 'Modo simulador: datos calculados con pvlib. Pulsa ? para ver el alcance del modelo.'],
    real: ['BANCO REAL', 'Mediciones del banco físico a través de la pasarela del laboratorio.'],
    fake: ['BANCO VIRTUAL', 'El puente está conectado a un banco VIRTUAL de pruebas, no a hardware: los datos no son mediciones físicas.'],
    twin: ['GEMELO', 'Modelo del simulador alimentado con el ambiente medido; compara lo esperado con lo medido.'],
    replay: ['REPRODUCCIÓN', 'Corrida registrada, en solo lectura.'],
  };
  function bindSource() {
    const sw = $('#sourceSwitch'); if (!sw) return;
    const served = /^https?:$/.test(location.protocol);
    const cur = source.kind === 'replay' ? null : (source.kind === 'ws' ? 'ws' : source.kind || 'sim');
    $$('button', sw).forEach((b) => {
      const k = b.dataset.src, on = k === cur;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
      if (k !== 'sim') { b.disabled = !served; if (!served) b.title = 'Disponible cuando la página se sirve desde el servidor del laboratorio (no desde un archivo local).'; else b.title = k === 'ws' ? 'Mediciones del banco físico (requiere iniciar sesión)' : b.title; }
    });
    sw.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled || b.dataset.src === cur) return;
      const u = new URL(location.href); u.searchParams.set('source', b.dataset.src); u.searchParams.delete('run'); location.href = u.href;
    });
  }
  function bindTopbar() {
    bindSource();
    $('#sessionBtn').addEventListener('click', () => {
      if (tel.safety.session.active) {
        const nRec = tel.acq.status === 'recording';
        if (confirm('¿Terminar la sesión de demostración?' + (nRec ? ' La adquisición en curso se detendrá y sus datos se conservarán.' : ' Tus corridas y tu avance se conservan.'))) { send({ type: 'session.end' }); }
      } else showModal($('#loginModal'));
    });
    $('#btnPractices').addEventListener('click', (e) => {
      if (!tel.safety.session.active) { ui.toast('Inicia una sesión de demostración para usar las prácticas.', 'warn'); showModal($('#loginModal')); return; }
      ui.practices.toggleDrawer(e.currentTarget);
    });
    $('#btnLog').addEventListener('click', () => { const p = $('#logpanel'); if (p.hidden) openLog(); else closeLog(); });
    $('#btnFull').addEventListener('click', () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); else document.exitFullscreen(); });
  }
  let logOpener = null;
  function openLog() { const p = $('#logpanel'); logOpener = document.activeElement; p.hidden = false; if (!logOpener || logOpener === document.body) logOpener = $('#btnLog'); const l = $('#logList'); l.scrollTop = l.scrollHeight; $('#logpanel .x').focus(); if (ui.practices) ui.practices.notify('logOpened'); }
  function closeLog() { $('#logpanel').hidden = true; if (logOpener && document.contains(logOpener)) logOpener.focus(); }

  // ------------------------------------------------------------------ seguidor
  function bindTracker() {
    $('#trModes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) send({ type: 'tracker.mode', mode: b.dataset.mode }); });
    $('#trAxes').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const a = b.dataset.axes;
      send({ type: 'tracker.locks', lockAz: a === 'tilt', lockTilt: a === 'az' });
    });
    const az = $('#azSlider'), tl = $('#tiltSlider');
    az.addEventListener('input', () => { dragging.az = true; setText('azOut', az.value + '°'); });
    tl.addEventListener('input', () => { dragging.tilt = true; setText('tiltOut', tl.value + '°'); });
    az.addEventListener('change', () => { dragging.az = false; send({ type: 'tracker.target', az: +az.value }); });
    tl.addEventListener('change', () => { dragging.tilt = false; send({ type: 'tracker.target', tilt: +tl.value }); });
    const nAz = $('#numAz'), nTl = $('#numTilt'), T = LAB.config.tracker;
    const go = () => {
      const a = readNum(nAz, 'Azimut', T.azMin, T.azMax, '°'), t = readNum(nTl, 'Inclinación', T.tiltMin, T.tiltMax, '°');
      if (a.error || t.error) { (a.error ? nAz : nTl).focus(); return; }          // se conserva lo escrito y se marca el campo
      if (a.empty && t.empty) { fieldErr(nAz, 'Escribe un azimut, una inclinación o ambos.'); nAz.focus(); return; }
      const o = { type: 'tracker.target' }; if (!a.empty) o.az = a.value; if (!t.empty) o.tilt = t.value;
      const r = send(o);
      if (r.ok) { nAz.value = ''; nTl.value = ''; ui.announce('Orden enviada al seguidor'); }       // solo se limpia si el controlador la aceptó
    };
    [nAz, nTl].forEach((n) => n.addEventListener('input', () => fieldErr(n, '')));
    $('#btnNumGo').addEventListener('click', go);
    [nAz, nTl].forEach((n) => n.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }));
    $('#trPresets').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      send({ type: 'tracker.target', az: +b.dataset.az, tilt: +b.dataset.tilt });
    });
  }

  // --------------------------------------------------------------------- carga
  const LOAD_NAMES = { mppt: 'MPPT', cv: 'Tensión', cr: 'Resistencia', oc: 'Abierto', sc: 'Cortocirc.' };
  function loadSetpoint(mode) {
    const v = +$('#loadSp').value;
    if (mode === 'cv') return v / 100;
    if (mode === 'cr') return LAB.sim.limits.CR_MIN + Math.pow(v / 100, 2) * (LAB.sim.limits.CR_MAX - LAB.sim.limits.CR_MIN);
    return null;
  }
  const LM = () => LAB.sim.limits;
  function bindLoad() {
    $('#loadModes').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const mode = b.dataset.mode;
      send({ type: 'load.set', mode, setpoint: loadSetpoint(mode) ?? undefined });
    });
    const sp = $('#loadSp');
    sp.addEventListener('input', () => {
      dragging.load = true;
      const mode = tel.load.mode;
      if (mode === 'cv' || mode === 'cr') send({ type: 'load.set', mode, setpoint: loadSetpoint(mode) });
    });
    sp.addEventListener('change', () => { dragging.load = false; });
    const num = $('#loadNum');
    const applyNum = () => {
      const mode = tel.load.mode; if (mode !== 'cv' && mode !== 'cr') { ui.toast('Elige modo Tensión o Resistencia para fijar un valor.', 'warn'); return; }
      const L = LM(), r = mode === 'cv' ? readNum(num, 'Tensión', L.CV_MIN * 100, L.CV_MAX * 100, '% de Voc') : readNum(num, 'Resistencia', L.CR_MIN, L.CR_MAX, 'Ω');
      if (r.error) { num.focus(); return; }
      if (r.empty) { fieldErr(num, 'Escribe un valor.'); num.focus(); return; }
      send({ type: 'load.set', mode, setpoint: mode === 'cv' ? r.value / 100 : r.value });
    };
    num.addEventListener('input', () => { dragging.loadNum = true; fieldErr(num, ''); });
    num.addEventListener('blur', () => { dragging.loadNum = false; });
    $('#btnLoadNum').addEventListener('click', applyNum);
    num.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyNum(); });
    $('#btnSweep').addEventListener('click', () => { if (tel.load.sweeping) send({ type: 'load.sweep.abort' }); else send({ type: 'load.sweep' }); });
  }

  // ------------------------------------------------------------------ seguridad
  function bindSafety() {
    $('#btnEstop').addEventListener('click', () => send({ type: 'safety.estop', who: 'Usuario remoto' }));
    $('#btnReset').addEventListener('click', () => {
      if (!tel.safety.estop) return ui.toast('No hay paro de emergencia activo.', 'info');
      if (!confirm('En el banco real el restablecimiento lo hace solo el técnico en sitio con la llave. Aquí puedes SIMULAR esa intervención. ¿Simular la intervención del técnico?')) return;
      send({ type: 'safety.reset' });
    });
    $('#btnComms').addEventListener('click', () => send({ type: 'sim.comms', connected: tel.safety.commsCut }));
    $('#btnAck').addEventListener('click', () => send({ type: 'safety.ack' }));
  }

  // ----------------------------------------------------------------------- dock
  function dayInfo(lt) {
    const key = `${lt.year}-${lt.month}-${lt.day}`;
    if (dayCache.key === key) return dayCache;
    let dawn = null, dusk = null, best = -99, noon = 720;
    const grad = [];
    for (let m = 0; m <= 1440; m += 10) {
      const el = LAB.sim.solar.position(LAB.fromLocal(lt.year, lt.month, lt.day, 0, m)).el;
      if (el > 0 && dawn == null) dawn = m;
      if (el > 0) dusk = m;
      if (el > best) { best = el; noon = m; }
      const k = clamp((el + 8) / 22, 0, 1);
      const col = k < 0.35 ? mix([10, 20, 40], [150, 90, 110], k / 0.35) : mix([150, 90, 110], [255, 214, 130], (k - 0.35) / 0.65);
      grad.push(`rgb(${col[0]},${col[1]},${col[2]}) ${(m / 1440 * 100).toFixed(1)}%`);
    }
    document.documentElement.style.setProperty('--daygrad', `linear-gradient(90deg, ${grad.join(',')})`);
    dayCache = { key, dawn: dawn ?? 360, noon, dusk: dusk ?? 1080 };
    return dayCache;
  }
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

  function setLocalTime(year, month, day, minutes) {
    send({ type: 'sim.time', ms: LAB.fromLocal(year, month, day, 0, Math.floor(minutes), Math.round((minutes % 1) * 60)) });
  }

  function bindDock() {
    $('#btnPlay').addEventListener('click', () => send({ type: 'sim.play', toggle: true }));   // el motor decide (la copia local de la telemetria puede ir un cuadro atrasada)
    $('#speedSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) send({ type: 'sim.speed', speed: +b.dataset.s }); });
    const ts = $('#timeSlider');
    ts.addEventListener('input', () => { dragging.time = true; const lt = tel.local; setLocalTime(lt.year, lt.month, lt.day, +ts.value); });
    ts.addEventListener('change', () => { dragging.time = false; });
    $('#dateIn').addEventListener('change', (e) => {
      const m = e.target.value.match(/(\d+)-(\d+)-(\d+)/); if (!m) return;
      const lt = tel.local; setLocalTime(+m[1], +m[2], +m[3], lt.hours * 60);
    });
    const quick = (key) => () => { const lt = tel.local, d = dayInfo(lt); setLocalTime(lt.year, lt.month, lt.day, d[key]); };
    $('#qDawn').addEventListener('click', quick('dawn')); $('#qNoon').addEventListener('click', quick('noon')); $('#qDusk').addEventListener('click', () => { const lt = tel.local, d = dayInfo(lt); setLocalTime(lt.year, lt.month, lt.day, d.dusk - 40); });
    $('#qNow').addEventListener('click', () => send({ type: 'sim.time', ms: Date.now() }));

    const cl = $('#cloudSlider'), wd = $('#windSlider');
    cl.addEventListener('input', () => { setText('cloudOut', cl.value + ' %'); send({ type: 'sim.cloud', value: cl.value / 100 }); });
    wd.addEventListener('input', () => { setText('windSetOut', (+wd.value).toFixed(1) + ' m/s'); send({ type: 'sim.wind', value: +wd.value }); });
    [cl, wd].forEach((e) => { e.addEventListener('pointerdown', () => { dragging[e.id] = true; }); e.addEventListener('change', () => { dragging[e.id] = false; }); e.addEventListener('blur', () => { dragging[e.id] = false; }); });
    $('#btnGust').addEventListener('click', () => send({ type: 'sim.gust', peak: 19, seconds: 14 }));
    $('#btnRain').addEventListener('click', () => {
      const lvl = ((tel.env.rainLevel || 0) + 1) % LAB.sim.RAIN_LEVELS.length; send({ type: 'sim.rain', level: lvl });
    });

    $('#btnCam1').addEventListener('click', () => togglePov('cam1'));
    $('#btnCam2').addEventListener('click', () => togglePov('cam2'));
    $('#povExit').addEventListener('click', exitPov);
    $('#btnPip').addEventListener('click', () => { const on = !app.pip.on; app.setPip(on, 'cam2'); $('#btnPip').classList.toggle('on', on); });
    $('#btnLabels').addEventListener('click', () => {
      const next = { main: 'all', all: 'off', off: 'main' }[app.world.labels.mode];
      app.world.labels.setMode(next);
      $('#btnLabels').title = { main: 'Etiquetas: principales (L)', all: 'Etiquetas: todas (L)', off: 'Sin etiquetas (L)' }[next];
      $('#btnLabels').classList.toggle('on', next === 'all'); $('#btnLabels').classList.toggle('dim', next === 'off');
    });
    const qBtn = $('#btnQuality');
    const qLabel = () => { const nm = { high: 'Alta', medium: 'Media', low: 'Baja' }[app.quality.level]; setText('qTxt', app.quality.auto ? 'Auto·' + nm[0] : nm); qBtn.title = 'Calidad gráfica: ' + (app.quality.auto ? 'automática (' + nm.toLowerCase() + ')' : nm.toLowerCase()) + ' — clic para cambiar'; };
    ui.onQuality = qLabel; qLabel();
    qBtn.addEventListener('click', () => {
      const q = app.quality;
      if (q.auto) { q.auto = false; app.applyQuality('high'); }
      else if (q.level === 'high') app.applyQuality('medium');
      else if (q.level === 'medium') app.applyQuality('low');
      else { q.auto = true; app.applyQuality('high'); }
      qLabel();
    });
    $('#btnFree').addEventListener('click', () => {
      const on = !app.rig.free; if (on) exitPov();
      app.rig.setFree(on); $('#btnFree').classList.toggle('on', on); $('#freeHud').hidden = !on; document.body.classList.toggle('freecam', on);
    });
    $('#btnClean').addEventListener('click', () => { const on = !document.body.classList.contains('clean'); document.body.classList.toggle('clean', on); $('#btnClean').classList.toggle('on', on); });
    $('#btnOrbit').addEventListener('click', () => { app.rig.autoOrbit = !app.rig.autoOrbit; $('#btnOrbit').classList.toggle('on', app.rig.autoOrbit); });
  }

  function togglePov(which) {
    if (app.rig.pov === which) return exitPov();
    if (app.rig.free) $('#btnFree').click();
    app.rig.enterPov(which); povOpener = document.activeElement;
    $('#povOverlay').hidden = false;
    setText('povName', which === 'cam1' ? 'CÁM 1 · Vista general' : 'CÁM 2 · Vista del seguidor');
    $('#btnCam1').classList.toggle('on', which === 'cam1'); $('#btnCam2').classList.toggle('on', which === 'cam2');
    if (ui.practices) ui.practices.notify('pov', { id: which, phase: 'enter' });
    $('#povExit').focus();
  }
  let povOpener = null;
  function exitPov() {
    if (!app.rig.pov) return;
    const was = app.rig.pov;
    app.rig.exitPov(); $('#povOverlay').hidden = true; $('#btnCam1').classList.remove('on'); $('#btnCam2').classList.remove('on');
    if (ui.practices) ui.practices.notify('pov', { id: was, phase: 'exit' });
    if (povOpener && document.contains(povOpener)) povOpener.focus();
  }

  // ------------------------------------------------------------------- datos
  function markTab() {
    const run = chartTab === 'run', an = chartTab === 'analysis', alt = run || an; $('#runPane').hidden = !run; $('#analysisPane').hidden = !an; $('#sweepPane').hidden = chartTab !== 'iv'; if (chartTab === 'iv') refreshSweeps(); $('.chartbox:not(.rvbox)').hidden = alt; $('#chartTableWrap').hidden = alt; $('#chartNote').hidden = alt;
    if (an) { if (!ui.analysisview) ui.analysisview = new ui.AnalysisView($('#analysisPane'), { getRuns: allRuns, download, toast: (m, k) => ui.toast(m, k) }); ui.analysisview.refresh(); }
    if (run) { if (!ui.runview) ui.runview = new ui.RunView($('#runPane'), { getRuns: allRuns, download, toast: (m, k) => ui.toast(m, k), announce: ui.announce }); ui.runview.refresh(); }
    $$('#chartTabs button').forEach((b) => { const on = b.dataset.tab === chartTab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }); if (ui.practices && chartTab === 'iv') ui.practices.notify('tab', 'iv'); }
  /** Corridas de la sesion (vivas, en memoria) mas las guardadas del perfil; la version viva gana */
  async function allRuns() {
    const pid = tel.session.profileId, saved = pid ? await store.listRuns(pid) : [], live = source.runs.slice(), ids = new Set(live.map((r) => r.id));
    return saved.filter((r) => !ids.has(r.id)).concat(live).sort((a, b) => String(a.createdAtUtc).localeCompare(String(b.createdAtUtc)));
  }
  function bindData() {
    $('#chartTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; chartTab = b.dataset.tab; markTab(); lastChart = 0; if (ui.practices) ui.practices.notify('tab', chartTab); });
    $('#btnCsv').addEventListener('click', async () => {
      const r = await source.exportCsv();                                  // la fuente devuelve un resultado (o una promesa, en red): no se finge exito sin datos
      if (!r.ok) return ui.toast(r.reason, 'warn', 6000);
      download(r.text, r.filename, r.mime);
      if (ui.practices) ui.practices.notify('csv', { rows: r.rows, runId: r.runId });
      ui.toast(`Descargadas ${r.rows} muestras de la corrida ${r.runId}.`, 'ok');
    });
    $('#btnAcq').addEventListener('click', () => {
      if (tel.acq.status === 'recording') return send({ type: 'acq.stop' });
      const st = ui.practices && ui.practices.state();
      if (!tel.acq.runId && st && st.current && st.ps && st.ps.status === 'in_progress') { const r = send({ type: 'acq.newRun', practiceId: st.current, label: 'Práctica ' + st.current }); if (!r.ok) return; }
      send({ type: 'acq.start' });
    });
    $('#btnNewRun').addEventListener('click', () => { if (tel.acq.status === 'recording') send({ type: 'acq.stop' }); const st = ui.practices && ui.practices.state(); send({ type: 'acq.newRun', practiceId: st && st.ps && st.ps.status === 'in_progress' ? st.current : undefined }); });
    $('#btnResetE').addEventListener('click', () => { if (confirm('Poner a cero los contadores de energía abre un nuevo segmento de integración. Las muestras ya registradas se conservan. ¿Continuar?')) send({ type: 'sim.resetEnergy' }); });
    $('#btnResetRain').addEventListener('click', () => send({ type: 'sim.resetRain' }));
    $('#btnRuns').addEventListener('click', () => { const p = $('#runsPanel'); p.hidden = !p.hidden; $('#btnRuns').setAttribute('aria-expanded', String(!p.hidden)); if (!p.hidden) refreshRuns(); });
  }
  function download(text, filename, mime) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' })); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  ui.download = download;

  async function refreshRuns() {
    const p = $('#runsPanel'); if (!p || p.hidden || !tel.session.profileId) return;
    const runs = await store.listRuns(tel.session.profileId), box = $('#runsList'); box.textContent = '';
    if (!runs.length) { box.textContent = 'Todavía no hay corridas guardadas para este perfil.'; return; }
    runs.slice().reverse().forEach((r) => {
      const row = document.createElement('div'); row.className = 'runrow';
      const t = document.createElement('span'); const lt = r.samples.length ? LAB.localTime(r.samples[0][2]) : null;
      t.textContent = `${r.id} · ${r.samples.length} muestras · ${r.segments.length} segmento(s) · ${r.status}${lt ? ' · ' + lt.day + '/' + lt.month + '/' + lt.year : ''}${r.practiceId ? ' · ' + r.practiceId : ''}`;
      const b1 = document.createElement('button'); b1.className = 'btn'; b1.type = 'button'; b1.textContent = 'CSV'; b1.setAttribute('aria-label', 'Descargar CSV de ' + r.id);
      b1.addEventListener('click', () => { if (!r.samples.length) return ui.toast('Esta corrida no tiene muestras.', 'warn'); download(LAB.core.runToCsv(r), `lab-solar-unach_${r.id}.csv`, 'text/csv;charset=utf-8'); });
      row.append(t, b1); box.appendChild(row);
    });
  }

  // -------------------------------------------------------------- ficha de componente
  function bindInfo() {
    $('#infocard .x').addEventListener('click', () => { $('#infocard').hidden = true; infoPart = null; app.world.select(null); });
    $('#icFocus').addEventListener('click', () => { const v = PART_VIEW[infoPart]; if (v) { app.rig.set(v); markViews(v); } });
    $('#icCam').addEventListener('click', () => { if (infoPart === 'cam1' || infoPart === 'cam2') togglePov(infoPart); });
  }
  ui.showPart = function (id) {
    const info = LAB.scene.PART_INFO[id];
    if (!info) { if (!id) { $('#infocard').hidden = true; infoPart = null; } return; }
    infoPart = id;
    $('#infocard').hidden = false;
    const k = $('#icKind'); k.textContent = info.kind; k.style.color = info.color;
    setText('icTitle', info.title); setText('icText', info.text);
    $('#icCam').hidden = !(id === 'cam1' || id === 'cam2');
    updateInfoLive();
    if (ui.practices) ui.practices.notify('part', id);
  };
  function updateInfoLive() {
    if (!infoPart) return;
    const info = LAB.scene.PART_INFO[infoPart];
    $('#icLive').innerHTML = info.live(tel).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  // ------------------------------------------------------------------- bitacora
  function bindLog() {
    $('#logpanel .x').addEventListener('click', () => closeLog());
    $('#logFilter').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      logFilter = b.dataset.f; $$('#logFilter button').forEach((x) => x.classList.toggle('on', x === b)); renderLog();
    });
  }
  const entries = [];
  function logMatch(e) { return logFilter === 'all' || (logFilter === 'cmd' && e.level === 'cmd') || (logFilter === 'warn' && (e.level === 'warn' || e.level === 'bad')); }
  function logItem(e) {
    const li = document.createElement('li'); li.className = e.level;
    const tm = document.createElement('time'), sp = document.createElement('span'), sm = document.createElement('small');
    tm.textContent = timeStr(e.local); sp.textContent = e.msg; sm.textContent = e.src; sp.append(document.createElement('br'), sm); li.append(tm, sp);
    return li;
  }
  function onLog(e) {
    entries.push(e); if (entries.length > 300) entries.shift();
    logCount++; setText('logCount', String(logCount));
    const list = $('#logList');
    if (logMatch(e)) { const near = list.scrollHeight - list.scrollTop - list.clientHeight < 40; list.appendChild(logItem(e)); if (near) list.scrollTop = list.scrollHeight; }
    if (e.level === 'warn' && e.src !== 'Interlock' && e.src !== 'Validación') ui.toast(e.msg, 'warn', 5500);
    else if (e.level === 'bad') ui.toast(e.msg, 'bad', 6500);
    if (ui.practices) ui.practices.notify('log', e);
  }
  function renderLog() { const l = $('#logList'); l.innerHTML = ''; entries.filter(logMatch).forEach((e) => l.appendChild(logItem(e))); l.scrollTop = l.scrollHeight; }

  function bindPanels() {
    $$('.panel').forEach((p, i) => {
      const b = $('.fold', p), body = $('.body', p); if (!b || !body) return;
      const name = p.querySelector('h3').firstChild.textContent.trim(); body.id = body.id || 'pbody' + i;
      b.setAttribute('aria-controls', body.id); b.setAttribute('aria-expanded', 'true'); b.setAttribute('aria-label', 'Plegar o desplegar el panel ' + name); b.type = 'button';
      b.addEventListener('click', () => { p.classList.toggle('folded'); const f = p.classList.contains('folded'); b.textContent = f ? '+' : '–'; b.setAttribute('aria-expanded', String(!f)); });
    });
    // pestanas de la grafica: flechas, Inicio y Fin (patron de pestanas)
    const tabs = $('#chartTabs');
    tabs.addEventListener('keydown', (e) => {
      const bs = $$('button', tabs), i = bs.indexOf(document.activeElement); if (i < 0) return;
      let j = null; if (e.key === 'ArrowRight') j = (i + 1) % bs.length; else if (e.key === 'ArrowLeft') j = (i + bs.length - 1) % bs.length; else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = bs.length - 1;
      if (j == null) return; e.preventDefault(); bs[j].focus(); bs[j].click();
    });
    $('#chartTableWrap').addEventListener('toggle', () => { lastTable = 0; });
  }
  /** Capa superior abierta (C10): Escape cierra una sola capa por pulsacion, la mas alta primero */
  function closeTopLayer() {
    if (modalStack.length) { const top = modalStack[modalStack.length - 1].m; if (top.id === 'loginModal') return true; hideModal(top); return true; }
    if (ui.practices && ui.practices.drawerOpen()) { ui.practices.closeDrawer(); return true; }
    if (!$('#logpanel').hidden) { closeLog(); return true; }
    if (!$('#runsPanel').hidden) { $('#btnRuns').click(); return true; }
    if (ui.practices && ui.practices.guideOpen() && document.activeElement && document.activeElement.closest && document.activeElement.closest('#practiceGuide')) { ui.practices.hideGuide(); return true; }
    if (app.rig.free) { $('#btnFree').click(); return true; }
    if (app.rig.pov) { exitPov(); return true; }
    if (!$('#infocard').hidden) { $('#infocard').hidden = true; infoPart = null; app.world.select(null); return true; }
    return false;
  }
  function bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (closeTopLayer()) e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;                            // no se pisan atajos del navegador
      if (LAB.util.isInteractive(e.target)) return;                              // los controles interactivos conservan sus teclas (espacio, flechas, letras)
      if (modalStack.length) return;
      const k = e.key.toLowerCase();
      if (e.key === ' ') { e.preventDefault(); send({ type: 'sim.play', toggle: true }); }
      else if (e.key >= '1' && e.key <= '7') { const v = VIEW_BTNS[+e.key - 1][0]; app.rig.set(v); markViews(v); }
      else if (k === 'l') $('#btnLabels').click();
      else if (k === 'h') $('#btnClean').click();
      else if (k === 'f') $('#btnFree').click();
      else if (e.key === '?') showModal($('#helpDlg'));
    });
  }

  // ====================================================================== actualizacion
  let badgeKey = '';
  ui.update = function (t, dt, now) {
    tel = t;
    if (t.source !== badgeKey) { badgeKey = t.source; const b = BADGE[t.source] || BADGE.sim, el = $('#simBadge'); if (el) { el.lastChild.textContent = b[0]; el.title = b[1]; el.dataset.kind = t.source; } document.body.dataset.srcKind = t.source; }
    if (ui.replayTick && t.replay) ui.replayTick(t.replay);
    if (!app) return;
    if (now - lastDom > 180) { lastDom = now; updateDom(); }
    if (now - lastChart > 110) { lastChart = now; if (chartTab === 'run') { if (tel.acq.status === 'recording' && now - lastRunView > 2000) { lastRunView = now; ui.runview.refresh(); } } else if (chartTab !== 'analysis') drawChart(); }
    if (ui.practices) ui.practices.tick(tel, dt);
  };

  function drawCompass() {
    const cv = $('#compass'); if (!cv) return;
    const ctx = cv.getContext('2d'), S = cv.width, c = S / 2, R = S * 0.42, rad = (d) => (d - 90) * Math.PI / 180;
    const pt = (d, r) => [c + Math.cos(rad(d)) * r, c + Math.sin(rad(d)) * r];
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.beginPath(); ctx.arc(c, c, R + 8, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(c, c, R, 0, 7); ctx.stroke();
    for (let d = 0; d < 360; d += 30) { const p1 = pt(d, R), p2 = pt(d, R - (d % 90 ? 7 : 13)); ctx.beginPath(); ctx.moveTo(...p1); ctx.lineTo(...p2); ctx.stroke(); }
    ctx.font = '700 22px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    [['N', 0, '#ff6b6b'], ['E', 90, '#e8f0f8'], ['S', 180, '#e8f0f8'], ['O', 270, '#e8f0f8']].forEach(([t, d, col]) => { const p = pt(d, R - 27); ctx.fillStyle = col; ctx.fillText(t, p[0], p[1]); });
    const line = (d, len, color, wd) => { ctx.strokeStyle = color; ctx.lineWidth = wd; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(...pt(d, len)); ctx.stroke(); };
    line(180, R * 0.62, '#35d07f', 4);                       // modulo A fijo (sur)
    line(tel.B.az, R * 0.8, '#ffb020', 5);                   // modulo B
    if (tel.sun.el > 0) { const p = pt(tel.sun.az, R + 1); ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.arc(p[0], p[1], 9, 0, 7); ctx.fill(); }
    // viento: la flecha indica hacia donde se MUEVE el aire (el viento sopla "desde" windDir)
    const to = (tel.env.windDir + 180) % 360, len = R * (0.28 + 0.5 * Math.min(1, tel.env.wind / 14));
    const tail = pt(tel.env.windDir, len * 0.9), head = pt(to, len);
    ctx.strokeStyle = '#2fb4ff'; ctx.fillStyle = '#2fb4ff'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(...tail); ctx.lineTo(...head); ctx.stroke();
    const a1 = rad(to) , hx = head[0], hy = head[1];
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - Math.cos(a1 - 0.45) * 14, hy - Math.sin(a1 - 0.45) * 14); ctx.lineTo(hx - Math.cos(a1 + 0.45) * 14, hy - Math.sin(a1 + 0.45) * 14); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(c, c, 5, 0, 7); ctx.fill();
  }
  function updateDom() {
    const lt = tel.local;
    setText('clockTime', timeStr(lt));
    setText('clockDate', `${DOW[new Date(Date.UTC(lt.year, lt.month - 1, lt.day)).getUTCDay()]} ${lt.day} ${MONTHS[lt.month - 1]} ${lt.year} · UTC${LAB.config.site.tzHours}`);
    const el = tel.sun.el;
    setText('sunIcon', el < -2 ? '☾' : el < 8 ? '🌅' : '☀');
    setText('sunTxt', `elev ${fmt(el, 1)}° · az ${fmt(tel.sun.az, 0)}°`);

    // sesion
    const s = tel.safety.session;
    $('#sessionBtn .led').className = 'led ' + (s.active ? (tel.safety.role && tel.safety.role.canOperate ? '' : 'warn') : 'off');
    setText('sessionTxt', s.active ? `${s.user === tel.safety.role.label ? s.user : s.user + ' · ' + tel.safety.role.label}` : 'Sin sesión · iniciar');
    document.body.classList.toggle('nosession', !(s.active && tel.safety.role.canOperate));
    const ro = $('#roBanner'), why = tel.safety.blockReason;
    ro.hidden = !why; setText('roTxt', why ? 'Solo lectura: ' + why : '');

    // seguidor
    const T = tel.tracker;
    setText('trAz', fmt(T.az, 1) + '°'); setText('trTilt', fmt(T.tilt, 1) + '°');
    setText('trAzT', 'objetivo ' + fmt(T.targetAz, 0) + '°' + (T.lockAz ? ' 🔒' : '')); setText('trTiltT', 'objetivo ' + fmt(T.targetTilt, 0) + '°' + (T.lockTilt ? ' 🔒' : ''));
    $$('#trModes button').forEach((b) => { const on = b.dataset.mode === T.requestedMode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    const axes = T.lockAz ? 'tilt' : T.lockTilt ? 'az' : 'both';
    $$('#trAxes button').forEach((b) => b.classList.toggle('on', b.dataset.axes === axes));
    const sb = [];
    sb.push(`<span class="${T.moving.az || T.moving.tilt ? 'warn' : 'ok'}">${T.moving.az || T.moving.tilt ? 'En movimiento' : 'En posición'}</span>`);
    if (T.mode === 'sensor') sb.push(`<span class="${T.sensor.lock ? 'ok' : 'warn'}">${SENSOR_TXT[T.sensor.state] || ''}</span>`);
    if (T.appliedMode !== T.requestedMode) sb.push(`<span class="bad" title="Modo pedido: ${MODE_TXT[T.requestedMode]}">Aplicado: ${({ night: 'Noche (estacionado)', stow: 'Posición segura', estop: 'Paro de emergencia' })[T.appliedMode] || T.appliedMode}${T.blockCause ? ' · ' + T.blockCause : ''}</span>`);
    if (T.stowing && T.appliedMode === T.requestedMode) sb.push('<span class="bad">Posición segura</span>');
    sb.push(`<span>${fmt(T.powerW, 0)} W motores</span>`);
    $('#trState').innerHTML = sb.join('');
    if (!dragging.az) { syncCtl($('#azSlider'), Math.round(T.targetAz)); setText('azOut', Math.round(T.targetAz) + '°'); }
    if (!dragging.tilt) { syncCtl($('#tiltSlider'), Math.round(T.targetTilt)); setText('tiltOut', Math.round(T.targetTilt) + '°'); }
    $('#azSlider').disabled = T.lockAz; $('#tiltSlider').disabled = T.lockTilt;

    // carga
    const L = tel.load;
    $$('#loadModes button').forEach((b) => { const on = b.dataset.mode === L.mode && !L.sweeping; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    const usesSp = L.mode === 'cv' || L.mode === 'cr';
    $('#loadSp').disabled = !usesSp || L.sweeping;
    const LMt = LAB.sim.limits;
    if (!dragging.load) {
      if (L.mode === 'cv') syncCtl($('#loadSp'), Math.round(L.setpoint * 100));
      else if (L.mode === 'cr') syncCtl($('#loadSp'), Math.round(Math.sqrt(Math.max(L.setpoint - LMt.CR_MIN, 0) / (LMt.CR_MAX - LMt.CR_MIN)) * 100));
    }
    const numEl = $('#loadNum');
    $('#loadNumRow').hidden = !usesSp;
    if (usesSp && !dragging.loadNum) { numEl.min = L.mode === 'cr' ? LMt.CR_MIN : LMt.CV_MIN * 100; numEl.max = L.mode === 'cr' ? LMt.CR_MAX : LMt.CV_MAX * 100; syncCtl(numEl, L.mode === 'cr' ? fmt(L.setpoint, 1) : Math.round(L.setpoint * 100)); }
    setText('loadNumUnit', L.mode === 'cr' ? 'Ω' : '% Voc');
    setText('loadSpLabel', L.mode === 'cr' ? 'Resistencia' : 'Tensión');
    setText('loadSpOut', L.mode === 'cr' ? fmt(LMt.CR_MIN + Math.pow(+$('#loadSp').value / 100, 2) * (LMt.CR_MAX - LMt.CR_MIN), 1) + ' Ω' : (usesSp ? Math.round(L.setpoint * 100) : +$('#loadSp').value) + ' % Voc');
    setText('btnSweep', L.sweeping ? `Interrumpir barrido (${fmt(L.sweepT, 0)} / ${L.sweepSeconds} s)` : `Barrido I‑V automático (${L.sweepSeconds} s)`);

    // seguridad
    const S = tel.safety;
    const stateTxt = { NORMAL: ['Normal', 'Todos los enclavamientos cumplidos', 'green'], WIND_STOW: ['Posición segura por viento', 'El seguidor se ha llevado a horizontal', 'amber'],
      COMMS_STOW: ['Watchdog: enlace caído', 'Posición segura. Reconoce la falla al restablecer el enlace', 'amber'], ESTOP: ['PARO DE EMERGENCIA', 'Motores sin energía y carga desconectada', 'red'],
      FAULT: ['Falla o sin datos del controlador', 'No hay estado confiable del PLC: el banco se considera en condición segura y sin comandos', 'red'] }[S.state] || ['Estado desconocido', 'Sin información del controlador', 'red'];
    setText('safeState', stateTxt[0]);
    setText('safeDetail', S.windStow && S.resumeText ? S.resumeText : S.commsCut && !S.watchdog ? `Enlace cortado: watchdog en ${fmt(LAB.config.safety.commsTimeoutS - S.commsAge, 0)} s` : stateTxt[1]);
    $('#safeBadge').className = 'safebadge ' + (stateTxt[2] === 'green' ? '' : stateTxt[2]);
    $('#safeBadge .lamp').className = 'lamp ' + (stateTxt[2] === 'green' ? '' : stateTxt[2]);
    setText('windOut', fmt(tel.env.wind, 1) + ' m/s (instantáneo)');
    const wmax = LAB.config.limits.windMax;
    $('#windBar').style.width = clamp(tel.env.wind / wmax * 100, 0, 100) + '%';
    $('#windThr').style.left = (LAB.config.safety.windStow / wmax * 100) + '%';
    setText('btnComms', S.commsCut ? 'Restablecer enlace' : 'Cortar enlace'); $('#linkBanner').hidden = !S.commsCut;
    $('#btnComms').classList.toggle('on', S.commsCut);
    $('#btnEstop').disabled = S.estop;

    // dock
    setText('btnPlay', tel.playing ? '❚❚' : '▶');
    { const bp = $('#btnPlay'), t = tel.playing ? 'Pausar reloj solar (el banco, el seguidor y los enclavamientos siguen activos)' : 'Reanudar reloj solar'; bp.title = t; bp.setAttribute('aria-label', t); bp.setAttribute('aria-pressed', String(!tel.playing)); }
    { const dc = $('#clock'); dc.classList.toggle('paused', !tel.playing); setText('clockPause', tel.playing ? '' : 'RELOJ SOLAR EN PAUSA'); }
    $$('#speedSeg button').forEach((b) => { const on = +b.dataset.s === tel.speed; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    const di = dayInfo(lt);
    if (!dragging.time) $('#timeSlider').value = Math.floor(lt.hours * 60);
    const dv = `${lt.year}-${pad2(lt.month)}-${pad2(lt.day)}`;
    if ($('#dateIn').value !== dv && document.activeElement !== $('#dateIn')) $('#dateIn').value = dv;
    void di;
    $('#btnRain').classList.toggle('on', tel.env.rain); $('#btnRain').setAttribute('aria-pressed', String(tel.env.rain));
    setText('btnRain', tel.env.rain ? 'Lluvia: ' + LAB.sim.RAIN_LEVELS[tel.env.rainLevel].name.toLowerCase() : 'Lluvia');
    if (!app.rig.pov && !$('#povOverlay').hidden) $('#povOverlay').hidden = true;

    // telemetria
    for (const k of ['A', 'B']) {
      const m = tel[k];
      setText('p' + k, fmt(m.p, 0)); setText('g' + k, fmt(m.poa, 0) + ' W/m²'); setText('t' + k, fmt(m.tcell, 1) + ' °C');
      setText('v' + k, fmt(m.v, 1) + ' V'); setText('i' + k, fmt(m.i, 2) + ' A'); setText('e' + k, fmt(m.wh, 1) + ' Wh'); setText('eta' + k, fmt(m.eff, 1) + ' %');
      const scale = 560;
      $('#p' + k + 'bar').style.width = clamp(m.p / scale * 100, 0, 100) + '%';
      $('#p' + k + 'max').style.left = clamp(m.pmp / scale * 100, 0, 100) + '%';
    }
    setText('bOrient', `${fmt(tel.B.az, 0)}° / ${fmt(tel.B.tilt, 0)}°`);
    { const C = tel.comparison, d = C.powerDiffPct, g = C.energyGainPct, sg = (v) => (v == null ? 'No disponible' : (v >= 0 ? '+' : '') + fmt(v, 1) + ' %');
      setText('diffTxt', sg(d)); setText('gainTxt', sg(g));
      $('#diffBadge').classList.toggle('neg', d != null && d < 0); $('#diffBadge').title = d == null ? C.powerNote : 'Diferencia de potencia ahora: P_B/P_A − 1';
      $('#gainBadge').classList.toggle('neg', g != null && g < 0); $('#gainBadge').title = g == null ? C.energyNote : `Ganancia de energía desde el último cero (${LAB.core.localStr(tel.energy.startedSimMs)}): E_B/E_A − 1`; }
    setText('eGhi', fmt(tel.env.ghi, 0)); setText('eDni', fmt(tel.env.dni, 0)); setText('eTa', fmt(tel.env.ta, 1)); setText('eRh', fmt(tel.env.rh, 0));
    setText('eWind', fmt(tel.env.wind, 1)); setText('eRain', fmt(tel.env.rainMm, 1));
    setText('eWindSet', 'consigna ' + fmt(tel.settings.windBase, 1));
    drawCompass();
    { const cs = $('#cloudSlider'), ws = $('#windSlider'); syncCtl(cs, Math.round(tel.settings.cloud * 100), dragging.cloudSlider); setText('cloudOut', Math.round(tel.settings.cloud * 100) + ' %');
      syncCtl(ws, tel.settings.windBase, dragging.windSlider); setText('windSetOut', fmt(tel.settings.windBase, 1) + ' m/s'); }
    // adquisicion
    { const A = tel.acq, rec = A.status === 'recording', bt = $('#btnAcq');
      setText('acqState', rec ? '● Grabando' : (A.runId ? '■ Detenido' : '■ Sin corrida'));
      $('#acqState').className = 'acqstate ' + (rec ? 'rec' : '');
      setText('acqCount', A.runId ? `${A.samples.toLocaleString('es-MX')} / ${A.limit.toLocaleString('es-MX')} muestras${A.segmentId ? ' · segmento ' + A.segmentId : ''}` : `límite ${A.limit.toLocaleString('es-MX')} muestras por corrida`);
      setText('btnAcq', rec ? 'Detener adquisición' : (A.runId ? 'Reanudar adquisición' : 'Iniciar adquisición'));
      bt.classList.toggle('danger', rec); bt.setAttribute('aria-pressed', String(rec));
      $('#acqBasis').textContent = `Una muestra cada ${A.everyS} s (${A.basis}).` + (A.reason === 'limite' ? ' La corrida llegó a su límite y se detuvo: exporta o crea una corrida nueva.' : '');
      const nl = !tel.safety.session.active || !tel.safety.role.canOperate; bt.disabled = nl; $('#btnNewRun').disabled = nl; }
    updateInfoLive();

    // camara IP
    if (app.rig.pov) {
      setText('povTime', `${timeStr(lt)} · ${lt.day}/${lt.month}/${lt.year}`);
      $('#povMeta').innerHTML = `Módulo B ${fmt(tel.B.az, 0)}° / ${fmt(tel.B.tilt, 0)}°<br>P_A ${fmt(tel.A.p, 0)} W · P_B ${fmt(tel.B.p, 0)} W<br>Viento ${fmt(tel.env.wind, 1)} m/s · ${fmt(tel.env.ta, 1)} °C`;
    }
  }

  // ====================================================================== graficas
  const C = { A: '#35d07f', B: '#ffb020', G: '#9db3c8', blue: '#2fb4ff' };
  const hms = (ms) => { const lt = LAB.localTime(ms); return `${pad2(lt.hour)}:${pad2(lt.minute)}:${pad2(lt.second)}`; };
  let lastTable = 0;
  /** Alternativa en tabla de la grafica (C18): mismos datos, legibles con lector de pantalla */
  function updateTable() {
    const w = $('#chartTableWrap'); if (!w.open) return;
    const now = performance.now(); if (now - lastTable < 1500) return; lastTable = now;
    const H = source.history, D = source.day, tb = $('#chartTable'), f = (v, d = 0) => (Number.isFinite(v) ? fmt(v, d) : '—');
    let head, rows = [], cap;
    if (chartTab === 'power') { cap = 'Potencia reciente (últimas muestras)'; head = ['Hora', 'P A (W)', 'P B (W)', 'POA B (W/m²)']; const n = H.t.length; for (let i = Math.max(0, n - 12); i < n; i++) rows.push([Number.isFinite(H.t[i]) ? hms(H.t[i]) : 'corte del reloj', f(H.pA[i]), f(H.pB[i]), f(H.gB[i])]); }
    else if (chartTab === 'day') { cap = 'Perfil del día simulado (cada ~30 min)'; head = ['Hora', 'P A (W)', 'P B (W)']; for (let i = 0; i < D.t.length; i += 30) rows.push([Number.isFinite(D.t[i]) ? fmt(D.t[i], 2) + ' h' : 'corte', f(D.pA[i]), f(D.pB[i])]); }
    else if (chartTab === 'iv') { const A = tel.A.curve, B = tel.B.curve; cap = 'Puntos característicos (curva calculada ahora)'; head = ['Módulo', 'Voc (V)', 'Isc (A)', 'Vmp (V)', 'Imp (A)', 'Pmp (W)']; rows = [['A', f(A.voc, 1), f(A.isc, 2), f(A.vmp, 1), f(A.imp, 2), f(A.pmp)], ['B', f(B.voc, 1), f(B.isc, 2), f(B.vmp, 1), f(B.imp, 2), f(B.pmp)]]; const sw = source.lastSweep; if (sw) rows.push(['Barrido ' + sw.status, sw.pts.A.length + ' puntos A', sw.pts.B.length + ' puntos B', '', '', '']); }
    else { cap = 'Energía acumulada'; head = ['Magnitud', 'Valor']; rows = [['Módulo A', f(tel.A.wh, 1) + ' Wh'], ['Módulo B', f(tel.B.wh, 1) + ' Wh'], ['Motores', f(tel.tracker.motorWh, 1) + ' Wh'], ['E_B/E_A−1', tel.comparison.energyGainPct == null ? 'No disponible' : f(tel.comparison.energyGainPct, 1) + ' %']]; }
    tb.textContent = '';
    const c = document.createElement('caption'); c.textContent = cap; tb.appendChild(c);
    const tr = document.createElement('tr'); head.forEach((h) => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = h; tr.appendChild(th); }); tb.appendChild(tr);
    rows.forEach((r) => { const t = document.createElement('tr'); r.forEach((v) => { const td = document.createElement('td'); td.textContent = v; t.appendChild(td); }); tb.appendChild(t); });
  }
  function drawChart() {
    updateTable();
    const H = source.history, note = $('#chartNote');
    note.textContent = '';
    if (chartTab === 'power') {
      const ft = H.t.filter(Number.isFinite), n = ft.length;
      if (n < 3) { chart.fit(); return; }
      const fin = (a) => a.filter(Number.isFinite);
      const ymax = ui.niceMax(Math.max(100, ...fin(H.pA), ...fin(H.pB)) * 1.05);
      const gmax = ui.niceMax(Math.max(200, ...fin(H.gA), ...fin(H.gB)));
      chart.line({
        x: { min: ft[0], max: ft[n - 1], fmt: (v) => hms(v).slice(0, 5) + ':' + hms(v).slice(6), ticks: 3 },
        y: { min: 0, max: ymax, label: 'P (W)', ticks: 4 }, y2: { min: 0, max: gmax, label: 'G (W/m²)', color: C.G, fmt: (v) => v.toFixed(0), ticks: 4 },
        series: [{ xs: H.t, ys: H.gB, color: C.G, width: 1.2, dash: [4, 3], axis: 'y2' }, { xs: H.t, ys: H.pA, color: C.A, fill: true }, { xs: H.t, ys: H.pB, color: C.B, fill: true }],
        legend: [{ name: 'P A', color: C.A }, { name: 'P B', color: C.B }, { name: 'G plano B', color: C.G, dash: true }],
      });
      note.textContent = 'últimos ~2 min reales';
    } else if (chartTab === 'day') {
      const D = source.day;
      chart.line({
        x: { min: 5, max: 19, fmt: (v) => pad2(Math.round(v)) + ':00', ticks: 7 },
        y: { min: 0, max: ui.niceMax(Math.max(150, ...D.pA.filter(Number.isFinite), ...D.pB.filter(Number.isFinite)) * 1.05), label: 'P (W)', ticks: 4 },
        series: [{ xs: D.t, ys: D.pA, color: C.A, fill: true }, { xs: D.t, ys: D.pB, color: C.B, fill: true }],
        vlines: [{ x: tel.local.hours }],
        legend: [{ name: 'A fijo', color: C.A }, { name: 'B móvil', color: C.B }],
      });
      note.textContent = D.t.length < 3 ? 'Acelera el tiempo (×600) para trazar el día' : 'perfil de potencia del día simulado';
    } else if (chartTab === 'iv') drawIV();
    else drawEnergy();
  }

  // ----------------------------------------------------------------- barridos (C14)
  let sweepCache = [], sweepSel = [], showCalc = true;
  async function refreshSweeps() {
    const pid = tel.session.profileId, saved = pid ? await store.listSweeps(pid) : [], live = source.sweeps.slice(), ids = new Set(live.map((s) => s.id));
    sweepCache = saved.filter((s) => !ids.has(s.id)).concat(live).sort((a, b) => (a.startSimMs - b.startSimMs) || String(a.id).localeCompare(String(b.id)));
    sweepSel = sweepSel.filter((id) => sweepCache.some((s) => s.id === id));
    if (!sweepSel.length && sweepCache.length) sweepSel = [sweepCache[sweepCache.length - 1].id];
    renderSweepPane(); lastChart = 0;
  }
  const selectedSweeps = () => sweepSel.map((id) => sweepCache.find((s) => s.id === id)).filter(Boolean);
  function sweepLabel(s) {
    const lt = LAB.localTime(s.startSimMs), c = s.cond && s.cond.start;
    return `${s.id} · ${pad2(lt.day)}/${pad2(lt.month)} ${pad2(lt.hour)}:${pad2(lt.minute)}` + (c ? ` · G_A ${fmt(c.gA, 0)} W/m² · G_B ${fmt(c.gB, 0)} W/m² · T celda A ${fmt(c.tA, 1)} °C` : '') + ` · ${s.pts.A.length + s.pts.B.length} puntos · ${s.status === 'complete' ? 'completo' : 'interrumpido' + (s.cause ? ' (' + s.cause + ')' : '')}`;
  }
  function renderSweepPane() {
    const box = $('#sweepPane'); box.textContent = '';
    const mk = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
    const fs = mk('fieldset', 'rvtoggles'); fs.appendChild(mk('legend', '', 'Barridos simulados registrados (elige hasta 2 para comparar)'));
    const lc = document.createElement('label'), cc = document.createElement('input'); cc.type = 'checkbox'; cc.checked = showCalc; cc.id = 'swCalc';
    cc.addEventListener('change', () => { showCalc = cc.checked; lastChart = 0; }); lc.append(cc, document.createTextNode(' Curva calculada actual (líneas, del modelo)')); fs.appendChild(lc);
    if (!sweepCache.length) fs.appendChild(mk('p', 'hint', 'Todavía no hay barridos registrados. Pulsa «Barrido I‑V» en el panel de carga: se guarda cada uno con sus condiciones.'));
    sweepCache.slice().reverse().forEach((s) => {
      const l = document.createElement('label'), cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'sw_' + s.id; cb.checked = sweepSel.includes(s.id);
      cb.addEventListener('change', () => { sweepSel = sweepSel.filter((x) => x !== s.id); if (cb.checked) { sweepSel.push(s.id); if (sweepSel.length > 2) sweepSel.shift(); } renderSweepPane(); lastChart = 0; });
      l.append(cb, document.createTextNode(' ' + sweepLabel(s))); fs.appendChild(l);
    });
    box.appendChild(fs);
    const sel = selectedSweeps();
    if (sel.length === 2) { const d = LAB.core.sweepConditionDiffs(sel[0], sel[1]); box.appendChild(mk('p', 'hint' + (d.length ? ' warn' : ''), d.length ? 'Atención: las condiciones difieren entre los dos barridos (' + d.join('; ') + '). Compáralos con cuidado: no se sobrescribe ninguna condición histórica.' : 'Los dos barridos se hicieron en condiciones similares (irradiancia y temperatura dentro de tolerancia).')); }
    else if (sel.length === 1) {
      const c = sel[0].cond && sel[0].cond.start, now = tel.A;
      if (c && Math.abs(c.gA - now.poa) > 0.1 * Math.max(c.gA, 50)) box.appendChild(mk('p', 'hint warn', `Este barrido se hizo con G_A ${fmt(c.gA, 0)} W/m² y ahora hay ${fmt(now.poa, 0)} W/m²: la curva calculada actual no coincide con los puntos, es normal.`));
    }
    if (sel.length) {
      const e = sel[sel.length - 1].cond && sel[sel.length - 1].cond.end;
      box.appendChild(mk('p', 'hint', 'Solo se guardan la irradiancia y la temperatura al inicio y al final de cada barrido, no una serie en el tiempo; por eso no se muestra la evolución de G durante el barrido' + (e ? ` (final del último elegido: G_A ${fmt(e.gA, 0)} W/m²).` : '.')));
      const b = mk('button', 'btn', 'CSV del barrido elegido'); b.type = 'button'; b.addEventListener('click', () => { const r = source.exportSweepCsv(sel[sel.length - 1].id); if (!r.ok) return ui.toast(r.reason, 'warn'); download(r.text, r.filename, r.mime); }); box.appendChild(b);
    }
  }

  function drawIV() {
    const A = tel.A.curve, B = tel.B.curve;
    const vmax = Math.max(A.voc, B.voc, 20) * 1.04;
    const imax = Math.max(A.isc, B.isc, 2) * 1.12, pmax = Math.max(A.pmp, B.pmp, 50) * 1.18;
    const series = [
      { xs: A.v, ys: A.i, color: C.A, width: 2 }, { xs: B.v, ys: B.i, color: C.B, width: 2 },
      { xs: A.v, ys: A.p, color: C.A, width: 1.6, dash: [5, 4], axis: 'y2' }, { xs: B.v, ys: B.p, color: C.B, width: 1.6, dash: [5, 4], axis: 'y2' },
    ].filter(() => showCalc);
    const points = [];
    if (A.pmp > 0) {
      points.push({ x: A.vmp, y: A.pmp, axis: 'y2', color: C.A, shape: 'diamond', r: 6 }, { x: B.vmp, y: B.pmp, axis: 'y2', color: C.B, shape: 'diamond', r: 6 });
      points.push({ x: tel.A.v, y: tel.A.i, color: '#fff', r: 4.5 }, { x: tel.B.v, y: tel.B.i, color: '#fff', r: 4.5 });
    }
    if (!tel.load.sweeping) selectedSweeps().forEach((w, k) => {
      const shape = k ? 'square' : 'circle', r = k ? 3 : 2.6;
      for (const p of w.pts.A) points.push({ x: p.v, y: p.i, color: C.A + 'dd', r, shape });
      for (const p of w.pts.B) points.push({ x: p.v, y: p.i, color: C.B + 'dd', r, shape });
    });
    if (tel.load.sweeping) {
      for (const p of source.sweep.pts.A) points.push({ x: p.v, y: p.i, color: C.A, r: 2.6 });
      for (const p of source.sweep.pts.B) points.push({ x: p.v, y: p.i, color: C.B, r: 2.6 });
    }
    chart.line({
      x: { min: 0, max: vmax, label: 'V (V)', fmt: (v) => v.toFixed(0), ticks: 5 },
      y: { min: 0, max: imax, label: 'I (A)', fmt: (v) => v.toFixed(0), ticks: 4 }, y2: { min: 0, max: pmax, label: 'P (W)', color: C.G, fmt: (v) => v.toFixed(0), ticks: 4 },
      series, points,
      legend: [{ name: 'I‑V', color: C.G }, { name: 'P‑V', color: C.G, dash: true }, { name: '◆ MPP', color: C.blue }],
    });
    const nsel = selectedSweeps().length;
    $('#chartNote').textContent = (nsel ? `Líneas = curva calculada ahora por el modelo · puntos (${nsel > 1 ? '○ primer barrido, □ segundo' : '○'}) = barrido registrado` : 'Líneas = curva calculada ahora por el modelo (aún no hay barridos registrados)') + ' · ◆ máx. potencia · ● operación actual';
  }

  function drawEnergy() {
    const eA = tel.A.wh, eB = tel.B.wh, mot = tel.tracker.motorWh;
    const C2 = tel.comparison, sg = (v) => (v == null ? 'No disponible (' + (C2.energyNote || 'sin referencia') + ')' : (v >= 0 ? '+' : '') + fmt(v, 1) + ' %');
    chart.bars([
      { label: 'Módulo A · fijo', value: eA, color: C.A, text: fmt(eA, 1) + ' Wh' },
      { label: 'Módulo B · móvil', value: eB, color: C.B, text: fmt(eB, 1) + ' Wh' },
      { label: 'Motores del seguidor', value: mot, color: '#a98bff', text: fmt(mot, 1) + ' Wh' },
    ], { minMax: 50, footer: [`Ganancia de energía de esta corrida (E_B/E_A−1): ${sg(C2.energyGainPct)}`, `Ganancia neta (restando motores): ${sg(C2.netGainPct)}`] });
  }

  ui.markViews = markViews;
})();
