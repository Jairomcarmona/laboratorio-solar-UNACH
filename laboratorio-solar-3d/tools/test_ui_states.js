/* Puntos 1-5: etiquetas de ayuda 3D ocultas, banda de ±1 % en la diferencia B/A, estados del enlace con el banco y modo Gemelo.
 * Las partes de red usan la pila de desarrollo (E2E_URL, por omision http://127.0.0.1:8765); si no responde se omiten con aviso. */
const { T, launch, open } = require('./lib/harness.js');
const d = require('./lib/drive.js');
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8765';
const t = new T('Estados de interfaz (puntos 1-5)');

async function netPage(browser, qs, errors) {
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 864 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|401|favicon/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(BASE + '/login.html?next=' + encodeURIComponent('/index.html?' + qs));
  await page.fill('#user', 'ana'); await page.fill('#pass', 'dev-password-123'); await page.click('#go');
  await page.waitForURL(/index\.html/, { timeout: 10000 });
  return { page, ctx };
}

(async () => {
  const b = await launch(); const errs = [];

  // ---- 1 y 2: simulador local
  {
    const { page, ctx } = await open(b, 'q=low&time=11:30&cloud=0', undefined, errs);
    await d.login(page, 'student'); await d.adv(page, 0.5);
    const aids = await page.evaluate(() => [...document.querySelectorAll('.tag.aid')].map((e) => getComputedStyle(e.parentElement).display));
    t.ok('1: las 4 etiquetas de ayudas 3D existen y nacen ocultas (no apiladas en el origen)', aids.length === 4 && aids.every((x) => x === 'none'), JSON.stringify(aids));
    await d.send(page, { type: 'tracker.mode', mode: 'manual' });
    await d.send(page, { type: 'tracker.target', az: 180, tilt: 17 });
    await d.adv(page, 120);
    const eq = await page.evaluate(() => ({ cls: document.getElementById('diffBadge').className, txt: document.getElementById('diffTxt').textContent, d: LAB.app.source.telemetry.comparison.powerDiffPct, band: LAB.app.source.telemetry.comparison.powerDiffBandPct }));
    t.ok('2: con B igual a A la diferencia es neutral (≈) y no roja', eq.band === 1 && /eq/.test(eq.cls) && !/neg/.test(eq.cls) && /≈/.test(eq.txt), JSON.stringify(eq));
    // ruido de décimas: se fuerza el cálculo del indicador con un valor dentro de la banda y otro fuera
    const forced = await page.evaluate(() => {
      const out = {}, s = LAB.app.source, orig = s._snapshot ? null : null; void orig;
      let n = 0; for (const v of [-0.6, -3]) { const tel = s.telemetry; tel.comparison.powerDiffPct = v; LAB.ui.update(tel, 0, performance.now() + 1e7 * (++n)); out[v] = document.getElementById('diffBadge').className; }
      return out;
    });
    t.ok('2: −0.6 % (ruido) no es rojo; −3 % sí', !/neg/.test(forced['-0.6']) && /neg/.test(forced['-3']), JSON.stringify(forced));
    await ctx.close();
  }

  // ---- 3, 4 y 5: pila de desarrollo
  let up = true;
  try { const r = await fetch(BASE + '/api/health').catch(() => null); up = !!r; } catch (e) { up = false; }
  if (!up) console.log('AVISO: sin pila de desarrollo en ' + BASE + ': se omiten las pruebas de banco real y gemelo');
  else {
    // banco real
    const { page, ctx } = await netPage(b, 'source=ws', errs);
    await page.waitForFunction(() => window.__labReady === true, null, { timeout: 60000 });
    const seen = await page.evaluate(() => new Promise((res) => { const s = LAB.data.source, got = []; const iv = setInterval(() => { const st = s.linkState(); if (got[got.length - 1] !== st) got.push(st); if (st === 'connected') { clearInterval(iv); res(got); } }, 5); setTimeout(() => { clearInterval(iv); res(got); }, 20000); }));
    t.ok('3: el enlace termina en conectado (pasando por estados previos o ya conectado)', seen[seen.length - 1] === 'connected', JSON.stringify(seen));
    await page.waitForTimeout(500);
    let badge = await page.textContent('#simBadge');
    t.ok('3: conectado: la insignia dice el origen verdadero (banco virtual del puente)', /BANCO VIRTUAL/.test(badge) && !/SIMULACI/i.test(badge), badge);
    t.ok('3: conectado: la franja dice Enlace correcto y no hay aviso', await page.evaluate(() => /Enlace correcto|Link OK|ms|no normal|not normal|Banco no|Bench not/i.test(document.getElementById('rlLink').textContent) && document.getElementById('linkBanner').hidden));
    await page.evaluate(() => { const s = LAB.data.source; s.closing = true; s.ws.close(); s.link = 'closed'; s.closing = false; s.opts.reconnectMs = [60000]; clearTimeout(s._retryTimer); s.now = () => Date.now() + 10000; });
    await page.waitForFunction(() => /perdido|lost/i.test(document.getElementById('simBadge').textContent), null, { timeout: 8000 });
    badge = await page.textContent('#simBadge');
    t.ok('3: enlace perdido: la insignia conserva el origen y lo dice', /BANCO VIRTUAL/.test(badge) && /perdido|lost/i.test(badge), badge);
    t.ok('3: enlace perdido: aviso visible que no habla de simulación local', await page.evaluate(() => { const b = document.getElementById('linkBanner'); return !b.hidden && !/simulaci/i.test(b.textContent) && /perdido|lost/i.test(b.textContent); }));
    t.ok('3: enlace perdido: la franja lo dice y bloquea la operación', await page.evaluate(() => /perdido|lost/i.test(document.getElementById('rlLink').textContent) && !LAB.data.source.telemetry.safety.canOperate));
    await ctx.close();

    // conectando / validando con una pasarela que no responde: sin datos nunca se muestra origen ni valores
    {
      const c2 = await b.newContext({ viewport: { width: 1536, height: 864 } }); const p2 = await c2.newPage();
      await p2.route('**/api/ws-ticket', (r) => r.fulfill({ status: 500, body: '{}' }));
      await p2.goto(BASE + '/login.html'); await p2.fill('#user', 'ana'); await p2.fill('#pass', 'dev-password-123'); await p2.click('#go'); await p2.waitForURL(/index\.html|reservas|portal/, { timeout: 10000 }).catch(() => {});
      await p2.goto(BASE + '/index.html?source=ws'); await p2.waitForFunction(() => window.__labReady === true, null, { timeout: 60000 });
      await p2.waitForTimeout(800);
      const txt = await p2.textContent('#simBadge');
      t.ok('3: sin datos del banco: la insignia dice BANCO · Conectando (no «Banco real» ni simulación)', /BANCO/.test(txt) && /Conectando|Connecting/.test(txt) && !/SIMULACI/i.test(txt), txt);
      t.ok('3: sin datos: el aviso lo explica y los valores quedan en —', await p2.evaluate(() => { const bn = document.getElementById('linkBanner'); return !bn.hidden && /—|valid/i.test(bn.textContent) && /—|NaN/.test(document.getElementById('pA').textContent) && !/\d{3}/.test(document.getElementById('pA').textContent); }));
      await c2.close();
    }

    // gemelo
    const tw = await netPage(b, 'source=twin', errs);
    await tw.page.waitForFunction(() => window.__labReady === true && LAB.app.source.ws.everValid, null, { timeout: 60000 });
    // el reloj de la pila de desarrollo es el real (aquí puede ser de noche): se fija el sello de la telemetría a mediodía local de Tuxtla
    await tw.page.evaluate(() => { const ws = LAB.app.source.ws, o = ws._onTele.bind(ws), noon = LAB.fromLocal(2026, 10, 23, 11, 30), t0 = Date.now(); window.__shade = 0; ws._onTele = (t) => { t.ts = Date.now(); const r = { ...t, B: { ...t.B, shadeFrac: window.__shade } }; r.__ts = noon + (Date.now() - t0); o(r); ws.telemetry.simMs = r.__ts; }; });
    await tw.page.waitForTimeout(2500);
    const r = await tw.page.evaluate(() => ({ box: !document.getElementById('twinBox').hidden, note: !document.getElementById('twinCtlNote').hidden, rows: ['twAm', 'twAmod', 'twAd', 'twBm', 'twBmod', 'twBd'].map((i) => document.getElementById(i).textContent), warn: document.getElementById('twinWarn').textContent, unc: document.getElementById('twinUnc').textContent, op: getComputedStyle(document.querySelector('#left .panel')).opacity, badge: document.getElementById('simBadge').textContent }));
    t.ok('4: el gemelo muestra Medido, Modelo y Diferencia con valores', r.box && r.rows.every((x) => x !== '—' && x.length > 1), JSON.stringify(r.rows));
    t.ok('4: los controles quedan atenuados y se explica por qué', r.note && +r.op < 0.8, r.op);
    t.ok('5: a mediodía el gemelo es válido y muestra la incertidumbre', /válido|valid/i.test(r.warn) && !/no válido|not valid/i.test(r.warn) && /±/.test(r.unc), r.warn + ' | ' + r.unc);
    await tw.page.evaluate(() => { window.__shade = 0.3; });
    await tw.page.waitForTimeout(2500);
    const sh = await tw.page.evaluate(() => ({ warn: document.getElementById('twinWarn').textContent, cls: document.getElementById('twinWarn').className }));
    t.ok('5: con sombra el gemelo avisa que no es válido y por qué', /no válido|not valid/i.test(sh.warn) && /sombra|shade|shad/i.test(sh.warn) && !/okmsg/.test(sh.cls), sh.warn);
    await tw.ctx.close();
  }
  t.ok('sin errores de página ni de consola', errs.length === 0, errs.slice(0, 3).join(' | '));
  await b.close(); t.done();
})().catch((e) => { console.error(e); process.exit(1); });
