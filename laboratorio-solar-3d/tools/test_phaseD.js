/* Fase D · C20: falla de WebGL con mensaje, pérdida/restauración de contexto, calidad baja, sin recursos externos. */
const h = require('./lib/harness.js'), d = require('./lib/drive.js');
(async () => {
  const t = new h.T('Fase D · C20'); const b = await h.launch();
  // 1) sin WebGL
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } }); const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(h.url ? h.url('glfail=1') : 'file://' + require('path').resolve(__dirname, '../index.html') + '?glfail=1');
    await page.waitForFunction(() => window.__labGlFailed === true, null, { timeout: 30000 });
    const r = await page.evaluate(() => ({ vis: !document.getElementById('glFail').hidden, title: document.getElementById('glFailTitle').textContent, foc: document.activeElement.id, why: document.getElementById('glFailWhy').textContent }));
    t.ok('C20 sin WebGL se muestra un mensaje claro y no una pantalla en blanco', r.vis && /No se pudieron iniciar/.test(r.title), r.title);
    t.ok('C20 el mensaje da pasos y el detalle técnico', /Detalle técnico/.test(r.why) && r.foc === 'glRetry', r.why);
    t.ok('C20 sin errores no controlados de página', errs.length === 0, errs.join('|'));
    await page.click('#glLow'); await page.waitForTimeout(500);
    t.ok('C20 «Reintentar en calidad baja» recarga con q=low y sin la falla', await page.evaluate(() => /q=low/.test(location.search) && !/glfail/.test(location.search)));
    await ctx.close();
  }
  // 2) pérdida y restauración de contexto
  {
    const errs = []; const { page, ctx } = await h.open(b, 'q=low', { width: 1280, height: 720 }, errs);
    await d.adv(page, 0.5);
    const ms0 = await page.evaluate(() => LAB.app.source.simMs);
    await page.evaluate(() => { const gl = LAB.app.renderer.getContext(); window.__ext = gl.getExtension('WEBGL_lose_context'); window.__ext.loseContext(); });
    await page.waitForFunction(() => LAB.app.glLost === true, null, { timeout: 20000 });
    t.ok('C20 al perder el contexto aparece un aviso persistente', await page.evaluate(() => { const b = document.getElementById('glLost'); return !b.hidden && b.getAttribute('role') === 'alert'; }));
    await d.adv(page, 3);
    t.ok('C20 el simulador sigue calculando mientras no hay imagen', await page.evaluate((m) => LAB.app.source.simMs > m, ms0));
    t.ok('C20 la pérdida queda en la bitácora', await page.evaluate(() => LAB.app.source.logs.some((l) => /Se perdió el contexto gráfico/.test(l.msg))));
    await page.evaluate(() => window.__ext.restoreContext());
    await page.waitForFunction(() => LAB.app.glLost === false, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    t.ok('C20 al restaurar desaparece el aviso y queda registrado', await page.evaluate(() => document.getElementById('glLost').hidden && LAB.app.source.logs.some((l) => /Contexto gráfico restaurado/.test(l.msg))));
    // la escena vuelve a dibujarse: el canvas no queda en negro
    await page.evaluate(() => { LAB.app.rig.set('general', true); }); await page.waitForTimeout(3000);
    const png = await page.locator('#stage canvas').screenshot();
    const nonBlack = await page.evaluate(async (b64) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = 64; c.height = 36; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 64, 36); const dta = x.getImageData(0, 0, 64, 36).data; let n = 0; for (let i = 0; i < dta.length; i += 4) if (dta[i] + dta[i + 1] + dta[i + 2] > 60) n++; return n; }, png.toString('base64'));
    t.ok('C20 tras restaurar la escena se vuelve a dibujar (no queda en negro)', nonBlack > 300, 'píxeles claros: ' + nonBlack);
    t.ok('C20 sin errores de consola o de página durante pérdida y restauración', errs.length === 0, errs.join(' | ').slice(0, 300));
    await ctx.close();
  }
  // 3) calidad baja y recursos locales
  {
    const errs = []; const { page, ctx } = await h.open(b, 'q=low', { width: 1280, height: 720 }, errs); const reqs = [];
    t.ok('C20 calidad baja: DPR 1, sin bloom, sombras 1024', await page.evaluate(() => LAB.app.quality.level === 'low' && !LAB.app.bloom.enabled && LAB.app.LEVELS.low.shadow === 1024 && LAB.app.LEVELS.low.dpr === 1));
    t.ok('C20 la interfaz ofrece el selector de calidad', await page.evaluate(() => { const b = document.getElementById('btnQuality'); return !!b && /Baja/i.test(b.textContent + b.title); }));
    const ext = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((n) => !n.startsWith('file:')));
    t.ok('C20 funciona sin recursos externos (fuentes y bibliotecas locales)', ext.length === 0, ext.join(', '));
    t.ok('C20 las fuentes son del sistema (sin descargas de fuentes)', await page.evaluate(() => !document.fonts || [...document.fonts].length === 0));
    await ctx.close();
  }
  await b.close(); t.done();
})();
