/* Fase B: distribucion responsive, alcanzabilidad, superposiciones, foco, teclado y escena que sigue a su contenedor. */
const h = require('./lib/harness.js');
const d = require('./lib/drive.js');

const SIZES = [[1920, 1080], [1536, 864], [1366, 768], [1024, 768], [894, 668], [900, 520], [768, 1024], [390, 844], [960, 540]];
const EXPECT = { '1920x1080': 'wide', '1536x864': 'wide', '1366x768': 'wide', '1024x768': 'medium', '894x668': 'narrow', '900x520': 'narrow', '768x1024': 'narrow', '390x844': 'narrow', '960x540': 'narrow' };
const ESSENTIAL = [
  ['#sessionBtn', 'top'], ['#btnLog', 'top'], ['#btnHelp', 'top'], ['#btnFull', 'top'],
  ['#viewSeg button', 'scene'], ['#btnCam1', 'scene'], ['#btnCam2', 'scene'], ['#btnFree', 'scene'],
  ['#trModes button', 'controls'], ['#azSlider', 'controls'], ['#tiltSlider', 'controls'], ['#numAz', 'controls'], ['#btnNumGo', 'controls'], ['#loadModes button', 'controls'], ['#btnSweep', 'controls'],
  ['#btnEstop', 'controls'], ['#btnReset', 'controls'], ['#btnComms', 'controls'], ['#btnAck', 'controls'],
  ['#btnPlay', 'dock'], ['#speedSeg button', 'dock'], ['#timeSlider', 'dock'], ['#cloudSlider', 'dock'], ['#windSlider', 'dock'], ['#btnGust', 'dock'], ['#btnRain', 'dock'],
  ['#chartTabs button', 'data'], ['#btnAcq', 'data'], ['#btnCsv', 'data'], ['#btnResetE', 'data'], ['#chartTableWrap summary', 'data'],
];
const OVERLAP = () => {
  const vis = (e) => { if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return cs.display === 'none' || cs.visibility === 'hidden' || r.width < 2 || r.height < 2 ? null : r; };
  const groups = [['#topbar', '#left', '#right', '#sidePractice', '#stagecell', '#dock', '#viewtabs'], ['#viewbar', '#practiceGuide', '#infocard', '#logpanel']];
  const out = [];
  for (const g of groups) {
    const items = g.map((s) => [s, vis(document.querySelector(s))]).filter((x) => x[1]);
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i][1], b = items[j][1]; const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), hh = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 2 && hh > 2) out.push(`${items[i][0]} × ${items[j][0]} (${Math.round(w)}×${Math.round(hh)})`);
    }
  }
  return out;
};
const REACH = ([sel, where]) => {
  const els = Array.from(document.querySelectorAll(sel)); if (!els.length) return { sel, ok: false, why: 'no existe' };
  const bad = [];
  for (const e of els) {
    if (e.closest('[hidden]')) { bad.push('oculto'); continue; }
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) { bad.push('sin tamaño'); continue; }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) { bad.push('fuera de la ventana'); continue; }
    const top = document.elementFromPoint(cx, cy); if (!(top === e || e.contains(top) || (top && top.closest('label') && top.closest('label').htmlFor === e.id))) bad.push('tapado por ' + (top && (top.id || top.className || top.tagName)));
  }
  return { sel, ok: bad.length === 0, why: bad.slice(0, 2).join(',') };
};
const VIEWS_FOR = { top: null, scene: 'scene', dock: 'scene', controls: 'controls', data: 'data' };

