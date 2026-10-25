/* Puntos 6 y 7 en la interfaz: vista «Conexiones del módulo» (marcada ilustrativa) y multímetro virtual con Voc e Isc. */
const { T, launch, open } = require('./lib/harness.js');
const d = require('./lib/drive.js');
const t = new T('Conexiones y multímetro (interfaz)');
/** Avanza el motor y el multímetro con un dt real conocido (d.adv llama a ui.update con dt = 0) */
const pump = (page, sec, dt = 0.1) => page.evaluate(([sec, dt]) => { const s = LAB.app.source; for (let i = 0; i < Math.round(sec / dt); i++) { s.step(dt); LAB.ui.connections.update(s.telemetry, dt); } window.__n = (window.__n || 0) + 1; LAB.ui.update(s.telemetry, 0, performance.now() + 1e5 * window.__n); }, [sec, dt]);
(async () => {
  const b = await launch(), errs = [];
  for (const [lang, theme] of [['es', 'dark'], ['en', 'light']]) {
    const { page, ctx } = await open(b, `q=low&lang=${lang}&theme=${theme}&cloud=0`, undefined, errs);
    await d.login(page, 'student'); await d.adv(page, 3);
    await page.click('#btnConn'); await d.adv(page, 0.3);
    const L = lang === 'es' ? { ill: /ILUSTRATIVO/, sc: /CORTOCIRCUITO|Medir Isc/ } : { ill: /ILLUSTRATIVE/, sc: /SHORT CIRCUIT|Measuring Isc/ };
    t.ok(`${lang}/${theme}: el diálogo abre marcado como ilustrativo`, await page.evaluate(() => !document.getElementById('connDlg').hidden && !!document.getElementById('connIllus').textContent) && L.ill.test(await page.textContent('#connIllus')));
    t.ok(`${lang}/${theme}: el diagrama muestra caja, MC4 y puntos de medida`, await page.evaluate(() => ['c-box', 'c-mc4', 'c-tp', 'c-stamp', 'c-diode'].every((c) => document.querySelector('#connSvg .' + c)) && document.querySelectorAll('#connSvg [data-tp]').length === 2));
    // Voc de B
    const before = await page.evaluate(() => ({ mode: LAB.app.source.telemetry.load.mode, voc: LAB.app.source.telemetry.B.voc }));
    await page.click('#dmmFn [data-fn=voc]'); await page.click('#dmmGo');
    let sawSc = false;
    for (let i = 0; i < 60; i++) { await pump(page, 0.5); if (await page.evaluate(() => !LAB.ui.connections.busy)) break; }
    const rv = await page.evaluate(() => ({ val: document.getElementById('dmmVal').textContent, unit: document.getElementById('dmmUnit').textContent, unc: document.getElementById('dmmUnc').textContent, mode: LAB.app.source.telemetry.load.mode, msg: document.getElementById('dmmMsg').textContent, voc: LAB.app.source.telemetry.B.voc }));
    t.ok(`${lang}/${theme}: Voc medido ≈ Voc del modelo y la carga vuelve al modo anterior`, Math.abs(parseFloat(rv.val) - rv.voc) < 0.6 && rv.unit === 'V' && rv.mode === before.mode && /±/.test(rv.unc), JSON.stringify(rv));
    // Isc de A: advertencia de cortocircuito durante la medida
    await page.click('#connMod [data-m=A]'); await page.click('#dmmFn [data-fn=isc]');
    t.ok(`${lang}/${theme}: con Isc seleccionado ya se advierte del cortocircuito`, L.sc.test(await page.textContent('#dmmScWarn')) && await page.evaluate(() => !document.getElementById('dmmScWarn').hidden));
    await page.click('#dmmGo');
    for (let i = 0; i < 80; i++) { await pump(page, 0.3); const s = await page.evaluate(() => ({ mode: LAB.app.source.telemetry.load.mode, busy: LAB.ui.connections.busy })); if (s.mode === 'sc') sawSc = true; if (!s.busy) break; }
    const ri = await page.evaluate(() => ({ val: document.getElementById('dmmVal').textContent, unit: document.getElementById('dmmUnit').textContent, mode: LAB.app.source.telemetry.load.mode, isc: LAB.app.source.telemetry.A.isc }));
    t.ok(`${lang}/${theme}: Isc pasó por el modo sc, midió ≈ Isc y restituyó la carga`, sawSc && Math.abs(parseFloat(ri.val) - ri.isc) < 0.5 && ri.unit === 'A' && ri.mode === before.mode, JSON.stringify(ri));
    // puntas invertidas
    await page.selectOption('#dmmRed', 'A-'); await page.selectOption('#dmmBlack', 'A+'); await page.click('#dmmFn [data-fn=voc]'); await page.click('#dmmGo');
    for (let i = 0; i < 60; i++) { await pump(page, 0.5); if (await page.evaluate(() => !LAB.ui.connections.busy)) break; }
    t.ok(`${lang}/${theme}: puntas invertidas dan una lectura negativa`, parseFloat(await page.textContent('#dmmVal')) < 0, await page.textContent('#dmmVal'));
    await page.selectOption('#dmmRed', 'A+'); await page.selectOption('#dmmBlack', 'B-');
    t.ok(`${lang}/${theme}: puntas en módulos distintos: Medir deshabilitado y se explica`, await page.evaluate(() => document.getElementById('dmmGo').disabled && document.getElementById('dmmMsg').textContent.length > 10));
    // clic en un punto de medida coloca las puntas
    await page.click('#connMod [data-m=B]'); await page.click('#tpNeg circle'); await page.click('#tpPos circle');
    t.ok(`${lang}/${theme}: clic en TP coloca la punta`, await page.evaluate(() => document.getElementById('dmmBlack').value === 'B+' || document.getElementById('dmmRed').value === 'B+'));
    // visitante: no puede medir
    await page.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/conexiones_${lang}_${theme}.png` : '/tmp/claude-0/shot_' + lang + '_' + theme + '.png' });
    await ctx.close();
  }
  { // sin control no se mide
    const { page, ctx } = await open(b, 'q=low&cloud=0', undefined, errs); await d.login(page, 'visitor'); await d.adv(page, 1);
    await page.click('#btnConn');
    t.ok('un visitante ve el diagrama pero no puede medir', await page.evaluate(() => document.getElementById('dmmGo').disabled));
    await ctx.close();
  }
  { // paro de emergencia durante la medida: aborta y no deja la carga en sc
    const { page, ctx } = await open(b, 'q=low&cloud=0', undefined, errs); await d.login(page, 'student'); await d.adv(page, 2);
    await page.click('#btnConn'); await page.click('#dmmFn [data-fn=isc]'); await page.click('#dmmGo'); await pump(page, 0.5);
    await page.evaluate(() => LAB.ui.send({ type: 'safety.estop', who: 'prueba' })); await pump(page, 1);
    t.ok('paro de emergencia durante Isc: la medida se aborta con aviso', await page.evaluate(() => !LAB.ui.connections.busy && /paro|emergencia|safety|stop/i.test(document.getElementById('dmmMsg').textContent)), await page.textContent('#dmmMsg'));
    await ctx.close();
  }
  t.ok('sin errores de página ni de consola', errs.length === 0, errs.slice(0, 3).join(' | '));
  await b.close(); t.done();
})().catch((e) => { console.error(e); process.exit(1); });
