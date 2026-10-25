/* Punto 8 en la interfaz: la sombra mutua se ve por módulo (subcadenas, bypass) y baja la potencia; sin sombra la línea no aparece. */
const { T, launch, open } = require('./lib/harness.js');
const d = require('./lib/drive.js');
const t = new T('Sombreado en la interfaz');
(async () => {
  const b = await launch(), errs = [];
  for (const lang of ['es', 'en']) {
    const { page, ctx } = await open(b, `q=low&lang=${lang}&cloud=0`, undefined, errs);
    await d.login(page, 'student');
    await d.send(page, { type: 'tracker.mode', mode: 'manual' }); await d.send(page, { type: 'tracker.target', az: 90, tilt: 60 });
    await page.evaluate(() => { const e = LAB.app.source; e.tracker.az = e.tracker.targetAz = 90; e.tracker.tilt = e.tracker.targetTilt = 60; });
    // se busca la hora de la mañana con sombra apreciable de B sobre A
    const h = await page.evaluate(() => { const e = LAB.app.source; for (let x = 6.3; x < 9.5; x += 0.05) { e.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 3, 21, x, 0) }); e.step(0.1); if (e.telemetry.A.shadeFrac > 0.25) return x; } return null; });
    t.ok(`${lang}: existe una hora con sombra de B sobre A`, h != null, String(h));
    await d.adv(page, 5);
    const r = await page.evaluate(() => ({ hidden: document.getElementById('shA').hidden, txt: document.getElementById('shA').textContent, shB: document.getElementById('shB').hidden, curve: LAB.app.source.telemetry.A.curve.shaded }));
    t.ok(`${lang}: con sombra la línea del módulo A se muestra con el reparto por subcadena`, !r.hidden && /\d+ ?%/.test(r.txt) && (lang === 'es' ? /subcadenas/.test(r.txt) : /substrings/.test(r.txt)) && r.curve, r.txt);
    t.ok(`${lang}: el módulo B sin sombra no muestra la línea`, r.shB);
        await page.evaluate(() => { const e = LAB.app.source; e.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 3, 21, 12, 0) }); });
    await d.adv(page, 3);
    t.ok(`${lang}: al mediodía desaparece`, await page.evaluate(() => document.getElementById('shA').hidden));
    await ctx.close();
  }
  t.ok('sin errores de página ni de consola', errs.length === 0, errs.slice(0, 3).join(' | '));
  await b.close(); t.done();
})().catch((e) => { console.error(e); process.exit(1); });
