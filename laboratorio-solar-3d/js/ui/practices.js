/* Practicas guiadas. Cada practica es un conjunto de DATOS (pasos con id estable, condiciones, ayudas y preguntas).
 * El estado de una practica (PS) es serializable y se guarda por perfil (js/core/store.js):
 *   PS = { practiceId, defVersion, status, steps{id:true}, answers{id:{draft,submitted,submittedAtUtc}}, evidence{}, closure, ... }
 * Reglas (C03-C06):
 *   - ocultar la guia NO abandona la practica; reiniciar es una accion explicita
 *   - escribir solo guarda un borrador; la respuesta se registra con "Guardar respuesta y continuar"
 *   - requisitos operativos, preguntas obligatorias y pasos opcionales se cuentan por separado
 *   - al completar se congela una copia de la evidencia: el reporte no cambia si el simulador sigue corriendo */
(function () {
  'use strict';
  const { fmt, pad2, esc } = LAB.util;
  const $ = (s) => document.querySelector(s);
  const ui = LAB.ui;
  const store = LAB.core.store;
  const MIN_ANSWER = 10;           // caracteres (sin espacios sobrantes) para registrar una respuesta

  let app, source, send, tel;
  let current = null;              // definicion de la practica activa
  let ps = null;                   // estado de la practica activa
  let E = {};                      // evidencia (ps.evidence)
  let profile = { id: null, user: null, role: null, sessionId: null };
  let progress = null;             // {practices:{}, activePractice}
  let guideOpen = false;
  let guideMin = false;
  let saveTimer = 0;
  let built = null;                // referencias a los nodos de la guia (se construye una vez por practica)
  let acc = 0;
  let lastOpener = null;

  // ---------------------------------------------------------------- utilidades de las practicas
  const lt = () => tel.local;
  const setTime = (h, m = 0) => { const l = lt(); return send({ type: 'sim.time', ms: LAB.fromLocal(l.year, l.month, l.day, h, m) }); };
  const canOperate = () => !!(tel && tel.safety.session.active && tel.safety.role && tel.safety.role.canOperate);
  const settled = () => !tel.tracker.moving.az && !tel.tracker.moving.tilt;
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const has = (arr, x) => Array.isArray(arr) && arr.includes(x);
  const add = (arr, x) => { if (!arr.includes(x)) arr.push(x); };
  /** Motivo por el que hoy un comando de operacion se rechazaria ('' = se aceptaria). Se revisa antes de preparar nada. */
  const guard = () => (tel.safety.blockReason || (tel.safety.canOperate ? '' : LAB.t('prac.el_banco_no_acepta')));
  const guarded = (fn) => () => { const why = guard(); if (why) { ui.toast(LAB.t('prac.no_se_puede_hacer') + why, 'warn', 6000); return; } fn(); };

  const mkSessionStep = () => ({
    id: 'session',
    text: LAB.t('prac.inicia_una_sesion_de'),
    why: LAB.t('prac.en_el_laboratorio_real'),
    check: () => canOperate(),
    assist: { label: LAB.t('prac.abrir_inicio_de_sesion'), run: () => ui.openLogin && ui.openLogin() },
  });

  // ---------------------------------------------------------------- escenarios comparables de la practica 3 (C12)
  // Dos cielos (despejado y nublado) con la misma fecha, viento y semilla: lo unico que cambia es la nubosidad.
  const P3_BASE = { y: 2026, mo: 10, d: 23, startH: 7, startM: 0, endHours: 17.5, windBase: 3.2, seed: 20261023, az: 180, tilt: 17, speed: 600 };
  const P3_SCENARIOS = { claro: { id: 'p3-claro-v1', cloud: 0.1 }, nublado: { id: 'p3-nublado-v1', cloud: 0.6 } };
  const p3Scn = (kind) => ({ ...P3_BASE, ...P3_SCENARIOS[P3_KINDS[kind].scn] });
  const p3Scenario = (kind) => { const s = p3Scn(kind); return { id: s.id, simMs: LAB.fromLocal(s.y, s.mo, s.d, s.startH, s.startM), cloud: s.cloud, windBase: s.windBase, seed: s.seed, az: s.az, tilt: s.tilt, speed: s.speed }; };
  const P3_KINDS = {
    astro: { scn: 'claro', get label() { return LAB.t('prac.p3_k_astro'); }, mode: 'astro', lockAz: false, lockTilt: false },
    sensor: { scn: 'claro', get label() { return LAB.t('prac.p3_k_sensor'); }, mode: 'sensor', lockAz: false, lockTilt: false },
    'astro-1eje': { scn: 'claro', get label() { return LAB.t('prac.p3_k_astro_1eje'); }, mode: 'astro', lockAz: false, lockTilt: true },
    'astro-nub': { scn: 'nublado', get label() { return LAB.t('prac.p3_k_astro_nub'); }, mode: 'astro', lockAz: false, lockTilt: false },
    'sensor-nub': { scn: 'nublado', get label() { return LAB.t('prac.p3_k_sensor_nub'); }, mode: 'sensor', lockAz: false, lockTilt: false },
  };
  function p3Prepare(kind) {
    const why = guard(); if (why) { ui.toast(LAB.t('prac.no_se_puede_preparar') + why, 'warn', 6500); return; }
    const k = P3_KINDS[kind], sc = p3Scn(kind);
    if (E.cur) p3Interrupt(LAB.t('prac.se_preparo_otra_corrida'));
    const r = send({ type: 'scenario.apply', scenario: p3Scenario(kind) });
    if (!r.ok) return;
    send({ type: 'tracker.locks', lockAz: k.lockAz, lockTilt: k.lockTilt });
    send({ type: 'tracker.mode', mode: k.mode });
    E.pending = { kind, label: k.label, mode: k.mode, lockAz: k.lockAz, lockTilt: k.lockTilt, scenarioId: sc.id };
    ui.toast(LAB.t('prac.escenario_aplicado_23_10', { id: sc.id, seed: sc.seed, cloud: Math.round(sc.cloud * 100) }), 'ok', 6500);
  }
  function p3Interrupt(cause) {
    if (!E.cur) return;
    E.runs.push({ kind: E.cur.kind, label: E.cur.label, status: 'interrupted', cause, startSimMs: E.cur.startSimMs, endSimMs: tel.simMs, scenarioId: E.cur.scenarioId, seed: E.cur.seed });
    E.cur = null; ui.toast(LAB.t('prac.corrida_interrumpida_no_cuenta', { cause }), 'warn', 7000);
  }
  function p3Tick() {
    const T = tel.tracker, l = lt();
    if (E.pending && tel.settings.scenarioId === E.pending.scenarioId && Math.abs(tel.energy.startedSimMs - tel.simMs) < 120000 && T.requestedMode === E.pending.mode) {
      E.cur = { ...E.pending, startSimMs: tel.simMs, lastSim: tel.simMs, resets: tel.energy.resets, cloud: tel.settings.cloud, windBase: tel.settings.windBase, seed: tel.settings.seed, day: l.day, noSignalS: 0 };
      E.pending = null;
    }
    const c = E.cur; if (!c) return;
    let cause = '';
    if (!tel.safety.session.active) cause = LAB.t('prac.se_cerro_la_sesion');
    else if (tel.settings.scenarioId !== c.scenarioId) cause = LAB.t('prac.se_cambio_o_reaplico');
    else if (tel.energy.resets !== c.resets) cause = LAB.t('prac.se_puso_la_energia');
    else if (tel.simMs < c.lastSim - 1000 || tel.simMs - c.lastSim > 40 * 60000) cause = LAB.t('prac.se_salto_el_reloj');
    else if (T.requestedMode !== c.mode || T.lockAz !== c.lockAz || T.lockTilt !== c.lockTilt) cause = LAB.t('prac.cambio_el_modo_o');
    else if (Math.abs(tel.settings.cloud - c.cloud) > 0.001 || Math.abs(tel.settings.windBase - c.windBase) > 0.001) cause = LAB.t('prac.se_modifico_la_nubosidad');
    else if (tel.settings.seed !== c.seed) cause = LAB.t('prac.se_cambio_la_semilla');
    else if (tel.load.mode !== 'mppt') cause = LAB.t('prac.se_cambio_el_modo');
    else if (tel.safety.state !== 'NORMAL') cause = LAB.t('prac.hubo_una_condicion_de') + tel.safety.state + ')';
    else if (l.day !== c.day) cause = LAB.t('prac.cambio_el_dia_simulado');
    if (cause) { p3Interrupt(cause); return; }
    if (c.mode === 'sensor' && T.sensor && T.sensor.state === 'NO_SIGNAL') c.noSignalS += Math.max(0, tel.simMs - c.lastSim) / 1000;
    c.lastSim = tel.simMs;
    if (l.hours >= P3_BASE.endHours) {
      const EA = tel.A.wh, EB = tel.B.wh, mot = T.motorWh;
      E.runs = E.runs.filter((r) => !(r.kind === c.kind && r.status === 'complete'));
      E.runs.push({ kind: c.kind, label: c.label, status: 'complete', startSimMs: c.startSimMs, endSimMs: tel.simMs, EA, EB, motor: mot, gainPct: EA >= 1 ? (EB / EA - 1) * 100 : null, netPct: EA >= 1 ? ((EB - mot) / EA - 1) * 100 : null, noSignalMin: c.mode === 'sensor' ? c.noSignalS / 60 : null, cloud: c.cloud, windBase: c.windBase, scenarioId: c.scenarioId, seed: c.seed });
      E.cur = null; ui.toast(LAB.t('prac.corrida_registrada', { label: c.label }), 'ok'); ui.announce(LAB.t('prac.corrida_registrada_2', { label: c.label }));
    }
  }
  const pct = (v) => (v == null ? LAB.t('prac.no_disponible') : (v >= 0 ? '+' : '') + fmt(v, 1) + ' %');

  // ---------------------------------------------------------------- definiciones
  const PART_VIEW = { pyr: 'station', anemo: 'station', shield: 'station', rain: 'station', cabinet: 'cabinet', estop: 'cabinet', load: 'load', moduleA: 'moduleA', moduleB: 'moduleB' };
  const PRACTICES = [];
  function buildPractices() {
  const fresh = [
    {
      id: 'p1', n: 1, version: 3, title: LAB.t('prac.caracterizacion_electrica_de_un'), get dur() { return LAB.t('prac.dur_p1'); },
      goal: LAB.t('prac.obtener_la_curva_i'),
      ilos: [LAB.t('prac.interpretar_las_variables_electricas'), LAB.t('prac.explicar_el_efecto_de'), LAB.t('prac.calcular_potencia_y_energia'), LAB.t('prac.identificar_la_region_de'), LAB.t('prac.comunicar_resultados_con_graficas')],
      rubric: [LAB.t('prac.p1_rub_1'), LAB.t('prac.p1_rub_2'), LAB.t('prac.p1_rub_3')],
      setup() { setTime(11, 30); send({ type: 'sim.cloud', value: 0.1 }); send({ type: 'sim.speed', speed: 1 }); send({ type: 'tracker.mode', mode: 'astro' }); send({ type: 'load.set', mode: 'mppt' }); app.rig.set('general'); ui.markViews('general'); },
      fresh: () => ({ parts: [], cams: {}, cond: null, ocT: 0, scT: 0, voc: null, isc: null, sweep: null, sweep2: null, sweepList: [], sweeps: 0, ivViewed: false }),
      steps: [
        mkSessionStep(),
        {
          id: 'pred',
          text: LAB.t('prac.p1_pred_text'),
          why: LAB.t('prac.p1_pred_why'),
          check: () => ansDone('p1pred'),
          question: { id: 'p1pred', kind: 'predict', after: 'nubes', text: LAB.t('prac.p1_pred_q'), ref: () => p1PredRef() },
        },
        {
          id: 'cond',
          text: LAB.t('prac.revisa_las_condiciones_abre'),
          why: LAB.t('prac.una_curva_i_v'),
          parts: ['pyr', 'anemo'],
          status: () => LAB.t('prac.ahora_poa_a_w', { fmt: fmt(tel.A.poa, 0), fmt2: fmt(tel.env.wind, 1) }),
          check: () => has(E.parts, 'pyr') && has(E.parts, 'anemo') && tel.A.poa > 600 && tel.env.wind < 8,
          warn: () => (has(E.parts, 'pyr') && has(E.parts, 'anemo') && !(tel.A.poa > 600 && tel.env.wind < 8) ? LAB.t('prac.las_fichas_estan_abiertas') : ''),
        },
        {
          id: 'cam1',
          text: LAB.t('prac.verifica_el_banco_con'),
          why: LAB.t('prac.antes_de_operar_se'),
          status: () => LAB.t('prac.cam_status', { a: E.cams.cam1 && E.cams.cam1.entered ? '✓' : '○', b: E.cams.cam1 && E.cams.cam1.exited ? '✓' : '○' }),
          check: () => !!(E.cams.cam1 && E.cams.cam1.entered && E.cams.cam1.exited),
          assist: { label: LAB.t('prac.ver_camara_1'), run: () => document.getElementById('btnCam1').click() },
        },
        {
          id: 'oc',
          text: LAB.t('prac.pon_la_carga_en'),
          why: LAB.t('prac.voc_es_la_tension'),
          status: () => LAB.t('prac.oc_status', { t: fmt(Math.min(E.ocT, 3), 1) }),
          check: () => E.ocT >= 3,
          assist: { label: LAB.t('prac.poner_circuito_abierto'), run: guarded(() => send({ type: 'load.set', mode: 'oc' })) },
        },
        {
          id: 'sc',
          text: LAB.t('prac.pasa_a_cortocircuito_controlado'),
          why: LAB.t('prac.isc_es_la_corriente'),
          status: () => LAB.t('prac.sc_status', { t: fmt(Math.min(E.scT, 3), 1) }),
          check: () => E.scT >= 3,
          assist: { label: LAB.t('prac.poner_cortocircuito'), run: guarded(() => send({ type: 'load.set', mode: 'sc' })) },
        },
        {
          id: 'sweep',
          text: LAB.t('prac.lanza_el_barrido_i'),
          why: LAB.t('prac.la_carga_recorre_la'),
          status: () => (tel.load.sweeping ? LAB.t('prac.sweep_status', { t: fmt(tel.load.sweepT, 0) }) : (E.sweep ? LAB.t('prac.barrido_completo_registrado') : LAB.t('prac.aun_no_hay_un'))),
          check: () => !!E.sweep,
          assist: { label: LAB.t('prac.iniciar_barrido'), run: guarded(() => send({ type: 'load.sweep' })) },
        },
        {
          id: 'mpp',
          text: LAB.t('prac.abre_la_pestana_i'),
          why: LAB.t('prac.el_mpp_esta_en'),
          check: () => !!E.sweep && E.ivViewed,
          assist: { label: LAB.t('prac.show_iv'), run: () => document.querySelector('#chartTabs [data-tab=iv]').click() },
          question: {
            id: 'p1q1', text: LAB.t('prac.a_que_fraccion_de'),
            ref: () => { const s = E.sweep; if (!s) return LAB.t('prac.aun_no_hay_un'); return LAB.t('prac.vmp_voc_vmp_v', { fmt: fmt(s.Vmp / s.Voc, 2), fmt2: fmt(s.Vmp, 1), fmt3: fmt(s.Voc, 1), v: fmt(s.Pmax / (s.Voc * s.Isc), 2) }); },
          },
        },
        {
          id: 'calc',
          text: LAB.t('prac.p1_calc_text'),
          why: LAB.t('prac.p1_calc_why'),
          status: () => (E.sweep ? LAB.t('prac.p1_calc_status', { pmax: fmt(E.sweep.Pmax, 1), voc: fmt(E.sweep.Voc, 2), isc: fmt(E.sweep.Isc, 2), g: fmt(E.sweep.G, 0), area: fmt(LAB.config.module.area, 3) }) : ''),
          check: () => !!E.sweep && measureDone('p1calc'),
          measure: { id: 'p1calc', ready: () => !!E.sweep, fields: [
            { k: 'ff', label: LAB.t('prac.p1_f_ff'), unit: '', ref: () => (E.sweep ? ffOf(E.sweep) : null), tolRel: 0.02 },
            { k: 'eta', label: LAB.t('prac.p1_f_eta'), unit: '%', ref: () => (E.sweep ? etaOf(E.sweep) : null), tolRel: 0.03 },
          ] },
        },
        {
          id: 'nubes',
          text: LAB.t('prac.p1_nubes_text'),
          why: LAB.t('prac.isc_crece_casi_linealmente'),
          status: () => (E.sweep2 ? LAB.t('prac.p1_nubes_ok', { g1: fmt(E.sweep.G, 0), g2: fmt(E.sweep2.G, 0) }) : LAB.t('prac.p1_nubes_falta', { g: E.sweep ? fmt(E.sweep.G, 0) : '—', n: E.sweeps || 0 })),
          check: () => !!E.sweep2,
          assist: { label: LAB.t('prac.iniciar_barrido'), run: guarded(() => send({ type: 'load.sweep' })) },
        },
        {
          id: 'interp',
          text: LAB.t('prac.p1_interp_text'),
          why: LAB.t('prac.p1_interp_why'),
          check: () => !!E.sweep2 && measureDone('p1iscg'),
          measure: { id: 'p1iscg', ready: () => !!E.sweep2, fields: [
            { k: 'iscg1', label: LAB.t('prac.p1_f_iscg1'), unit: 'mA/(W/m²)', ref: () => (E.sweep ? iscPerG(E.sweep) : null), tolRel: 0.03 },
            { k: 'iscg2', label: LAB.t('prac.p1_f_iscg2'), unit: 'mA/(W/m²)', ref: () => (E.sweep2 ? iscPerG(E.sweep2) : null), tolRel: 0.03 },
          ] },
          question: { id: 'p1q2', text: LAB.t('prac.p1_q2'), ref: () => p1InterpRef() },
        },
      ],
      tick(dt) {
        if (tel.load.mode === 'oc' && !tel.load.sweeping && tel.safety.state === 'NORMAL') E.ocT += dt; else if (tel.load.mode !== 'oc') E.ocT = 0;
        if (tel.load.mode === 'sc' && !tel.load.sweeping && tel.safety.state === 'NORMAL') E.scT += dt; else if (tel.load.mode !== 'sc') E.scT = 0;
        if (E.ocT >= 3 && E.voc == null) E.voc = { A: tel.A.v, B: tel.B.v, G: tel.A.poa, T: tel.A.tcell };
        if (E.scT >= 3 && E.isc == null) E.isc = { A: tel.A.i, B: tel.B.i };
      },
      onSweep(sw) {
        if (sw.status !== 'complete') { ui.toast(LAB.t('prac.barrido_interrumpido_se_conservaron', { cause: LAB.tm(sw.cause), length: sw.pts.A.length }), 'warn', 7000); return; }
        const pa = sw.pts.A.reduce((m, p) => (p.p > m.p ? p : m), { p: 0, v: 0, i: 0 });
        const one = { id: sw.id, Pmax: pa.p, Vmp: pa.v, Imp: pa.i, G: (sw.cond.start.gA + sw.cond.end.gA) / 2, T: sw.cond.start.tA, Voc: Math.max(...sw.pts.A.map((p) => p.v)), Isc: Math.max(...sw.pts.A.map((p) => p.i)) };
        E.sweepList = (E.sweepList || []).concat([one]).slice(-8);
        E.sweeps = (E.sweeps || 0) + 1;
        if (!E.sweep) E.sweep = one;
        else if (!E.sweep2 && Math.abs(one.G / E.sweep.G - 1) >= 0.15) E.sweep2 = one;   // otro nivel de irradiancia: >= 15 % de diferencia
      },
      report(D) {
        const s = D.sweep;
        const L = [LAB.t('prac.datos_medidos_modulo_a')];
        if (D.voc) L.push(LAB.t('prac.rep_voc', { a: fmt(D.voc.A, 1), b: fmt(D.voc.B, 1), g: fmt(D.voc.G, 0), t: fmt(D.voc.T, 1) }));
        if (D.isc) L.push(LAB.t('prac.rep_isc', { a: fmt(D.isc.A, 2), b: fmt(D.isc.B, 2) }));
        if (s) {
          L.push(LAB.t('prac.barrido_i_v_pmax', { id: s.id, fmt: fmt(s.Pmax, 0), fmt3: fmt(s.Vmp, 1), fmt4: fmt(s.Imp, 2) }));
          L.push(LAB.t('prac.factor_de_forma_ff', { fmt: fmt(ffOf(s), 3) }), LAB.t('prac.eficiencia_del_modulo_pmax', { fmt: fmt(etaOf(s), 1), fmt2: fmt(s.G, 0), fmt3: fmt(LAB.config.module.area, 2) }));
          if (D.sweep2) L.push(LAB.t('prac.p1_rep_s2', { id: D.sweep2.id, g: fmt(D.sweep2.G, 0), pmax: fmt(D.sweep2.Pmax, 0), isc: fmt(D.sweep2.Isc, 2), voc: fmt(D.sweep2.Voc, 2), iscg: fmt(iscPerG(D.sweep2), 2), eta: fmt(etaOf(D.sweep2), 1) }));
        } else L.push(LAB.t('prac.barrido_i_v_no'));
        return L;
      },
    },
    {
      id: 'p2', n: 2, version: 3, title: LAB.t('prac.efecto_de_la_orientacion'), get dur() { return LAB.t('prac.dur_p2'); },
      goal: LAB.t('prac.cuantificar_cuanta_potencia_se'),
      ilos: [LAB.t('prac.relacionar_la_geometria_solar'), LAB.t('prac.operar_un_posicionador_remoto'), LAB.t('prac.comparar_simultaneamente_un_sistema'), LAB.t('prac.cuantificar_perdidas_o_ganancias'), LAB.t('prac.distinguir_variaciones_geometricas_de')],
      rubric: [LAB.t('prac.p2_rub_1'), LAB.t('prac.p2_rub_2'), LAB.t('prac.p2_rub_3')],
      setup() { setTime(11, 0); send({ type: 'sim.cloud', value: 0.05 }); send({ type: 'sim.speed', speed: 1 }); send({ type: 'tracker.locks', lockAz: false, lockTilt: false }); send({ type: 'tracker.mode', mode: 'manual' }); send({ type: 'load.set', mode: 'mppt' }); send({ type: 'tracker.target', az: 180, tilt: 17 }); document.querySelector('#chartTabs [data-tab=power]').click(); },
      fresh: () => ({ ack1: false, points: {}, hold: 0, win: { t: 0, r: [], a: [], b: [] }, astroPoint: null }),
      steps: [
        mkSessionStep(),
        {
          id: 'pred',
          text: LAB.t('prac.p2_pred_text'),
          why: LAB.t('prac.p2_pred_why'),
          check: () => ansDone('p2pred'),
          question: { id: 'p2pred', kind: 'predict', after: 'calc', text: LAB.t('prac.p2_pred_q'), ref: () => p2PredRef() },
        },
        {
          id: 'sun',
          text: LAB.t('prac.anota_la_posicion_del'),
          why: LAB.t('prac.un_modulo_capta_mas'),
          check: () => E.ack1, manual: LAB.t('prac.ya_la_anote'),
        },
        {
          id: 'base',
          text: LAB.t('prac.calibra_el_par_deja'),
          why: LAB.t('prac.dos_modulos_identicos_nunca'),
          status: () => holdStatus(),
          check: () => !!E.points['180|17'],
          assist: { label: LAB.t('prac.mover_b_a_180'), run: guarded(() => send({ type: 'tracker.target', az: 180, tilt: 17 })) },
        },
        {
          id: 'az',
          text: LAB.t('prac.barrido_de_azimut_con'),
          why: LAB.t('prac.la_tabla_de_abajo'),
          status: () => holdStatus(LAB.t('prac.az_count', { n: azPoints().length })),
          check: () => azPoints().length >= 4 && spread(azPoints().map((p) => p.az)) >= 60,
          warn: () => (tel.tracker.lockAz ? LAB.t('prac.el_azimut_esta_inmovilizado') : ''),
        },
        {
          id: 'tilt',
          text: LAB.t('prac.barrido_de_inclinacion_con'),
          why: LAB.t('prac.mide_cuanto_pesa_la'),
          status: () => holdStatus(LAB.t('prac.tilt_count', { n: tiltPoints().length })),
          check: () => tiltPoints().length >= 4 && spread(tiltPoints().map((p) => p.tilt)) >= 50,
          warn: () => (tel.tracker.lockTilt ? LAB.t('prac.la_inclinacion_esta_inmovilizada') : ''),
        },
        {
          id: 'astro',
          text: LAB.t('prac.apunta_b_directamente_al'),
          why: LAB.t('prac.es_el_maximo_teorico'),
          status: () => holdStatus(),
          check: () => !!E.astroPoint,
          assist: { label: LAB.t('prac.activar_astronomico'), run: guarded(() => send({ type: 'tracker.mode', mode: 'astro' })) },
        },
        {
          id: 'calc',
          text: LAB.t('prac.p2_calc_text'),
          why: LAB.t('prac.p2_calc_why'),
          status: () => { const b = E.points['180|17']; return b ? LAB.t('prac.p2_calc_status', { base: fmt(b.ratio, 4), n: Object.keys(E.points).length }) : ''; },
          check: () => !!E.points['180|17'] && Object.keys(E.points).length >= 3 && measureDone('p2calc'),
          measure: { id: 'p2calc', ready: () => !!E.points['180|17'] && Object.keys(E.points).length >= 3, fields: [
            { k: 'best', label: LAB.t('prac.p2_f_best'), unit: '%', ref: () => p2Delta('max'), tolAbs: 0.4 },
            { k: 'worst', label: LAB.t('prac.p2_f_worst'), unit: '%', ref: () => p2Delta('min'), tolAbs: 0.4 },
          ] },
          question: { id: 'p2q1', text: LAB.t('prac.en_que_orientacion_fue'), ref: () => p2Ref() },
        },
      ],
      tick(dt) {
        const T = tel.tracker;
        const reset = () => { E.hold = 0; E.win = { t: 0, r: [], a: [], b: [] }; };
        if (T.appliedMode !== 'manual' && T.appliedMode !== 'astro') { reset(); return; }
        if (!settled() || tel.load.mode !== 'mppt' || tel.A.p < 40 || tel.safety.state !== 'NORMAL') { reset(); return; }
        E.hold += dt;
        if (E.hold >= 0) {                                       // ventana de medicion: media y desviacion de P_B/P_A cada 0.5 s
          const w = (E.win = E.win || { t: 0, r: [], a: [], b: [] });
          w.t += dt;
          if (w.t >= 0.5) { w.t = 0; w.r.push(tel.B.p / tel.A.p); w.a.push(tel.A.p); w.b.push(tel.B.p); }
        }
        if (E.hold >= HOLD_S) {
          const az = Math.round(T.az), tilt = Math.round(T.tilt), w = E.win, st = meanSd(w.r);
          const pt = { az, tilt, ratio: st.mean, sd: st.sd, n: w.r.length, pA: meanSd(w.a).mean, pB: meanSd(w.b).mean, G: tel.B.poa, sunAz: tel.sun.az, sunEl: tel.sun.el };
          if (T.appliedMode === 'astro') E.astroPoint = pt;
          else E.points[`${az}|${tilt}`] = pt;
          E.hold = -9999; E.win = { t: 0, r: [], a: [], b: [] };
        }
        if (T.moving.az || T.moving.tilt) reset();
      },
      extra(D) {
        const rows = Object.values(D.points).sort((a, b) => a.az - b.az || a.tilt - b.tilt);
        if (!rows.length) return '';
        return LAB.t('prac.posiciones_registradas_az_incl', { join: rows.map((r) => `<tr><td>${r.az}°</td><td>${r.tilt}°</td><td>${fmt(r.pA, 0)}</td><td>${fmt(r.pB, 0)}</td><td><b>${fmt(r.ratio, 3)}</b></td><td>${r.sd != null ? fmt(r.sd, 4) : '—'}</td></tr>`).join('') });
      },
      report(D) {
        const rows = Object.values(D.points).sort((a, b) => a.az - b.az || a.tilt - b.tilt);
        const L = [LAB.t('prac.tabla_de_posiciones_simulada'), LAB.t('prac.azimut_inclinacion_p_a'), '|---|---|---|---|---|---|---|'];
        rows.forEach((r) => L.push(`| ${r.az}° | ${r.tilt}° | ${fmt(r.pA, 0)} | ${fmt(r.pB, 0)} | ${fmt(r.G, 0)} | ${fmt(r.ratio, 3)} | ${r.sd != null ? fmt(r.sd, 4) : '—'} |`));
        const base = D.points['180|17']; const best = bestPoint(D);
        if (base) L.push('', LAB.t('prac.linea_base_misma_orientacion', { fmt: fmt(base.ratio, 3) }));
        if (best && base) L.push(LAB.t('prac.mejor_orientacion_manual_con', { az: best.az, tilt: best.tilt, fmt: fmt(best.ratio, 3), v: fmt((best.ratio / base.ratio - 1) * 100, 1) }));
        if (D.astroPoint) L.push(LAB.t('prac.seguimiento_astronomico', { az: D.astroPoint.az, tilt: D.astroPoint.tilt, fmt: fmt(D.astroPoint.ratio, 3) }));
        if (D.sunAtClose) L.push(LAB.t('prac.posicion_solar_al_cierre', { fmt: fmt(D.sunAtClose.az, 0), fmt2: fmt(D.sunAtClose.el, 0) }));
        return L;
      },
    },
    {
      id: 'p3', n: 3, version: 3, title: LAB.t('prac.fijo_contra_estrategias_de'), get dur() { return LAB.t('prac.dur_p3'); },
      goal: LAB.t('prac.comparar_la_energia_diaria'),
      ilos: [LAB.t('prac.diferenciar_estrategias_de_seguimiento'), LAB.t('prac.interpretar_series_temporales_de'), LAB.t('prac.calcular_y_comparar_energia'), LAB.t('prac.analizar_el_compromiso_entre'), LAB.t('prac.sustentar_una_decision_tecnica')],
      rubric: [LAB.t('prac.p3_rub_1'), LAB.t('prac.p3_rub_2'), LAB.t('prac.p3_rub_3')],
      setup() { /* cada corrida aplica su propio escenario */ },
      fresh: () => ({ runs: [], pending: null, cur: null }),
      steps: [
        mkSessionStep(),
        {
          id: 'pred',
          text: LAB.t('prac.p3_pred_text'),
          why: LAB.t('prac.p3_pred_why'),
          check: () => ansDone('p3pred'),
          question: { id: 'p3pred', kind: 'predict', after: 'calc', text: LAB.t('prac.p3_pred_q'), ref: () => p3PredRef() },
        },
        {
          id: 'r-astro',
          text: LAB.t('prac.corrida_1_seguimiento_astronomico'),
          why: LAB.t('prac.el_modulo_a_fijo'),
          status: () => runStatus('astro'),
          check: () => hasRun('astro'),
          assist: { label: LAB.t('prac.preparar_corrida_dos_ejes'), run: () => p3Prepare('astro') },
        },
        {
          id: 'r-sensor',
          text: LAB.t('prac.corrida_3_seguimiento_por'),
          why: LAB.t('prac.los_sensores_se_pierden'),
          status: () => runStatus('sensor'),
          check: () => hasRun('sensor'),
          assist: { label: LAB.t('prac.preparar_corrida_sensores'), run: () => p3Prepare('sensor') },
        },
        {
          id: 'r-astro-nub',
          text: LAB.t('prac.p3_r3_text'),
          why: LAB.t('prac.p3_r3_why'),
          status: () => runStatus('astro-nub'),
          check: () => hasRun('astro-nub'),
          assist: { label: LAB.t('prac.p3_prep_astro_nub'), run: () => p3Prepare('astro-nub') },
        },
        {
          id: 'r-sensor-nub',
          text: LAB.t('prac.p3_r4_text'),
          why: LAB.t('prac.p3_r4_why'),
          status: () => runStatus('sensor-nub'),
          check: () => hasRun('sensor-nub'),
          assist: { label: LAB.t('prac.p3_prep_sensor_nub'), run: () => p3Prepare('sensor-nub') },
        },
        {
          id: 'calc',
          text: LAB.t('prac.p3_calc_text'),
          why: LAB.t('prac.p3_calc_why'),
          check: () => hasRun('astro') && hasRun('astro-nub') && measureDone('p3calc'),
          measure: { id: 'p3calc', ready: () => hasRun('astro') && hasRun('astro-nub'), fields: [
            { k: 'gclear', label: LAB.t('prac.p3_f_gclear'), unit: '%', ref: () => runOf('astro') && runOf('astro').gainPct, tolAbs: 0.3 },
            { k: 'gcloud', label: LAB.t('prac.p3_f_gcloud'), unit: '%', ref: () => runOf('astro-nub') && runOf('astro-nub').gainPct, tolAbs: 0.3 },
          ] },
          question: { id: 'p3q1', text: LAB.t('prac.p3_q1'), ref: () => p3Q1Ref() },
        },
        {
          id: 'decide',
          text: LAB.t('prac.p3_decide_text'),
          why: LAB.t('prac.p3_decide_why'),
          check: () => hasRun('astro') && hasRun('sensor') && hasRun('astro-nub') && hasRun('sensor-nub') && ansDone('p3q2'),
          question: { id: 'p3q2', text: LAB.t('prac.considerando_la_ganancia_neta'), ref: () => p3Q2Ref() },
        },
        {
          id: 'r-1eje', optional: true,
          text: LAB.t('prac.corrida_2_un_solo'),
          why: LAB.t('prac.un_eje_es_mas'),
          status: () => runStatus('astro-1eje'),
          check: () => hasRun('astro-1eje'),
          assist: { label: LAB.t('prac.preparar_corrida_un_eje'), run: () => p3Prepare('astro-1eje') },
        },
      ],
      tick() { p3Tick(); },
      extra(D) {
        if (!D.runs.length && !D.cur) return LAB.t('prac.cuando_una_corrida_llegue');
        const rows = D.runs.map((r) => (r.status === 'complete'
          ? `<tr><td>${esc(r.label)}</td><td>${fmt(r.EA, 0)}</td><td>${fmt(r.EB, 0)}</td><td>${fmt(r.motor, 1)}</td><td><b>${pct(r.gainPct)}</b></td><td>${pct(r.netPct)}</td><td>${r.noSignalMin != null ? fmt(r.noSignalMin, 0) : '—'}</td></tr>`
          : LAB.t('prac.interrumpida', { esc: esc(r.label), esc2: esc(r.cause) }))).join('');
        const cur = D.cur ? LAB.t('prac.en_curso', { esc: esc(D.cur.label) }) : '';
        return LAB.t('prac.corridas_del_dia_simulado', { cur, rows });
      },
      report(D) {
        const L = [LAB.t('prac.corridas_del_dia_simulado_2'), LAB.t('prac.escenario_23_10_2026', { v: Math.round(P3_SCENARIOS.claro.cloud * 100), w: Math.round(P3_SCENARIOS.nublado.cloud * 100), windBase: P3_BASE.windBase, seed: P3_BASE.seed }), '',
          LAB.t('prac.estrategia_estado_e_a'), '|---|---|---|---|---|---|---|---|'];
        D.runs.forEach((r) => L.push(r.status === 'complete' ? LAB.t('prac.rep_run_row', { label: r.label, EA: fmt(r.EA, 0), EB: fmt(r.EB, 0), motor: fmt(r.motor, 1), gain: pct(r.gainPct), net: pct(r.netPct), ns: r.noSignalMin != null ? fmt(r.noSignalMin, 0) : '—' }) : LAB.t('prac.interrumpida_no_disponible_no', { label: r.label, cause: r.cause })));
        return L;
      },
    },
    {
      id: 'p4', n: 4, version: 3, title: LAB.t('prac.calidad_e_incertidumbre_de'), get dur() { return LAB.t('prac.dur_p4'); },
      goal: LAB.t('prac.p4_goal'),
      ilos: [LAB.t('prac.p4_ilo_1'), LAB.t('prac.p4_ilo_2'), LAB.t('prac.p4_ilo_3'), LAB.t('prac.p4_ilo_4'), LAB.t('prac.p4_ilo_5')],
      rubric: [LAB.t('prac.p4_rub_1'), LAB.t('prac.p4_rub_2'), LAB.t('prac.p4_rub_3')],
      setup() { setTime(11, 30); send({ type: 'sim.cloud', value: 0.1 }); send({ type: 'sim.wind', value: 3 }); send({ type: 'sim.speed', speed: 1 }); send({ type: 'tracker.mode', mode: 'astro' }); send({ type: 'load.set', mode: 'mppt' }); document.querySelector('#chartTabs [data-tab=iv]').click(); },
      fresh: () => ({ sweepList: [], windStow: false }),
      steps: [
        mkSessionStep(),
        {
          id: 'pred',
          text: LAB.t('prac.p4_pred_text'),
          why: LAB.t('prac.p4_pred_why'),
          check: () => ansDone('p4pred'),
          question: { id: 'p4pred', kind: 'predict', after: 'repcalc', text: LAB.t('prac.p4_pred_q'), ref: () => p4PredRef() },
        },
        {
          id: 'rep',
          text: LAB.t('prac.p4_rep_text'),
          why: LAB.t('prac.p4_rep_why'),
          status: () => { const r = repSet(); return LAB.t('prac.p4_rep_status', { n: r.length, list: r.map((s) => fmt(s.Pmax, 1)).join(' · ') || '—' }); },
          check: () => repSet().length >= 3,
          assist: { label: LAB.t('prac.iniciar_barrido'), run: guarded(() => send({ type: 'load.sweep' })) },
        },
        {
          id: 'repcalc',
          text: LAB.t('prac.p4_repcalc_text'),
          why: LAB.t('prac.p4_repcalc_why'),
          check: () => repSet().length >= 3 && measureDone('p4rep'),
          measure: { id: 'p4rep', ready: () => repSet().length >= 3, fields: [
            { k: 'mean', label: LAB.t('prac.p4_f_mean'), unit: 'W', ref: () => repStats() && repStats().mean, tolRel: 0.01 },
            { k: 'sd', label: LAB.t('prac.p4_f_sd'), unit: 'W', ref: () => repStats() && repStats().sd, tolRel: 0.1, tolAbs: 0.2 },
            { k: 'cv', label: LAB.t('prac.p4_f_cv'), unit: '%', ref: () => repStats() && repStats().cv, tolRel: 0.1, tolAbs: 0.05 },
          ] },
        },
        {
          id: 'defects',
          text: LAB.t('prac.p4_def_text'),
          why: LAB.t('prac.p4_def_why'),
          check: () => measureDone('p4def'),
          measure: { id: 'p4def', ready: () => true, fields: [
            { k: 'out', label: LAB.t('prac.p4_f_out'), unit: '', ref: () => p4Data().outliers.length, tolAbs: 0 },
            { k: 'gap', label: LAB.t('prac.p4_f_gap'), unit: '', ref: () => p4Data().gaps.length, tolAbs: 0 },
            { k: 'k', label: LAB.t('prac.p4_f_k'), unit: '', ref: () => p4Data().k, tolRel: 0.01 },
          ] },
          question: { id: 'p4q1', text: LAB.t('prac.p4_q1'), ref: () => p4Q1Ref() },
        },
        {
          id: 'uncert',
          text: LAB.t('prac.p4_unc_text'),
          why: LAB.t('prac.p4_unc_why'),
          status: () => (repStats() ? LAB.t('prac.p4_unc_status', { cv: fmt(repStats().cv, 2), ug: UG_REL * 100 }) : ''),
          check: () => repSet().length >= 3 && measureDone('p4unc'),
          measure: { id: 'p4unc', ready: () => repSet().length >= 3, fields: [
            { k: 'u', label: LAB.t('prac.p4_f_u'), unit: '%', ref: () => (repStats() ? Math.sqrt(repStats().cv ** 2 + (UG_REL * 100) ** 2) : null), tolRel: 0.05 },
          ] },
          question: { id: 'p4q2', text: LAB.t('prac.p4_q2'), ref: () => p4Q2Ref() },
        },
        {
          id: 'seg', optional: true,
          text: LAB.t('prac.p4_seg_text'),
          why: LAB.t('prac.p4_seg_why'),
          check: () => E.windStow,
          assist: { label: LAB.t('prac.generar_rafaga_20_m'), run: guarded(() => send({ type: 'sim.gust', peak: 20, seconds: 16 })) },
        },
      ],
      tick() { if (tel.safety.state === 'WIND_STOW') E.windStow = true; },
      onSweep(sw) {
        if (sw.status !== 'complete') { ui.toast(LAB.t('prac.barrido_interrumpido_se_conservaron', { cause: LAB.tm(sw.cause), length: sw.pts.A.length }), 'warn', 7000); return; }
        const pa = sw.pts.A.reduce((m, p) => (p.p > m.p ? p : m), { p: 0, v: 0, i: 0 });
        E.sweepList = (E.sweepList || []).concat([{ id: sw.id, Pmax: pa.p, Vmp: pa.v, Imp: pa.i, G: (sw.cond.start.gA + sw.cond.end.gA) / 2, T: sw.cond.start.tA }]).slice(-12);
      },
      extra() {
        if (!ps.steps.rep) return '';
        const d = p4Data(), cell = (v, f) => (v == null ? '—' : fmt(v, f));
        const rows = d.rows.map((r) => `<tr><td>${r.i + 1}</td><td>${cell(r.g, 1)}</td><td>${cell(r.isc, 2)}</td></tr>`).join('');
        return LAB.t('prac.p4_table', { rows, iscg: ISC_PER_G.toFixed(1) });
      },
      report(D) {
        const L = [LAB.t('prac.p4_rep_head')];
        const s = repOf(D.sweepList || []);
        if (s.length >= 3) { const st = statsOf(s.map((x) => x.Pmax)); L.push(LAB.t('prac.p4_rep_rep', { n: s.length, mean: fmt(st.mean, 1), sd: fmt(st.sd, 2), cv: fmt(st.cv, 2), g: fmt(s[0].G, 0) })); }
        else L.push(LAB.t('prac.p4_rep_rep_no'));
        const d = p4Data();
        L.push(LAB.t('prac.p4_rep_data', { out: d.outliers.map((i) => i + 1).join(', '), gap: d.gaps.map((i) => i + 1).join(', '), k: fmt(d.k, 3), ug: UG_REL * 100 }));
        L.push(LAB.t('prac.p4_rep_stow', { no: D.windStow ? LAB.t('common.yes') : LAB.t('common.no') }));
        return L;
      },
    },
  ];

  // ---------------------------------------------------------------- objetivo / observación esperada / evidencia / pistas (C16)
  // Las pistas son graduales: la primera orienta, la segunda dice dónde mirar. Nunca contienen la respuesta de la pregunta.
  const STEP_META = {
    session: { expect: LAB.t('prac.la_barra_superior_muestra'), evidence: LAB.t('prac.sesion_activa_con_identidad'), hints: [LAB.t('prac.pulsa_el_boton_de'), LAB.t('prac.el_rol_visitante_solo')] },
    cond: { expect: LAB.t('prac.poa_mayor_que_600'), evidence: LAB.t('prac.poa_viento_y_hora'), hints: [LAB.t('prac.los_valores_de_g'), LAB.t('prac.haz_clic_en_la')] },
    cam1: { expect: LAB.t('prac.la_imagen_de_la'), evidence: LAB.t('prac.se_registra_la_entrada'), hints: [LAB.t('prac.el_boton_camara_1'), LAB.t('prac.para_salir_usa_salir')] },
    oc: { expect: LAB.t('prac.corriente_0_a_potencia'), evidence: LAB.t('prac.voc_de_a_y'), hints: [LAB.t('prac.panel_carga_cc_modo'), LAB.t('prac.espera_3_s_para')] },
    sc: { expect: LAB.t('prac.tension_0_v_potencia'), evidence: LAB.t('prac.isc_de_a_y'), hints: [LAB.t('prac.panel_carga_cc_modo_2'), LAB.t('prac.la_corriente_de_cortocircuito')] },
    sweep: { expect: LAB.t('prac.la_grafica_i_v'), evidence: LAB.t('prac.barrido_completo_guardado_con'), hints: [LAB.t('prac.boton_barrido_i_v'), LAB.t('prac.no_cambies_nubes_hora')] },
    mpp: { expect: LAB.t('prac.el_rombo_esta_en'), evidence: LAB.t('prac.se_registra_que_abriste'), hints: [LAB.t('prac.la_pestana_es_i'), LAB.t('prac.busca_el_maximo_de')] },
    sun: { expect: LAB.t('prac.el_azimut_solar_cambia'), evidence: LAB.t('prac.posicion_solar_registrada_al'), hints: [LAB.t('prac.la_barra_superior_muestra_2'), LAB.t('prac.piensa_hacia_donde_deberia')] },
    base: { expect: LAB.t('prac.p_b_p_a'), evidence: LAB.t('prac.razon_de_linea_base'), hints: [LAB.t('prac.pon_b_en_azimut'), LAB.t('prac.deja_el_modo_de')] },
    az: { expect: LAB.t('prac.la_razon_p_b'), evidence: LAB.t('prac.cuatro_o_mas_puntos'), hints: [LAB.t('prac.usa_el_deslizador_de_2'), LAB.t('prac.el_punto_se_registra')] },
    tilt: { expect: LAB.t('prac.hay_una_inclinacion_intermedia'), evidence: LAB.t('prac.cuatro_o_mas_puntos_2'), hints: [LAB.t('prac.manten_el_azimut_en'), LAB.t('prac.prueba_extremos_0_y')] },
    astro: { expect: LAB.t('prac.la_razon_del_punto'), evidence: LAB.t('prac.punto_en_modo_astronomico'), hints: [LAB.t('prac.modo_de_control_astronomico'), LAB.t('prac.espera_a_que_el')] },
    'r-astro': { expect: LAB.t('prac.e_b_mayor_que'), evidence: LAB.t('prac.corrida_completa_de_07'), hints: [LAB.t('prac.pulsa_preparar_corrida_dos'), LAB.t('prac.deja_correr_el_reloj')] },
    'r-1eje': { expect: LAB.t('prac.ganancia_menor_que_con'), evidence: LAB.t('prac.corrida_del_mismo_escenario'), hints: [LAB.t('prac.pulsa_preparar_corrida_un'), LAB.t('prac.las_corridas_con_salto')] },
    'r-sensor': { expect: LAB.t('prac.p3_sensor_expect'), evidence: LAB.t('prac.corrida_del_mismo_escenario_2'), hints: [LAB.t('prac.pulsa_preparar_corrida_sensores'), LAB.t('prac.observa_el_estado_del')] },
    'p1.pred': { expect: LAB.t('prac.p1_pred_expect'), evidence: LAB.t('prac.p1_pred_evid'), hints: [LAB.t('prac.p1_pred_h1'), LAB.t('prac.p1_pred_h2')] },
    'p1.calc': { expect: LAB.t('prac.p1_calc_expect'), evidence: LAB.t('prac.p1_calc_evid'), hints: [LAB.t('prac.p1_calc_h1'), LAB.t('prac.p1_calc_h2')] },
    'p1.nubes': { expect: LAB.t('prac.isc_y_pmax_bajan'), evidence: LAB.t('prac.p1_nubes_evid'), hints: [LAB.t('prac.usa_el_deslizador_de'), LAB.t('prac.p1_nubes_h2')] },
    'p1.interp': { expect: LAB.t('prac.p1_interp_expect'), evidence: LAB.t('prac.p1_interp_evid'), hints: [LAB.t('prac.p1_interp_h1'), LAB.t('prac.p1_interp_h2')] },
    'p2.pred': { expect: LAB.t('prac.p2_pred_expect'), evidence: LAB.t('prac.p2_pred_evid'), hints: [LAB.t('prac.p2_pred_h1'), LAB.t('prac.p2_pred_h2')] },
    'p2.calc': { expect: LAB.t('prac.p2_calc_expect'), evidence: LAB.t('prac.p2_calc_evid'), hints: [LAB.t('prac.p2_calc_h1'), LAB.t('prac.p2_calc_h2')] },
    'p3.pred': { expect: LAB.t('prac.p3_pred_expect'), evidence: LAB.t('prac.p3_pred_evid'), hints: [LAB.t('prac.p3_pred_h1'), LAB.t('prac.p3_pred_h2')] },
    'r-astro-nub': { expect: LAB.t('prac.p3_r3_expect'), evidence: LAB.t('prac.p3_r3_evid'), hints: [LAB.t('prac.p3_r3_h1'), LAB.t('prac.las_corridas_con_salto')] },
    'r-sensor-nub': { expect: LAB.t('prac.p3_r4_expect'), evidence: LAB.t('prac.p3_r4_evid'), hints: [LAB.t('prac.p3_r4_h1'), LAB.t('prac.observa_el_estado_del')] },
    'p3.calc': { expect: LAB.t('prac.p3_calc_expect'), evidence: LAB.t('prac.p3_calc_evid'), hints: [LAB.t('prac.p3_calc_h1'), LAB.t('prac.p3_calc_h2')] },
    decide: { expect: LAB.t('prac.p3_decide_expect'), evidence: LAB.t('prac.respuesta_registrada_2'), hints: [LAB.t('prac.p3_decide_h1'), LAB.t('prac.p3_decide_h2')] },
    'p4.pred': { expect: LAB.t('prac.p4_pred_expect'), evidence: LAB.t('prac.p4_pred_evid'), hints: [LAB.t('prac.p4_pred_h1'), LAB.t('prac.p4_pred_h2')] },
    rep: { expect: LAB.t('prac.p4_rep_expect'), evidence: LAB.t('prac.p4_rep_evid'), hints: [LAB.t('prac.no_cambies_nubes_hora'), LAB.t('prac.p4_rep_h2')] },
    repcalc: { expect: LAB.t('prac.p4_repcalc_expect'), evidence: LAB.t('prac.p4_repcalc_evid'), hints: [LAB.t('prac.p4_repcalc_h1'), LAB.t('prac.p4_repcalc_h2')] },
    defects: { expect: LAB.t('prac.p4_def_expect'), evidence: LAB.t('prac.p4_def_evid'), hints: [LAB.t('prac.p4_def_h1'), LAB.t('prac.p4_def_h2')] },
    uncert: { expect: LAB.t('prac.p4_unc_expect'), evidence: LAB.t('prac.p4_unc_evid'), hints: [LAB.t('prac.p4_unc_h1'), LAB.t('prac.p4_unc_h2')] },
    seg: { expect: LAB.t('prac.con_viento_14_m'), evidence: LAB.t('prac.posicion_segura_por_viento_2'), hints: [LAB.t('prac.boton_rafaga_del_panel'), LAB.t('prac.observa_el_estado_de')] },
  };
  fresh.forEach((pr) => pr.steps.forEach((st) => Object.assign(st, STEP_META[pr.id + '.' + st.id] || STEP_META[st.id] || {})));
  // se rellena EN SITIO: LAB.ui.practices.list conserva su referencia al cambiar de idioma
  const curId = current && current.id;
  PRACTICES.length = 0; PRACTICES.push(...fresh);
  if (curId) current = PRACTICES.find((p) => p.id === curId) || current;
  }
  buildPractices();

  // ---------------------------------------------------------------- ayudas de las practicas
  const HOLD_S = 10;               // ventana de medicion de la practica 2: media y desviacion de P_B/P_A
  const MAX_TRIES = 3;             // intentos de comprobar un calculo antes de poder continuar
  const UG_REL = 0.05;             // incertidumbre relativa del piranometro que se SUPONE en la practica 4 (ilustrativa; la del banco es O1, pendiente)
  const ISC_PER_G = 13.0;          // mA por W/m2 del modulo simulado (se comprueba contra el motor en tools/test_guide_claims.js)
  const ansDone = (id) => !!(ps && ps.answers[id] && ps.answers[id].submitted);
  const measureDone = (id) => { const m = ps && ps.measures && ps.measures[id]; return !!m && (m.ok || m.attempts >= MAX_TRIES); };
  const meanSd = (a) => { const n = a.length, mean = n ? a.reduce((s, x) => s + x, 0) / n : 0; return { n, mean, sd: n > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0 }; };
  const statsOf = (a) => { const s = meanSd(a); return { ...s, cv: s.mean ? s.sd / s.mean * 100 : 0 }; };
  const ffOf = (s) => s.Pmax / (s.Voc * s.Isc);
  const etaOf = (s) => s.Pmax / (s.G * LAB.config.module.area) * 100;
  const iscPerG = (s) => s.Isc / s.G * 1000;
  const azPoints = () => Object.values(E.points).filter((p) => near(p.tilt, 17, 3));
  const tiltPoints = () => Object.values(E.points).filter((p) => near(p.az, 180, 3));
  const spread = (a) => Math.max(...a) - Math.min(...a);
  const bestPoint = (D) => Object.values(D.points).sort((a, b) => b.ratio - a.ratio)[0];
  const worstPoint = (D) => Object.values(D.points).sort((a, b) => a.ratio - b.ratio)[0];
  const runOf = (kind) => E.runs.find((r) => r.kind === kind && r.status === 'complete');
  const hasRun = (kind) => !!runOf(kind);
  /** Cambio (%) de P_B/P_A de un punto respecto a la linea base (misma orientacion que A) */
  const p2Delta = (which) => { const b = E.points['180|17']; if (!b) return null; const p = which === 'max' ? bestPoint(E) : worstPoint(E); return (p.ratio / b.ratio - 1) * 100; };
  /** cos(angulo de incidencia) de un plano (az, tilt) para un Sol (az, elevacion), en grados */
  const cosAoi = (sunAz, sunEl, az, tilt) => { const r = Math.PI / 180; return Math.sin(sunEl * r) * Math.cos(tilt * r) + Math.cos(sunEl * r) * Math.sin(tilt * r) * Math.cos((sunAz - az) * r); };
  const pt = (p) => `${p.az}°/${p.tilt}°`;

  // barridos repetidos de la practica 4: los validos son los que tienen la misma irradiancia (±3 %) que el primero
  const repOf = (list) => (list.length ? list.filter((s) => Math.abs(s.G / list[0].G - 1) <= 0.03) : []);
  const repSet = () => repOf(E.sweepList || []);
  const repStats = () => { const r = repSet(); return r.length >= 2 ? statsOf(r.map((s) => s.Pmax)) : null; };
  /** Serie didactica con fallas inyectadas a proposito (NO es una corrida del banco ni del simulador): 16 lecturas de G (piranometro) e Isc */
  function p4Data() {
    const jit = [0.002, -0.001, 0.0015, -0.002, 0.001, 0, -0.0015, 0.002, 0.001, -0.001, 0.0005, -0.002, 0.0015, 0.001, -0.0005, 0.002];
    const OUT = [4, 11], GAP = [7, 8, 9], CAL = 0.94;             // atipicos (sombra puntual), huecos del registrador, piranometro que lee 6 % bajo
    const rows = jit.map((j, i) => {
      const gTrue = 300 + 40 * i;
      if (GAP.includes(i)) return { i, g: null, isc: null };
      const isc = ISC_PER_G * gTrue / 1000 * (1 + j) * (OUT.includes(i) ? 0.62 : 1);
      return { i, g: Math.round(gTrue * CAL * 10) / 10, isc: Math.round(isc * 100) / 100 };
    });
    const good = rows.filter((r) => r.g != null && !OUT.includes(r.i));
    const k = good.reduce((s, r) => s + 1000 * r.isc / r.g, 0) / good.length / ISC_PER_G;
    return { rows, outliers: OUT, gaps: GAP, k, cal: CAL };
  }

  // ---------------------------------------------------------------- respuestas de referencia (solo se muestran DESPUES de contestar)
  const delta = (x, y) => (y / x - 1) * 100;
  function p1PredRef() {
    const a = E.sweep, b = E.sweep2; if (!a || !b) return LAB.t('prac.aun_no_hay_un');
    return LAB.t('prac.p1_pred_ref', { g1: fmt(a.G, 0), g2: fmt(b.G, 0), i1: fmt(a.Isc, 2), i2: fmt(b.Isc, 2), di: pct(delta(a.Isc, b.Isc)), v1: fmt(a.Voc, 2), v2: fmt(b.Voc, 2), dv: pct(delta(a.Voc, b.Voc)), p1: fmt(a.Pmax, 0), p2: fmt(b.Pmax, 0), dp: pct(delta(a.Pmax, b.Pmax)) });
  }
  function p1InterpRef() {
    const a = E.sweep, b = E.sweep2; if (!a || !b) return LAB.t('prac.aun_no_hay_un');
    return LAB.t('prac.p1_q2_ref', { k1: fmt(iscPerG(a), 2), k2: fmt(iscPerG(b), 2), dv: pct(delta(a.Voc, b.Voc)), e1: fmt(etaOf(a), 1), e2: fmt(etaOf(b), 1), dg: pct(delta(a.G, b.G)), dp: pct(delta(a.Pmax, b.Pmax)) });
  }
  function p2PredRef() {
    const b = E.points['180|17']; if (!b) return LAB.t('prac.aun_no_hay_un');
    const hi = bestPoint(E), lo = worstPoint(E);
    return LAB.t('prac.p2_pred_ref', { hi: pt(hi), dhi: pct(p2Delta('max')), lo: pt(lo), dlo: pct(p2Delta('min')) });
  }
  function p2Ref() {
    const b = E.points['180|17'], best = bestPoint(E); if (!b || !best) return LAB.t('prac.aun_no_hay_un');
    const f = LAB.config.fixed, sun = best.sunAz != null ? { az: best.sunAz, el: best.sunEl } : { az: tel.sun.az, el: tel.sun.el };
    const rc = cosAoi(sun.az, sun.el, best.az, best.tilt) / cosAoi(sun.az, sun.el, f.az, f.tilt);
    return LAB.t('prac.p2_q1_ref', { best: pt(best), saz: fmt(sun.az, 0), sel: fmt(sun.el, 0), rc: fmt(rc, 3), rp: fmt(best.ratio / b.ratio, 3) });
  }
  function p3PredRef() {
    const a = runOf('astro'), c = runOf('astro-nub'); if (!a || !c) return LAB.t('prac.aun_no_hay_corridas');
    return LAB.t('prac.p3_pred_ref', { ga: pct(a.gainPct), ca: Math.round(a.cloud * 100), gc: pct(c.gainPct), cc: Math.round(c.cloud * 100) });
  }
  function p3Q1Ref() {
    const a = runOf('astro'), c = runOf('astro-nub'); if (!a || !c) return LAB.t('prac.aun_no_hay_corridas');
    return LAB.t('prac.p3_q1_ref', { ga: pct(a.gainPct), gc: pct(c.gainPct), ea: fmt(a.EA, 0), ec: fmt(c.EA, 0) });
  }
  function p3Q2Ref() {
    const done = E.runs.filter((x) => x.status === 'complete'); if (!done.length) return LAB.t('prac.aun_no_hay_corridas');
    const L = done.map((x) => LAB.t('prac.ganancia_de_energia_neta', { label: x.label, pct: pct(x.gainPct), pct3: pct(x.netPct) })).join(' · ');
    const s = runOf('sensor-nub'), a = runOf('astro-nub');
    return L + LAB.t('prac.el_consumo_de_motores') + (s && a ? LAB.t('prac.p3_q2_sensor', { es: fmt(s.EB, 0), ea: fmt(a.EB, 0), ns: fmt(s.noSignalMin, 0) }) : '');
  }
  function p4PredRef() {
    const s = repStats(); if (!s) return LAB.t('prac.aun_no_hay_un');
    return LAB.t('prac.p4_pred_ref', { n: s.n, mean: fmt(s.mean, 1), sd: fmt(s.sd, 2), cv: fmt(s.cv, 2), ug: UG_REL * 100 });
  }
  function p4Q1Ref() {
    const d = p4Data();
    return LAB.t('prac.p4_q1_ref', { out: d.outliers.map((i) => i + 1).join(' y '), gap: d.gaps.map((i) => i + 1).join(', '), k: fmt(d.k, 3), pc: fmt((1 - 1 / d.k) * 100, 0) });
  }
  function p4Q2Ref() {
    const s = repStats(); if (!s) return LAB.t('prac.aun_no_hay_un');
    const u = Math.sqrt(s.cv ** 2 + (UG_REL * 100) ** 2);
    const p3 = progress && progress.practices && progress.practices.p3, run = p3 && p3.evidence && (p3.evidence.runs || []).find((r) => r.kind === 'astro-nub' && r.status === 'complete');
    return LAB.t('prac.p4_q2_ref', { u: fmt(u, 1), cv: fmt(s.cv, 2), ug: UG_REL * 100 }) + (run ? LAB.t('prac.p4_q2_p3', { g: pct(run.gainPct), cv: fmt(s.cv, 2) }) : '');
  }

  function holdStatus(extra) {
    const T = tel.tracker;
    let s;
    if (T.moving.az || T.moving.tilt) s = LAB.t('prac.esperando_estabilizacion_el_seguidor');
    else if (tel.load.mode !== 'mppt') s = LAB.t('prac.pon_la_carga_en_2');
    else if (tel.A.p < 40) s = LAB.t('prac.potencia_demasiado_baja_para');
    else if (E.hold < 0) s = LAB.t('prac.punto_registrado_mueve_el');
    else s = LAB.t('prac.esperando_estabilizacion_5_s', { v: fmt(Math.max(0, E.hold), 0), s: HOLD_S });
    return extra ? `${extra} · ${s}` : s;
  }
  function runStatus(kind) {
    if (hasRun(kind)) return LAB.t('prac.corrida_completa_registrada');
    const c = E.cur;
    if (c && c.kind === kind) return LAB.t('prac.en_curso_h_de', { v: fmt(lt().hours, 1) });
    if (E.pending && E.pending.kind === kind) return LAB.t('prac.escenario_aplicado_esperando_el');
    const bad = E.runs.filter((r) => r.kind === kind && r.status === 'interrupted').pop();
    return bad ? LAB.t('prac.ultima_corrida_interrumpida', { cause: bad.cause }) : LAB.t('prac.sin_corrida');
  }

  // ---------------------------------------------------------------- estado y persistencia
  const defOf = (id) => PRACTICES.find((p) => p.id === id);
  function freshPS(p) {
    const now = new Date().toISOString();
    return { practiceId: p.id, defVersion: p.version, status: 'in_progress', source: 'sim', createdAtUtc: now, updatedAtUtc: now, sessionId: profile.sessionId, steps: {}, answers: {}, measures: {}, self: {}, evidence: p.fresh(), closure: null, setupDone: false, runIds: [] };
  }
  function commit(now) {
    clearTimeout(saveTimer);
    const run = () => { if (!progress || !profile.id) return; if (ps) ps.updatedAtUtc = new Date().toISOString(); progress.activePractice = current && ps && ps.status === 'in_progress' ? current.id : progress.activePractice; store.saveProgress(profile.id, progress); renderSaveState(); };
    if (now) run(); else saveTimer = setTimeout(run, 400);
  }
  function renderSaveState() {
    const el = document.getElementById('saveState'); if (!el) return;
    const s = store.status;
    if (!profile.id) { el.textContent = ''; return; }
    if (s.error) { el.className = 'savestate bad'; el.textContent = '⚠ ' + s.error; }
    else if (s.lastSavedAt) { el.className = 'savestate'; el.textContent = LAB.t('prac.guardado_en_este_navegador') + new Date(s.lastSavedAt).toLocaleTimeString(LAB.locale()); }
    else { el.className = 'savestate'; el.textContent = LAB.t('prac.se_guarda_automaticamente_en'); }
  }

  /** Completada con una version anterior de la definicion: sus pasos ya no existen, asi que no se reabre; se conserva su cierre congelado */
  const isOldDone = (p, st) => !!st && st.status === 'completed' && (st.completionVersion || st.defVersion || 1) < p.version;
  function summaryOf(p, st) {
    if (!st) return { text: LAB.t('prac.sin_iniciar'), cls: '' };
    if (isOldDone(p, st)) return { text: LAB.t('prac.completada_version_anterior'), cls: 'done' };
    if (st.status === 'completed_legacy') return { text: LAB.t('prac.completada_con_el_criterio'), cls: 'done' };
    const m = metrics(p, st);
    if (st.status === 'completed') return { text: LAB.t('prac.completada_pasos_respuestas', { stepsDone: m.stepsDone, stepsReq: m.stepsReq, ansDone: m.ansDone, ansReq: m.ansReq }), cls: 'done' };
    return { text: LAB.t('prac.en_curso_pasos_respuestas', { stepsDone: m.stepsDone, stepsReq: m.stepsReq, ansDone: m.ansDone, ansReq: m.ansReq }), cls: 'cur' };
  }
  function metrics(p, st) {
    const req = p.steps.filter((s) => !s.optional), qs = p.steps.filter((s) => s.question);
    return {
      stepsReq: req.length, stepsDone: req.filter((s) => st.steps && st.steps[s.id]).length,
      ansReq: qs.length, ansDone: qs.filter((s) => st.answers && st.answers[s.question.id] && st.answers[s.question.id].submitted).length,
      optReq: p.steps.length - req.length, optDone: p.steps.filter((s) => s.optional && st.steps && st.steps[s.id]).length,
    };
  }

  // ---------------------------------------------------------------- guia (se construye una vez, se actualiza en sitio)
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (v === true) n.setAttribute(k, ''); else if (v !== false && v != null) n.setAttribute(k, v); }
    kids.flat().forEach((c) => c && n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  };

  function buildGuide() {
    const g = $('#practiceGuide'), p = current;
    g.textContent = '';
    g.setAttribute('role', 'region'); g.setAttribute('aria-label', LAB.t('prac.guia_de_la_practica', { n: p.n }));
    const refs = { steps: [] };
    refs.hide = el('button', { class: 'x', type: 'button', 'aria-label': LAB.t('prac.ocultar_la_guia_la'), title: LAB.t('prac.ocultar_la_guia_la_2'), text: '×' });
    refs.min = el('button', { class: 'mn', type: 'button', 'aria-label': LAB.t('prac.minimizar_o_expandir_la'), 'aria-expanded': 'true', title: LAB.t('prac.minimizar_expandir') });
    refs.title = el('h3', { text: LAB.t('prac.practica', { n: p.n, title: p.title }) });
    refs.sub = el('div', { class: 'sub', text: p.dur });
    refs.summary = el('div', { class: 'pgsum', 'aria-live': 'off' });
    refs.overview = el('button', { class: 'btn', type: 'button', id: 'btnOverview', text: LAB.t('prac.ver_todos_los_pasos') });
    refs.overview.addEventListener('click', () => openOverview());
    refs.bar = el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': LAB.t('prac.progreso_de_la_practica') }, el('i'));
    const ilos = el('details', {}, el('summary', { text: LAB.t('prac.resultados_de_aprendizaje') }), el('ul', { class: 'ilos' }, p.ilos.map((x) => el('li', { text: x }))));
    const rubric = el('details', { class: 'rubric' }, el('summary', { text: LAB.t('prac.rubrica_que_se_evalua') }), el('p', { class: 'hint', text: LAB.t('prac.rubrica_nota') }), el('ul', { class: 'ilos' }, p.rubric.map((x) => el('li', { text: x }))));
    const ol = el('ol', { class: 'steps' });
    p.steps.forEach((s, i) => {
      const r = {};
      r.li = el('li');
      r.c = el('span', { class: 'c', 'aria-hidden': 'true' });
      r.t = el('div', { class: 't' }); r.t.textContent = s.text;
      if (s.optional) r.t.appendChild(el('em', { class: 'opt', text: LAB.t('prac.optional_paren') }));
      r.state = el('span', { class: 'sr' });
      r.d = el('div', { class: 'd', text: s.why || '' });
      r.st = el('div', { class: 'pgstatus', 'aria-live': 'off' });
      r.warn = el('div', { class: 'pwarn', role: 'status' });
      r.chips = el('div', { class: 'partchips' });
      r.btns = el('div', { class: 'stepbtns' });
      r.hintBtn = el('button', { class: 'btn', type: 'button', text: LAB.t('prac.necesito_una_pista') }); r.hintTxt = el('p', { class: 'hint pghint', 'aria-live': 'polite', hidden: true });
      r.hintBtn.addEventListener('click', () => { const h = s.hints || [], k = (ps.hints && ps.hints[s.id]) || 0; if (!h.length) return; ps.hints = ps.hints || {}; ps.hints[s.id] = Math.min(h.length, k + 1); commit(); updateGuide(); });
      r.btns.appendChild(r.hintBtn);
      const body = el('div', { class: 'body' }, r.t, r.state, r.d, r.st, r.warn, r.chips, r.btns, r.hintTxt);
      if (s.parts) { r.partChipEls = s.parts.map((id) => el('span', { text: (LAB.scene.PART_INFO[id] || {}).title || id })); r.partChipEls.forEach((c) => r.chips.appendChild(c)); r.partsBtn = el('button', { class: 'btn', type: 'button' }); r.btns.appendChild(r.partsBtn); r.partsBtn.addEventListener('click', () => openNextPart(s)); }
      if (s.assist) { r.assist = el('button', { class: 'btn', type: 'button', text: s.assist.label }); r.btns.appendChild(r.assist); r.assist.addEventListener('click', () => { if (s.id !== 'session' && !canOperate()) ui.toast(LAB.t('prac.primero_inicia_una_sesion'), 'warn'); s.assist.run(); }); }
      if (s.manual) { r.manual = el('button', { class: 'btn', type: 'button', text: s.manual }); r.btns.appendChild(r.manual); r.manual.addEventListener('click', () => { E.ack1 = true; evaluate(true); }); }
      if (s.measure) buildMeasure(s.measure, r, body);
      if (s.question) buildQuestion(s.question, r, body);
      r.li.append(r.c, body);
      ol.appendChild(r.li); refs.steps.push(r);
    });
    refs.extra = el('div', { class: 'pgextra' });
    refs.closure = el('div', { class: 'q closure', hidden: true });
    refs.foot = el('div', { class: 'pgfoot' });
    refs.save = el('span', { id: 'saveState', class: 'savestate', role: 'status' });
    refs.restart = el('button', { class: 'btn', type: 'button', text: LAB.t('prac.reiniciar_practica') });
    refs.draft = el('button', { class: 'btn', type: 'button', text: LAB.t('prac.descargar_borrador_md') });
    refs.draftHtml = el('button', { class: 'btn', type: 'button', id: 'btnDraftHtml', text: LAB.t('prac.ver_borrador_imprimible') });
    refs.draftHtml.addEventListener('click', () => openReport());
    refs.foot.append(refs.save, el('div', { class: 'row3' }, refs.draftHtml, refs.draft, refs.restart));
    refs.live = el('div', { class: 'sr', 'aria-live': 'polite', id: 'pgLive' });
    g.append(refs.hide, refs.min, refs.title, refs.sub, ilos, rubric, refs.summary, refs.overview, refs.bar, ol, refs.extra, refs.closure, refs.foot, refs.live);
    refs.hide.addEventListener('click', () => hideGuide());
    refs.min.addEventListener('click', () => { guideMin = !guideMin; applyMin(); });
    refs.restart.addEventListener('click', () => restart(p.id));
    refs.draft.addEventListener('click', () => download());
    built = refs; applyMin();
  }
  function applyMin() { const g = $('#practiceGuide'); g.classList.toggle('min', guideMin); if (built) { built.min.textContent = guideMin ? '+' : '–'; built.min.setAttribute('aria-expanded', String(!guideMin)); } }

  function buildQuestion(q, r, body) {
    const id = 'ta_' + q.id;
    r.q = {};
    r.q.box = el('div', { class: 'q' });
    const predict = q.kind === 'predict';
    r.q.label = el('label', { for: id }, el('b', { text: LAB.t(predict ? 'prac.prediccion_obligatoria' : 'prac.pregunta_obligatoria') }), document.createTextNode(q.text));
    r.q.ta = el('textarea', { id, rows: '3', placeholder: LAB.t('prac.escribe_tu_respuesta_minimo') + MIN_ANSWER + LAB.t('prac.caracteres_y_pulsa_guardar'), 'aria-describedby': id + '_h', autocomplete: 'off', spellcheck: 'true' });
    r.q.hint = el('div', { class: 'qhint', id: id + '_h', 'aria-live': 'polite' });
    r.q.submit = el('button', { class: 'btn accent', type: 'button', text: LAB.t(predict ? 'prac.guardar_prediccion' : 'prac.guardar_respuesta_y_continuar') });
    r.q.edit = el('button', { class: 'btn', type: 'button', text: LAB.t('prac.editar_respuesta'), hidden: true });
    r.q.ref = el('button', { class: 'btn', type: 'button', 'aria-expanded': 'false', hidden: true, text: LAB.t(predict ? 'prac.ver_resultado_y_comparar' : 'prac.ver_respuesta_de_referencia') });
    r.q.refTxt = el('p', { class: 'hint', hidden: true });
    r.q.box.append(r.q.label, r.q.ta, r.q.hint, el('div', { class: 'report' }, r.q.submit, r.q.edit, r.q.ref), r.q.refTxt);
    body.appendChild(r.q.box);
    r.q.ta.addEventListener('input', () => {                         // solo borrador: no completa nada ni reconstruye el formulario
      const a = answerOf(q.id); a.draft = r.q.ta.value; a.dirty = !!a.submitted && a.draft.trim() !== a.submitted;
      updateQuestion(q, r.q); commit();
    });
    r.q.submit.addEventListener('click', () => {
      const a = answerOf(q.id), t = r.q.ta.value.trim();
      if (t.length < MIN_ANSWER) { r.q.hint.textContent = LAB.t('prac.la_respuesta_no_puede', { MIN_ANSWER }); r.q.ta.setAttribute('aria-invalid', 'true'); r.q.ta.focus(); return; }
      a.draft = r.q.ta.value; a.submitted = t; a.submittedAtUtc = new Date().toISOString(); a.dirty = false;
      r.q.ta.removeAttribute('aria-invalid'); r.q.ta.readOnly = true;
      ui.announce(LAB.t(predict ? 'prac.prediccion_guardada' : 'prac.respuesta_guardada')); commit(true); evaluate(true);
      (predict ? r.q.ta : r.q.edit).focus();
    });
    r.q.edit.addEventListener('click', () => { if (ps.status === 'completed') { ui.toast(LAB.t('prac.la_practica_esta_cerrada'), 'info'); return; } r.q.ta.readOnly = false; r.q.ta.focus(); });
    r.q.ref.addEventListener('click', () => {
      const open = r.q.refTxt.hidden; r.q.refTxt.hidden = !open; r.q.ref.setAttribute('aria-expanded', String(open));
      r.q.ref.textContent = predict ? LAB.t(open ? 'prac.ocultar_resultado' : 'prac.ver_resultado_y_comparar') : (open ? LAB.t('prac.ocultar') : LAB.t('prac.ver')) + LAB.t('prac.respuesta_de_referencia');
      if (open) { const a = answerOf(q.id); if (a.ref == null) { a.ref = q.ref(); commit(); } r.q.refTxt.textContent = a.ref; }   // se congela la primera vez que se abre
    });
  }
  // ---------------------------------------------------------------- calculos del alumno: se comparan con SU propia corrida (sin calificacion)
  const parseNum = (t) => { const x = parseFloat(String(t).replace(',', '.').trim()); return Number.isFinite(x) && /^[-+]?[\d.,]+(e[-+]?\d+)?$/i.test(String(t).trim()) ? x : null; };
  const within = (f, x, ref) => Math.abs(x - ref) <= Math.max(f.tolAbs || 0, (f.tolRel || 0) * Math.abs(ref)) + 1e-9;
  function buildMeasure(ms, r, body) {
    r.m = { rows: [] };
    r.m.box = el('div', { class: 'q measure' }, el('b', { text: LAB.t('prac.calcula_tu_comprueba') }));
    ms.fields.forEach((f) => {
      const id = `m_${ms.id}_${f.k}`;
      const row = { f, input: el('input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-describedby': id + '_r' }), res: el('div', { class: 'qhint', id: id + '_r', 'aria-live': 'polite' }) };
      row.input.addEventListener('input', () => { const m = measureRec(ms.id); m.draft = m.draft || {}; m.draft[f.k] = row.input.value; commit(); });
      r.m.box.append(el('label', { for: id, text: f.label + (f.unit ? ` (${f.unit})` : '') }), row.input, row.res);
      r.m.rows.push(row);
    });
    r.m.btn = el('button', { class: 'btn accent', type: 'button', text: LAB.t('prac.comprobar_mis_calculos') });
    r.m.btn.addEventListener('click', () => checkMeasure(ms, r));
    r.m.sum = el('div', { class: 'qhint', 'aria-live': 'polite' });
    r.m.box.append(el('div', { class: 'report' }, r.m.btn), r.m.sum);
    body.appendChild(r.m.box);
  }
  const measureRec = (id) => { ps.measures = ps.measures || {}; return (ps.measures[id] = ps.measures[id] || { vals: {}, refs: {}, ok: false, attempts: 0 }); };
  function checkMeasure(ms, r) {
    if (ps.status === 'completed' || measureDone(ms.id)) return;
    const vals = {}, refs = {}, okf = {};
    for (const row of r.m.rows) {
      const x = parseNum(row.input.value), ref = row.f.ref();
      if (x == null) { r.m.err = LAB.t('prac.escribe_un_numero_en'); r.m.sum.textContent = r.m.err; row.input.focus(); return; }
      if (ref == null || !Number.isFinite(ref)) { r.m.err = LAB.t('prac.aun_no_hay_datos'); r.m.sum.textContent = r.m.err; return; }
      vals[row.f.k] = x; refs[row.f.k] = ref; okf[row.f.k] = within(row.f, x, ref);
    }
    r.m.err = '';
    const m = measureRec(ms.id);
    m.vals = vals; m.refs = refs; m.fieldOk = okf; m.attempts += 1; m.ok = Object.values(okf).every(Boolean); m.checkedAtUtc = new Date().toISOString();
    ui.announce(LAB.t(m.ok ? 'prac.calculos_coinciden' : 'prac.calculos_no_coinciden'));
    commit(true); evaluate(true);
  }
  function updateMeasure(s, r, isCur, isDone) {
    const ms = s.measure, m = (ps.measures || {})[ms.id], done = measureDone(ms.id), closed = ps.status === 'completed';
    r.m.box.hidden = !(isCur || isDone || m);
    r.m.rows.forEach((row) => {
      const draft = (m && m.draft && m.draft[row.f.k]) || '';
      if (document.activeElement !== row.input && row.input.value !== draft) row.input.value = draft;
      row.input.readOnly = done || closed;
      let t = '';
      if (m && m.fieldOk && m.fieldOk[row.f.k] != null) {
        if (m.fieldOk[row.f.k]) t = LAB.t('prac.coincide_con_tu_corrida');
        else if (m.attempts >= MAX_TRIES) t = LAB.t('prac.no_coincide_corrida', { ref: fmt(m.refs[row.f.k], Math.abs(m.refs[row.f.k]) < 10 ? 3 : 1), val: fmt(m.vals[row.f.k], Math.abs(m.vals[row.f.k]) < 10 ? 3 : 1) });
        else t = LAB.t('prac.no_coincide_revisa', { n: m.attempts, max: MAX_TRIES });
      }
      if (row.res.textContent !== t) row.res.textContent = t;
    });
    r.m.btn.hidden = done || closed;
    r.m.btn.disabled = !(ms.ready ? ms.ready() : true);
    const sum = done ? LAB.t(m.ok ? 'prac.todos_coinciden' : 'prac.puedes_continuar_revisa') : (r.m.btn.disabled ? LAB.t('prac.aun_no_hay_datos') : (r.m.err || ''));
    if (r.m.sum.textContent !== sum) r.m.sum.textContent = sum;
  }

  const answerOf = (qid) => (ps.answers[qid] = ps.answers[qid] || { draft: '', submitted: null, submittedAtUtc: null });
  /** La referencia solo existe cuando la respuesta esta guardada y el paso del que depende ya se hizo (nunca antes de contestar) */
  const refAvailable = (q, stepId) => { const a = ps.answers[q.id]; return !!(a && a.submitted) && !!ps.steps[q.after || stepId]; };
  function updateQuestion(q, rq, stepId) {
    const a = ps.answers[q.id] || { draft: '', submitted: null };
    const avail = refAvailable(q, stepId);
    rq.ref.hidden = !avail;
    if (!avail) { rq.refTxt.hidden = true; rq.ref.setAttribute('aria-expanded', 'false'); }
    if (document.activeElement !== rq.ta && rq.ta.value !== a.draft) rq.ta.value = a.draft || '';
    const n = rq.ta.value.trim().length;
    const saved = !!a.submitted && !a.dirty;
    rq.ta.readOnly = saved || ps.status === 'completed';
    rq.submit.hidden = saved; rq.edit.hidden = !saved || ps.status === 'completed' || q.kind === 'predict';   // una prediccion no se edita despues de verla
    rq.submit.disabled = ps.status === 'completed';
    if (!rq.ta.getAttribute('aria-invalid') || n >= MIN_ANSWER) {
      rq.hint.textContent = saved ? LAB.t(q.kind === 'predict' ? 'prac.prediccion_registrada' : 'prac.respuesta_registrada') : (a.submitted && a.dirty ? LAB.t('prac.tienes_cambios_sin_guardar') : (n ? LAB.t('prac.borrador_caracteres_aun_no', { n }) : LAB.t('prac.respuesta_pendiente')));
      if (n >= MIN_ANSWER) rq.ta.removeAttribute('aria-invalid');
    }
  }

  function openNextPart(s) {
    const next = s.parts.find((id) => !has(E.parts, id)); if (!next) return;
    const view = PART_VIEW[next]; if (view) { app.rig.set(view); ui.markViews(view); }
    app.handlePart(next);
  }

  function updateGuide() {
    if (!built || !current) return;
    const p = current, m = metrics(p, ps);
    const firstOpen = p.steps.findIndex((s) => !s.optional && !ps.steps[s.id]);
    const total = m.stepsReq + m.ansReq, done = m.stepsDone + m.ansDone;
    built.bar.firstChild.style.width = (total ? done / total * 100 : 0) + '%';
    built.bar.setAttribute('aria-valuenow', String(Math.round(total ? done / total * 100 : 0)));
    const pendingAns = m.ansReq - m.ansDone;
    built.summary.textContent = ps.status === 'completed' ? LAB.t('prac.practica_cerrada_resultados_congelados') : LAB.t('prac.requisitos_operativos_respuestas', { t: firstOpen >= 0 ? LAB.t('prac.paso_actual_de', { v: firstOpen + 1, length: p.steps.length }) : LAB.t('prac.pasos_operativos_completos'), stepsDone: m.stepsDone, stepsReq: m.stepsReq, ansDone: m.ansDone, ansReq: m.ansReq, s: pendingAns ? LAB.t(pendingAns > 1 ? 'prac.pending_n_pl' : 'prac.pending_n', { n: pendingAns }) : '', opcional: m.optReq ? LAB.t('prac.opt_progress', { done: m.optDone, req: m.optReq }) : '' });
    p.steps.forEach((s, i) => {
      const r = built.steps[i], isDone = !!ps.steps[s.id], isCur = i === firstOpen && ps.status === 'in_progress';
      r.li.className = isDone ? 'ok' : isCur ? 'cur' : '';
      const mark = isDone ? '✓' : String(i + 1);
      if (r.c.textContent !== mark) r.c.textContent = mark;
      r.state.textContent = isDone ? LAB.t('prac.sr_done') : isCur ? LAB.t('prac.paso_actual') : '';
      r.d.hidden = !(isCur || isDone);
      const st = (isCur || isDone) && s.status ? s.status() : '';
      if (r.st.textContent !== st) r.st.textContent = st;
      const w = isCur && s.warn ? s.warn() : '';
      if (r.warn.textContent !== (w ? '⚠ ' + w : '')) r.warn.textContent = w ? '⚠ ' + w : '';
      r.warn.hidden = !w;
      if (r.partChipEls) {
        r.chips.hidden = !isCur;
        s.parts.forEach((id, k) => { const on = has(E.parts, id), c = r.partChipEls[k], txt = `${on ? '✓' : '○'} ${(LAB.scene.PART_INFO[id] || {}).title || id}`; if (c.textContent !== txt) { c.textContent = txt; c.className = on ? 'ok' : ''; } });
        const miss = s.parts.find((id) => !has(E.parts, id));
        r.partsBtn.hidden = !isCur || !miss; if (miss) r.partsBtn.textContent = LAB.t('prac.abrir') + ((LAB.scene.PART_INFO[miss] || {}).title || miss);
      }
      { const h = s.hints || [], k = (ps.hints && ps.hints[s.id]) || 0; r.hintTxt.hidden = !(isCur && k > 0); r.hintTxt.textContent = k ? LAB.t('prac.pista') + k + LAB.t('prac.of') + h.length + ': ' + h[k - 1] : '';
        r.hintBtn.hidden = !isCur || !h.length || k >= h.length; r.hintBtn.textContent = k ? LAB.t('prac.otra_pista') : LAB.t('prac.necesito_una_pista'); }
      if (r.assist) r.assist.hidden = !isCur;
      if (r.manual) r.manual.hidden = !isCur;
      r.btns.hidden = !Array.from(r.btns.children).some((b) => !b.hidden);
      if (r.q) { r.q.box.hidden = !(isCur || isDone || (s.question && ps.answers[s.question.id])); updateQuestion(s.question, r.q, s.id); }
      if (r.m) updateMeasure(s, r, isCur, isDone);
    });
    if (p.extra) { const h = p.extra(E); if (built.extra.dataset.h !== h) { built.extra.innerHTML = h; built.extra.dataset.h = h; } }
    const c = built.closure;
    c.hidden = ps.status !== 'completed' && !(m.stepsDone === m.stepsReq && m.ansDone < m.ansReq);
    if (!c.hidden) {
      if (ps.status === 'completed') {
        if (!c.dataset.done) {
          c.dataset.done = '1'; c.textContent = '';
          const rev = el('button', { class: 'btn accent', type: 'button', id: 'btnReportHtml', text: LAB.t('prac.revisar_e_imprimir_reporte') }), rep = el('button', { class: 'btn', type: 'button', text: LAB.t('prac.descargar_reporte_md') }), nx = el('button', { class: 'btn', type: 'button', text: LAB.t('prac.siguiente_practica') });
          rev.addEventListener('click', () => openReport()); rep.addEventListener('click', () => download()); nx.addEventListener('click', () => nextPractice());
          const self = el('div', { class: 'selfassess' }, el('b', { text: LAB.t('prac.autoevaluacion') }), el('p', { class: 'hint', text: LAB.t('prac.autoevaluacion_nota') }));
          p.rubric.forEach((txt, i) => {
            const id = 'self_' + i, sel = el('select', { id }, [['', '—'], ['2', LAB.t('prac.nivel_logrado')], ['1', LAB.t('prac.nivel_en_proceso')], ['0', LAB.t('prac.nivel_no_logrado')]].map(([v, l]) => el('option', { value: v, text: l })));
            sel.value = ps.self && ps.self[i] != null ? String(ps.self[i]) : '';
            sel.addEventListener('change', () => { ps.self = ps.self || {}; if (sel.value === '') delete ps.self[i]; else ps.self[i] = Number(sel.value); commit(true); });
            self.append(el('label', { for: id, text: txt }), sel);
          });
          c.append(el('b', { class: 'okt', text: LAB.t('prac.practica_completada') }), document.createTextNode(LAB.t('prac.el_reporte_usa_los')), self, el('div', { class: 'report' }, rev, rep, nx));
        }
      } else { delete c.dataset.done; c.textContent = LAB.t('prac.los_requisitos_operativos_estan', { pendingAns, s: pendingAns > 1 ? 's' : '', s3: pendingAns > 1 ? 's' : '' }); }
    } else delete c.dataset.done;
    built.restart.hidden = false;
    renderSaveState();
  }

  function evaluate(force) {
    if (!current || !ps) return;
    let changed = false;
    if (ps.status === 'in_progress') {
      current.steps.forEach((s) => {
        if (!ps.steps[s.id]) {
          let ok = false; try { ok = !!s.check(E); } catch (e) { console.error('check', s.id, e); }
          if (ok) { ps.steps[s.id] = true; changed = true; ui.announce(LAB.t('prac.paso_completado', { slice: s.text.slice(0, 60) })); }
        }
      });
      const m = metrics(current, ps);
      if (m.stepsDone === m.stepsReq && m.ansDone === m.ansReq) closePractice();
    }
    if (changed || force) { commit(); }
    updateGuide();
  }

  function closePractice() {
    ps.status = 'completed'; ps.completedAtUtc = new Date().toISOString(); ps.completionVersion = current.version;
    const snap = store.plain(E); snap.sunAtClose = { az: tel.sun.az, el: tel.sun.el };
    current.steps.forEach((s) => { const q = s.question; if (q && q.kind === 'predict') { const a = ps.answers[q.id]; if (a && a.ref == null) a.ref = q.ref(); } });   // el resultado que se compara con la prediccion queda congelado
    ps.closure = { completedAtUtc: ps.completedAtUtc, completionVersion: current.version, simLocal: `${lt().day}/${lt().month}/${lt().year} ${pad2(lt().hour)}:${pad2(lt().minute)}`, user: profile.user, role: profile.role, answers: store.plain(ps.answers), measures: store.plain(ps.measures || {}), evidence: snap, runIds: ps.runIds.slice(),
      incidents: incidentsNow(ps.sessionId), sweepIds: source.sweeps.filter((w) => w.sessionId === ps.sessionId).map((w) => w.id), runs: ps.runIds.map((id) => source.getRun(id)).filter(Boolean).map((r) => ({ id: r.id, n: r.samples.length, summary: store.plain(LAB.core.runSummary(r)) })) };
    progress.activePractice = null;
    commit(true);
    ui.toast(LAB.t('prac.practica_completada_descarga_tu', { n: current.n }), 'ok', 6500);
    ui.announce(LAB.t('prac.practica_completada_2', { n: current.n }));
  }

  // ---------------------------------------------------------------- acciones
  function hideGuide() { guideOpen = false; $('#practiceGuide').hidden = true; refreshChip(); if (lastOpener && document.contains(lastOpener)) lastOpener.focus(); }
  function showGuide() { guideOpen = true; $('#practiceGuide').hidden = false; refreshChip(); if (ui.layout) { ui.layout.onGuideShown(); ui.layout.focusGuide(); } }
  function refreshChip() {
    const b = $('#btnPractices'); if (!b) return;
    const active = current && ps && ps.status === 'in_progress';
    b.textContent = active ? LAB.t('prac.practica_2', { n: current.n }) : LAB.t('prac.practicas');
    b.title = active ? LAB.t('prac.practica_en_curso', { n: current.n, t: guideOpen ? '' : LAB.t('prac.pulsa_para_abrir_el') }) : LAB.t('prac.practicas_guiadas');
  }

  function open(id, { restartIt } = {}) {
    const p = defOf(id); if (!p || !progress) return;
    const old = progress.practices[id];
    if (current && ps && current.id !== id && ps.status === 'in_progress') commit(true);
    current = p;
    if (!old || restartIt || old.status === 'completed_legacy') {
      ps = freshPS(p); progress.practices[id] = ps;
    } else { ps = old; if (!ps.evidence) ps.evidence = p.fresh(); ps.evidence = Object.assign(p.fresh(), ps.evidence); }
    ps.measures = ps.measures || {}; ps.self = ps.self || {};
    E = ps.evidence;
    if (ps.defVersion < p.version && ps.status === 'in_progress') ps.outdated = true;
    if (ps.status === 'in_progress' && !ps.setupDone) { if (canOperate()) { ps.setupDone = true; p.setup(); } }
    progress.activePractice = ps.status === 'in_progress' ? id : progress.activePractice;
    buildGuide(); showGuide(); evaluate(true); commit(true);
  }
  function restart(id) {
    if (!confirm(LAB.t('prac.reiniciar_esta_practica_se'))) return;
    open(id, { restartIt: true });
  }
  function nextPractice() {
    const i = PRACTICES.indexOf(current), nx = PRACTICES[(i + 1) % PRACTICES.length];
    commit(true);
    const st = progress.practices[nx.id];
    open(nx.id, st && st.status !== 'completed_legacy' ? {} : {});
  }
  function consult(id) {
    const p = defOf(id); current = p; ps = progress.practices[id]; E = ps.evidence; buildGuide(); showGuide(); updateGuide();
  }

  // ---------------------------------------------------------------- vista de todos los pasos (C16): siempre accesible, también con la guía minimizada
  function openOverview() {
    const p = current, body = $('#ovBody'), dlg = $('#overviewDlg'); if (!p || !ps) return;
    body.textContent = '';
    const m = metrics(p, ps);
    body.append(el('h2', { id: 'ovTitle', text: LAB.t('prac.practica', { n: p.n, title: p.title }) }), el('p', { class: 'hint', text: LAB.t('prac.avance_requisitos_operativos_y', { goal: p.goal, stepsDone: m.stepsDone, stepsReq: m.stepsReq, ansDone: m.ansDone, ansReq: m.ansReq }) }));
    const t = el('table'); t.appendChild(el('caption', { class: 'sr', text: LAB.t('prac.todos_los_pasos_de') }));
    const hr = el('tr'); [LAB.t('prac.paso'), LAB.t('prac.objetivo'), LAB.t('prac.accion'), LAB.t('prac.observacion_esperada'), LAB.t('prac.evidencia'), LAB.t('prac.estado')].forEach((h) => hr.appendChild(el('th', { scope: 'col', text: h }))); t.appendChild(hr);
    p.steps.forEach((s, i) => {
      const done = !!ps.steps[s.id], tr = el('tr', { class: done ? 'ok' : '' });
      [`${i + 1}${s.optional ? LAB.t('prac.opt_short') : ''}`, s.why || '', s.text, s.expect || '—', s.evidence || (s.question ? LAB.t('prac.respuesta_registrada_2') : '—'), done ? LAB.t('prac.st_done') : (s.question && ps.answers[s.question.id] && ps.answers[s.question.id].draft ? LAB.t('prac.st_draft') : LAB.t('prac.st_pending'))].forEach((v) => tr.appendChild(el('td', { text: v })));
      t.appendChild(tr);
    });
    body.append(t, el('h3', { text: LAB.t('prac.resultados_de_aprendizaje') }), el('ul', {}, p.ilos.map((x) => el('li', { text: x }))));
    ui.showModal(dlg);
  }

  // ---------------------------------------------------------------- reporte imprimible (C16)
  /** Alarmas e incidentes de la bitácora de una sesión (se congelan al cerrar la práctica: T30) */
  function incidentsNow(sessionId) {
    return source.logs.filter((e) => e.sessionId === sessionId && (e.level === 'warn' || e.level === 'bad' || e.src === 'Seguridad' || e.src === 'Red')).slice(-40).map((e) => `${pad2(e.local.hour)}:${pad2(e.local.minute)} · ${e.src}: ${e.msg}`);
  }
  /** Predicciones comparadas con el resultado, calculos del alumno contra su corrida y autoevaluacion (todo congelado al cerrar) */
  function studyLines(p, st) {
    const cl = st.closure, ans = cl ? cl.answers : st.answers, ms = (cl ? cl.measures : st.measures) || {}, L = [];
    const preds = p.steps.filter((x) => x.question && x.question.kind === 'predict');
    if (preds.length) {
      L.push(LAB.t('prac.h_pred'), '');
      preds.forEach((x) => { const a = ans[x.question.id]; L.push(`**${x.question.text}**`, '', a && a.submitted ? a.submitted : LAB.t('prac.sin_respuesta'), ''); if (a && a.ref) L.push(LAB.t('prac.resultado_de_tus_datos', { ref: a.ref }), ''); });
    }
    const withM = p.steps.filter((x) => x.measure);
    if (withM.length) {
      L.push(LAB.t('prac.h_calculos'), '', LAB.t('prac.th_calculos'), '|---|---|---|---|');
      withM.forEach((x) => x.measure.fields.forEach((f) => {
        const m = ms[x.measure.id], v = m && m.vals && m.vals[f.k], r = m && m.refs && m.refs[f.k];
        L.push(`| ${f.label}${f.unit ? ` (${f.unit})` : ''} | ${v != null ? fmt(v, 3) : '—'} | ${r != null ? fmt(r, 3) : '—'} | ${m && m.fieldOk ? (m.fieldOk[f.k] ? LAB.t('prac.coincide') : LAB.t('prac.no_coincide')) : '—'} |`);
      }));
      L.push('');
    }
    const lv = [LAB.t('prac.nivel_no_logrado'), LAB.t('prac.nivel_en_proceso'), LAB.t('prac.nivel_logrado')];
    if (p.rubric && st.self && Object.keys(st.self).length) {
      L.push(LAB.t('prac.h_autoeval'), '', LAB.t('prac.th_autoeval'), '|---|---|');
      p.rubric.forEach((txt, i) => L.push(`| ${txt} | ${st.self[i] != null ? lv[st.self[i]] : '—'} |`));
      L.push('');
    }
    return L;
  }
  async function reportContext() {
    const p = current, snap = ps.closure ? ps.closure.evidence : E, ans = ps.closure ? ps.closure.answers : ps.answers, l = lt();
    const pid = profile.id, saved = pid ? await store.listRuns(pid) : [], live = source.runs.slice(), ids = new Set(live.map((r) => r.id));
    const all = saved.filter((r) => !ids.has(r.id)).concat(live), want = new Set(ps.closure ? ps.closure.runIds : ps.runIds);
    const frozen = {}; if (ps.closure && ps.closure.runs) ps.closure.runs.forEach((x) => (frozen[x.id] = x));
    const runs = all.filter((r) => want.has(r.id) && r.samples).sort((a, b) => String(a.createdAtUtc).localeCompare(String(b.createdAtUtc)))
      .map((r) => (frozen[r.id] ? { ...r, samples: r.samples.slice(0, frozen[r.id].n), _frozen: frozen[r.id].summary } : r));
    const sv = pid ? await store.listSweeps(pid) : [], sids = new Set(source.sweeps.map((w) => w.id));
    const sweeps = sv.filter((w) => !sids.has(w.id)).concat(source.sweeps).filter((w) => w.sessionId === ps.sessionId && (!ps.closure || !ps.closure.sweepIds || ps.closure.sweepIds.includes(w.id))).sort((a, b) => a.startSimMs - b.startSimMs);
    const incidents = ps.closure && ps.closure.incidents ? ps.closure.incidents : incidentsNow(ps.sessionId);
    const complete = ps.status === 'completed';
    return { practice: p, ps, snap, answers: ans, complete, mt: metrics(p, ps), user: profile.user, role: profile.role, version: LAB.config.appVersion, site: LAB.config.site.name, tz: LAB.config.site.tzHours,
      extraLines: studyLines(p, ps), simLocal: ps.closure ? ps.closure.simLocal : `${l.day}/${l.month}/${l.year} ${pad2(l.hour)}:${pad2(l.minute)}`, realDate: complete ? ps.completedAtUtc : new Date().toISOString(), runs, sweeps, incidents };
  }
  async function openReport() {
    if (!current || !ps) return;
    const ctx = await reportContext(), html = LAB.ui.reportHtml(ctx), dlg = $('#reportDlg'), fr = $('#rpFrame');
    fr.srcdoc = html; dlg._html = html; dlg._name = `reporte_practica${current.n}${ctx.complete ? '' : '_borrador'}`;
    $('#rpTitle').textContent = LAB.t('prac.reporte_practica', { n: current.n, incompleto: ctx.complete ? '' : LAB.t('prac.incomplete_draft_paren') });
    $('#rpNote').textContent = ctx.complete ? LAB.t('prac.revisa_tus_respuestas_y') : LAB.t('prac.la_practica_no_esta');
    ui.showModal(dlg);
  }
  function bindReportDialogs() {
    const rd = $('#reportDlg'), od = $('#overviewDlg');
    rd.querySelector('.x').addEventListener('click', () => ui.hideModal(rd)); od.querySelector('.x').addEventListener('click', () => ui.hideModal(od));
    const save = (text, ext, mime) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = `${rd._name}_${lt().year}${pad2(lt().month)}${pad2(lt().day)}.${ext}`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
    $('#rpPrint').addEventListener('click', () => { const w = $('#rpFrame').contentWindow; if (w) { w.focus(); w.print(); } });
    $('#rpHtml').addEventListener('click', () => save(rd._html, 'html', 'text/html;charset=utf-8'));
    $('#rpMd').addEventListener('click', () => download());
  }

  // ---------------------------------------------------------------- reporte (datos congelados)
  function reportMarkdown(draft) {
    const p = current, snap = ps.closure ? ps.closure.evidence : E, ans = ps.closure ? ps.closure.answers : ps.answers, l = lt();
    const complete = ps.status === 'completed';
    const mt = metrics(p, ps);
    return [LAB.t('prac.reporte_practica_2', { n: p.n, title: p.title, INCOMPLETO: complete ? '' : LAB.t('prac.incomplete_draft_caps') }), '',
      ...(complete ? [] : [LAB.t('prac.borrador_incompleto_requisitos_operativos', { stepsDone: mt.stepsDone, stepsReq: mt.stepsReq, ansDone: mt.ansDone, ansReq: mt.ansReq }), '']),
      LAB.t('prac.laboratorio_remoto_solar_unach'),
      LAB.t('prac.identidad_de_demostracion_rol', { user: profile.user || '—', role: profile.role || '—' }),
      LAB.t('prac.en_tiempo_simulado_utc', { t: complete ? LAB.t('prac.cerrada') : LAB.t('prac.descargada'), minute: ps.closure ? ps.closure.simLocal : `${l.day}/${l.month}/${l.year} ${pad2(l.hour)}:${pad2(l.minute)}`, tzHours: LAB.config.site.tzHours, toISOString: complete ? ps.completedAtUtc : new Date().toISOString() }),
      LAB.t('prac.sitio_version_de_la', { name: LAB.config.site.name, appVersion: LAB.config.appVersion, version: p.version, sessionId: ps.sessionId || '—' }), '',
      LAB.t('prac.objetivo_2', { goal: p.goal }), '', ...(p.report ? p.report(snap) : []), '', ...studyLines(p, ps), LAB.t('prac.respuestas'),
      ...p.steps.filter((x) => x.question && x.question.kind !== 'predict').map((x) => { const a = ans[x.question.id]; return `**${x.question.text}**\n\n${a && a.submitted ? a.submitted : (a && a.draft ? LAB.t('prac.borrador_sin_registrar', { draft: a.draft }) : LAB.t('prac.sin_respuesta'))}\n`; }),
      LAB.t('prac.resultados_de_aprendizaje_2'), ...p.ilos.map((x) => `- ${x}`), ''].join('\n');
    void draft;
  }
  function download() {
    const l = lt(), md = reportMarkdown();
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    a.download = `reporte_practica${current.n}${ps.status === 'completed' ? '' : '_borrador'}_${l.year}${pad2(l.month)}${pad2(l.day)}.md`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------------------------------------------------------------- listado de practicas
  function renderDrawer() {
    const d = $('#practiceDrawer');
    d.textContent = '';
    d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', LAB.t('prac.practicas_guiadas')); d.setAttribute('aria-modal', 'false');
    const x = el('button', { class: 'x', type: 'button', 'aria-label': LAB.t('prac.cerrar_el_listado_de'), text: '×' });
    x.addEventListener('click', () => closeDrawer());
    d.append(x, el('h3', { text: LAB.t('prac.practicas_guiadas') }), el('p', { text: LAB.t('prac.los_pasos_se_marcan') }));
    if (!progress) d.appendChild(el('p', { class: 'pwarn', text: LAB.t('prac.inicia_una_sesion_de_2') }));
    PRACTICES.forEach((p) => {
      const st = progress && progress.practices[p.id], sm = summaryOf(p, st);
      const card = el('div', { class: 'pcard ' + sm.cls });
      card.append(el('div', { class: 'n', 'aria-hidden': 'true', text: st && (st.status === 'completed' || st.status === 'completed_legacy') ? '✓' : String(p.n) }), el('b', { text: LAB.t('prac.practica', { n: p.n, title: p.title }) }), el('p', { text: p.goal }), el('span', { class: 'meta', text: `${p.dur} · ${sm.text}${st && (st.outdated || (st.status === 'in_progress' && st.defVersion < p.version)) ? LAB.t('prac.la_definicion_cambio_desde') : ''}` }));
      const row = el('div', { class: 'pbtns' });
      const b = (txt, fn, cls) => { const e = el('button', { class: 'btn ' + (cls || ''), type: 'button', text: txt }); e.addEventListener('click', fn); row.appendChild(e); };
      if (!progress) { /* sin perfil */ }
      else if (!st || st.status === 'completed_legacy') b(st ? LAB.t('prac.comenzar_de_nuevo_criterio') : LAB.t('prac.comenzar'), () => { open(p.id, { restartIt: true }); closeDrawer(true); }, 'accent');
      else if (st.status === 'in_progress') { b(LAB.t('prac.continuar'), () => { open(p.id); closeDrawer(true); }, 'accent'); b(LAB.t('prac.reiniciar'), () => { closeDrawer(true); restart(p.id); }); }
      else if (isOldDone(p, st)) { b(LAB.t('prac.descargar_resultados_anteriores'), () => downloadOld(p.id), 'accent'); b(LAB.t('prac.hacer_la_version_nueva'), () => { closeDrawer(true); restart(p.id); }); }
      else { b(LAB.t('prac.consultar_resultados'), () => { consult(p.id); closeDrawer(true); }, 'accent'); b(LAB.t('prac.repetir_reinicia'), () => { closeDrawer(true); restart(p.id); }); }
      card.appendChild(row); d.appendChild(card);
    });
    // copia de seguridad
    const bk = el('div', { class: 'backup' }, el('b', { text: LAB.t('prac.copia_de_seguridad') }), el('p', { class: 'hint', text: LAB.t('prac.exporta_o_importa_tu') }));
    const ex = el('button', { class: 'btn', type: 'button', text: LAB.t('prac.exportar_copia_json') }), im = el('button', { class: 'btn', type: 'button', text: LAB.t('prac.import_backup') });
    const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true, 'aria-label': LAB.t('prac.archivo_de_copia_de') });
    ex.addEventListener('click', exportBackup); im.addEventListener('click', () => file.click());
    file.addEventListener('change', () => importBackupFile(file.files[0]));
    ex.disabled = im.disabled = !progress;
    bk.append(el('div', { class: 'row3' }, ex, im), file, el('div', { id: 'saveState2', class: 'savestate', role: 'status', text: store.status.error ? '⚠ ' + store.status.error : '' }));
    d.appendChild(bk);
    return x;
  }
  function downloadOld(id) {
    const st = progress && progress.practices[id]; if (!st) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ practiceId: id, version: st.completionVersion || st.defVersion, closure: st.closure, answers: st.answers }, null, 1)], { type: 'application/json' }));
    a.download = `practica${defOf(id).n}_resultados_version_anterior.json`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function exportBackup() {
    const data = await store.exportAll(profile.id, progress);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = `lab-solar-unach_copia_${profile.id}_${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    ui.toast(LAB.t('prac.copia_de_seguridad_descargada'), 'ok');
  }
  async function importBackupFile(f) {
    if (!f) return;
    if (f.size > 60e6) { ui.toast(LAB.t('prac.el_archivo_es_demasiado'), 'warn'); return; }
    let obj; try { obj = JSON.parse(await f.text()); } catch (e) { ui.toast(LAB.t('prac.el_archivo_no_es'), 'warn'); return; }
    const v = store.validateBackup(obj);
    if (!v.ok) { ui.toast(LAB.t('prac.copia_rechazada') + v.errors.join(' · '), 'bad', 9000); return; }
    if (!confirm(LAB.t('prac.importar_esta_copia_reemplaza'))) return;
    const r = await store.importBackup(obj, profile.id);
    if (r.ok) { progress = r.progress; current = null; ps = null; $('#practiceGuide').hidden = true; ui.toast(LAB.t('prac.copia_importada_corridas_barridos', { runs: r.runs, sweeps: r.sweeps }), 'ok'); renderDrawer(); refreshChip(); }
  }
  function closeDrawer(noFocus) { const d = $('#practiceDrawer'); if (d.hidden) return; if (noFocus) { const i = 0; void i; d.hidden = true; ui.dropModal(d); } else ui.hideModal(d); }

  // ---------------------------------------------------------------- API publica
  ui.practices = {
    list: PRACTICES, defs: defOf, MIN_ANSWER,
    init(a) {
      app = a; source = a.source; send = ui.send; tel = source.telemetry;
      source.on('sweep', (sw) => { if (current && ps && ps.status === 'in_progress' && current.onSweep) { current.onSweep(sw); evaluate(false); } });
      source.on('acq', (e) => { if (current && ps && e.runId && !ps.runIds.includes(e.runId) && ps.status === 'in_progress') { ps.runIds.push(e.runId); commit(); } });
      store.onStatus(renderSaveState); bindReportDialogs();
      // cambio de idioma en vivo: se reconstruyen las definiciones (el texto vive en ellas) y lo que esté abierto
      LAB.i18n.onChange(() => {
        buildPractices();
        if (current && ps) { buildGuide(); updateGuide(); }
        if ($('#practiceDrawer')) renderDrawer();
        refreshChip();
      });
    },
    /** Llamado al iniciar o terminar una sesion: carga el avance del perfil correspondiente (aislado por perfil) */
    onSession(phase, entry) {
      if (phase === 'end') {
        if (progress && profile.id) commit(true);
        current = null; ps = null; E = {}; progress = null; profile = { id: null }; $('#practiceGuide').hidden = true; guideOpen = false; refreshChip(); return;
      }
      profile = { id: entry.profileId, user: entry.user, role: entry.role, sessionId: entry.id };
      progress = store.loadProgress(profile.id);
      if (progress.warning) ui.toast(progress.warning, 'warn', 9000);
      const act = progress.activePractice && progress.practices[progress.activePractice];
      if (act && act.status === 'in_progress') ui.toast(LAB.t('prac.tienes_la_practica_en', { n: defOf(act.practiceId).n }), 'info', 7000);
      refreshChip();
    },
    openFromUrl(id) { if (progress && defOf(id)) { const st = progress.practices[id]; if (st && st.status === 'in_progress') open(id); else open(id, { restartIt: !st || st.status === 'completed_legacy' }); } },
    toggleDrawer(opener) {
      const d = $('#practiceDrawer');
      if (!d.hidden) { closeDrawer(); return; }
      lastOpener = opener || document.activeElement;
      renderDrawer(); ui.showModal(d);
    },
    closeDrawer,
    drawerOpen: () => !$('#practiceDrawer').hidden,
    guideOpen: () => guideOpen,
    hideGuide, openReport, openOverview,
    reopenGuide() { if (current && ps) { if (!built) buildGuide(); showGuide(); } },
    state: () => ({ current: current && current.id, ps, E, progress, profile }),
    notify(type, data) {
      if (!current || !ps || ps.status !== 'in_progress') return;
      if (type === 'part') { add(E.parts, data); acc = 1; }
      else if (type === 'pov') { const c = (E.cams[data.id] = E.cams[data.id] || {}); if (data.phase === 'enter') c.entered = true; else if (data.phase === 'exit' && c.entered) c.exited = true; acc = 1; }
      else if (type === 'tab' && data === 'iv') { E.ivViewed = true; acc = 1; }
      else if (type === 'csv' && data && data.rows > 0) { E.csv = { rows: data.rows, runId: data.runId }; acc = 1; }
      else if (type === 'logOpened') { E.logOpened = true; acc = 1; }
      else if (type === 'log' && current.onLog) current.onLog(data);
    },
    tick(t, dt) {
      tel = t;
      if (!current || !ps || !profile.id) return;
      if (ps.status !== 'in_progress') { return; }
      if (!ps.setupDone && canOperate()) { ps.setupDone = true; current.setup(); commit(); }
      if (current.tick) current.tick(dt);
      acc += dt;
      if (acc < 0.4) return; acc = 0;
      evaluate(false);
    },
    download,
  };
})();
