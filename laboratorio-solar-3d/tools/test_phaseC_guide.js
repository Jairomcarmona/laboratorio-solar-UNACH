/* Fase C · C16 y T30: guía (vista de todos los pasos, pistas, borrador), reporte imprimible con evidencia congelada. */
const h = require('./lib/harness.js'), d = require('./lib/drive.js');
(async () => {
  const t = new h.T('Fase C · guía y reporte'); const b = await h.launch(); const errs = [];
  const { page } = await h.open(b, 'q=low', { width: 1366, height: 768 }, errs);
  page.on('dialog', (dl) => dl.accept());
  await d.adv(page, 0.3); await d.login(page, 'student', 'Rosa Informe'); await d.adv(page, 0.5);
  await d.openPractice(page, 'p1'); await d.adv(page, 0.5);

  const sum0 = await page.evaluate(() => document.querySelector('#practiceGuide .pgsum').textContent);
  t.ok('C16 la guía dice «Paso actual N de total» y condiciones pendientes', /Paso actual \d+ de \d+/.test(sum0) && /requisitos operativos/.test(sum0), sum0);
  // pistas progresivas
  const nh = async () => page.evaluate(() => { const li = document.querySelector('#practiceGuide li.cur'); const t = li.querySelector('.pghint'); return t && !t.hidden ? t.textContent : ''; });
  t.eq('C16 sin pista al inicio', await nh(), '');
  await page.evaluate(() => [...document.querySelectorAll('#practiceGuide li.cur .stepbtns button')].find((x) => /pista/i.test(x.textContent)).click()); await d.adv(page, 0.3);
  const h1 = await nh(); t.ok('C16 la primera pista orienta', /^Pista 1 de 2:/.test(h1), h1);
  await page.evaluate(() => [...document.querySelectorAll('#practiceGuide li.cur .stepbtns button')].find((x) => /pista/i.test(x.textContent)).click()); await d.adv(page, 0.3);
  const h2 = await nh(); t.ok('C16 la segunda pista es más concreta', /^Pista 2 de 2:/.test(h2), h2);
  t.ok('C16 las pistas se acaban (no hay más botón)', await page.evaluate(() => ![...document.querySelectorAll('#practiceGuide li.cur .stepbtns button')].some((x) => !x.hidden && /pista/i.test(x.textContent))));
  t.ok('C16 la pista persiste en el progreso guardado', await page.evaluate(() => { const st = LAB.ui.practices.state(); return Object.values(st.ps.hints || {}).includes(2); }));

  // vista de todos los pasos con la guía minimizada
  await page.click('#practiceGuide .mn'); await d.adv(page, 0.3);
  t.ok('C16 con la guía minimizada el botón de todos los pasos sigue visible', await page.evaluate(() => { const b = document.getElementById('btnOverview'); const r = b.getBoundingClientRect(); return document.getElementById('practiceGuide').classList.contains('min') && r.width > 0 && getComputedStyle(b).display !== 'none'; }));
  await page.click('#btnOverview'); await d.adv(page, 0.5);
  const ov = await page.evaluate(() => ({ rows: document.querySelectorAll('#ovBody tr').length, head: [...document.querySelectorAll('#ovBody th')].map((x) => x.textContent), ilo: document.querySelectorAll('#ovBody ul li').length, txt: document.getElementById('ovBody').textContent }));
  t.ok('C16 la vista lista objetivo, acción, observación esperada y evidencia de cada paso', ov.rows === 12 && ['Objetivo', 'Acción', 'Observación esperada', 'Evidencia'].every((k) => ov.head.includes(k)), JSON.stringify(ov.head) + ov.rows);
  t.ok('C16 la vista incluye los resultados de aprendizaje', ov.ilo >= 3, String(ov.ilo));
  t.ok('C16 todas las filas traen observación esperada', await page.evaluate(() => [...document.querySelectorAll('#ovBody tr')].slice(1).every((r) => r.children[3].textContent.length > 8)));
  await page.keyboard.press('Escape'); await d.adv(page, 0.3);
  t.ok('C16 Escape cierra la vista', await page.evaluate(() => document.getElementById('overviewDlg').hidden));
  await page.click('#practiceGuide .mn');

  // borrador incompleto
  await page.click('#btnDraftHtml'); await page.waitForFunction(() => !document.getElementById('reportDlg').hidden); await d.adv(page, 0.5);
  const dr = await page.evaluate(() => ({ title: document.getElementById('rpTitle').textContent, html: document.getElementById('reportDlg')._html }));
  t.ok('C16 el borrador está marcado como incompleto', /borrador incompleto/i.test(dr.title) && /Borrador incompleto/.test(dr.html) && /BORRADOR INCOMPLETO/.test(dr.html));
  t.ok('C16 el HTML declara el modo simulador', /Modo simulador/.test(dr.html));
  t.ok('C16 incluye identidad de demostración, sesión, versión y práctica', /Rosa Informe/.test(dr.html) && /Sesión: /.test(dr.html) && /Versión de la aplicación 2\./.test(dr.html) && /definición de la práctica v3/.test(dr.html));
  await page.keyboard.press('Escape'); await d.adv(page, 0.3);

  // completar la práctica
  await d.doOperative(page, 80); await d.answerAll(page); await d.adv(page, 1);
  const st = await d.state(page); t.eq('la práctica 1 se completa', st && st.status, 'completed');
  await page.click('#btnReportHtml'); await page.waitForFunction(() => !document.getElementById('reportDlg').hidden); await d.adv(page, 0.5);
  const html1 = await page.evaluate(() => document.getElementById('reportDlg')._html);
  t.ok('C16 reporte final sin marca de borrador', !/BORRADOR/.test(html1) && /Práctica completada el/.test(html1));
  t.ok('C16 el reporte incluye respuestas, barridos, corridas e incidentes', /<h2>Respuestas<\/h2>/.test(html1) && /Barridos I‑V registrados/.test(html1) && /Corridas y gráficas/.test(html1) && /Incidentes y alarmas/.test(html1) && /Respuesta de prueba/.test(html1));
  t.ok('C16 la vista previa se muestra en un iframe sandbox', await page.evaluate(() => { const f = document.getElementById('rpFrame'); return !!f.srcdoc && f.contentDocument && f.contentDocument.querySelector('h1') && /Reporte/.test(f.contentDocument.querySelector('h1').textContent); }));
  // descargas
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#rpHtml')]);
  const file = require('fs').readFileSync(await dl.path(), 'utf8');
  t.ok('C16 descarga .html autocontenida (sin scripts ni recursos externos)', /^<!doctype html>/.test(file) && !/<script|src=["']http|<link /.test(file), dl.suggestedFilename());
  const [dm] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#rpMd')]);
  t.ok('C16 descarga .md equivalente', /^# Reporte/.test(require('fs').readFileSync(await dm.path(), 'utf8')), dm.suggestedFilename());
  t.ok('C16 el botón imprimir existe y llama a la impresión del navegador', await page.evaluate(() => { let called = 0; const w = document.getElementById('rpFrame').contentWindow; w.print = () => { called++; }; document.getElementById('rpPrint').click(); return called === 1; }));
  await page.keyboard.press('Escape'); await d.adv(page, 0.3);

  // T30: cambiar el modelo y el entorno no altera la evidencia congelada
  await page.evaluate(() => { const s = LAB.app.source; s.send({ type: 'sim.cloud', value: 0.95 }); s.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, 4, 0) }); s.send({ type: 'sim.wind', value: 12 }); });
  await d.adv(page, 5);
  await page.evaluate(() => LAB.ui.practices.openReport()); await page.waitForFunction(() => !document.getElementById('reportDlg').hidden); await d.adv(page, 0.5);
  const html2 = await page.evaluate(() => document.getElementById('reportDlg')._html);
  const strip = (x) => x.replace(/fecha real: [^<]*/, '');
  t.ok('T30 tras cambiar nubes, hora y viento (y generar una alarma nueva) el reporte final no cambia (evidencia congelada)', strip(html1) === strip(html2), `len ${html1.length} vs ${html2.length}`);
  await page.keyboard.press('Escape');

  // Siguiente práctica
  await page.evaluate(() => { const b = [...document.querySelectorAll('#practiceGuide .closure button')].find((x) => /Siguiente/.test(x.textContent)); b.click(); }); await d.adv(page, 0.8);
  const nx = await page.evaluate(() => ({ cur: LAB.ui.practices.state().current, p1: LAB.ui.practices.state().progress.practices.p1.status }));
  t.ok('C16 «Siguiente práctica» abre la 2 y deja la 1 archivada como completada', nx.cur === 'p2' && nx.p1 === 'completed', JSON.stringify(nx));
  t.ok('sin errores de consola', errs.length === 0, errs.join(' | ').slice(0, 300));
  await page.screenshot({ path: '/tmp/phaseC_guide.png' });
  await b.close(); t.done();
})();
