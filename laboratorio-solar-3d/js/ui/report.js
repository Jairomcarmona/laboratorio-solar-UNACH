/* Reporte imprimible (C16): HTML autocontenido (se imprime o se guarda como PDF desde el navegador, sin servidor)
 * y su equivalente en Markdown. Recibe SOLO evidencia congelada: respuestas, evidencia de cierre, corridas y barridos
 * registrados. Nunca lee la telemetria viva (T30). */
(function () {
  'use strict';
  const { esc, fmt, pad2 } = LAB.util;
  /** Incidentes guardados como 'HH:MM · Origen: mensaje' (en español): se traducen al mostrarlos */
  const incTm = (i) => { const m = /^(\d\d:\d\d) · ([^:]+): ([\s\S]*)$/.exec(i); return m ? `${m[1]} · ${LAB.tk('src.', m[2])}: ${LAB.tm(m[3])}` : LAB.tm(i); };
  const hms = (ms) => { const l = LAB.localTime(ms); return `${pad2(l.hour)}:${pad2(l.minute)}`; };
  const pct = (v) => (v == null ? LAB.t('report.no_disponible') : (v >= 0 ? '+' : '') + fmt(v, 1) + ' %');

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
    const S = run.samples; if (S.length < 2) return `<p><i>${LAB.t('report.sin_muestras_graficar')}</i></p>`;
    const W = 640, H = 220, L = 44, R = 12, T = 12, B = 28, t0 = S[0][idx.simMs], t1 = S[S.length - 1][idx.simMs] || t0 + 1;
    let pmax = 50; S.forEach((r) => { pmax = Math.max(pmax, r[idx.pA] || 0, r[idx.pB] || 0); });
    const step = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v / 4))), f = v / 4 / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; };
    const st = step(pmax), ymax = Math.ceil(pmax / st) * st;
    const X = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R), Y = (v) => T + (H - T - B) * (1 - v / ymax);
    const path = (key) => { let d = '', prevSeg = null; S.forEach((r, i) => { const seg = r[idx.segmentId]; d += `${i === 0 || seg !== prevSeg ? 'M' : 'L'}${X(r[idx.simMs]).toFixed(1)},${Y(r[idx[key]] || 0).toFixed(1)} `; prevSeg = seg; }); return d; };
    let g = '';
    for (let v = 0; v <= ymax + 1e-9; v += st) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="#ccd" stroke-width=".6"/><text x="${L - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end" font-size="9">${v}</text>`;
    for (let i = 0; i <= 4; i++) { const t = t0 + (t1 - t0) * i / 4; g += `<text x="${X(t).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="9">${hms(t)}</text>`; }
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(LAB.t('report.svg_aria', { run: run.label || run.id }))}" font-family="sans-serif">${g}
      <path d="${path('pA')}" fill="none" stroke="${LAB.config.palette.Aprint}" stroke-width="1.6"/><path d="${path('pB')}" fill="none" stroke="${LAB.config.palette.Bprint}" stroke-width="1.6" stroke-dasharray="5 3"/>
      <text x="${L}" y="9" font-size="9" fill="${LAB.config.palette.Aprint}">${esc(LAB.t('report.svg_pa'))}</text><text x="${L + 110}" y="9" font-size="9" fill="${LAB.config.palette.Bprint}">${esc(LAB.t('report.svg_pb'))}</text><text x="${W - R}" y="${H - 2}" text-anchor="end" font-size="9">${esc(LAB.t('report.svg_hora'))} · ${(() => { const l = LAB.localTime(t0); return `${pad2(l.day)}/${pad2(l.month)}/${l.year}`; })()}</text></svg>`;
  }

  function runsSection(runs) {
    if (!runs.length) return `<p><i>${LAB.t('report.sin_corridas')}</i></p>`;
    const sums = runs.map((r) => r._frozen || LAB.core.runSummary(r));
    const rows = runs.map((r, k) => { const s = sums[k]; return `<tr><td>${esc(r.label || r.id)}</td><td>${esc(r.id)}</td><td>${r.samples.length}</td><td>${esc(r.status)}</td><td>${s.hasEnergy ? fmt(s.EA, 0) : '—'}</td><td>${s.hasEnergy ? fmt(s.EB, 0) : '—'}</td><td>${s.hasEnergy ? fmt(s.motorWh, 1) : '—'}</td><td>${pct(s.grossPct)}</td><td>${pct(s.netPct)}</td><td>${s.altered.length ? esc(LAB.t('report.alterada') + s.altered.map(LAB.tm).join('; ')) : LAB.t('report.valida')}</td></tr>`; }).join('');
    const cmp = runs.length > 1 ? LAB.core.compareRuns(runs) : null;
    return `<table><caption>${LAB.t('report.cap_runs')}</caption><thead><tr><th scope="col">${LAB.t('report.th_corrida')}</th><th scope="col">${LAB.t('report.th_id')}</th><th scope="col">${LAB.t('report.th_muestras')}</th><th scope="col">${LAB.t('report.th_estado')}</th><th scope="col">E_A (Wh)</th><th scope="col">E_B (Wh)</th><th scope="col">${LAB.t('report.th_motores')}</th><th scope="col">${LAB.t('report.th_gross')}</th><th scope="col">${LAB.t('report.th_net')}</th><th scope="col">${LAB.t('report.th_validez')}</th></tr></thead><tbody>${rows}</tbody></table>`
      + (cmp ? `<p>${cmp.comparable ? LAB.t('report.comparables', { id: esc(cmp.conds[0].scenarioId || '—'), day: esc(cmp.conds[0].day), varied: esc(cmp.varied.map(LAB.tm).join(LAB.t('report.y')) || LAB.t('report.ninguna')) }) : LAB.t('report.no_comparables') + esc([cmp.differs.length ? LAB.t('report.difieren_en') + cmp.differs.map(LAB.tm).join(', ') : '', cmp.altered.length ? LAB.t('report.hay_alteradas') : ''].filter(Boolean).join('; ')) + '.'}</p>` : '')
      + runs.filter((r) => r.samples.length >= 2).slice(0, 4).map((r) => `<figure><figcaption>${esc(r.label || r.id)}: ${esc(LAB.t('report.pot_ab'))}</figcaption>${svgRun(r)}</figure>`).join('');
  }
  function sweepsSection(sweeps) {
    if (!sweeps.length) return `<p><i>${LAB.t('report.sin_barridos')}</i></p>`;
    const rows = sweeps.map((s) => { const c = s.cond && s.cond.start; return `<tr><td>${esc(s.id)}</td><td>${esc(LAB.core.localStr(s.startSimMs))}</td><td>${c ? fmt(c.gA, 0) : '—'}</td><td>${c ? fmt(c.gB, 0) : '—'}</td><td>${c ? fmt(c.tA, 1) : '—'}</td><td>${s.pts.A.length + s.pts.B.length}</td><td>${s.status === 'complete' ? LAB.t('report.completo') : LAB.t('report.interrumpido') + (s.cause ? ' (' + esc(LAB.tm(s.cause)) + ')' : '')}</td></tr>`; }).join('');
    return `<table><caption>${LAB.t('report.cap_sweeps')}</caption><thead><tr><th scope="col">${LAB.t('report.th_barrido')}</th><th scope="col">${LAB.t('report.th_inicio')}</th><th scope="col">G_A (W/m²)</th><th scope="col">G_B (W/m²)</th><th scope="col">${LAB.t('report.th_tcelda')}</th><th scope="col">${LAB.t('report.th_puntos')}</th><th scope="col">${LAB.t('report.th_estado')}</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  /**
   * ctx: { practice, ps, snap, answers, complete, mt, user, role, version, simLocal, realDate, site, tz, runs, sweeps, incidents[] }
   */
  /** Datos de ubicación del reporte: viven en config.site (un solo lugar) y se marca si son aproximados o medidos */
  const siteInfo = () => { const c = LAB.config, S = c.site, st = c.siteStatus(); return { lat: fmt(S.lat, 4), lon: fmt(S.lon, 4), alt: fmt(S.alt, 0), tz: S.tz, measured: st.measured, tableMatches: st.tableMatches }; };
  LAB.ui.reportSite = () => { const i = siteInfo(); return LAB.t(i.measured ? 'report.meta_site_medida' : 'report.meta_site_aprox', i) + (i.tableMatches ? '' : LAB.t('report.meta_site_tabla')); };
  LAB.ui.reportHtml = function (ctx) {
    const p = ctx.practice, title = LAB.t('report.title', { n: p.n, title: p.title }) + (ctx.complete ? '' : LAB.t('report.incompleto'));
    const answers = p.steps.filter((x) => x.question).map((x) => { const a = ctx.answers[x.question.id]; return `<div class="ans"><p><b>${esc(x.question.text)}</b></p><p>${a && a.submitted ? esc(a.submitted).replace(/\n/g, '<br>') : (a && a.draft ? '<i>' + LAB.t('report.borrador_sin_registrar') + '</i> ' + esc(a.draft) : '<i>' + LAB.t('report.sin_respuesta') + '</i>')}</p></div>`; }).join('');
    const inc = ctx.incidents.length ? '<ul>' + ctx.incidents.map((i) => `<li>${esc(incTm(i))}</li>`).join('') + '</ul>' : `<p>${LAB.t('report.sin_incidentes')}</p>`;
    const css = 'body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:820px;margin:20px auto;padding:0 16px}h1{font-size:21px;margin:0 0 4px}h2{font-size:16px;border-bottom:1px solid #999;padding-bottom:2px;margin-top:22px}h3{font-size:14px}table{border-collapse:collapse;width:100%;font-size:12px;margin:8px 0}th,td{border:1px solid #888;padding:3px 6px;text-align:left}th{background:#e8edf2}caption{text-align:left;font-size:11.5px;color:#444;padding:2px 0}blockquote{border-left:4px solid #c00;background:#fff0f0;margin:8px 0;padding:6px 10px}.sim{border:2px solid #b36b00;background:#fff6e5;padding:6px 10px;font-size:12.5px}.meta{font-size:12.5px;color:#333}figure{margin:10px 0;break-inside:avoid}figcaption{font-size:12px;color:#444}.ans{break-inside:avoid;margin:8px 0}@media print{body{margin:0;max-width:none}}';
    return `<!doctype html><html lang="${LAB.i18n.lang}"><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>
${LAB.ui.logoBannerDataUri ? `<img src="${LAB.ui.logoBannerDataUri}" alt="${esc(LAB.t('report.logo_alt'))}" style="width:100%;max-height:70px;object-fit:contain;margin-bottom:8px">` : ''}
<h1>${esc(title)}</h1>
${ctx.complete ? '' : `<blockquote>${LAB.t('report.borrador_nota', { sd: ctx.mt.stepsDone, sr: ctx.mt.stepsReq, ad: ctx.mt.ansDone, ar: ctx.mt.ansReq })}</blockquote>`}
<p class="sim">${LAB.t('report.sim_nota')}</p>
<p class="meta">${esc(LAB.t('report.meta1', { site: ctx.site, version: ctx.version, pv: p.version }))}<br>
${esc(LAB.ui.reportSite())}<br>
${esc(LAB.t('report.meta2', { user: ctx.user || '—', role: ctx.role || '—', sid: ctx.ps.sessionId || '—' }))}<br>
${esc(LAB.t(ctx.complete ? 'report.meta3_closed' : 'report.meta3_draft', { sim: ctx.simLocal, tz: ctx.tz, real: ctx.realDate }))}</p>
<p><b>${LAB.t('report.objetivo')}</b> ${esc(p.goal)}</p>
${mdToHtml(p.report ? p.report(ctx.snap) : [])}
<h2>${LAB.t('report.h_corridas')}</h2>${runsSection(ctx.runs)}
<h2>${LAB.t('report.h_barridos')}</h2>${sweepsSection(ctx.sweeps)}
<h2>${LAB.t('report.h_respuestas')}</h2>${answers || `<p>${LAB.t('report.sin_preguntas')}</p>`}
<h2>${LAB.t('report.h_incidentes')}</h2>${inc}
<h2>${LAB.t('report.h_cierre')}</h2><p>${ctx.complete ? LAB.t('report.cierre_completa', { fecha: esc(ctx.ps.completedAtUtc || '') }) : LAB.t('report.cierre_en_curso')}</p>
<h2>${LAB.t('report.h_ilos')}</h2><ul>${p.ilos.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
</body></html>`;
  };
  LAB.ui.mdToHtml = mdToHtml;
})();
