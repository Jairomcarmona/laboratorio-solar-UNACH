/* Distribucion de la interfaz (C01). Una sola politica, medida sobre el tamano real de la ventana en px CSS
 * (el zoom del navegador ya esta incluido: 200 % en 1920x1080 equivale a 960x540):
 *   wide   ancho >= 1360 y alto >= 600  controles | escena | datos
 *   medium ancho >= 900  y alto >= 560  panel lateral con pestanas | escena
 *   narrow en otro caso                 una seccion a la vez con barra inferior
 * La escena 3D se redimensiona con su contenedor (ResizeObserver en main.js). Los separadores se pueden mover
 * con el puntero y con el teclado. */
(function () {
  'use strict';
  const ui = LAB.ui;
  const $ = (s) => document.querySelector(s);
  const root = document.documentElement, body = document.body;
  const LIM = { wL: [240, 460, 300], wR: [280, 560, 360], wS: [280, 520, 360] };
  const KEY = 'labsolar.v2.layout';
  let layout = '', view = 'controls';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } })();
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* sin almacenamiento: el ancho no se recuerda */ } };

  function classify(w, h) {
    if (w >= 1360 && h >= 600) return 'wide';
    if (w >= 900 && h >= 560) return 'medium';
    return 'narrow';
  }
  function setVar(name, v) { root.style.setProperty('--' + name, v + 'px'); }
  function clampW(key, v, avail) { const [lo, hi] = LIM[key]; return Math.round(Math.max(lo, Math.min(hi, avail != null ? Math.min(v, avail) : v))); }

  function apply() {
    const w = window.innerWidth, h = window.innerHeight, next = classify(w, h);
    if (next !== layout) {
      layout = next; body.dataset.layout = layout;
      if (layout === 'wide') { /* la vista deja de importar */ }
      else if (layout === 'medium' && view === 'scene') view = 'controls';
      moveGuide();
    }
    // los anchos guardados se recortan para que la escena conserve al menos 320 px
    const room = w - 20 - 20 - 320;
    if (layout === 'wide') { const a = clampW('wL', saved.wL || LIM.wL[2]), b = clampW('wR', saved.wR || LIM.wR[2]); const over = a + b - room; setVar('wL', over > 0 ? Math.max(LIM.wL[0], a - Math.ceil(over / 2)) : a); setVar('wR', over > 0 ? Math.max(LIM.wR[0], b - Math.ceil(over / 2)) : b); }
    if (layout === 'medium') setVar('wS', clampW('wS', saved.wS || LIM.wS[2], room + 40));
    body.dataset.view = view;
    syncTabs(); syncSeps();
  }

  function moveGuide() {
    const g = $('#practiceGuide'), mid = $('#midcol'), hold = $('#practiceHolder');
    if (!g) return;
    const target = layout === 'wide' ? mid : hold;
    if (g.parentElement !== target) { if (layout === 'wide') mid.insertBefore(g, mid.firstChild); else hold.appendChild(g); }
  }

  function setView(v) { if (layout === 'wide') return; if (layout === 'medium' && v === 'scene') v = 'controls'; view = v; body.dataset.view = v; syncTabs(); }
  function syncTabs() {
    document.querySelectorAll('#viewtabs [role=tab]').forEach((t) => { const on = t.dataset.view === view; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
  }

  // ----- separadores
  function sepKey(id) { return id === 'sepR' ? 'wR' : (layout === 'medium' ? 'wS' : 'wL'); }
  function cur(key) { const v = parseInt(getComputedStyle(root).getPropertyValue('--' + key), 10); return Number.isFinite(v) ? v : LIM[key][2]; }
  function syncSeps() {
    ['sepL', 'sepR'].forEach((id) => {
      const el = document.getElementById(id), k = sepKey(id), [lo, hi] = LIM[k];
      el.setAttribute('aria-valuemin', String(lo)); el.setAttribute('aria-valuemax', String(hi)); el.setAttribute('aria-valuenow', String(cur(k)));
      el.setAttribute('aria-valuetext', LAB.t('layout.pixeles', { cur: cur(k) }));
    });
  }
  function resizeTo(id, px) {
    const k = sepKey(id), w = window.innerWidth, room = w - 20 - 20 - 320 - (k === 'wL' ? cur('wR') : k === 'wR' ? cur('wL') : 0);
    const v = clampW(k, px, Math.max(LIM[k][0], room));
    saved[k] = v; setVar(k, v); persist(); syncSeps(); window.dispatchEvent(new Event('resize'));
  }
  function bindSep(id) {
    const el = document.getElementById(id);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('drag');
      const x0 = e.clientX, k = sepKey(id), w0 = cur(k), dir = id === 'sepR' ? -1 : 1;
      const mv = (ev) => resizeTo(id, w0 + dir * (ev.clientX - x0));
      const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
    el.addEventListener('keydown', (e) => {
      const k = sepKey(id), step = e.shiftKey ? 48 : 16, dir = id === 'sepR' ? -1 : 1;
      let v = null;
      if (e.key === 'ArrowLeft') v = cur(k) - dir * step; else if (e.key === 'ArrowRight') v = cur(k) + dir * step;
      else if (e.key === 'Home') v = LIM[k][0]; else if (e.key === 'End') v = LIM[k][1]; else if (e.key === 'Enter') v = LIM[k][2];
      if (v == null) return; e.preventDefault(); resizeTo(id, v);
    });
    el.addEventListener('dblclick', () => resizeTo(id, LIM[sepKey(id)][2]));
  }

  ui.layout = {
    init() {
      bindSep('sepL'); bindSep('sepR');
      const bar = $('#viewtabs');
      bar.addEventListener('click', (e) => { const t = e.target.closest('[role=tab]'); if (t) setView(t.dataset.view); });
      bar.addEventListener('keydown', (e) => {
        const tabs = Array.from(bar.querySelectorAll('[role=tab]')).filter((t) => t.offsetParent !== null), i = tabs.indexOf(document.activeElement);
        if (i < 0) return;
        let j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length; else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = tabs.length - 1;
        if (j == null) return; e.preventDefault(); tabs[j].focus(); setView(tabs[j].dataset.view);
      });
      $('#btnPracticesSide').addEventListener('click', () => $('#btnPractices').click());
      window.addEventListener('resize', apply);
      if (window.ResizeObserver) new ResizeObserver(apply).observe(root);
      apply();
    },
    get: () => layout, view: () => view, setView, apply,
    /** Una guia recien abierta se muestra donde corresponde: en pantallas pequenas, en su seccion */
    onGuideShown() { moveGuide(); if (layout !== 'wide') { setView('practice'); } },
    focusGuide() { const t = document.querySelector('#practiceGuide h3'); if (t) { t.tabIndex = -1; t.focus(); } },
  };
})();
