/* Entrada guiada (C19): Explorar / Realizar práctica / Crear experimento, recorrido opcional, glosario contextual
 * y el interruptor de ayudas 3D. Todo es opcional y reabrible; nada de esto cambia datos ni avance. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs, ...kids) => { const n = document.createElement(tag); Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (v === true) n.setAttribute(k, ''); else if (v !== false && v != null) n.setAttribute(k, v); }); kids.flat().forEach((c) => c && n.append(c)); return n; };
  const safe = (fn) => { try { return fn(); } catch (e) { return null; } };

  // Tipo de cada variable: así se distingue lo que el usuario fija, lo que el simulador «mide» y lo que se calcula.
  const KIND = () => ({ consigna: LAB.t('onb.consigna_tu_la_fijas'), medida: LAB.t('onb.medida_simulada_la_produce'), derivada: LAB.t('onb.derivada_se_calcula_a') });
  const GLOSS = () => [
    { id: 'irradiancia', term: LAB.t('onb.irradiancia'), kind: 'medida', def: LAB.t('onb.potencia_de_la_luz') },
    { id: 'ghi', term: LAB.t('onb.term_ghi'), kind: 'medida', def: LAB.t('onb.luz_total_sobre_una') },
    { id: 'dni', term: LAB.t('onb.term_dni'), kind: 'derivada', def: LAB.t('onb.luz_que_llega_en') },
    { id: 'dhi', term: LAB.t('onb.term_dhi'), kind: 'derivada', def: LAB.t('onb.luz_dispersada_por_el') },
    { id: 'poa', term: LAB.t('onb.poa_irradiancia_en_el'), kind: 'medida', def: LAB.t('onb.irradiancia_sobre_la_superficie') },
    { id: 'azimut', term: LAB.t('onb.azimut'), kind: 'consigna', def: LAB.t('onb.direccion_hacia_la_que') },
    { id: 'inclinacion', term: LAB.t('onb.inclinacion'), kind: 'consigna', def: LAB.t('onb.angulo_del_panel_respecto') },
    { id: 'incidencia', term: LAB.t('onb.angulo_de_incidencia'), kind: 'derivada', def: LAB.t('onb.angulo_entre_la_normal') },
    { id: 'mppt', term: LAB.t('onb.mppt'), kind: 'consigna', def: LAB.t('onb.modo_de_carga_que') },
    { id: 'mpp', term: LAB.t('onb.punto_de_maxima_potencia'), kind: 'derivada', def: LAB.t('onb.punto_de_la_curva') },
    { id: 'voc', term: LAB.t('onb.voc_tension_de_circuito'), kind: 'medida', def: LAB.t('onb.tension_maxima_del_modulo') },
    { id: 'isc', term: LAB.t('onb.isc_corriente_de_cortocircuito'), kind: 'medida', def: LAB.t('onb.corriente_maxima_del_modulo') },
    { id: 'tcelda', term: LAB.t('onb.temperatura_de_celda'), kind: 'medida', def: LAB.t('onb.temperatura_de_las_celdas') },
  ];
  const CLASSIF = () => [
    [LAB.t('onb.consignas'), LAB.t('onb.azimut_e_inclinacion_objetivo')],
    [LAB.t('onb.medidas_simuladas'), LAB.t('onb.poa_ghi_temperatura_de')],
    [LAB.t('onb.resultados_derivados'), LAB.t('onb.energia_e_integral_de')],
  ];

  // ---------------------------------------------------------------- glosario
  function buildGlossary() {
    const dlg = $('#glossDlg'); const body = $('#glossBody'); body.textContent = '';
    body.append(el('h2', { id: 'glossTitle', text: LAB.t('onb.glosario') }), el('p', { class: 'hint', text: LAB.t('onb.cada_termino_indica_si') }));
    const dl = el('dl', { class: 'gloss' });
    GLOSS().forEach((g) => dl.append(el('dt', { id: 'gl_' + g.id, tabindex: '-1', text: g.term }), el('dd', {}, el('span', { class: 'gk ' + g.kind, text: KIND()[g.kind] }), el('br'), document.createTextNode(g.def))));
    body.append(dl, el('h3', { text: LAB.t('onb.consignas_medidas_simuladas_y') }));
    const ul = el('ul'); CLASSIF().forEach(([a, b]) => ul.append(el('li', {}, el('b', { text: a + ': ' }), document.createTextNode(b)))); body.append(ul);
  }
  function openGlossary(id) {
    const dlg = $('#glossDlg'); if (!$('#glossBody').children.length) buildGlossary();
    LAB.ui.showModal(dlg);
    const t = id && $('#gl_' + id); if (t) { t.scrollIntoView({ block: 'start' }); t.focus(); t.classList.add('hl'); setTimeout(() => t.classList.remove('hl'), 2500); }
  }

  // ---------------------------------------------------------------- recorrido (opcional, se omite y se reabre)
  const STEPS = () => [
    { sel: '#btnView_general, #viewbar', title: LAB.t('onb.modulos_a_y_b'), text: LAB.t('onb.a_verde_es_el') },
    { sel: '#tracker, .panel:has(#azSlider)', title: LAB.t('onb.controles'), text: LAB.t('onb.aqui_fijas_lo_que') },
    { sel: '#chartTabs', title: LAB.t('onb.resultados'), text: LAB.t('onb.las_pestanas_muestran_potencia') },
    { sel: '#acqBox', title: LAB.t('onb.guardado'), text: LAB.t('onb.con_iniciar_adquisicion_se') },
    { sel: '#practiceEmpty, #practiceGuide', title: LAB.t('onb.tu_siguiente_paso'), text: LAB.t('onb.elige_realizar_una_practica') },
  ];
  let tourI = -1, tourOpener = null;
  const tourPop = () => $('#tourPop');
  function tourShow(i) {
    const pop = tourPop(); if (i < 0 || i >= STEPS().length) return tourEnd();
    tourI = i; const s = STEPS()[i]; pop.hidden = false;
    $('#tourTitle').textContent = `${i + 1}/${STEPS().length} · ${s.title}`; $('#tourText').textContent = s.text;
    $('#tourPrev').disabled = i === 0; $('#tourNext').textContent = i === STEPS().length - 1 ? LAB.t('onb.terminar') : LAB.t('onb.siguiente');
    document.querySelectorAll('.tour-hl').forEach((n) => n.classList.remove('tour-hl'));
    const t = safe(() => document.querySelector(s.sel)); if (t) { t.classList.add('tour-hl'); t.scrollIntoView({ block: 'nearest' }); }
    $('#tourNext').focus();
  }
  function tourEnd() {
    tourI = -1; tourPop().hidden = true; document.querySelectorAll('.tour-hl').forEach((n) => n.classList.remove('tour-hl'));
    safe(() => localStorage.setItem('labsolar.v2.tourSeen', '1'));
    if (tourOpener && document.contains(tourOpener)) tourOpener.focus();
  }
  function startTour(opener) { tourOpener = opener || document.activeElement; tourShow(0); }

  // ---------------------------------------------------------------- entrada: Explorar / Práctica / Experimento
  function needSession() { if (LAB.app.source.telemetry.safety.session.active) return false; LAB.ui.toast(LAB.t('onb.inicia_una_sesion_de'), 'warn'); LAB.ui.openLogin(); return true; }
  function explore() {
    const app = LAB.app; app.rig.set('general'); LAB.ui.markViews && LAB.ui.markViews('general');
    app.world.labels.setMode('all'); const b = $('#btnLabels'); if (b) { b.classList.add('on'); b.classList.remove('dim'); }
    app.handlePart('moduleA', false);
    LAB.ui.toast(LAB.t('onb.explorando_mostre_todas_las'), 'info', 9000);
    LAB.ui.announce(LAB.t('onb.modo_exploracion_etiquetas_visibles'));
  }
  function experimentCard() {
    const h = $('#practiceEmpty'); let c = $('#expCard'); if (c) { c.hidden = false; return c; }
    c = el('div', { id: 'expCard', class: 'expcard', role: 'region', 'aria-label': LAB.t('onb.crear_experimento') });
    c.append(el('b', { text: LAB.t('onb.tu_experimento_paso_a') }), el('ol', {}, [
      LAB.t('onb.fija_las_condiciones_fecha'),
      LAB.t('onb.elige_una_variable_a'),
      LAB.t('onb.pulsa_iniciar_adquisicion_abajo'),
      LAB.t('onb.cambia_la_variable_observa'),
      LAB.t('onb.descarga_el_csv_de'),
    ].map((t) => el('li', { text: t }))));
    const sc = el('button', { class: 'btn', type: 'button', id: 'btnExpScenario', text: LAB.t('onb.aplicar_escenario_comun_23') });
    sc.addEventListener('click', () => { const r = LAB.ui.send({ type: 'scenario.apply', scenario: { id: 'experimento-base', simMs: LAB.fromLocal(2026, 10, 23, 7, 0), cloud: 0.1, windBase: 3.2, seed: 20261023, az: 180, tilt: 17, speed: 60 } }); if (r && r.ok) LAB.ui.toast(LAB.t('onb.escenario_comun_aplicado_el'), 'ok'); });
    const nw = el('button', { class: 'btn accent', type: 'button', id: 'btnExpRun', text: LAB.t('onb.crear_corrida_experimento_libre') });
    nw.addEventListener('click', () => { const r = LAB.ui.send({ type: 'acq.newRun', label: LAB.t('onb.free_run_label') }); if (r && r.ok) LAB.ui.toast(LAB.t('onb.corrida_creada_pulsa_iniciar'), 'ok'); });
    c.append(el('div', { class: 'row3' }, sc, nw)); h.querySelector('.body').appendChild(c); return c;
  }
  function buildEntry(force) {
    const h = $('#practiceEmpty'); if (!h || ($('#entryBox') && !force)) return;
    if (force) { const old = $('#expCard'); if (old) old.remove(); }
    const body = h.querySelector('.body'); body.textContent = '';
    h.querySelector('h3').textContent = LAB.t('onb.que_quieres_hacer');
    const legend = el('p', { class: 'hint', id: 'abLegend' }, el('b', { class: 'ca', text: LAB.t('onb.a_fijo_verde') }), document.createTextNode(LAB.t('onb.es_la_referencia')), el('b', { class: 'cb', text: LAB.t('onb.b_movil_de_2') }), document.createTextNode(LAB.t('onb.se_orienta_para_captar')));
    const mk = (id, t, d, fn, cls) => { const b = el('button', { class: 'btn entry ' + (cls || ''), type: 'button', id }, el('b', { text: t }), el('span', { text: d })); b.addEventListener('click', fn); return b; };
    const box = el('div', { id: 'entryBox', class: 'entrybox' },
      mk('btnEntryExplore', LAB.t('onb.explorar_el_laboratorio'), LAB.t('onb.mira_el_banco_en'), explore),
      mk('btnEntryPractice', LAB.t('onb.realizar_una_practica'), LAB.t('onb.cuatro_practicas_guiadas_con'), () => { if (needSession()) return; LAB.ui.practices.toggleDrawer(document.activeElement); }, 'accent'),
      mk('btnEntryExperiment', LAB.t('onb.crear_experimento'), LAB.t('onb.cambia_una_variable_y'), () => { if (needSession()) return; experimentCard(); LAB.ui.toast(LAB.t('onb.sigue_los_pasos_de'), 'info'); }));
    const aux = el('div', { class: 'row3' });
    const tr = el('button', { class: 'btn', type: 'button', id: 'btnTour', text: LAB.t('onb.recorrido_de_1_minuto') }); tr.addEventListener('click', () => startTour(tr));
    const gl = el('button', { class: 'btn', type: 'button', id: 'btnGloss', text: LAB.t('onb.glosario') }); gl.addEventListener('click', () => openGlossary());
    aux.append(tr, gl);
    body.append(legend, box, aux, el('p', { class: 'hint', text: LAB.t('onb.el_recorrido_es_opcional') }));
    const old = $('#btnPracticesSide'); if (old) old.remove();
  }

  // ---------------------------------------------------------------- ayudas 3D (auto por tarea / siempre / nunca)
  const AIDS = ['auto', 'on', 'off'], AIDS_T = () => ({ auto: LAB.t('onb.ayudas_3d_segun_la'), on: LAB.t('onb.ayudas_3d_siempre'), off: LAB.t('onb.ayudas_3d_ocultas') });
  function aidsBtn() {
    const b = $('#btnAids'); if (!b) return;
    const sync = () => { const m = LAB.app.world.aidsMode; b.title = AIDS_T()[m] + LAB.t('onb.normal_del_panel_rayo'); b.setAttribute('aria-label', b.title); b.classList.toggle('on', m === 'on'); b.classList.toggle('dim', m === 'off'); $('#aidsTxt').textContent = { auto: LAB.t('onb.auto'), on: LAB.t('onb.si'), off: LAB.t('onb.no') }[m]; };
    b.addEventListener('click', () => { const w = LAB.app.world; w.aidsMode = AIDS[(AIDS.indexOf(w.aidsMode) + 1) % 3]; safe(() => localStorage.setItem('labsolar.v2.aids', w.aidsMode)); sync(); LAB.ui.announce(AIDS_T()[w.aidsMode]); });
    const saved = safe(() => localStorage.getItem('labsolar.v2.aids')); if (AIDS.includes(saved)) LAB.app.world.aidsMode = saved; sync();
  }

  LAB.ui.onboarding = {
    GLOSS, KIND,
    rebuild() { const b = $('#glossBody'); if (b) b.textContent = ''; buildEntry(true); const m = tourI; if (m >= 0) tourShow(m); },
    init() {
      buildEntry(); aidsBtn();
      $('#glossDlg .x').addEventListener('click', () => LAB.ui.hideModal($('#glossDlg')));
      $('#tourPrev').addEventListener('click', () => tourShow(tourI - 1)); $('#tourNext').addEventListener('click', () => tourShow(tourI + 1)); $('#tourSkip').addEventListener('click', tourEnd);
      tourPop().addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); tourEnd(); } });
      document.addEventListener('click', (e) => { const g = e.target.closest && e.target.closest('[data-gloss]'); if (g) openGlossary(g.dataset.gloss); });
      document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-gloss]')) { e.preventDefault(); openGlossary(e.target.dataset.gloss); } });
      const ht = $('#helpTour'); if (ht) ht.addEventListener('click', () => { LAB.ui.hideModal($('#helpDlg')); startTour($('#btnHelp')); });
      const hg = $('#helpGloss'); if (hg) hg.addEventListener('click', () => { LAB.ui.hideModal($('#helpDlg')); openGlossary(); });
    },
    openGlossary, startTour, tourEnd, tourOpen: () => tourI >= 0, explore, experimentCard,
  };
})();
