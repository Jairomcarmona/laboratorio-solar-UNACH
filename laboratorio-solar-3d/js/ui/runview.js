/* Pestaña "Corrida": la gráfica como herramienta de análisis (C15) y comparación de corridas (C12/C13).
 * Trabaja SIEMPRE sobre corridas registradas (objetos de dominio), no sobre la telemetría viva. */
(function () {
  'use strict';
  const { fmt, pad2, esc } = LAB.util;
  const SERIES = [
    { key: 'pA', name: 'P módulo A', unit: 'W', color: '#35d07f', dash: [], axis: 'y', width: 2, dec: 1 },
    { key: 'pB', name: 'P módulo B', unit: 'W', color: '#ffb020', dash: [], axis: 'y', width: 2, dec: 1 },
    { key: 'gA', name: 'G plano A', unit: 'W/m²', color: '#9db3c8', dash: [2, 3], axis: 'y2', width: 1.4, dec: 0 },
    { key: 'gB', name: 'G plano B', unit: 'W/m²', color: '#c4a7ff', dash: [6, 4], axis: 'y2', width: 1.4, dec: 0 },
  ];
  const KIND_COLOR = { seguridad: '#ff6b6b', carga: '#2fb4ff', seguimiento: '#ffb020', segmento: '#a98bff' };
  const PAGE = 20;
  const hmsOf = (ms) => { const l = LAB.localTime(ms); return `${pad2(l.hour)}:${pad2(l.minute)}:${pad2(l.second)}`; };
  const dayStr = (ms) => { const l = LAB.localTime(ms); return `${pad2(l.day)}/${pad2(l.month)}/${l.year}`; };
  const pct = (v) => (v == null ? 'No disponible' : (v >= 0 ? '+' : '') + fmt(v, 1) + ' %');
  const el = (tag, attrs, ...kids) => { const n = document.createElement(tag); Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v); }); kids.forEach((c) => c && n.append(c)); return n; };

  class RunView {
    constructor(root, hooks) {
      this.root = root; this.hooks = hooks;           // hooks: {getRuns():Promise<run[]>, download(text,name,mime), toast(msg,kind), announce(msg)}
      this.runs = []; this.runId = null; this.on = new Set(['pA', 'pB', 'gB']); this.view = null; this.scale = 'auto'; this.cursor = null; this.page = 0; this.cmp = new Set(); this.annOn = true;
      this.build();
    }
    build() {
      const r = this.root; r.textContent = '';
      this.sel = el('select', { id: 'rvSelect', 'aria-label': 'Corrida a analizar' });
      this.sel.addEventListener('change', () => { this.runId = this.sel.value; this.view = null; this.cursor = null; this.page = 0; this.render(); });
      const tools = el('div', { class: 'rvtools', role: 'toolbar', 'aria-label': 'Zoom y desplazamiento de la gráfica' });
      const mk = (id, txt, label, fn) => { const b = el('button', { class: 'btn', type: 'button', id, 'aria-label': label, title: label, text: txt }); b.addEventListener('click', fn); tools.appendChild(b); return b; };
      mk('rvIn', '＋', 'Acercar (tecla +)', () => this.zoom(0.5)); mk('rvOut', '－', 'Alejar (tecla −)', () => this.zoom(2));
      mk('rvL', '◀', 'Desplazar a la izquierda (flecha con Mayús)', () => this.pan(-0.3)); mk('rvR', '▶', 'Desplazar a la derecha', () => this.pan(0.3));
      mk('rvReset', 'Todo', 'Mostrar toda la corrida', () => { this.view = null; this.page = 0; this.render(); });
      this.scaleBtn = mk('rvScale', 'Escala: auto', 'Alternar escala vertical automática o fija', () => { this.scale = this.scale === 'auto' ? 'fixed' : 'auto'; this.render(); });
      mk('rvPng', 'PNG', 'Exportar la gráfica como imagen PNG', () => this.exportPng());
      mk('rvCsv', 'CSV tramo', 'Descargar CSV del tramo visible', () => this.exportCsv());
      this.toggles = el('fieldset', { class: 'rvtoggles' }, el('legend', { text: 'Series' }));
      SERIES.forEach((s) => {
        const cb = el('input', { type: 'checkbox', id: 'rvS_' + s.key }); cb.checked = this.on.has(s.key);
        cb.addEventListener('change', () => { cb.checked ? this.on.add(s.key) : this.on.delete(s.key); this.render(); });
        const sw = el('i', { class: 'rvsw', 'aria-hidden': 'true' }); sw.style.borderTopColor = s.color; sw.style.borderTopStyle = s.dash.length ? (s.dash[0] <= 2 ? 'dotted' : 'dashed') : 'solid';
        this.toggles.appendChild(el('label', { for: 'rvS_' + s.key }, cb, sw, document.createTextNode(` ${s.name} (${s.unit})`)));
      });
      const annL = el('label', {}, (this.annCb = el('input', { type: 'checkbox', id: 'rvAnn' })), document.createTextNode(' Anotaciones')); this.annCb.checked = true;
      this.annCb.addEventListener('change', () => { this.annOn = this.annCb.checked; this.render(); }); this.toggles.appendChild(annL);
      this.empty = el('p', { class: 'rvempty', id: 'rvEmpty' });
      this.canvas = el('canvas', { id: 'rvCanvas', tabindex: '0', role: 'img', 'aria-label': 'Gráfica de la corrida. Con la gráfica enfocada: flechas mueven el cursor, más y menos acercan y alejan, Inicio y Fin saltan a los extremos.' });
      this.chart = new LAB.ui.Chart(this.canvas);
      const box = el('div', { class: 'chartbox rvbox' }, this.canvas);
      this.axisNote = el('p', { class: 'hint', id: 'rvAxisNote' });
      this.readout = el('div', { class: 'rvreadout', id: 'rvReadout', 'aria-live': 'polite' });
      this.annList = el('details', { class: 'tablewrap', id: 'rvAnnList' }, el('summary', { text: 'Anotaciones de la corrida' }));
      this.tableWrap = el('details', { class: 'tablewrap', id: 'rvTableWrap' }, el('summary', { text: 'Tabla de muestras del tramo visible' }));
      this.tableWrap.addEventListener('toggle', () => this.renderTable());
      this.summary = el('div', { id: 'rvSummary' });
      this.cmpWrap = el('details', { class: 'tablewrap', id: 'rvCmpWrap' }, el('summary', { text: 'Comparar corridas (mismo escenario)' }));
      this.cmpWrap.addEventListener('toggle', () => this.renderCompare());
      r.append(el('label', { for: 'rvSelect', class: 'sr', text: 'Corrida' }), this.sel, tools, this.toggles, this.empty, box, this.axisNote, this.readout, this.annList, this.tableWrap, this.summary, this.cmpWrap);
      this.bindCanvas();
    }
    async refresh() {
      this.runs = (await this.hooks.getRuns()).filter((x) => x && x.samples);
      if (!this.runs.find((x) => x.id === this.runId)) this.runId = this.runs.length ? this.runs[this.runs.length - 1].id : null;
      this.sel.textContent = '';
      this.runs.slice().reverse().forEach((x) => { const o = el('option', { value: x.id, text: `${x.label || x.id} · ${x.samples.length} muestras · ${x.status}${x.practiceId ? ' · ' + x.practiceId : ''}` }); this.sel.appendChild(o); });
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
      this.empty.textContent = !run ? 'Todavía no hay corridas. Inicia una sesión y pulsa «Iniciar adquisición» para registrar muestras.' : (!D ? 'Todavía no hay muestras en esta corrida; inicia la adquisición.' : '');
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
      this.scaleBtn.textContent = 'Escala: ' + (this.scale === 'auto' ? 'auto' : 'fija');
      this.axisNote.textContent = `Eje izquierdo P (W): 0–${ymax} · Eje derecho G (W/m²): 0–${y2max} · escala ${this.scale === 'auto' ? 'automática (se ajusta al tramo visible)' : 'fija (usa toda la corrida)'}. Tramo: ${hmsOf(a)}–${hmsOf(b)} del ${dayStr(a)} (hora local simulada).`;
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
      const D = this.D, run = this.run; if (this.cursor == null) { this.readout.textContent = 'Pasa el puntero, toca la gráfica o usa las flechas para leer una muestra.'; return; }
      const i = this.cursor, S = D.S, idx = {}; (run.cols || LAB.core.RUN_COLS).forEach((c, k) => (idx[c] = k)); const row = run.samples[i];
      const parts = SERIES.map((s) => `${s.name} ${Number.isFinite(S[s.key][i]) ? fmt(S[s.key][i], s.dec) : '—'} ${s.unit}${this.on.has(s.key) ? '' : ' (oculta)'}`);
      this.readout.textContent = `Muestra ${i} · ${hmsOf(S.simMs[i])} ${dayStr(S.simMs[i])} · segmento ${S.seg[i]} · ${parts.join(' · ')} · módulo B ${fmt(S.azB[i], 0)}°/${fmt(S.tiltB[i], 0)}° · carga ${row[idx.loadMode]} · seguimiento ${row[idx.trMode]} · seguridad ${row[idx.safety]}`;
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
      d.querySelector('summary').textContent = `Anotaciones de la corrida (${an.length})`;
      if (!an.length) return d.appendChild(el('p', { class: 'hint', text: 'Sin eventos: no hubo cambios de carga, seguimiento, seguridad ni segmentos.' }));
      const ul = el('ul', { class: 'rvann' });
      an.slice(0, 200).forEach((a) => { const i = Math.min(a.n, this.D.S.simMs.length - 1); const b = el('button', { class: 'btn', type: 'button', text: `${hmsOf(this.D.S.simMs[i])} · ${a.kind}: ${a.text}` }); b.addEventListener('click', () => { this.cursor = i; const [x0, x1] = this.range(), t = this.D.S.simMs[i]; if (t < x0 || t > x1) this.view = null; this.render(); this.canvas.focus(); }); ul.appendChild(el('li', {}, b)); });
      d.appendChild(ul); if (an.length > 200) d.appendChild(el('p', { class: 'hint', text: `Se muestran 200 de ${an.length}.` }));
    }
    renderTable() {
      const w = this.tableWrap; if (!this.D || !w.open) return; w.querySelectorAll('table,div.rvpager').forEach((x) => x.remove());
      const vis = this.visibleIdx(), pages = Math.max(1, Math.ceil(vis.length / PAGE)); this.page = Math.min(this.page, pages - 1);
      const run = this.run, idx = {}; (run.cols || LAB.core.RUN_COLS).forEach((c, k) => (idx[c] = k));
      const t = el('table', { class: 'mini' }, el('caption', { text: `Muestras ${vis.length ? vis[this.page * PAGE] : 0}–${vis.length ? vis[Math.min(vis.length - 1, this.page * PAGE + PAGE - 1)] : 0} de la corrida · página ${this.page + 1} de ${pages}` }));
      const head = ['n', 'Hora', 'Seg.', 'P A (W)', 'P B (W)', 'G A (W/m²)', 'G B (W/m²)', 'Carga', 'Seguimiento']; const tr = el('tr'); head.forEach((h) => tr.appendChild(el('th', { scope: 'col', text: h }))); t.appendChild(tr);
      vis.slice(this.page * PAGE, this.page * PAGE + PAGE).forEach((i) => { const r = run.samples[i], row = el('tr'); [i, hmsOf(r[idx.simMs]), r[idx.segmentId], fmt(r[idx.pA], 1), fmt(r[idx.pB], 1), fmt(r[idx.gA], 0), fmt(r[idx.gB], 0), r[idx.loadMode], r[idx.trMode]].forEach((v) => row.appendChild(el('td', { text: String(v) }))); t.appendChild(row); });
      const pager = el('div', { class: 'rvpager row3' }), pv = el('button', { class: 'btn', type: 'button', text: '◀ Anterior' }), nx = el('button', { class: 'btn', type: 'button', text: 'Siguiente ▶' });
      pv.disabled = this.page === 0; nx.disabled = this.page >= pages - 1; pv.addEventListener('click', () => { this.page--; this.renderTable(); }); nx.addEventListener('click', () => { this.page++; this.renderTable(); }); pager.append(pv, nx);
      w.append(t, pager);
    }
    // ------------------------------------------------------- resumen / comparar
    renderSummary() {
      const box = this.summary; box.textContent = ''; const run = this.run; if (!run || !run.samples.length) return;
      const s = LAB.core.runSummary(run);
      const t = el('table', { class: 'mini', id: 'rvSumTable' }, el('caption', { text: `Resumen de ${run.label || run.id}` }));
      const rows = [['E_A (módulo A, referencia)', s.hasEnergy ? fmt(s.EA, 1) + ' Wh' : 'No disponible'], ['E_B (módulo B)', s.hasEnergy ? fmt(s.EB, 1) + ' Wh' : 'No disponible'], ['Consumo de motores', s.hasEnergy ? fmt(s.motorWh, 1) + ' Wh' : 'No disponible'],
        ['Ganancia de energía de esta corrida = (E_B/E_A − 1)×100', pct(s.grossPct)], ['Ganancia neta = ((E_B − motores)/E_A − 1)×100', pct(s.netPct)]];
      rows.forEach(([k, v]) => t.appendChild(el('tr', {}, el('th', { scope: 'row', text: k }), el('td', { text: v }))));
      box.appendChild(t);
      const notes = [s.grossNote, s.netNote].filter(Boolean); if (notes.length) box.appendChild(el('p', { class: 'hint', text: notes[0] }));
      box.appendChild(el('p', { class: 'hint', text: `Periodo: ${hmsOf(s.t0)}–${hmsOf(s.t1)} del ${dayStr(s.t0)}, suma de ${s.segments} segmento(s). Referencia: módulo A fijo de la misma corrida.` }));
      if (s.altered.length) box.appendChild(el('p', { class: 'hint warn', text: 'Corrida alterada, no apta para comparar: ' + s.altered.join('; ') + '.' }));
    }
    renderCompare() {
      const w = this.cmpWrap; w.querySelectorAll('.rvcmp').forEach((x) => x.remove()); if (!w.open) return;
      const box = el('div', { class: 'rvcmp' }); const list = el('fieldset', { class: 'rvtoggles' }, el('legend', { text: 'Corridas a comparar (elige 2 o más)' }));
      this.runs.filter((r) => r.samples.length).forEach((r) => { const cb = el('input', { type: 'checkbox', id: 'rvC_' + r.id }); cb.checked = this.cmp.has(r.id); cb.addEventListener('change', () => { cb.checked ? this.cmp.add(r.id) : this.cmp.delete(r.id); this.renderCompare(); }); list.appendChild(el('label', { for: 'rvC_' + r.id }, cb, document.createTextNode(` ${r.label || r.id} (${r.samples.length} muestras)`))); });
      box.appendChild(list);
      const chosen = this.runs.filter((r) => this.cmp.has(r.id));
      if (chosen.length < 2) box.appendChild(el('p', { class: 'hint', text: 'Elige al menos dos corridas. Solo son comparables si comparten fecha, escenario, semilla, nubes y viento; lo que cambia a propósito debe ser el modo de seguimiento o el eje inmovilizado.' }));
      else {
        const cmp = LAB.core.compareRuns(chosen), sums = chosen.map(LAB.core.runSummary);
        const t = el('table', { class: 'mini', id: 'rvCmpTable' }, el('caption', { text: 'E en Wh · ganancia de energía = (E_B/E_A − 1)×100 · neta = ((E_B − motores)/E_A − 1)×100' }));
        const tr = el('tr'); ['Corrida', 'Seguimiento', 'E_A (Wh)', 'E_B (Wh)', 'Motores (Wh)', 'Ganancia de energía', 'Ganancia neta', 'Estado'].forEach((h) => tr.appendChild(el('th', { scope: 'col', text: h }))); t.appendChild(tr);
        sums.forEach((s, k) => { const c = cmp.conds[k], ok = !s.altered.length; const row = el('tr', ok ? {} : { class: 'bad' }); [chosen[k].label || s.id, `${c.trackerMode || '—'}${c.lockAz ? ' · az fijo' : ''}${c.lockTilt ? ' · incl. fija' : ''}`, s.hasEnergy ? fmt(s.EA, 0) : '—', s.hasEnergy ? fmt(s.EB, 0) : '—', s.hasEnergy ? fmt(s.motorWh, 1) : '—', pct(s.grossPct), pct(s.netPct), ok ? 'válida' : 'alterada: ' + s.altered.join('; ')].forEach((v) => row.appendChild(el('td', { text: v }))); t.appendChild(row); });
        box.appendChild(t);
        box.appendChild(el('p', { class: 'hint' + (cmp.comparable ? '' : ' warn'), id: 'rvCmpVerdict', text: cmp.comparable ? `Comparación válida: mismo escenario (${cmp.conds[0].scenarioId || 'sin escenario'}), fecha ${cmp.conds[0].day}, semilla ${cmp.conds[0].seed}. Variable estudiada: ${cmp.varied.join(' y ') || 'ninguna'}.` : 'Estas corridas NO forman una comparación válida: ' + [cmp.differs.length ? 'difieren en ' + cmp.differs.join(', ') + ' (son experimentos distintos)' : '', cmp.altered.length ? 'hay corridas alteradas o interrumpidas' : ''].filter(Boolean).join('; ') + '.' }));
      }
      w.appendChild(box);
    }
    // --------------------------------------------------------------- exportar
    exportPng() {
      if (!this.D) return; const run = this.run, src = this.canvas, pad = 44, c = document.createElement('canvas'); c.width = src.width; c.height = src.height + pad * (src.width / this.chart.w);
      const k = src.width / this.chart.w, ctx = c.getContext('2d'); ctx.fillStyle = '#0b1622'; ctx.fillRect(0, 0, c.width, c.height); ctx.fillStyle = '#e7f1fb'; ctx.font = `${12 * k}px sans-serif`; ctx.textBaseline = 'top';
      const [a, b] = this.range(); ctx.fillText(`Laboratorio Solar UNACH · ${run.label || run.id} · Modo simulador`, 8 * k, 6 * k); ctx.fillStyle = '#9db3c8'; ctx.fillText(`Tramo ${hmsOf(a)}–${hmsOf(b)} del ${dayStr(a)} · escala ${this.scale === 'auto' ? 'automática' : 'fija'} · ${run.samples.length} muestras`, 8 * k, 24 * k);
      ctx.drawImage(src, 0, pad * k);
      c.toBlob((blob) => { if (!blob) return this.hooks.toast('El navegador no pudo generar la imagen.', 'warn'); const a2 = document.createElement('a'); a2.href = URL.createObjectURL(blob); a2.download = `lab-solar-unach_${run.id}.png`; document.body.appendChild(a2); a2.click(); a2.remove(); setTimeout(() => URL.revokeObjectURL(a2.href), 2000); this.hooks.toast('Imagen PNG descargada.', 'ok'); }, 'image/png');
    }
    exportCsv() {
      if (!this.D) return; const vis = this.visibleIdx(); if (!vis.length) return this.hooks.toast('No hay muestras en el tramo visible.', 'warn');
      const run = this.run, text = LAB.core.runSliceCsv(run, vis[0], vis[vis.length - 1]); this.hooks.download(text, `lab-solar-unach_${run.id}_${vis[0]}-${vis[vis.length - 1]}.csv`, 'text/csv;charset=utf-8'); this.hooks.toast(`Descargadas ${vis.length} muestras del tramo visible.`, 'ok');
    }
    // para pruebas
    select(id) { this.runId = id; this.sel.value = id; this.view = null; this.cursor = null; this.render(); }
  }
  LAB.ui.RunView = RunView;
  void esc;
})();
