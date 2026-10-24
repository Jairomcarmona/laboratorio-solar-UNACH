/* S13 en el navegador: la pestaña Análisis sobre una corrida real del simulador (carga en cortocircuito -> Isc contra G). */
const h = require('./lib/harness.js');
(async () => {
  const t = new h.T('Pestaña Análisis (navegador)');
  const browser = await h.launch(), errors = [];
  const { page } = await h.open(browser, 'session=student&speed=60&time=2026-10-23T09:00&cloud=0', undefined, errors);
  await page.evaluate(() => { LAB.ui.send({ type: 'tracker.mode', mode: 'fixed' }); LAB.ui.send({ type: 'load.set', mode: 'sc' }); LAB.ui.send({ type: 'acq.newRun', label: 'sc-prueba' }); LAB.ui.send({ type: 'acq.start' }); });
  await h.step(page, 600, 0.1);
  await page.evaluate(() => LAB.ui.send({ type: 'acq.stop' }));
  await page.click('#chartTabs button[data-tab="analysis"]');
  await page.waitForSelector('#anCanvas', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('#anStats tr').length >= 4, null, { timeout: 8000 });
  const stats = await page.evaluate(() => Array.from(document.querySelectorAll('#anStats tr')).map((r) => r.textContent));
  const view = await page.evaluate(() => { const v = LAB.ui.analysisview; return { n: v.res.points.length, slope: v.res.fit && v.res.fit.slope, r2: v.res.fit && v.res.fit.r2 }; });
  t.ok('Isc–G con puntos y ajuste', view.n >= 15 && view.slope > 0.010 && view.slope < 0.016 && view.r2 > 0.99, JSON.stringify(view));
  t.ok('tabla de estadísticas con pendiente, ordenada y R²', stats.some((s) => /Pendiente/.test(s)) && stats.some((s) => /R²/.test(s)));
  t.ok('la gráfica de Potencia se oculta', await page.evaluate(() => document.querySelector('.chartbox:not(.rvbox)').hidden));
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#anCsv')]);
  t.ok('CSV del análisis se descarga', /iscVsG\.csv$/.test(dl.suggestedFilename()));
  const [dp] = await Promise.all([page.waitForEvent('download', { timeout: 40000 }), page.click('#anPng')]);
  t.ok('PNG se descarga', /\.png$/.test(dp.suggestedFilename()));
  await page.click('#anTabs button[data-k="vocVsT"]');
  t.ok('Voc–T sin puntos en cortocircuito: avisa en vez de fallar', await page.evaluate(() => /no tiene suficientes puntos/.test(document.getElementById('anNote').textContent)));
  await page.click('#anTabs button[data-k="dailyPR"]');
  t.ok('PR diario calcula el día de la corrida', await page.evaluate(() => LAB.ui.analysisview.res.days.length === 1));
  t.ok('sin errores de página', errors.length === 0, errors.join(' | '));
  await browser.close(); t.done();
})().catch((e) => { console.error(e); process.exit(1); });
