/* Reporte imprimible (C16): HTML autocontenido (se imprime o se guarda como PDF desde el navegador, sin servidor)
 * y su equivalente en Markdown. Recibe SOLO evidencia congelada: respuestas, evidencia de cierre, corridas y barridos
 * registrados. Nunca lee la telemetria viva (T30). */
(function () {
  'use strict';
  const { esc, fmt, pad2 } = LAB.util;
  const hms = (ms) => { const l = LAB.localTime(ms); return `${pad2(l.hour)}:${pad2(l.minute)}`; };
  const pct = (v) => (v == null ? 'No disponible' : (v >= 0 ? '+' : '') + fmt(v, 1) + ' %');

  /** Markdown mínimo (títulos, tablas, listas, citas, negritas/cursivas) → HTML escapado. Solo para los reportes que genera la propia app. */
  function mdToHtml(lines) {
    const inl = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/_(.+?)_/g, '<i>$1</i>');
    const out = []; let list = false, tbl = null;
    const close = () => { if (list) { out.push('</ul>'); list = false; } if (tbl) { out.push('</tbody></table>'); tbl = null; } };
    for (const raw of lines) {
      const l = String(raw);
      if (/^\|/.test(l)) {
        if (/^\|[-| ]+\|$/.test(l)) continue;
        const cells = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!tbl) { close(); tbl = 1; out.push('<table><thead><tr>' + cells.map((c) => `<th scope="col">${inl(c)}</th>`).join('') + '</tr></thead><tbody>'); } else out.push('<tr>' + cells.map((c) => `<td>${inl(c)}</td>`).join('') + '</tr>');
        continue;
      }
      if (tbl) close();
      let m;
      if ((m = /^(#{1,3}) (.*)$/.exec(l))) { close(); out.push(`<h${m[1].length + 1}>${inl(m[2])}</h${m[1].length + 1}>`); }
      else if (/^[-*] /.test(l)) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inl(l.slice(2))}</li>`); }
      else if (/^> /.test(l)) { close(); out.push(`<blockquote>${inl(l.slice(2))}</blockquote>`); }
      else if (!l.trim()) close();
      else { close(); out.push(`<p>${inl(l).replace(/\n/g, '<br>')}</p>`); }
    }
    close(); return out.join('\n');
  }

  /** Gráfica vectorial P-t de una corrida registrada (se imprime nítida): módulo A, B y G. */
  function svgRun(run) {
    const idx = {}; (run.cols || LAB.core.RUN_COLS).forEach((c, i) => (idx[c] = i));
    const S = run.samples; if (S.length < 2) return '<p><i>Corrida sin muestras suficientes para graficar.</i></p>';
    const W = 640, H = 220, L = 44, R = 12, T = 12, B = 28, t0 = S[0][idx.simMs], t1 = S[S.length - 1][idx.simMs] || t0 + 1;
    let pmax = 50; S.forEach((r) => { pmax = Math.max(pmax, r[idx.pA] || 0, r[idx.pB] || 0); });
    const step = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v / 4))), f = v / 4 / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; };
    const st = step(pmax), ymax = Math.ceil(pmax / st) * st;
    const X = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R), Y = (v) => T + (H - T - B) * (1 - v / ymax);
    const path = (key) => { let d = '', prevSeg = null; S.forEach((r, i) => { const seg = r[idx.segmentId]; d += `${i === 0 || seg !== prevSeg ? 'M' : 'L'}${X(r[idx.simMs]).toFixed(1)},${Y(r[idx[key]] || 0).toFixed(1)} `; prevSeg = seg; }); return d; };
    let g = '';
    for (let v = 0; v <= ymax + 1e-9; v += st) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="#ccd" stroke-width=".6"/><text x="${L - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end" font-size="9">${v}</text>`;
    for (let i = 0; i <= 4; i++) { const t = t0 + (t1 - t0) * i / 4; g += `<text x="${X(t).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="9">${hms(t)}</text>`; }
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Potencia de los módulos A y B durante la corrida ${esc(run.label || run.id)}" font-family="sans-serif">${g}
      <path d="${path('pA')}" fill="none" stroke="#1a9e5b" stroke-width="1.6"/><path d="${path('pB')}" fill="none" stroke="#d98a00" stroke-width="1.6" stroke-dasharray="5 3"/>
      <text x="${L}" y="9" font-size="9" fill="#1a9e5b">— P módulo A (W)</text><text x="${L + 110}" y="9" font-size="9" fill="#d98a00">- - P módulo B (W)</text><text x="${W - R}" y="${H - 2}" text-anchor="end" font-size="9">hora local simulada · ${(() => { const l = LAB.localTime(t0); return `${pad2(l.day)}/${pad2(l.month)}/${l.year}`; })()}</text></svg>`;
  }

  function runsSection(runs) {
    if (!runs.length) return '<p><i>No se registraron corridas de adquisición asociadas a esta práctica.</i></p>';
    const sums = runs.map((r) => r._frozen || LAB.core.runSummary(r));
    const rows = runs.map((r, k) => { const s = sums[k]; return `<tr><td>${esc(r.label || r.id)}</td><td>${esc(r.id)}</td><td>${r.samples.length}</td><td>${esc(r.status)}</td><td>${s.hasEnergy ? fmt(s.EA, 0) : '—'}</td><td>${s.hasEnergy ? fmt(s.EB, 0) : '—'}</td><td>${s.hasEnergy ? fmt(s.motorWh, 1) : '—'}</td><td>${pct(s.grossPct)}</td><td>${pct(s.netPct)}</td><td>${s.altered.length ? esc('alterada: ' + s.altered.join('; ')) : 'válida'}</td></tr>`; }).join('');
    const cmp = runs.length > 1 ? LAB.core.compareRuns(runs) : null;
    return `<table><caption>Corridas registradas. E en Wh; ganancia de energía = (E_B/E_A − 1)×100; neta = ((E_B − motores)/E_A − 1)×100</caption><thead><tr><th scope="col">Corrida</th><th scope="col">Id</th><th scope="col">Muestras</th><th scope="col">Estado</th><th scope="col">E_A (Wh)</th><th scope="col">E_B (Wh)</th><th scope="col">Motores (Wh)</th><th scope="col">Ganancia de energía</th><th scope="col">Ganancia neta</th><th scope="col">Validez</th></tr></thead><tbody>${rows}</tbody></table>`
      + (cmp ? `<p>${cmp.comparable ? `Las corridas son comparables (mismo escenario ${esc(cmp.conds[0].scenarioId || '—')}, fecha ${esc(cmp.conds[0].day)}). Variable estudiada: ${esc(cmp.varied.join(' y ') || 'ninguna')}.` : 'Las corridas <b>no</b> forman una comparación válida: ' + esc([cmp.differs.length ? 'difieren en ' + cmp.differs.join(', ') : '', cmp.altered.length ? 'hay corridas alteradas o interrumpidas' : ''].filter(Boolean).join('; ')) + '.'}</p>` : '')
      + runs.filter((r) => r.samples.length >= 2).slice(0, 4).map((r) => `<figure><figcaption>${esc(r.label || r.id)}: potencia de A y B</figcaption>${svgRun(r)}</figure>`).join('');
  }
  function sweepsSection(sweeps) {
    if (!sweeps.length) return '<p><i>No hay barridos I‑V registrados.</i></p>';
    const rows = sweeps.map((s) => { const c = s.cond && s.cond.start; return `<tr><td>${esc(s.id)}</td><td>${esc(LAB.core.localStr(s.startSimMs))}</td><td>${c ? fmt(c.gA, 0) : '—'}</td><td>${c ? fmt(c.gB, 0) : '—'}</td><td>${c ? fmt(c.tA, 1) : '—'}</td><td>${s.pts.A.length + s.pts.B.length}</td><td>${s.status === 'complete' ? 'completo' : 'interrumpido' + (s.cause ? ' (' + esc(s.cause) + ')' : '')}</td></tr>`; }).join('');
    return `<table><caption>Barridos I‑V registrados. Se guardan la irradiancia y la temperatura al inicio del barrido.</caption><thead><tr><th scope="col">Barrido</th><th scope="col">Inicio (hora local simulada)</th><th scope="col">G_A (W/m²)</th><th scope="col">G_B (W/m²)</th><th scope="col">T celda A (°C)</th><th scope="col">Puntos</th><th scope="col">Estado</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  /**
   * ctx: { practice, ps, snap, answers, complete, mt, user, role, version, simLocal, realDate, site, tz, runs, sweeps, incidents[] }
   */
  LAB.ui.reportHtml = function (ctx) {
    const p = ctx.practice, title = `Reporte · Práctica ${p.n}: ${p.title}${ctx.complete ? '' : ' (BORRADOR INCOMPLETO)'}`;
    const answers = p.steps.filter((x) => x.question).map((x) => { const a = ctx.answers[x.question.id]; return `<div class="ans"><p><b>${esc(x.question.text)}</b></p><p>${a && a.submitted ? esc(a.submitted).replace(/\n/g, '<br>') : (a && a.draft ? '<i>(borrador sin registrar)</i> ' + esc(a.draft) : '<i>(sin respuesta)</i>')}</p></div>`; }).join('');
    const inc = ctx.incidents.length ? '<ul>' + ctx.incidents.map((i) => `<li>${esc(i)}</li>`).join('') + '</ul>' : '<p>Sin alarmas ni incidentes en la bitácora de esta sesión.</p>';
    const css = 'body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:820px;margin:20px auto;padding:0 16px}h1{font-size:21px;margin:0 0 4px}h2{font-size:16px;border-bottom:1px solid #999;padding-bottom:2px;margin-top:22px}h3{font-size:14px}table{border-collapse:collapse;width:100%;font-size:12px;margin:8px 0}th,td{border:1px solid #888;padding:3px 6px;text-align:left}th{background:#e8edf2}caption{text-align:left;font-size:11.5px;color:#444;padding:2px 0}blockquote{border-left:4px solid #c00;background:#fff0f0;margin:8px 0;padding:6px 10px}.sim{border:2px solid #b36b00;background:#fff6e5;padding:6px 10px;font-size:12.5px}.meta{font-size:12.5px;color:#333}figure{margin:10px 0;break-inside:avoid}figcaption{font-size:12px;color:#444}.ans{break-inside:avoid;margin:8px 0}@media print{body{margin:0;max-width:none}}';
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>
${LAB.ui.logoBannerDataUri ? `<img src="${LAB.ui.logoBannerDataUri}" alt="UNACH · Cofinanciado por la Unión Europea · EU-COLMEV · SISDIC" style="width:100%;max-height:70px;object-fit:contain;margin-bottom:8px">` : ''}
<h1>${esc(title)}</h1>
${ctx.complete ? '' : `<blockquote><b>Borrador incompleto:</b> ${ctx.mt.stepsDone}/${ctx.mt.stepsReq} requisitos operativos y ${ctx.mt.ansDone}/${ctx.mt.ansReq} respuestas registradas al momento de generarlo. No es un reporte final.</blockquote>`}
<p class="sim"><b>Modo simulador.</b> Los resultados provienen del simulador (pvlib y modelo de un diodo), con parámetros de referencia del equipo.</p>
<p class="meta">Laboratorio Remoto Solar UNACH · EU‑COLMEV WP3 · Sitio: ${esc(ctx.site)} · Versión de la aplicación ${esc(ctx.version)} · definición de la práctica v${p.version}<br>
Identidad de demostración: ${esc(ctx.user || '—')} (${esc(ctx.role || '—')}; rol local, no es autenticación) · Sesión: ${esc(ctx.ps.sessionId || '—')}<br>
${ctx.complete ? 'Cerrada' : 'Generada'} en tiempo simulado: ${esc(ctx.simLocal)} (UTC${ctx.tz}) · fecha real: ${esc(ctx.realDate)}</p>
<p><b>Objetivo.</b> ${esc(p.goal)}</p>
${mdToHtml(p.report ? p.report(ctx.snap) : [])}
<h2>Corridas y gráficas</h2>${runsSection(ctx.runs)}
<h2>Barridos I‑V</h2>${sweepsSection(ctx.sweeps)}
<h2>Respuestas</h2>${answers || '<p>Esta práctica no tiene preguntas.</p>'}
<h2>Incidentes y alarmas de la sesión</h2>${inc}
<h2>Cierre</h2><p>${ctx.complete ? `Práctica completada el ${esc(ctx.ps.completedAtUtc || '')}. La evidencia usada es la congelada al cerrar; no cambia si el simulador sigue corriendo.` : 'Práctica en curso: este borrador refleja el avance al momento de generarlo.'}</p>
<h2>Resultados de aprendizaje</h2><ul>${p.ilos.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
</body></html>`;
  };
  LAB.ui.mdToHtml = mdToHtml;
})();
