/* Pestaña "Corrida": la gráfica como herramienta de análisis (C15) y comparación de corridas (C12/C13).
 * Trabaja SIEMPRE sobre corridas registradas (objetos de dominio), no sobre la telemetría viva. */
(function () {
  'use strict';
  const { fmt, pad2, esc } = LAB.util;
  const SERIES = [
    { key: 'pA', get name() { return LAB.t('runview.p_modulo_a'); }, unit: 'W', color: LAB.config.palette.A, dash: [], axis: 'y', width: 2, dec: 1 },
    { key: 'pB', get name() { return LAB.t('runview.p_modulo_b'); }, unit: 'W', color: LAB.config.palette.B, dash: [], axis: 'y', width: 2, dec: 1 },
    { key: 'gA', get name() { return LAB.t('runview.g_plano_a'); }, unit: 'W/m²', color: '#9db3c8', dash: [2, 3], axis: 'y2', width: 1.4, dec: 0 },
    { key: 'gB', get name() { return LAB.t('runview.g_plano_b'); }, unit: 'W/m²', color: '#c4a7ff', dash: [6, 4], axis: 'y2', width: 1.4, dec: 0 },
  ];
  const KIND_COLOR = { seguridad: '#ff6b6b', carga: '#2fb4ff', seguimiento: '#ffb020', segmento: '#a98bff' };
  const PAGE = 20;
  const hmsOf = (ms) => { const l = LAB.localTime(ms); return `${pad2(l.hour)}:${pad2(l.minute)}:${pad2(l.second)}`; };
  const dayStr = (ms) => { const l = LAB.localTime(ms); return `${pad2(l.day)}/${pad2(l.month)}/${l.year}`; };
  const pct = (v) => (v == null ? LAB.t('runview.no_disponible') : (v >= 0 ? '+' : '') + fmt(v, 1) + ' %');
  const el = (tag, attrs, ...kids) => { const n = document.createElement(tag); Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v); }); kids.forEach((c) => c && n.append(c)); return n; };

  class RunView {
    constructor(root, hooks) {
      this.root = root; this.hooks = hooks;           // hooks: {getRuns():Promise<run[]>, download(text,name,mime), toast(msg,kind), announce(msg)}
      this.runs = []; this.runId = null; this.on = new Set(['pA', 'pB', 'gB']); this.view = null; this.scale = LAB.t('runview.auto'); this.cursor = null; this.page = 0; this.cmp = new Set(); this.annOn = true;
      this.build();
    }
    build() {
      const r = this.root; r.textContent = '';
      this.sel = el('select', { id: 'rvSelect', 'aria-label': LAB.t('runview.corrida_a_analizar') });
      this.sel.addEventListener('change', () => { this.runId = this.sel.value; this.view = null; this.cursor = null; this.page = 0; this.render(); });
      const tools = el('div', { class: 'rvtools', role: 'toolbar', 'aria-label': LAB.t('runview.zoom_y_desplazamiento_de') });
      const mk = (id, txt, label, fn) => { const b = el('button', { class: 'btn', type: 'button', id, 'aria-label': label, title: label, text: txt }); b.addEventListener('click', fn); tools.appendChild(b); return b; };
      mk('rvIn', '＋', LAB.t('runview.acercar_tecla'), () => this.zoom(0.5)); mk('rvOut', '－', LAB.t('runview.alejar_tecla'), () => this.zoom(2));
      mk('rvL', '◀', LAB.t('runview.desplazar_a_la_izquierda'), () => this.pan(-0.3)); mk('rvR', '▶', LAB.t('runview.desplazar_a_la_derecha'), () => this.pan(0.3));
      mk('rvReset', LAB.t('runview.todo'), LAB.t('runview.mostrar_toda_la_corrida'), () => { this.view = null; this.page = 0; this.render(); });
      this.scaleBtn = mk('rvScale', LAB.t('runview.escala_auto'), LAB.t('runview.alternar_escala_vertical_automatica'), () => { this.scale = this.scale === 'auto' ? 'fixed' : 'auto'; this.render(); });
      mk('rvPng', 'PNG', LAB.t('runview.exportar_la_grafica_como'), () => this.exportPng());
      mk('rvCsv', LAB.t('runview.csv_tramo'), LAB.t('runview.descargar_csv_del_tramo'), () => this.exportCsv());
      this.toggles = el('fieldset', { class: 'rvtoggles' }, el('legend', { text: LAB.t('runview.series') }));
      SERIES.forEach((s) => {
        const cb = el('input', { type: 'checkbox', id: 'rvS_' + s.key }); cb.checked = this.on.has(s.key);
        cb.addEventListener('change', () => { cb.checked ? this.on.add(s.key) : this.on.delete(s.key); this.render(); });
        const sw = el('i', { class: 'rvsw', 'aria-hidden': 'true' }); sw.style.borderTopColor = s.color; sw.style.borderTopStyle = s.dash.length ? (s.dash[0] <= 2 ? 'dotted' : 'dashed') : 'solid';
        this.toggles.appendChild(el('label', { for: 'rvS_' + s.key }, cb, sw, document.createTextNode(` ${s.name} (${s.unit})`)));
      });
      const annL = el('label', {}, (this.annCb = el('input', { type: 'checkbox', id: 'rvAnn' })), document.createTextNode(' Anotaciones')); this.annCb.checked = true;
      this.annCb.addEventListener('change', () => { this.annOn = this.annCb.checked; this.render(); }); this.toggles.appendChild(annL);
      this.empty = el('p', { class: 'rvempty', id: 'rvEmpty' });
      this.canvas = el('canvas', { id: 'rvCanvas', tabindex: '0', role: 'img', 'aria-label': LAB.t('runview.grafica_de_la_corrida') });
      this.chart = new LAB.ui.Chart(this.canvas);
      const box = el('div', { class: 'chartbox rvbox' }, this.canvas);
      this.axisNote = el('p', { class: 'hint', id: 'rvAxisNote' });
      this.readout = el('div', { class: 'rvreadout', id: 'rvReadout', 'aria-live': 'polite' });
      this.annList = el('details', { class: 'tablewrap', id: 'rvAnnList' }, el('summary', { text: LAB.t('runview.anotaciones_de_la_corrida') }));
      this.tableWrap = el('details', { class: 'tablewrap', id: 'rvTableWrap' }, el('summary', { text: LAB.t('runview.tabla_de_muestras_del') }));
      this.tableWrap.addEventListener('toggle', () => this.renderTable());
      this.summary = el('div', { id: 'rvSummary' });
      this.cmpWrap = el('details', { class: 'tablewrap', id: 'rvCmpWrap' }, el('summary', { text: LAB.t('runview.comparar_corridas_mismo_escenario') }));
      this.cmpWrap.addEventListener('toggle', () => this.renderCompare());
      r.append(el('label', { for: 'rvSelect', class: 'sr', text: LAB.t('runview.corrida') }), this.sel, tools, this.toggles, this.empty, box, this.axisNote, this.readout, this.annList, this.tableWrap, this.summary, this.cmpWrap);
      this.bindCanvas();
    }
    async refresh() {
      this.runs = (await this.hooks.getRuns()).filter((x) => x && x.samples);
      if (!this.runs.find((x) => x.id === this.runId)) this.runId = this.runs.length ? this.runs[this.runs.length - 1].id : null;
      this.sel.textContent = '';
      this.runs.slice().reverse().forEach((x) => { const o = el('option', { value: x.id, text: LAB.t('runview.muestras', { id: x.label || x.id, length: x.samples.length, status: x.status, practiceId: x.practiceId ? ' · ' + x.practiceId : '' }) }); this.sel.appendChild(o); });
      this.sel.value = this.runId || ''; this.sel.disabled = !this.runs.length;
      this.render();
    }
    get run() { return this.runs.find((x) => x.id === this.runId) || null; }
    // ------------------------------------------------------------------ datos
    prepare() {
      const run = this.run; if (!run || !run.samples.length) { this.D = null; return; }
      const S = LAB.core.runSeries(run), xs = [], idxMap = [], out = {}; SERIES.forEach((s) => (out[s.key] = []));
      for (let i = 0; i < S.simMs.length; i++) {
        if (i > 0 && S.seg[i] !== S.seg[i - 1]) { xs.push(NaN); idxMap.push(-1); SERIES.forEach((s) => out[s.key].push(NaN)); }   // un cambio de segmento no se une con línea
        xs.push(S.simMs[i]); idxMap.push(i); SERIES.forEach((s) => out[s.key].push(S[s.key][i]));
      }
      this.D = { S, xs, idxMap, out, t0: S.simMs[0], t1: S.simMs[S.simMs.length - 1], ann: LAB.core.runAnnotations(run) };
    }
    range() { const D = this.D; if (!this.view) return [D.t0, Math.max(D.t1, D.t0 + 1000)]; return this.view; }
    visibleIdx() { const D = this.D, [a, b] = this.range(), r = []; for (let i = 0; i < D.S.simMs.length; i++) if (D.S.simMs[i] >= a && D.S.simMs[i] <= b) r.push(i); return r; }
    zoom(f) {
      if (!this.D) return; const [a, b] = this.range(), c = this.cursor != null ? this.D.S.simMs[this.cursor] : (a + b) / 2, full = this.D.t1 - this.D.t0 || 1000;
      let w = Math.min(full, Math.max(10000, (b - a) * f)); let na = c - (c - a) * (w / (b - a)); na = Math.max(this.D.t0, Math.min(na, this.D.t1 - w)); this.view = w >= full - 1 ? null : [na, na + w]; this.page = 0; this.render();
    }
    pan(f) {
      if (!this.D || !this.view) return; const w = this.view[1] - this.view[0]; let na = this.view[0] + w * f; na = Math.max(this.D.t0, Math.min(na, this.D.t1 - w)); this.view = [na, na + w]; this.page = 0; this.render();
    }
    // --------------------------------------------------------------- render
    render() {
      this.prepare(); const run = this.run, D = this.D;
      this.empty.hidden = !!D;
      this.empty.textContent = !run ? LAB.t('runview.todavia_no_hay_corridas') : (!D ? LAB.t('runview.todavia_no_hay_muestras') : '');
      ['rvIn', 'rvOut', 'rvL', 'rvR', 'rvReset', 'rvScale', 'rvPng', 'rvCsv'].forEach((id) => { const b = this.root.querySelector('#' + id); if (b) b.disabled = !D; });
      this.canvas.parentElement.hidden = !D; this.readout.hidden = !D; this.axisNote.hidden = !D;
      this.annList.hidden = !D; this.tableWrap.hidden = !D;
      this.renderSummary(); this.renderCompare();
      if (!D) { this.annList.querySelectorAll('ul').forEach((u) => u.remove()); return; }
      this.draw(); this.renderReadout(); this.renderAnn(); this.renderTable();
    }
    draw() {
      const D = this.D, [a, b] = this.range(), vis = this.visibleIdx(), live = SERIES.filter((s) => this.on.has(s.key));
      const maxOf = (axis, from) => { let m = 0; live.filter((s) => s.axis === axis).forEach((s) => from.forEach((i) => { const v = D.S[s.key][i]; if (Number.isFinite(v) && v > m) m = v; })); return m; };
      const all = D.S.simMs.map((_, i) => i), src = this.scale === 'auto' ? vis : all;
      const ymax = LAB.ui.niceMax(Math.max(100, maxOf('y', src)) * 1.05), y2max = LAB.ui.niceMax(Math.max(200, maxOf('y2', src)));
      this.scaleBtn.textContent = LAB.t('runview.escala') + (this.scale === 'auto' ? LAB.t('runview.auto') : LAB.t('runview.fija'));
      this.axisNote.textContent = LAB.t('runview.eje_izquierdo_p_w', { ymax, y2max, t: this.scale === 'auto' ? LAB.t('runview.automatica_se_ajusta_al') : LAB.t('runview.fija_usa_toda_la'), hmsOf: hmsOf(a), hmsOf5: hmsOf(b), dayStr: dayStr(a) });
      const spec = {
        x: { min: a, max: b, fmt: (v) => hmsOf(v).slice(0, 5), ticks: 4 },
        y: { min: 0, max: ymax, label: 'P (W)', ticks: 4 }, y2: { min: 0, max: y2max, label: 'G (W/m²)', color: '#9db3c8', fmt: (v) => v.toFixed(0), ticks: 4 },
        series: live.map((s) => ({ xs: D.xs, ys: D.out[s.key], color: s.color, width: s.width, dash: s.dash.length ? s.dash : null, axis: s.axis })),
        legend: live.map((s) => ({ name: s.name, color: s.color, dash: s.dash.length > 0 })),
      };
      const g = this.chart.line(spec); this.geo = g; this.spec = spec;
      const ctx = this.chart.ctx;
      if (this.annOn) D.ann.forEach((an) => {
        const i = Math.min(an.n, D.S.simMs.length - 1); const t = D.S.simMs[i]; if (t < a || t > b) return;
        const x = g.X(t); ctx.save(); ctx.strokeStyle = KIND_COLOR[an.kind] || '#e7f1fb'; ctx.globalAlpha = 0.75; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x, g.padT + 14); ctx.lineTo(x, g.padT + g.ih); ctx.stroke(); ctx.restore();
        ctx.fillStyle = KIND_COLOR[an.kind] || '#e7f1fb'; ctx.beginPath(); ctx.moveTo(x - 4, g.padT + 14); ctx.lineTo(x + 4, g.padT + 14); ctx.lineTo(x, g.padT + 21); ctx.closePath(); ctx.fill();
      });
      if (this.cursor != null) {
        const t = D.S.simMs[this.cursor]; if (t >= a && t <= b) {
          const x = g.X(t); ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, g.padT); ctx.lineTo(x, g.padT + g.ih); ctx.stroke();
          live.forEach((s) => { const v = D.S[s.key][this.cursor]; if (!Number.isFinite(v)) return; ctx.fillStyle = s.color; ctx.strokeStyle = '#06101a'; ctx.beginPath(); ctx.arc(x, g.Y(v, s.axis), 3.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); });
        }
      }
    }
    renderReadout() {
      const D = this.D, run = this.run; if (this.cursor == null) { this.readout.textContent = LAB.t('runview.pasa_el_puntero_toca'); return; }
      const i = this.cursor, S = D.S, idx = {}; (run.cols || LAB.core.RUN_COLS).forEach((c, k) => (idx[c] = k)); const row = run.samples[i];
      const parts = SERIES.map((s) => `${s.name} ${Number.isFinite(S[s.key][i]) ? fmt(S[s.key][i], s.dec) : '—'} ${s.unit}${this.on.has(s.key) ? '' : ' (oculta)'}`);
      this.readout.textContent = LAB.t('runview.muestra_segmento_modulo_b', { i, hmsOf: hmsOf(S.simMs[i]), dayStr: dayStr(S.simMs[i]), i4: S.seg[i], join: parts.join(' · '), fmt: fmt(S.azB[i], 0), fmt7: fmt(S.tiltB[i], 0), loadMode: row[idx.loadMode], trMode: row[idx.trMode], safety: row[idx.safety] });
    }
    setCursorFromX(px) {
      if (!this.D || !this.geo) return; const g = this.geo, [a, b] = this.range(), t = a + ((px - g.padL) / g.iw) * (b - a), S = this.D.S.simMs; let best = -1, bd = Infinity;
      this.visibleIdx().forEach((i) => { const d = Math.abs(S[i] - t); if (d < bd) { bd = d; best = i; } }); if (best >= 0) { this.cursor = best; this.draw(); this.renderReadout(); }
    }
    bindCanvas() {
      const c = this.canvas; let drag = null;
      const lx = (e) => e.clientX - c.getBoundingClientRect().left;
      c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, v: this.view && this.view.slice(), moved: false }; c.setPointerCapture && c.setPointerCapture(e.pointerId); this.setCursorFromX(lx(e)); });
      c.addEventListener('pointermove', (e) => {
        if (drag && this.view && Math.abs(e.clientX - drag.x) > 6) { drag.moved = true; const w = drag.v[1] - drag.v[0], dt = -((e.clientX - drag.x) / this.geo.iw) * w; let na = drag.v[0] + dt; na = Math.max(this.D.t0, Math.min(na, this.D.t1 - w)); this.view = [na, na + w]; this.draw(); }
        else if (!drag || !drag.moved) this.setCursorFromX(lx(e));
      });
      c.addEventListener('pointerup', () => { if (drag && drag.moved) this.render(); drag = null; });
      c.addEventListener('wheel', (e) => { if (!this.D) return; e.preventDefault(); this.setCursorFromX(lx(e)); this.zoom(e.deltaY < 0 ? 0.6 : 1.6); }, { passive: false });
      c.addEventListener('keydown', (e) => {
        if (!this.D) return; const vis = this.visibleIdx(); if (!vis.length) return; let k = this.cursor == null ? vis[0] : this.cursor, handled = true;
        const step = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowRight') k = Math.min(this.D.S.simMs.length - 1, k + step); else if (e.key === 'ArrowLeft') k = Math.max(0, k - step);
        else if (e.key === 'Home') k = vis[0]; else if (e.key === 'End') k = vis[vis.length - 1];
        else if (e.key === '+' || e.key === '=') { this.cursor = k; this.zoom(0.5); return e.preventDefault(); } else if (e.key === '-' || e.key === '_') { this.cursor = k; this.zoom(2); return e.preventDefault(); } else handled = false;
        if (!handled) return; e.preventDefault(); this.cursor = k; const t = this.D.S.simMs[k], [a, b] = this.range(); if (t < a || t > b) { const w = b - a; this.view = [Math.max(this.D.t0, Math.min(t - w / 2, this.D.t1 - w)), 0]; this.view[1] = this.view[0] + w; }
        this.draw(); this.renderReadout();
      });
      if (window.ResizeObserver) new ResizeObserver(() => { if (this.D && this.canvas.offsetParent) this.draw(); }).observe(c.parentElement);
    }
    // ------------------------------------------------------- anotaciones/tabla
    renderAnn() {
      const d = this.annList; d.querySelectorAll('ul,p').forEach((u) => u.remove()); const an = this.D.ann;
      d.querySelector('summary').textContent = LAB.t('runview.anotaciones_de_la_corrida_2', { length: an.length });
      if (!an.length) return d.appendChild(el('p', { class: 'hint', text: LAB.t('runview.sin_eventos_no_hubo') }));
      const ul = el('ul', { class: 'rvann' });
      an.slice(0, 200).forEach((a) => { const i = Math.min(a.n, this.D.S.simMs.length - 1); const b = el('button', { class: 'btn', type: 'button', text: `${hmsOf(this.D.S.simMs[i])} · ${LAB.tk('ev.kind.', a.kind)}: ${LAB.tm(a.text)}` }); b.addEventListener('click', () => { this.cursor = i; const [x0, x1] = this.range(), t = this.D.S.simMs[i]; if (t < x0 || t > x1) this.view = null; this.render(); this.canvas.focus(); }); ul.appendChild(el('li', {}, b)); });
      d.appendChild(ul); if (an.length > 200) d.appendChild(el('p', { class: 'hint', text: LAB.t('runview.se_muestran_200_de', { length: an.length }) }));
    }
    renderTable() {
      const w = this.tableWrap; if (!this.D || !w.open) return; w.querySelectorAll('table,div.rvpager').forEach((x) => x.remove());
      const vis = this.visibleIdx(), pages = Math.max(1, Math.ceil(vis.length / PAGE)); this.page = Math.min(this.page, pages - 1);
      const run = this.run, idx = {}; (run.cols || LAB.core.RUN_COLS).forEach((c, k) => (idx[c] = k));
      const t = el('table', { class: 'mini' }, el('caption', { text: LAB.t('runview.muestras_de_la_corrida', { v: vis.length ? vis[this.page * PAGE] : 0, v2: vis.length ? vis[Math.min(vis.length - 1, this.page * PAGE + PAGE - 1)] : 0, v3: this.page + 1, pages }) }));
      const head = ['n', LAB.t('runview.hora'), LAB.t('runview.seg'), 'P A (W)', 'P B (W)', 'G A (W/m²)', 'G B (W/m²)', LAB.t('runview.carga'), LAB.t('runview.seguimiento')]; const tr = el('tr'); head.forEach((h) => tr.appendChild(el('th', { scope: 'col', text: h }))); t.appendChild(tr);
      vis.slice(this.page * PAGE, this.page * PAGE + PAGE).forEach((i) => { const r = run.samples[i], row = el('tr'); [i, hmsOf(r[idx.simMs]), r[idx.segmentId], fmt(r[idx.pA], 1), fmt(r[idx.pB], 1), fmt(r[idx.gA], 0), fmt(r[idx.gB], 0), r[idx.loadMode], r[idx.trMode]].forEach((v) => row.appendChild(el('td', { text: String(v) }))); t.appendChild(row); });
      const pager = el('div', { class: 'rvpager row3' }), pv = el('button', { class: 'btn', type: 'button', text: LAB.t('runview.anterior') }), nx = el('button', { class: 'btn', type: 'button', text: LAB.t('runview.siguiente') });
      pv.disabled = this.page === 0; nx.disabled = this.page >= pages - 1; pv.addEventListener('click', () => { this.page--; this.renderTable(); }); nx.addEventListener('click', () => { this.page++; this.renderTable(); }); pager.append(pv, nx);
      w.append(t, pager);
    }
    // ------------------------------------------------------- resumen / comparar
    renderSummary() {
      const box = this.summary; box.textContent = ''; const run = this.run; if (!run || !run.samples.length) return;
      const s = LAB.core.runSummary(run);
      const t = el('table', { class: 'mini', id: 'rvSumTable' }, el('caption', { text: LAB.t('runview.resumen_de', { id: run.label || run.id }) }));
      const rows = [[LAB.t('runview.e_a_modulo_a'), s.hasEnergy ? fmt(s.EA, 1) + ' Wh' : LAB.t('runview.no_disponible')], [LAB.t('runview.e_b_modulo_b'), s.hasEnergy ? fmt(s.EB, 1) + ' Wh' : LAB.t('runview.no_disponible')], [LAB.t('runview.consumo_de_motores'), s.hasEnergy ? fmt(s.motorWh, 1) + ' Wh' : LAB.t('runview.no_disponible')],
        [LAB.t('runview.ganancia_de_energia_de'), pct(s.grossPct)], [LAB.t('runview.ganancia_neta_e_b'), pct(s.netPct)]];
      rows.forEach(([k, v]) => t.appendChild(el('tr', {}, el('th', { scope: 'row', text: k }), el('td', { text: v }))));
      box.appendChild(t);
      const notes = [s.grossNote, s.netNote].filter(Boolean); if (notes.length) box.appendChild(el('p', { class: 'hint', text: LAB.tm(notes[0]) }));
      box.appendChild(el('p', { class: 'hint', text: LAB.t('runview.periodo_del_suma_de', { hmsOf: hmsOf(s.t0), hmsOf2: hmsOf(s.t1), dayStr: dayStr(s.t0), segments: s.segments }) }));
      if (s.altered.length) box.appendChild(el('p', { class: 'hint warn', text: LAB.t('runview.corrida_alterada_no_apta') + s.altered.map(LAB.tm).join('; ') + '.' }));
    }
    renderCompare() {
      const w = this.cmpWrap; w.querySelectorAll('.rvcmp').forEach((x) => x.remove()); if (!w.open) return;
      const box = el('div', { class: 'rvcmp' }); const list = el('fieldset', { class: 'rvtoggles' }, el('legend', { text: LAB.t('runview.corridas_a_comparar_elige') }));
      this.runs.filter((r) => r.samples.length).forEach((r) => { const cb = el('input', { type: 'checkbox', id: 'rvC_' + r.id }); cb.checked = this.cmp.has(r.id); cb.addEventListener('change', () => { cb.checked ? this.cmp.add(r.id) : this.cmp.delete(r.id); this.renderCompare(); }); list.appendChild(el('label', { for: 'rvC_' + r.id }, cb, document.createTextNode(LAB.t('runview.muestras_2', { id: r.label || r.id, length: r.samples.length })))); });
      box.appendChild(list);
      const chosen = this.runs.filter((r) => this.cmp.has(r.id));
      if (chosen.length < 2) box.appendChild(el('p', { class: 'hint', text: LAB.t('runview.elige_al_menos_dos') }));
      else {
        const cmp = LAB.core.compareRuns(chosen), sums = chosen.map(LAB.core.runSummary);
        const t = el('table', { class: 'mini', id: 'rvCmpTable' }, el('caption', { text: LAB.t('runview.e_en_wh_ganancia') }));
        const tr = el('tr'); [LAB.t('runview.corrida'), LAB.t('runview.seguimiento'), 'E_A (Wh)', 'E_B (Wh)', LAB.t('runview.motores_wh'), LAB.t('runview.ganancia_de_energia'), LAB.t('runview.ganancia_neta'), LAB.t('runview.estado')].forEach((h) => tr.appendChild(el('th', { scope: 'col', text: h }))); t.appendChild(tr);
        sums.forEach((s, k) => { const c = cmp.conds[k], ok = !s.altered.length; const row = el('tr', ok ? {} : { class: 'bad' }); [chosen[k].label || s.id, `${c.trackerMode || '—'}${c.lockAz ? LAB.t('runview.az_fijo') : ''}${c.lockTilt ? LAB.t('runview.incl_fija') : ''}`, s.hasEnergy ? fmt(s.EA, 0) : '—', s.hasEnergy ? fmt(s.EB, 0) : '—', s.hasEnergy ? fmt(s.motorWh, 1) : '—', pct(s.grossPct), pct(s.netPct), ok ? LAB.t('runview.valida') : LAB.t('runview.alterada') + s.altered.map(LAB.tm).join('; ')].forEach((v) => row.appendChild(el('td', { text: v }))); t.appendChild(row); });
        box.appendChild(t);
        box.appendChild(el('p', { class: 'hint' + (cmp.comparable ? '' : ' warn'), id: 'rvCmpVerdict', text: cmp.comparable ? LAB.t('runview.comparacion_valida_mismo_escenario', { t: cmp.conds[0].scenarioId || LAB.t('runview.sin_escenario'), day: cmp.conds[0].day, seed: cmp.conds[0].seed, ninguna: cmp.varied.map(LAB.tm).join(LAB.t('runview.y')) || LAB.t('runview.ninguna') }) : LAB.t('runview.estas_corridas_no_forman') + [cmp.differs.length ? LAB.t('runview.difieren_en') + cmp.differs.map(LAB.tm).join(', ') + LAB.t('runview.son_experimentos_distintos') : '', cmp.altered.length ? LAB.t('runview.hay_corridas_alteradas_o') : ''].filter(Boolean).join('; ') + '.' }));
      }
      w.appendChild(box);
    }
    // --------------------------------------------------------------- exportar
    exportPng() {
      if (!this.D) return; const run = this.run, src = this.canvas, pad = 44, c = document.createElement('canvas'); c.width = src.width; c.height = src.height + pad * (src.width / this.chart.w);
      const k = src.width / this.chart.w, ctx = c.getContext('2d'); ctx.fillStyle = '#0b1622'; ctx.fillRect(0, 0, c.width, c.height); ctx.fillStyle = '#e7f1fb'; ctx.font = `${12 * k}px sans-serif`; ctx.textBaseline = 'top';
      const [a, b] = this.range(); ctx.fillText(LAB.t('runview.laboratorio_solar_unach_modo', { id: run.label || run.id }), 8 * k, 6 * k); ctx.fillStyle = '#9db3c8'; ctx.fillText(LAB.t('runview.tramo_del_escala_muestras', { hmsOf: hmsOf(a), hmsOf2: hmsOf(b), dayStr: dayStr(a), t: this.scale === 'auto' ? LAB.t('runview.automatica') : LAB.t('runview.fija'), length: run.samples.length }), 8 * k, 24 * k);
      ctx.drawImage(src, 0, pad * k);
      c.toBlob((blob) => { if (!blob) return this.hooks.toast(LAB.t('runview.el_navegador_no_pudo'), 'warn'); const a2 = document.createElement('a'); a2.href = URL.createObjectURL(blob); a2.download = `lab-solar-unach_${run.id}.png`; document.body.appendChild(a2); a2.click(); a2.remove(); setTimeout(() => URL.revokeObjectURL(a2.href), 2000); this.hooks.toast(LAB.t('runview.imagen_png_descargada'), 'ok'); }, 'image/png');
    }
    exportCsv() {
      if (!this.D) return; const vis = this.visibleIdx(); if (!vis.length) return this.hooks.toast(LAB.t('runview.no_hay_muestras_en'), 'warn');
      const run = this.run, text = LAB.core.runSliceCsv(run, vis[0], vis[vis.length - 1]); this.hooks.download(text, `lab-solar-unach_${run.id}_${vis[0]}-${vis[vis.length - 1]}.csv`, 'text/csv;charset=utf-8'); this.hooks.toast(LAB.t('runview.descargadas_muestras_del_tramo', { length: vis.length }), 'ok');
    }
    // para pruebas
    select(id) { this.runId = id; this.sel.value = id; this.view = null; this.cursor = null; this.render(); }
  }
  LAB.ui.RunView = RunView;
  void esc;
})();
