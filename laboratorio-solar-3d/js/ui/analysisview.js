/* Pestaña «Análisis» (S13): dispersión con ajuste lineal por mínimos cuadrados sobre una corrida elegida.
 * Cuatro gráficas: Isc–G, Voc–T, (T−Ta)/G–viento y PR diario. Cursor, CSV y PNG como la pestaña Corrida. Solo corridas registradas. */
(function () {
  'use strict';
  const { fmt } = LAB.util;
  const el = (tag, attrs, ...kids) => { const n = document.createElement(tag); Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v); }); kids.forEach((c) => c && n.appendChild(c)); return n; };
  const KINDS = [
    ['iscVsG', 'Isc – G', 'Corriente de cortocircuito contra irradiancia: casi una recta por el origen. Necesita muestras con la carga en cortocircuito.'],
    ['vocVsT', 'Voc – T', 'Tensión de circuito abierto contra temperatura de celda: pendiente negativa (coeficiente de Voc). Necesita muestras en circuito abierto.'],
    ['thermalVsWind', '(T−Ta)/G – viento', 'Qué tanto se calienta la celda por W/m² según el viento. Solo con irradiancia estable (|ΔG| < 20 W/m² en 5 min) y G > 400 W/m².'],
    ['dailyPR', 'PR diario', 'Rendimiento global (performance ratio) por día, sin y con corrección por temperatura.'],
  ];
  const pad = { l: 46, r: 12, t: 12, b: 28 };

  class AnalysisView {
    constructor(root, hooks) {
      this.root = root; this.hooks = hooks; this.kind = 'iscVsG'; this.mod = 'B'; this.runs = []; this.runId = null; this.res = null; this.cursor = null;
      this.build();
    }
    build() {
      const r = this.root; r.textContent = '';
      this.sel = el('select', { id: 'anSelect', 'aria-label': 'Corrida a analizar' });
      this.sel.addEventListener('change', () => { this.runId = this.sel.value; this.render(); });
      this.modSel = el('select', { id: 'anMod', 'aria-label': 'Módulo' }); [['B', 'Módulo B'], ['A', 'Módulo A']].forEach(([v, t]) => this.modSel.appendChild(el('option', { value: v, text: t })));
      this.modSel.addEventListener('change', () => { this.mod = this.modSel.value; this.render(); });
      const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Tipo de análisis', id: 'anTabs' });
      KINDS.forEach(([k, t]) => { const b = el('button', { type: 'button', role: 'tab', 'data-k': k, text: t, 'aria-selected': String(k === this.kind) }); b.addEventListener('click', () => { this.kind = k; this.cursor = null; this.render(); }); tabs.appendChild(b); });
      const tools = el('div', { class: 'rvtools', role: 'toolbar' });
      const mk = (id, txt, fn) => { const b = el('button', { class: 'btn', type: 'button', id, text: txt }); b.addEventListener('click', fn); tools.appendChild(b); };
      mk('anPng', 'PNG', () => this.exportPng()); mk('anCsv', 'CSV', () => this.exportCsv());
      this.canvas = el('canvas', { id: 'anCanvas', role: 'img', 'aria-label': 'Gráfica de dispersión con ajuste lineal' });
      this.canvas.addEventListener('pointermove', (e) => this.pointer(e)); this.canvas.addEventListener('pointerleave', () => { this.cursor = null; this.draw(); });
      this.note = el('p', { class: 'hint', id: 'anNote', 'aria-live': 'polite' });
      this.stats = el('table', { class: 'mini', id: 'anStats' });
      r.append(el('div', { class: 'row3' }, this.sel, this.modSel), tabs, tools, el('div', { class: 'chartbox' }, this.canvas), this.note, this.stats);
    }
    async refresh() {
      this.runs = (await this.hooks.getRuns()).filter((x) => x.samples && x.samples.length);
      this.sel.textContent = '';
      this.runs.forEach((x) => this.sel.appendChild(el('option', { value: x.id, text: `${x.label || x.id} · ${x.samples.length} muestras` })));
      if (!this.runs.some((x) => x.id === this.runId)) this.runId = this.runs.length ? this.runs[this.runs.length - 1].id : null;
      this.sel.value = this.runId || '';
      this.render();
    }
    get run() { return this.runs.find((x) => x.id === this.runId) || null; }
    compute() {
      const run = this.run; if (!run) return null;
      const fn = LAB.core[this.kind];
      return fn(run, this.mod);
    }
    render() {
      $$('#anTabs button', this.root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.k === this.kind)));
      this.res = this.compute();
      const kind = KINDS.find((k) => k[0] === this.kind);
      this.stats.textContent = '';
      if (!this.res) { this.note.textContent = 'Todavía no hay corridas con muestras. Inicia una adquisición, o abre una corrida guardada, para analizarla.'; this.draw(); return; }
      const r = this.res;
      if (this.kind === 'dailyPR') {
        this.note.textContent = r.days.length ? kind[2] : 'La corrida no tiene muestras contiguas con irradiancia y potencia.';
        const head = el('tr'); ['Día', 'H (kWh/m²)', 'E (kWh)', 'PR', 'PR corregido por T', 'Horas'].forEach((h) => head.appendChild(el('th', { scope: 'col', text: h }))); this.stats.appendChild(head);
        r.days.forEach((d) => { const tr = el('tr'); [d.day, fmt(d.H, 2), fmt(d.E, 3), d.PR == null ? '—' : fmt(d.PR, 3), d.PRT == null ? '—' : fmt(d.PRT, 3), fmt(d.hours, 2)].forEach((v) => tr.appendChild(el('td', { text: v }))); this.stats.appendChild(tr); });
      } else {
        const f = r.fit;
        this.note.textContent = r.points.length < 2 ? `${kind[2]} — Esta corrida no tiene suficientes puntos que cumplan (${r.points.length}).` : kind[2] + (r.filter ? ` Filtro: ${r.filter}.` : '');
        if (f) { const rows = [['Puntos', String(f.n)], ['Pendiente', fmt(f.slope, 5)], ['Ordenada', fmt(f.intercept, 4)], ['R²', fmt(f.r2, 4)]]; rows.forEach(([a, b]) => { const tr = el('tr'); tr.append(el('th', { scope: 'row', text: a }), el('td', { text: b })); this.stats.appendChild(tr); }); }
      }
      this.draw();
    }
    draw() {
      const c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2), b = c.getBoundingClientRect(), w = Math.max(200, Math.round(b.width || 400)), h = Math.max(120, Math.round(b.height || 220));
      c.width = w * dpr; c.height = h * dpr; const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      ctx.font = '11px ui-monospace, monospace'; const r = this.res; this.geom = null;
      if (!r || r.points.length === 0) { ctx.fillStyle = '#9db3c8'; ctx.textAlign = 'center'; ctx.fillText('Sin puntos que graficar', w / 2, h / 2); return; }
      const xs = r.points.map((p) => p.x), ys = r.points.map((p) => p.y);
      let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      if (this.kind === 'iscVsG') { x0 = Math.min(0, x0); y0 = Math.min(0, y0); }
      if (this.kind === 'dailyPR') { x0 -= 0.5; x1 += 0.5; y0 = Math.min(y0, 0.5); y1 = Math.max(y1, 1); }
      if (x1 - x0 < 1e-9) { x0 -= 1; x1 += 1; } if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
      const py = (y1 - y0) * 0.06; y0 -= py; y1 += py;
      const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b, X = (v) => pad.l + (v - x0) / (x1 - x0) * iw, Y = (v) => pad.t + ih - (v - y0) / (y1 - y0) * ih;
      ctx.strokeStyle = 'rgba(140,200,255,.12)'; ctx.fillStyle = 'rgba(157,179,200,.85)'; ctx.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) { const v = y0 + (y1 - y0) * i / 4, yy = Y(v); ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText(Math.abs(v) < 0.01 && v !== 0 ? v.toExponential(1) : fmt(v, Math.abs(y1 - y0) < 1 ? 3 : 1), pad.l - 5, yy); }
      ctx.textBaseline = 'top'; ctx.textAlign = 'center';
      for (let i = 0; i <= 4; i++) { const v = x0 + (x1 - x0) * i / 4; ctx.fillText(this.kind === 'dailyPR' ? '' : fmt(v, Math.abs(x1 - x0) < 10 ? 1 : 0), X(v), pad.t + ih + 6); }
      ctx.textAlign = 'right'; ctx.fillText(r.xLabel, w - 4, h - 12); ctx.save(); ctx.translate(10, pad.t + ih / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(r.yLabel, 0, 0); ctx.restore();
      ctx.fillStyle = this.mod === 'A' ? '#35d07f' : '#ffb020';
      r.points.forEach((p) => { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 2.4, 0, 7); ctx.fill(); });
      if (r.fit) { ctx.strokeStyle = '#2fb4ff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(X(x0), Y(r.fit.slope * x0 + r.fit.intercept)); ctx.lineTo(X(x1), Y(r.fit.slope * x1 + r.fit.intercept)); ctx.stroke(); }
      if (this.kind === 'dailyPR') { ctx.fillStyle = '#9db3c8'; ctx.textAlign = 'center'; r.points.forEach((p) => ctx.fillText(p.day.slice(5), X(p.x), pad.t + ih + 6)); }
      this.geom = { X, Y, x0, x1, y0, y1, w, h };
      if (this.cursor) { const p = this.cursor; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 6, 0, 7); ctx.stroke(); ctx.fillStyle = '#e7f1fb'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(`${fmt(p.x, 3)} ; ${fmt(p.y, 4)}${p.n != null ? ` · muestra ${p.n}` : ''}`, pad.l + 6, pad.t + 2); }
    }
    pointer(e) {
      if (!this.res || !this.geom) return; const b = this.canvas.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top; let best = null, bd = 400;
      this.res.points.forEach((p) => { const d = (this.geom.X(p.x) - mx) ** 2 + (this.geom.Y(p.y) - my) ** 2; if (d < bd) { bd = d; best = p; } });
      if (best !== this.cursor) { this.cursor = best; this.draw(); }
    }
    csvText() {
      const r = this.res; if (!r) return null;
      const L = [`# Laboratorio Remoto Solar UNACH - ANALISIS ${this.kind} (${this.mod}) de la corrida ${this.runId}`];
      if (r.fit) L.push(`# ajuste lineal: pendiente=${r.fit.slope} ordenada=${r.fit.intercept} R2=${r.fit.r2} n=${r.fit.n}`);
      if (this.kind === 'dailyPR') { L.push('dia,H_kWh_m2,E_kWh,PR,PR_corregido_T,horas'); r.days.forEach((d) => L.push([d.day, d.H, d.E, d.PR, d.PRT, d.hours].join(','))); }
      else { L.push(`n,${r.xLabel.replace(/,/g, ' ')},${r.yLabel.replace(/,/g, ' ')}`); r.points.forEach((p) => L.push(`${p.n},${p.x},${p.y}`)); }
      return L.join('\n') + '\n';
    }
    exportCsv() { const t = this.csvText(); if (!t) return this.hooks.toast('No hay datos que exportar.', 'warn'); this.hooks.download(t, `lab-solar-unach_${this.runId}_${this.kind}.csv`, 'text/csv;charset=utf-8'); this.hooks.toast('CSV del análisis descargado.', 'ok'); }
    exportPng() {
      if (!this.res) return this.hooks.toast('No hay gráfica que exportar.', 'warn');
      const src = this.canvas, k = src.width / (this.geom ? this.geom.w : src.width), c = document.createElement('canvas'), top = Math.round(34 * k); c.width = src.width; c.height = src.height + top;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#0b1622'; ctx.fillRect(0, 0, c.width, c.height); ctx.fillStyle = '#e7f1fb'; ctx.font = `${12 * k}px sans-serif`; ctx.textBaseline = 'top';
      ctx.fillText(`Laboratorio Solar UNACH · ${this.run.label || this.runId} · ${KINDS.find((x) => x[0] === this.kind)[1]} · módulo ${this.mod}`, 8 * k, 6 * k);
      const f = this.res.fit; if (f) { ctx.fillStyle = '#9db3c8'; ctx.fillText(`y = ${fmt(f.slope, 5)} x + ${fmt(f.intercept, 4)}   R² = ${fmt(f.r2, 4)}   n = ${f.n}`, 8 * k, 20 * k); }
      ctx.drawImage(src, 0, top);
      c.toBlob((blob) => { if (!blob) return this.hooks.toast('El navegador no pudo generar la imagen.', 'warn'); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `lab-solar-unach_${this.runId}_${this.kind}.png`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); this.hooks.toast('Imagen PNG descargada.', 'ok'); }, 'image/png');
    }
  }
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  LAB.ui.AnalysisView = AnalysisView;
})();
