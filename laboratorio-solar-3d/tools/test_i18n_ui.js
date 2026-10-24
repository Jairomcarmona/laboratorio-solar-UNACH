/* Idioma, tema y accesibilidad de la interfaz (navegador real): selector ES/EN, cambio en vivo sin perder el avance,
 * tema claro/oscuro, contraste, foco con teclado, colores A/B y etiquetas 3D sin solaparse. */
const h = require('./lib/harness.js'), d = require('./lib/drive.js');

const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

(async () => {
  const t = new h.T('Idioma, tema y accesibilidad'); const b = await h.launch(); const errs = [];
  let { page, ctx } = await h.open(b, 'q=low', { width: 1366, height: 800 }, errs);
  page.on('dialog', (dl) => dl.accept());
  const txt = (sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);
  const attr = (sel, a) => page.evaluate(([s, a]) => (document.querySelector(s) || { getAttribute: () => null }).getAttribute(a), [sel, a]);

  // ---------------------------------------------------------------- idioma
  await d.adv(page, 0.3);
  t.eq('por defecto: español', await attr('html', 'lang'), 'es');
  t.eq('el botón del idioma activo está marcado', await attr('#langSwitch [data-lang=es]', 'aria-pressed'), 'true');
  t.eq('botón de prácticas en español', (await txt('#btnPractices')).trim(), 'Prácticas');
  await d.login(page, 'student', 'Ana'); await d.adv(page, 0.5);
  await d.openPractice(page, 'p1'); await d.adv(page, 1);
  const stepsBefore = await page.evaluate(() => JSON.stringify(LAB.ui.practices.state().ps.steps));
  const guideEs = await txt('#practiceGuide h3');
  t.ok('la guía abierta está en español', /Práctica 1/.test(guideEs), guideEs);
  await page.click('#langSwitch [data-lang=en]'); await d.adv(page, 0.5);
  t.eq('cambio en vivo a inglés (html lang)', await attr('html', 'lang'), 'en');
  t.eq('botón de prácticas en inglés', (await txt('#btnPractices')).replace(/▸/, '').trim().replace(/\s+1$/, ''), 'Practice');
  t.ok('la guía abierta se reconstruyó en inglés', /Practice 1/.test(await txt('#practiceGuide h3')), await txt('#practiceGuide h3'));
  t.ok('…sin perder el avance de la práctica', (await page.evaluate(() => JSON.stringify(LAB.ui.practices.state().ps.steps))) === stepsBefore);
  t.ok('el idioma se guarda en el navegador', (await page.evaluate(() => localStorage.getItem('lab.lang'))) === 'en');
  t.ok('vistas, etiquetas 3D y panel lateral cambian de idioma', await page.evaluate(() => /Overview/.test(document.getElementById('viewSeg').textContent) && /Anemometer/.test(document.querySelector('.tag[data-part=anemo]').textContent) && /Tracker/i.test(document.querySelector('#pTracker h3').textContent)));
  t.ok('el selector refleja el idioma (aria-pressed)', (await attr('#langSwitch [data-lang=en]', 'aria-pressed')) === 'true' && (await attr('#langSwitch [data-lang=es]', 'aria-pressed')) === 'false');
  // mensaje del banco generado en español por el motor, mostrado en inglés
  await page.evaluate(() => LAB.app.source.send({ type: 'tracker.target', az: 20 })); await d.adv(page, 0.3);
  t.ok('mensajes del motor se muestran en inglés (bitácora y aviso)', await page.evaluate(() => /outside the authorised range/.test(document.getElementById('logList').textContent)));
  t.ok('y los datos guardados siguen en español (la bitácora del motor no se altera)', await page.evaluate(() => LAB.app.source.logs.some((l) => /fuera del rango autorizado/.test(l.msg))));
  await page.click('#langSwitch [data-lang=es]'); await d.adv(page, 0.5);
  t.ok('volver a español reconstruye la guía y la bitácora', /Práctica 1/.test(await txt('#practiceGuide h3')) && await page.evaluate(() => /fuera del rango autorizado/.test(document.getElementById('logList').textContent)));
  await page.reload(); await page.waitForFunction('window.__labReady === true', null, { timeout: 90000 });
  t.eq('al recargar se conserva el idioma elegido', await attr('html', 'lang'), 'es');
  await page.evaluate(() => localStorage.setItem('lab.lang', 'en')); await page.reload(); await page.waitForFunction('window.__labReady === true', null, { timeout: 90000 });
  t.eq('…y el guardado manda sobre el del navegador', await attr('html', 'lang'), 'en');
  await ctx.close();

  // ?lang= manda sobre lo guardado; idioma desconocido se ignora
  ({ page, ctx } = await h.open(b, 'q=low&lang=es', { width: 1366, height: 800 }, errs));
  t.eq('?lang=es', await attr('html', 'lang'), 'es');
  await ctx.close();
  ({ page, ctx } = await h.open(b, 'q=low&lang=zz', { width: 1366, height: 800 }, errs));
  t.eq('?lang desconocido: queda español', await attr('html', 'lang'), 'es');
  await ctx.close();

  // ---------------------------------------------------------------- ubicación por URL (un solo lugar)
  ({ page, ctx } = await h.open(b, 'q=low&lat=19.43&lon=-99.13&alt=2240', { width: 1366, height: 800 }, errs));
  t.ok('?lat/lon/alt cambian la ubicación del motor y avisan de la tabla de cielo despejado', await page.evaluate(() => LAB.config.site.lat === 19.43 && !LAB.config.siteStatus().tableMatches && LAB.app.source.logs.some((l) => /Tuxtla/.test(l.msg))));
  await ctx.close();
  ({ page, ctx } = await h.open(b, 'q=low&lat=500', { width: 1366, height: 800 }, errs));
  t.ok('latitud inválida por URL: se ignora, se avisa y queda Tuxtla', await page.evaluate(() => LAB.config.site.lat === 16.7516 && LAB.app.source.logs.some((l) => /latitud/i.test(l.msg))));
  await ctx.close();

  // ---------------------------------------------------------------- tema, contraste, foco, colores
  for (const theme of ['dark', 'light']) {
    ({ page, ctx } = await h.open(b, `q=low&theme=${theme}&lang=en`, { width: 1366, height: 800 }, errs));
    page.on('dialog', (dl) => dl.accept());
    await d.adv(page, 0.3); await d.login(page, 'student', 'Ana'); await d.adv(page, 1);
    t.eq(`${theme}: data-theme aplicado`, await attr('html', 'data-theme'), theme);
    const probe = await page.evaluate(() => {
      const rgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); return m ? m[1].split(',').slice(0, 3).map(Number) : null; };
      const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
      const probeEl = (sel, prop) => { const e = document.querySelector(sel); return e ? rgb(getComputedStyle(e)[prop]) : null; };
      // un nodo auxiliar resuelve cualquier color CSS (incluidos los rgba sobre el fondo real del panel)
      const resolve = (c) => { const n = document.createElement('i'); n.style.color = c; document.body.appendChild(n); const r = rgb(getComputedStyle(n).color); n.remove(); return r; };
      const blend = (fg, a, bg) => fg.map((x, i) => Math.round(x * a + bg[i] * (1 - a)));
      const glassA = (() => { const m = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(getComputedStyle(document.querySelector('#pTracker')).backgroundColor); return m ? +m[1] : 1; })();
      const panelBg = blend(rgb(getComputedStyle(document.querySelector('#pTracker')).backgroundColor) || [0, 0, 0], glassA, resolve(v('--bg')));
      const cola = v('--col-a'), colb = v('--col-b');
      return { panelBg, tx: resolve(v('--tx')), tx2: resolve(v('--tx-2')), tx3: resolve(v('--tx-3')), accentBg: resolve('#2f6fd6'), colA: cola, colB: colb, palA: LAB.config.palette.A, palB: LAB.config.palette.B };
    });
    t.ok(`${theme}: texto principal ≥ 7:1 sobre el panel`, ratio(probe.tx, probe.panelBg) >= 7, ratio(probe.tx, probe.panelBg).toFixed(2));
    t.ok(`${theme}: texto secundario ≥ 4.5:1`, ratio(probe.tx2, probe.panelBg) >= 4.5, ratio(probe.tx2, probe.panelBg).toFixed(2));
    t.ok(`${theme}: texto terciario ≥ 4.5:1`, ratio(probe.tx3, probe.panelBg) >= 4.5, ratio(probe.tx3, probe.panelBg).toFixed(2));
    t.ok(`${theme}: texto blanco del botón principal ≥ 4.5:1 en todo su degradado`, ratio([255, 255, 255], probe.accentBg) >= 4.5 && ratio([255, 255, 255], [0, 62, 147]) >= 4.5, ratio([255, 255, 255], probe.accentBg).toFixed(2));
    t.ok(`${theme}: colores A/B del CSS = config.palette (escena, curvas y reporte comparten fuente)`, probe.colA.toLowerCase() === probe.palA && probe.colB.toLowerCase() === probe.palB, `${probe.colA}/${probe.colB}`);
    // foco visible con teclado
    const focus = await page.evaluate(async () => {
      const out = []; document.body.focus();
      for (let i = 0; i < 14; i++) {
        const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }); void ev;
        out.push(null);
      }
      return out.length;
    });
    void focus;
    const seen = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      seen.push(await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const s = getComputedStyle(e); return { tag: e.tagName + (e.id ? '#' + e.id : ''), outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 }; }));
    }
    const ok = seen.filter(Boolean);
    t.ok(`${theme}: el teclado alcanza controles y todos muestran un foco de ≥ 2 px`, ok.length >= 10 && ok.every((x) => x.outline), JSON.stringify(ok.filter((x) => !x.outline).slice(0, 3)));
    // etiquetas 3D sin solaparse (vista general)
    await page.evaluate(() => LAB.app.rig.set('general')); await d.adv(page, 0.5); await page.waitForTimeout(1500);
    const over = await page.evaluate(() => {
      const r = [...document.querySelectorAll('.tag')].filter((e) => getComputedStyle(e).visibility !== 'hidden' && +getComputedStyle(e).opacity > 0.3).map((e) => ({ n: e.textContent.trim(), ...e.getBoundingClientRect().toJSON() }));
      const bad = []; for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) { const a = r[i], c = r[j]; const w = Math.min(a.right, c.right) - Math.max(a.left, c.left), hh = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top); if (w > 3 && hh > 3) bad.push(a.n + ' × ' + c.n); }
      return { n: r.length, bad };
    });
    t.ok(`${theme}: etiquetas 3D visibles sin solaparse (${over.n} a la vista)`, over.n >= 3 && over.bad.length === 0, over.bad.join(' | '));
    if (theme === 'dark') {
      await page.click('#themeBtn'); await d.adv(page, 0.2);
      t.eq('el botón de tema cambia a claro', await attr('html', 'data-theme'), 'light');
      t.ok('…y lo guarda', (await page.evaluate(() => localStorage.getItem('lab.theme'))) === 'light');
      t.eq('…con aria-pressed', await attr('#themeBtn', 'aria-pressed'), 'true');
      await page.click('#themeBtn'); await d.adv(page, 0.2);
      t.eq('y de vuelta a oscuro', await attr('html', 'data-theme'), 'dark');
    }
    await ctx.close();
  }

  t.ok('sin errores de consola ni excepciones', errs.length === 0, errs.slice(0, 3).join(' | '));
  await b.close(); t.done();
})();
