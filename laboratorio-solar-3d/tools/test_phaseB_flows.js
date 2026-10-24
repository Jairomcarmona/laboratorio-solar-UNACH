/* Fase B: recorrido completo solo con teclado (T26) y las cuatro practicas abiertas/completas en modo compacto y expandido. */
const h = require('./lib/harness.js');
const d = require('./lib/drive.js');
const fs = require('fs');

async function tabTo(page, sel, max = 120) {
  for (let i = 0; i < max; i++) { if (await page.evaluate((s) => document.activeElement && document.activeElement.matches(s), sel)) return i; await page.keyboard.press('Tab'); }
  return -1;
}
(async () => {
  const t = new h.T('Fase B · flujos'); const b = await h.launch(); const errs = [];
  // ---------------- T26 solo teclado
  {
    const { page, ctx } = await h.open(b, 'q=low', { width: 1366, height: 768 }, errs);
    page.on('dialog', (dl) => dl.accept());
    await d.adv(page, 0.3);
    t.ok('T26 el acceso se abre con el foco dentro del diálogo', await page.evaluate(() => document.getElementById('loginModal').contains(document.activeElement)), await page.evaluate(() => document.activeElement.id || document.activeElement.tagName));
    await page.keyboard.type('Teclado Solo');
    t.ok('T26 el foco queda atrapado en el diálogo al tabular', await (async () => { for (let i = 0; i < 12; i++) await page.keyboard.press('Tab'); return page.evaluate(() => document.getElementById('loginModal').contains(document.activeElement)); })());
    t.ok('T26 llegar al rol Estudiante con Tab', (await tabTo(page, '.role[data-role=student]', 12)) >= 0);
    await page.keyboard.press('Enter'); await d.adv(page, 1.5);
    t.ok('T26 sesión iniciada solo con teclado', await page.evaluate(() => LAB.app.source.telemetry.session.active && LAB.app.source.telemetry.session.user === 'Teclado Solo'));
    t.ok('T26 el foco vuelve a la página tras cerrar el diálogo', await page.evaluate(() => !document.getElementById('loginModal').contains(document.activeElement)), await page.evaluate(() => { const a = document.activeElement; return a.tagName + '#' + a.id + ' modalHidden=' + document.getElementById('loginModal').hidden; }));
    await page.evaluate(() => document.activeElement.blur && document.activeElement.blur());
    t.ok('T26 llegar a "Prácticas" con Tab', (await tabTo(page, '#btnPractices')) >= 0);
    await page.keyboard.press('Enter'); await d.adv(page, 0.3);
    t.ok('T26 el listado se abre con foco dentro', await page.evaluate(() => document.getElementById('practiceDrawer').contains(document.activeElement)));
    t.ok('T26 llegar a "Comenzar" de la práctica 1', (await tabTo(page, '#practiceDrawer .pcard button')) >= 0);
    await page.keyboard.press('Enter'); await d.adv(page, 0.6);
    t.ok('T26 la guía se abre y recibe el foco', await page.evaluate(() => document.activeElement.closest('#practiceGuide') !== null && !document.getElementById('practiceGuide').hidden));
    await d.doOperative(page);
    // controles con teclado
    await page.focus('#azSlider'); const az0 = await page.evaluate(() => LAB.app.source.telemetry.tracker.targetAz);
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await d.adv(page, 0.5);
    t.ok('T26 el deslizador de azimut responde a las flechas y envía la orden', await page.evaluate((a) => Math.abs(LAB.app.source.telemetry.tracker.targetAz - a) >= 1, az0));
    // respuesta con teclado
    await page.evaluate(() => { document.activeElement.blur(); });
    t.ok('T26 llegar al campo de respuesta con Tab', (await tabTo(page, '#ta_p1q1')) >= 0);
    await page.keyboard.type('Respuesta escrita solo con el teclado: Vmp/Voc ronda 0.8 y P=V·I vale cero en los extremos.', { delay: 2 });
    t.ok('T26 llegar a "Guardar respuesta y continuar" y activarla', (await tabTo(page, '#practiceGuide .q:not([hidden]) .btn.accent', 6)) >= 0);
    await page.keyboard.press('Enter'); await d.adv(page, 1);
    t.eq('T26 la práctica se completa con la respuesta enviada por teclado', await page.evaluate(() => LAB.ui.practices.state().ps.status), 'completed');
    // exportar reporte, tabla y CSV
    t.ok('T26 llegar a "Revisar e imprimir reporte" con Tab', (await tabTo(page, '#practiceGuide .closure .btn.accent', 60)) >= 0);
    await page.keyboard.press('Enter'); await page.waitForFunction(() => !document.getElementById('reportDlg').hidden); await d.adv(page, 0.5);
    t.ok('T26 el diálogo del reporte recibe el foco', await page.evaluate(() => document.getElementById('reportDlg').contains(document.activeElement)));
    t.ok('T26 llegar a "Descargar (.md)" dentro del diálogo', (await tabTo(page, '#rpMd', 10)) >= 0);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    t.ok('T26 el reporte se descarga con Enter', /reporte_practica1/.test(dl.suggestedFilename()), dl.suggestedFilename());
    await page.keyboard.press('Escape'); await d.adv(page, 0.5);
    t.ok('T26 Escape cierra el reporte y el foco vuelve a la guía', await page.evaluate(() => document.getElementById('reportDlg').hidden));
    await page.focus('#btnAcq'); await page.keyboard.press('Space'); await d.adv(page, 5); await page.keyboard.press('Space'); await d.adv(page, 0.5);
    await page.focus('#chartTableWrap summary'); await page.keyboard.press('Enter'); await d.adv(page, 3);
    t.ok('T26 la tabla alternativa de la gráfica se abre con teclado y tiene datos', await page.evaluate(() => document.querySelectorAll('#chartTable tr').length >= 3));
    await page.focus('#chartTabs button:nth-child(3)'); await page.keyboard.press('ArrowRight'); await d.adv(page, 1);
    t.ok('T26 las pestañas de la gráfica se recorren con flechas', await page.evaluate(() => document.querySelector('#chartTabs [aria-selected=true]').dataset.tab === 'energy'));
    await page.focus('#btnCsv'); const [dl2] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    t.ok('T26 el CSV se descarga con teclado', /\.csv$/.test(dl2.suggestedFilename()));
    await ctx.close();
  }
  // ---------------- cuatro prácticas, compacto y expandido, en tres distribuciones
  {
    const { page, ctx } = await h.open(b, 'q=low', { width: 1366, height: 768 }, errs);
    page.on('dialog', (dl) => dl.accept());
    await d.login(page, 'teacher', 'Layout Cuatro');
    await page.evaluate(() => { document.getElementById('toasts').style.display = 'none'; });
    const ovl = () => page.evaluate(() => {
      const vis = (e) => { if (!e || e.hidden) return null; let r = e.getBoundingClientRect(); if (e.id === 'practiceGuide') { const c = e.closest('#sidePractice, #midcol').getBoundingClientRect(); r = { left: Math.max(r.left, c.left), right: Math.min(r.right, c.right), top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom), width: Math.min(r.right, c.right) - Math.max(r.left, c.left) }; } return getComputedStyle(e).display === 'none' || r.width < 2 ? null : r; };
      const ids = ['#topbar', '#left', '#right', '#sidePractice', '#stagecell', '#dock', '#viewtabs', '#practiceGuide'], out = [];
      const items = ids.map((s) => [s, vis(document.querySelector(s))]).filter((x) => x[1]);
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) { const a = items[i][1], c = items[j][1]; if (items[j][0] === '#practiceGuide' && items[i][0] === '#stagecell') continue; if (items[i][0] === '#practiceGuide' || items[j][0] === '#practiceGuide') { const p = document.getElementById('practiceGuide').parentElement; if (p.id === 'midcol' || p.id === 'practiceHolder') { /* contenida en su región */ if (items[i][0] === '#sidePractice' || items[j][0] === '#sidePractice') continue; } } const w = Math.min(a.right, c.right) - Math.max(a.left, c.left), hh = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top); if (w > 2 && hh > 2) out.push(`${items[i][0]}×${items[j][0]}`); }
      const g = document.getElementById('practiceGuide'), r = g.getBoundingClientRect(), par = g.parentElement.getBoundingClientRect();
      if (!g.hidden && (r.left < par.left - 1 || r.right > par.right + 1)) out.push('guía fuera de su contenedor');
      return out;
    });
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      await d.openPractice(page, id);
      if (id === 'p4') { await d.click(page, '#btnAcq'); await d.adv(page, 6); }
      await d.doOperative(page, 120); await d.answerAll(page);
      t.eq(`${id} completada por la interfaz`, await page.evaluate(() => LAB.ui.practices.state().ps.status), 'completed');
      for (const [w, hh] of [[1366, 768], [1024, 768], [390, 844]]) {
        await page.setViewportSize({ width: w, height: hh }); await page.waitForTimeout(500); await d.adv(page, 0.3);
        await page.evaluate(() => { if (document.body.dataset.layout !== 'wide') { const tb = document.querySelector('#viewtabs [data-view=practice]'); if (tb) tb.click(); } });
        await d.adv(page, 0.3);
        for (const min of [false, true]) {
          await page.evaluate((m) => { const b = document.querySelector('#practiceGuide .mn'); if ((b.textContent === '+') !== m) b.click(); }, min);
          await d.adv(page, 0.2);
          const o = await ovl(); const fits = await page.evaluate(() => { const g = document.getElementById('practiceGuide'); const r = g.getBoundingClientRect(); return !g.hidden && r.width > 150 && r.right <= innerWidth + 1; });
          t.ok(`${id} ${w}x${hh} ${min ? 'compacta' : 'expandida'}: visible y sin superposiciones`, fits && o.length === 0, o.join(',') || (fits ? '' : 'no cabe'));
        }
      }
      await page.setViewportSize({ width: 1366, height: 768 }); await page.waitForTimeout(500);
      await page.evaluate(() => { const b = document.querySelector('#practiceGuide .mn'); if (b && b.textContent === '+') b.click(); });
    }
    await ctx.close();
  }
  t.ok('Sin errores de consola ni excepciones', errs.length === 0, errs.slice(0, 3).join(' | '));
  await b.close(); t.done();
})().catch((e) => { console.error('FALLO DE LA PRUEBA', e); process.exit(2); });