(async () => {
  const t = new h.T('Fase B (navegador)');
  const b = await h.launch(); const errs = [];
  const { page, ctx } = await h.open(b, 'session=student&q=low', { width: 1366, height: 768 }, errs);
  page.on('dialog', (dl) => dl.accept());
  await d.adv(page, 0.5);
  await page.evaluate(() => { document.getElementById('toasts').style.display = 'none'; });

  for (const [w, hh] of SIZES) {
    await page.setViewportSize({ width: w, height: hh }); await page.waitForTimeout(400); await d.adv(page, 0.3);
    const key = `${w}x${hh}`;
    for (let i = 0; i < 20 && (await page.evaluate(() => document.body.dataset.layout)) !== EXPECT[key]; i++) await page.waitForTimeout(500);
    t.eq(`E04 ${key}: política de distribución`, await page.evaluate(() => document.body.dataset.layout), EXPECT[key]);
    t.ok(`C01 ${key}: sin desplazamiento horizontal de la página`, await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1 && document.scrollingElement.scrollHeight <= innerHeight + 1));
    // el canvas ocupa exactamente su contenedor (el render por software tarda ~1 s en entregar el cuadro del ResizeObserver)
    await page.waitForFunction(() => { const c = document.querySelector('#stage canvas'), s = document.getElementById('stagecell'); return s.clientWidth === 0 || Math.abs(c.clientWidth - s.clientWidth) <= 2 && Math.abs(c.clientHeight - s.clientHeight) <= 2; }, null, { timeout: 6000 }).catch(() => {});
    const sz = await page.evaluate(() => { const c = document.querySelector('#stage canvas'), s = document.getElementById('stagecell').getBoundingClientRect(); return { cw: c.clientWidth, ch: c.clientHeight, sw: Math.round(s.width), sh: Math.round(s.height), vis: s.width > 0 }; });
    if (sz.vis) t.ok(`E04 ${key}: la escena 3D se redimensiona con su contenedor`, Math.abs(sz.cw - sz.sw) <= 2 && Math.abs(sz.ch - sz.sh) <= 2, JSON.stringify(sz));
    // alcanzabilidad por vista
    const layout = EXPECT[key]; const needed = {};
    for (const [sel, where] of ESSENTIAL) { const v = VIEWS_FOR[where]; (needed[layout === 'wide' ? 'all' : (where === 'dock' && layout === 'medium' ? 'all' : (where === 'top' ? 'all' : (layout === 'medium' ? (v === 'scene' ? 'scene' : v) : v)))] = needed[layout === 'wide' ? 'all' : (where === 'top' ? 'all' : (v))] || []).push([sel, where]); }
    const fails = [];
    const check = async (view) => {
      if (view && layout !== 'wide') { await page.evaluate((v) => LAB.ui.layout.setView(v), view); await page.waitForTimeout(150); }
      const list = ESSENTIAL.filter(([s, wh]) => {
        if (layout === 'wide') return true; if (wh === 'top') return view === 'controls'; if (layout === 'medium') { if (wh === 'dock') return view === 'controls'; if (wh === 'scene') return view === 'controls'; return wh === view; }
        if (wh === 'dock') return view === 'scene'; return wh === view;
      });
      for (const it of list) { const r = await page.evaluate(REACH, it); if (!r.ok) fails.push(`${view || 'todo'}:${r.sel}(${r.why})`); }
    };
    if (layout === 'wide') await check(null); else { for (const v of layout === 'medium' ? ['controls', 'data'] : ['scene', 'controls', 'data']) await check(v); }
    t.ok(`C01 ${key}: controles esenciales alcanzables y no tapados`, fails.length === 0, fails.slice(0, 5).join(' | '));
    const ov = await page.evaluate(OVERLAP);
    t.ok(`C01 ${key}: sin superposiciones entre regiones`, ov.length === 0, ov.join(' | '));
  }

  // E05/E04: guía + ficha + bitácora abiertas a la vez en el tamaño de referencia
  await page.setViewportSize({ width: 1366, height: 768 }); await page.waitForTimeout(400);
  await page.evaluate(() => { LAB.ui.practices.openFromUrl('p1'); });
  await d.adv(page, 0.5);
  await page.evaluate(() => { LAB.app.handlePart('pyr'); }); await page.focus('#btnLog'); await page.keyboard.press('Enter'); await d.adv(page, 0.5);
  let ov = await page.evaluate(OVERLAP);
  t.ok('E05 guía + ficha + bitácora + vistas abiertas sin superponerse (1366x768)', ov.length === 0, ov.join(' | '));
  t.ok('E05 la escena sigue visible junto a los paneles', await page.evaluate(() => document.getElementById('stagecell').getBoundingClientRect().width > 500));

  // T03: cierre claro, foco coherente, tarea recuperable
  await page.keyboard.press('Escape'); await d.adv(page, 0.2);
  t.ok('T03 Escape cierra la bitácora primero (una capa por pulsación)', await page.evaluate(() => document.getElementById('logpanel').hidden && !document.getElementById('infocard').hidden));
  t.eq('T03 el foco vuelve al botón que abrió la bitácora', await page.evaluate(() => document.activeElement.id), 'btnLog');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Escape'); await d.adv(page, 0.2);
  t.ok('T03 Escape cierra la ficha', await page.evaluate(() => document.getElementById('infocard').hidden));
  await page.evaluate(() => document.querySelector('#practiceGuide .x').focus());
  await page.keyboard.press('Enter'); await d.adv(page, 0.3);
  t.ok('T03 ocultar la guía conserva la práctica (recuperable)', await page.evaluate(() => document.getElementById('practiceGuide').hidden && LAB.ui.practices.state().ps.status === 'in_progress'));
  await page.focus('#btnPractices'); await page.keyboard.press('Enter'); await d.adv(page, 0.3);
  t.ok('T03 el listado se abre como diálogo con el foco dentro', await page.evaluate(() => !document.getElementById('practiceDrawer').hidden && document.getElementById('practiceDrawer').contains(document.activeElement)));
  await page.keyboard.press('Escape'); await d.adv(page, 0.2);
  t.ok('T03 Escape cierra el listado y devuelve el foco', await page.evaluate(() => document.getElementById('practiceDrawer').hidden && document.activeElement.id === 'btnPractices'));
  await page.keyboard.press('Enter'); await d.adv(page, 0.3);
  await page.evaluate(() => { Array.from(document.querySelectorAll('#practiceDrawer .pcard button')).find((x) => /Continuar/.test(x.textContent)).click(); }); await d.adv(page, 0.5);
  t.ok('T03 "Continuar" reabre la guía con el progreso intacto', await page.evaluate(() => !document.getElementById('practiceGuide').hidden && LAB.ui.practices.state().ps.steps.session === true));

  // escena sigue a su contenedor al arrastrar / usar el separador con teclado
  const w0 = await page.evaluate(() => document.getElementById('stagecell').getBoundingClientRect().width);
  await page.focus('#sepL'); for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight'); await d.adv(page, 0.5);
  const w1 = await page.evaluate(() => ({ s: document.getElementById('stagecell').getBoundingClientRect().width, c: document.querySelector('#stage canvas').clientWidth, v: document.getElementById('sepL').getAttribute('aria-valuenow') }));
  t.ok('C01 el separador se mueve con el teclado y la escena se ajusta', w1.s < w0 - 40 && Math.abs(w1.c - w1.s) <= 2, `escena ${Math.round(w0)}→${Math.round(w1.s)}, valor ${w1.v}`);
  const bb = await page.evaluate(() => { const r = document.getElementById('sepR').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await page.mouse.move(bb[0], bb[1]); await page.mouse.down(); await page.mouse.move(bb[0] - 60, bb[1], { steps: 4 }); await page.mouse.up(); await d.adv(page, 0.5);
  t.ok('C01 el separador derecho se arrastra con el puntero', await page.evaluate((x) => Math.abs(document.getElementById('sepR').getBoundingClientRect().left - x) > 30, bb[0] - 5));
  t.ok('C01 los anchos se recuerdan', await page.evaluate(() => /wL|wR/.test(localStorage.getItem('labsolar.v2.layout') || '')));
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400); await page.setViewportSize({ width: 1366, height: 768 }); await page.waitForTimeout(500); await d.adv(page, 0.3);
  t.ok('E04 grande → pequeña → grande conserva la composición y la guía', await page.evaluate(() => document.body.dataset.layout === 'wide' && document.getElementById('practiceGuide').parentElement.id === 'midcol' && !document.getElementById('practiceGuide').hidden));

  // T16: Tab/Espacio no accionan atajos globales
  await page.evaluate(() => { document.activeElement.blur(); });
  const before = await page.evaluate(() => ({ p: LAB.app.source.telemetry.playing, v: LAB.app.rig.free, c: document.body.classList.contains('clean'), m: LAB.app.world.labels.mode }));
  let pressed = 0; const seen = new Set();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => { const e = document.activeElement; return { tag: e.tagName, id: e.id, type: e.type, text: (e.textContent || '').slice(0, 20), danger: ['btnEstop', 'btnComms', 'btnFull', 'btnPlay', 'btnSweep', 'btnAcq', 'btnClean', 'btnFree', 'btnLabels', 'btnOrbit', 'btnQuality', 'sessionBtn', 'btnReset', 'btnResetE', 'btnResetRain', 'btnNewRun'].includes(e.id) }; });
    seen.add(info.id || info.tag);
    if (info.tag === 'BUTTON' && !info.danger && !/Práctica|Reiniciar|Descargar|Abrir|Ver|Guardar/.test(info.text)) { await page.keyboard.press('Space'); pressed++; await page.evaluate(() => { document.activeElement.blur && 0; }); }
  }
  const after = await page.evaluate(() => ({ p: LAB.app.source.telemetry.playing, v: LAB.app.rig.free, c: document.body.classList.contains('clean'), m: LAB.app.world.labels.mode }));
  t.ok('T16 recorrer con Tab y activar con Espacio no dispara atajos globales extra', pressed > 5 && JSON.stringify(before) === JSON.stringify(after), `botones activados=${pressed}; ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  t.ok('T16 el orden de Tab alcanza controles de varias regiones', seen.size > 15, `${seen.size} elementos distintos`);

  t.ok('Sin errores de consola ni excepciones', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close(); await b.close(); t.done();
})().catch((e) => { console.error('FALLO DE LA PRUEBA', e); process.exit(2); });
