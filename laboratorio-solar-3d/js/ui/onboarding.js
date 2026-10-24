/* Entrada guiada (C19): Explorar / Realizar práctica / Crear experimento, recorrido opcional, glosario contextual
 * y el interruptor de ayudas 3D. Todo es opcional y reabrible; nada de esto cambia datos ni avance. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs, ...kids) => { const n = document.createElement(tag); Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (v === true) n.setAttribute(k, ''); else if (v !== false && v != null) n.setAttribute(k, v); }); kids.flat().forEach((c) => c && n.append(c)); return n; };
  const safe = (fn) => { try { return fn(); } catch (e) { return null; } };

  // Tipo de cada variable: así se distingue lo que el usuario fija, lo que el simulador «mide» y lo que se calcula.
  const KIND = { consigna: 'Consigna (tú la fijas)', medida: 'Medida simulada (la produce el modelo del banco)', derivada: 'Derivada (se calcula a partir de otras)' };
  const GLOSS = [
    { id: 'irradiancia', term: 'Irradiancia', kind: 'medida', def: 'Potencia de la luz solar por unidad de área, en W/m². Un módulo produce más cuanta más irradiancia recibe en su plano.' },
    { id: 'ghi', term: 'GHI (irradiancia global horizontal)', kind: 'medida', def: 'Luz total sobre una superficie horizontal: directa + difusa. La mide el piranómetro (aquí, su valor simulado).' },
    { id: 'dni', term: 'DNI (irradiancia directa normal)', kind: 'derivada', def: 'Luz que llega en línea recta del disco solar, medida perpendicular a los rayos. Aquí es un valor derivado del modelo (pvlib), no una medición independiente del piranómetro.' },
    { id: 'dhi', term: 'DHI (irradiancia difusa horizontal)', kind: 'derivada', def: 'Luz dispersada por el cielo y las nubes. También es un valor derivado del modelo (pvlib).' },
    { id: 'poa', term: 'POA (irradiancia en el plano del módulo)', kind: 'medida', def: 'Irradiancia sobre la superficie inclinada del módulo; es la que importa para su potencia y difiere de la GHI.' },
    { id: 'azimut', term: 'Azimut', kind: 'consigna', def: 'Dirección hacia la que mira el panel medida desde el norte, en grados: 90° este, 180° sur, 270° oeste. El rango autorizado del seguidor es 90°–270°.' },
    { id: 'inclinacion', term: 'Inclinación', kind: 'consigna', def: 'Ángulo del panel respecto a la horizontal: 0° plano, 90° vertical. Rango autorizado 0°–90°.' },
    { id: 'incidencia', term: 'Ángulo de incidencia', kind: 'derivada', def: 'Ángulo entre la normal del panel y el rayo solar. Con 0° el Sol da de frente y el panel capta lo máximo; crece cuando se desalinean.' },
    { id: 'mppt', term: 'MPPT', kind: 'consigna', def: 'Modo de carga que busca el punto de máxima potencia de la curva I‑V para extraer la mayor potencia posible.' },
    { id: 'mpp', term: 'Punto de máxima potencia (MPP)', kind: 'derivada', def: 'Punto de la curva donde V·I es máximo (la «rodilla»). Su tensión es Vmp y su corriente Imp; aquí se calcula con el modelo.' },
    { id: 'voc', term: 'Voc (tensión de circuito abierto)', kind: 'medida', def: 'Tensión máxima del módulo cuando no circula corriente.' },
    { id: 'isc', term: 'Isc (corriente de cortocircuito)', kind: 'medida', def: 'Corriente máxima del módulo cuando la tensión es cero; crece casi linealmente con la irradiancia.' },
    { id: 'tcelda', term: 'Temperatura de celda', kind: 'medida', def: 'Temperatura de las celdas del módulo (modelo térmico del simulador). Al subir, la tensión y la potencia bajan.' },
  ];
  const CLASSIF = [
    ['Consignas', 'azimut e inclinación objetivo, modo del seguidor, modo y valor de la carga, nubes, viento medio, velocidad y fecha/hora del reloj'],
    ['Medidas simuladas', 'POA, GHI, temperatura de celda, V, I y P de cada módulo, viento actual, posición real de los ejes'],
    ['Resultados derivados', 'energía E (integral de P), ganancias, razón P_B/P_A, DNI y DHI, ángulo de incidencia, curva I‑V calculada y MPP'],
  ];

  // ---------------------------------------------------------------- glosario
  function buildGlossary() {
    const dlg = $('#glossDlg'); const body = $('#glossBody'); body.textContent = '';
    body.append(el('h2', { id: 'glossTitle', text: 'Glosario' }), el('p', { class: 'hint', text: 'Cada término indica si es una consigna, una medida o un valor derivado.' }));
    const dl = el('dl', { class: 'gloss' });
    GLOSS.forEach((g) => dl.append(el('dt', { id: 'gl_' + g.id, tabindex: '-1', text: g.term }), el('dd', {}, el('span', { class: 'gk ' + g.kind, text: KIND[g.kind] }), el('br'), document.createTextNode(g.def))));
    body.append(dl, el('h3', { text: 'Consignas, medidas simuladas y derivadas' }));
    const ul = el('ul'); CLASSIF.forEach(([a, b]) => ul.append(el('li', {}, el('b', { text: a + ': ' }), document.createTextNode(b)))); body.append(ul);
  }
  function openGlossary(id) {
    const dlg = $('#glossDlg'); if (!$('#glossBody').children.length) buildGlossary();
    LAB.ui.showModal(dlg);
    const t = id && $('#gl_' + id); if (t) { t.scrollIntoView({ block: 'start' }); t.focus(); t.classList.add('hl'); setTimeout(() => t.classList.remove('hl'), 2500); }
  }

  // ---------------------------------------------------------------- recorrido (opcional, se omite y se reabre)
  const STEPS = [
    { sel: '#btnView_general, #viewbar', title: 'Módulos A y B', text: 'A (verde) es el módulo fijo, la referencia. B (ámbar) es el módulo que se mueve con el seguidor de dos ejes. Se comparan en las mismas condiciones. Usa la barra de vistas o haz clic en las etiquetas 3D.' },
    { sel: '#tracker, .panel:has(#azSlider)', title: 'Controles', text: 'Aquí fijas lo que quieres probar: modo del seguidor, azimut e inclinación, y la carga eléctrica. Abajo, el reloj y el clima (nubes y viento). Primero inicia una sesión de demostración.' },
    { sel: '#chartTabs', title: 'Resultados', text: 'Las pestañas muestran potencia, el día, la curva I‑V, la energía y «Corrida» (análisis de lo registrado). Las tarjetas de arriba comparan A y B en vivo.' },
    { sel: '#acqBox', title: 'Guardado', text: 'Con «Iniciar adquisición» se registra una muestra por segundo. Todo se guarda en este navegador (también tu avance); exporta CSV o una copia de seguridad desde «Prácticas».' },
    { sel: '#practiceEmpty, #practiceGuide', title: 'Tu siguiente paso', text: 'Elige Realizar una práctica para seguir una guía paso a paso, o Crear experimento para probar tus propias condiciones.' },
  ];
  let tourI = -1, tourOpener = null;
  const tourPop = () => $('#tourPop');
  function tourShow(i) {
    const pop = tourPop(); if (i < 0 || i >= STEPS.length) return tourEnd();
    tourI = i; const s = STEPS[i]; pop.hidden = false;
    $('#tourTitle').textContent = `${i + 1}/${STEPS.length} · ${s.title}`; $('#tourText').textContent = s.text;
    $('#tourPrev').disabled = i === 0; $('#tourNext').textContent = i === STEPS.length - 1 ? 'Terminar' : 'Siguiente';
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
  function needSession() { if (LAB.app.source.telemetry.safety.session.active) return false; LAB.ui.toast('Inicia una sesión de demostración (Estudiante o Docente) para continuar.', 'warn'); LAB.ui.openLogin(); return true; }
  function explore() {
    const app = LAB.app; app.rig.set('general'); LAB.ui.markViews && LAB.ui.markViews('general');
    app.world.labels.setMode('all'); const b = $('#btnLabels'); if (b) { b.classList.add('on'); b.classList.remove('dim'); }
    app.handlePart('moduleA', false);
    LAB.ui.toast('Explorando: mostré todas las etiquetas y la ficha del módulo A (fijo). Pulsa «B» en la barra de vistas o la etiqueta del módulo B para compararlo.', 'info', 9000);
    LAB.ui.announce('Modo exploración: etiquetas visibles y ficha del módulo A abierta');
  }
  function experimentCard() {
    const h = $('#practiceEmpty'); let c = $('#expCard'); if (c) { c.hidden = false; return c; }
    c = el('div', { id: 'expCard', class: 'expcard', role: 'region', 'aria-label': 'Crear experimento' });
    c.append(el('b', { text: 'Tu experimento, paso a paso' }), el('ol', {}, [
      'Fija las condiciones: fecha y hora, nubes y viento (barra inferior). Para comparar estrategias usa el escenario común.',
      'Elige UNA variable a cambiar: azimut, inclinación o modo del seguidor. Lo demás se queda igual.',
      'Pulsa «Iniciar adquisición» (abajo, en datos) y espera varias muestras.',
      'Cambia la variable, observa la pestaña «Corrida» y compara con la corrida anterior.',
      'Descarga el CSV de la corrida o abre el reporte desde «Prácticas».',
    ].map((t) => el('li', { text: t }))));
    const sc = el('button', { class: 'btn', type: 'button', id: 'btnExpScenario', text: 'Aplicar escenario común (23/10/2026 07:00, nubes 10 %)' });
    sc.addEventListener('click', () => { const r = LAB.ui.send({ type: 'scenario.apply', scenario: { id: 'experimento-base', simMs: LAB.fromLocal(2026, 10, 23, 7, 0), cloud: 0.1, windBase: 3.2, seed: 20261023, az: 180, tilt: 17, speed: 60 } }); if (r && r.ok) LAB.ui.toast('Escenario común aplicado: el módulo A queda como referencia y las condiciones se pueden repetir.', 'ok'); });
    const nw = el('button', { class: 'btn accent', type: 'button', id: 'btnExpRun', text: 'Crear corrida «Experimento libre»' });
    nw.addEventListener('click', () => { const r = LAB.ui.send({ type: 'acq.newRun', label: 'Experimento libre' }); if (r && r.ok) LAB.ui.toast('Corrida creada. Pulsa «Iniciar adquisición» cuando estés listo.', 'ok'); });
    c.append(el('div', { class: 'row3' }, sc, nw)); h.querySelector('.body').appendChild(c); return c;
  }
  function buildEntry() {
    const h = $('#practiceEmpty'); if (!h || $('#entryBox')) return;
    const body = h.querySelector('.body'); body.textContent = '';
    h.querySelector('h3').textContent = '¿Qué quieres hacer?';
    const legend = el('p', { class: 'hint', id: 'abLegend' }, el('b', { class: 'ca', text: 'A · fijo (verde)' }), document.createTextNode(' es la referencia; '), el('b', { class: 'cb', text: 'B · móvil de 2 ejes (ámbar)' }), document.createTextNode(' se orienta para captar más.'));
    const mk = (id, t, d, fn, cls) => { const b = el('button', { class: 'btn entry ' + (cls || ''), type: 'button', id }, el('b', { text: t }), el('span', { text: d })); b.addEventListener('click', fn); return b; };
    const box = el('div', { id: 'entryBox', class: 'entrybox' },
      mk('btnEntryExplore', 'Explorar el laboratorio', 'Mira el banco en 3D y abre la ficha de cada equipo', explore),
      mk('btnEntryPractice', 'Realizar una práctica', 'Cuatro prácticas guiadas con pasos, pistas y reporte', () => { if (needSession()) return; LAB.ui.practices.toggleDrawer(document.activeElement); }, 'accent'),
      mk('btnEntryExperiment', 'Crear experimento', 'Cambia una variable y compara corridas', () => { if (needSession()) return; experimentCard(); LAB.ui.toast('Sigue los pasos de la tarjeta «Tu experimento».', 'info'); }));
    const aux = el('div', { class: 'row3' });
    const tr = el('button', { class: 'btn', type: 'button', id: 'btnTour', text: 'Recorrido de 1 minuto' }); tr.addEventListener('click', () => startTour(tr));
    const gl = el('button', { class: 'btn', type: 'button', id: 'btnGloss', text: 'Glosario' }); gl.addEventListener('click', () => openGlossary());
    aux.append(tr, gl);
    body.append(legend, box, aux, el('p', { class: 'hint', text: 'El recorrido es opcional: puedes omitirlo y volver a abrirlo aquí o en la ayuda (?).' }));
    const old = $('#btnPracticesSide'); if (old) old.remove();
  }

  // ---------------------------------------------------------------- ayudas 3D (auto por tarea / siempre / nunca)
  const AIDS = ['auto', 'on', 'off'], AIDS_T = { auto: 'Ayudas 3D: según la tarea', on: 'Ayudas 3D: siempre', off: 'Ayudas 3D: ocultas' };
  function aidsBtn() {
    const b = $('#btnAids'); if (!b) return;
    const sync = () => { const m = LAB.app.world.aidsMode; b.title = AIDS_T[m] + ' (normal del panel, rayo solar, ángulo de incidencia, azimut)'; b.setAttribute('aria-label', b.title); b.classList.toggle('on', m === 'on'); b.classList.toggle('dim', m === 'off'); $('#aidsTxt').textContent = { auto: 'Auto', on: 'Sí', off: 'No' }[m]; };
    b.addEventListener('click', () => { const w = LAB.app.world; w.aidsMode = AIDS[(AIDS.indexOf(w.aidsMode) + 1) % 3]; safe(() => localStorage.setItem('labsolar.v2.aids', w.aidsMode)); sync(); LAB.ui.announce(AIDS_T[w.aidsMode]); });
    const saved = safe(() => localStorage.getItem('labsolar.v2.aids')); if (AIDS.includes(saved)) LAB.app.world.aidsMode = saved; sync();
  }

  LAB.ui.onboarding = {
    GLOSS, KIND,
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
