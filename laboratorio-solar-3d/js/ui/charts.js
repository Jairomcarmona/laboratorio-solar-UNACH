/* Graficas ligeras en canvas 2D (sin dependencias): lineas con relleno, doble eje, marcadores y barras. */
(function () {
  'use strict';
  const FONT = '11px "JetBrains Mono", ui-monospace, monospace';
  const GRID = 'rgba(140,200,255,.10)';
  const AXIS = 'rgba(157,179,200,.85)';

  function niceStep(range, n) {
    const raw = range / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }
  function niceMax(v) { if (v <= 0) return 1; const s = niceStep(v, 4); return Math.ceil(v / s) * s; }

  class Chart {
    constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.w = 0; this.h = 0; this.dpr = 1; }

    fit() {
      const r = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
      if (w !== this.w || h !== this.h || dpr !== this.dpr) {
        this.w = w; this.h = h; this.dpr = dpr;
        this.canvas.width = w * dpr; this.canvas.height = h * dpr;
      }
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.ctx.clearRect(0, 0, w, h);
    }

    /** spec: {x:{min,max,fmt,ticks}, y:{min,max,fmt,ticks,label}, y2?:{...}, series:[], points:[], vlines:[], legend:[]} */
    line(spec) {
      this.fit();
      const { ctx, w, h } = this;
      const padL = 38, padR = spec.y2 ? 40 : 10, padT = 10, padB = 24;
      const iw = w - padL - padR, ih = h - padT - padB;
      const X = (v) => padL + ((v - spec.x.min) / (spec.x.max - spec.x.min || 1)) * iw;
      const axes = { y: spec.y, y2: spec.y2 };
      const Y = (v, ax = 'y') => padT + ih - ((v - axes[ax].min) / (axes[ax].max - axes[ax].min || 1)) * ih;
      ctx.font = FONT; ctx.textBaseline = 'middle';

      // rejilla y ejes
      for (const [key, side] of [['y', 'L'], ['y2', 'R']]) {
        const a = axes[key]; if (!a) continue;
        const n = a.ticks || 4;
        const step = (a.max - a.min) / n;
        for (let i = 0; i <= n; i++) {
          const v = a.min + step * i, yy = Y(v, key);
          if (key === 'y') { ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke(); }
          ctx.fillStyle = a.color || AXIS; ctx.textAlign = side === 'L' ? 'right' : 'left';
          ctx.fillText(a.fmt ? a.fmt(v) : v.toFixed(0), side === 'L' ? padL - 6 : w - padR + 6, yy);
        }
        if (a.label) {
          ctx.save(); ctx.translate(side === 'L' ? 9 : w - 8, padT + ih / 2); ctx.rotate(-Math.PI / 2);
          ctx.fillStyle = a.color || AXIS; ctx.textAlign = 'center'; ctx.font = '10px "JetBrains Mono", monospace'; ctx.fillText(a.label, 0, 0); ctx.restore(); ctx.font = FONT;
        }
      }
      ctx.textBaseline = 'top'; ctx.textAlign = 'center';
      const nx = spec.x.ticks || 4;
      for (let i = 0; i <= nx; i++) {
        const v = spec.x.min + ((spec.x.max - spec.x.min) * i) / nx, xx = X(v);
        ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + ih); ctx.stroke();
        ctx.fillStyle = AXIS; ctx.fillText(spec.x.fmt ? spec.x.fmt(v) : v.toFixed(0), Math.min(Math.max(xx, padL + 10), w - padR - 10), padT + ih + 6);
      }
      if (spec.x.label) { ctx.fillStyle = AXIS; ctx.textAlign = 'right'; ctx.fillText(spec.x.label, w - 4, 1); }

      ctx.save();
      ctx.beginPath(); ctx.rect(padL, padT - 2, iw, ih + 4); ctx.clip();
      // series
      for (const s of spec.series) {
        if (!s.xs || s.xs.length < 2) continue;
        const ax = s.axis || 'y';
        // tramos continuos: un valor no finito (discontinuidad del reloj) corta la linea en lugar de unir puntos no consecutivos
        const runs = []; let cur = null;
        for (let i = 0; i < s.xs.length; i++) {
          if (!Number.isFinite(s.xs[i]) || !Number.isFinite(s.ys[i])) { cur = null; continue; }
          if (!cur) { cur = []; runs.push(cur); }
          cur.push([X(s.xs[i]), Y(s.ys[i], ax)]);
        }
        const trace = (r) => { ctx.beginPath(); r.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); };
        if (s.fill) {
          for (const r of runs) {
            if (r.length < 2) continue;
            ctx.save(); trace(r); ctx.lineTo(r[r.length - 1][0], padT + ih); ctx.lineTo(r[0][0], padT + ih); ctx.closePath();
            const g = ctx.createLinearGradient(0, padT, 0, padT + ih);
            g.addColorStop(0, s.color + '55'); g.addColorStop(1, s.color + '00');
            ctx.fillStyle = g; ctx.fill(); ctx.restore();
          }
        }
        ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; ctx.lineJoin = 'round'; ctx.setLineDash(s.dash || []);
        for (const r of runs) { if (r.length < 2) continue; trace(r); ctx.stroke(); }
        ctx.setLineDash([]);
      }
      for (const v of spec.vlines || []) {
        const xx = X(v.x);
        ctx.strokeStyle = v.color || 'rgba(255,255,255,.5)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + ih); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.restore();
      // puntos
      for (const p of spec.points || []) {
        const px = X(p.x), py = Y(p.y, p.axis || 'y');
        if (px < padL - 2 || px > w - padR + 2) continue;
        ctx.fillStyle = p.color; ctx.strokeStyle = '#06101a'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (p.shape === 'diamond') { const r = p.r || 5; ctx.moveTo(px, py - r); ctx.lineTo(px + r, py); ctx.lineTo(px, py + r); ctx.lineTo(px - r, py); ctx.closePath(); }
        else if (p.shape === 'square') { const r = p.r || 4; ctx.rect(px - r, py - r, 2 * r, 2 * r); }
        else ctx.arc(px, py, p.r || 4, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
      // leyenda
      if (spec.legend) {
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        let lx = padL + 6;
        for (const l of spec.legend) {
          ctx.fillStyle = l.color; ctx.fillRect(lx, padT + 8, 10, l.dash ? 2 : 3);
          ctx.fillStyle = 'rgba(231,241,251,.9)'; ctx.fillText(l.name, lx + 14, padT + 9);
          lx += 22 + ctx.measureText(l.name).width;
        }
      }
      return { X, Y, padL, padT, iw, ih };
    }

    /** Barras horizontales comparativas */
    bars(items, opts = {}) {
      this.fit();
      const { ctx, w, h } = this;
      const max = niceMax(Math.max(...items.map((i) => i.value), opts.minMax || 1));
      const padL = 14, padR = 14, top = 22;
      const bh = Math.min(38, (h - top - 70) / items.length - 8);
      ctx.font = FONT; ctx.textBaseline = 'middle';
      items.forEach((it, i) => {
        const y = top + i * (bh + 14) + 16;
        ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(padL, y, w - padL - padR, bh);
        const bw = ((w - padL - padR) * it.value) / max;
        const g = ctx.createLinearGradient(padL, 0, padL + bw, 0); g.addColorStop(0, it.color + 'aa'); g.addColorStop(1, it.color);
        ctx.fillStyle = g; ctx.fillRect(padL, y, Math.max(bw, 1), bh);
        ctx.fillStyle = 'rgba(231,241,251,.95)'; ctx.textAlign = 'left'; ctx.fillText(it.label, padL + 8, y - 8);
        ctx.textAlign = 'right'; ctx.font = '600 13px "JetBrains Mono", monospace';
        ctx.fillText(it.text || it.value.toFixed(1), w - padR - 8, y + bh / 2); ctx.font = FONT;
      });
      if (opts.footer) {
        ctx.fillStyle = AXIS; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        opts.footer.forEach((t, i) => ctx.fillText(t, padL, top + items.length * (bh + 14) + 16 + i * 15));
      }
    }
  }

  LAB.ui.Chart = Chart;
  LAB.ui.niceMax = niceMax;
})();
