/* Salida de la posición segura por viento, con la interfaz real: se explica la espera y al levantarse se puede operar de nuevo. */
const h = require('./lib/harness.js'), d = require('./lib/drive.js');
(async () => {
  const t = new h.T('Posición segura por viento · salida'); const b = await h.launch(); const errs = [];
  const { page } = await h.open(b, 'q=low', { width: 1366, height: 768 }, errs);
  await d.adv(page, 0.3); await d.login(page, 'student', 'Viento'); await d.adv(page, 0.5);
  await page.evaluate(() => { const s = LAB.app.source; s.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, 11, 0) }); s.send({ type: 'tracker.mode', mode: 'manual' }); s.send({ type: 'sim.wind', value: 20 }); });
  await d.adv(page, 6);
  const a = await page.evaluate(() => ({ st: document.getElementById('safeState').textContent, det: document.getElementById('safeDetail').textContent, stow: LAB.app.source.telemetry.safety.windStow }));
  t.ok('viento fuerte: posición segura con explicación de qué falta', a.stow && /Posición segura por viento/.test(a.st) && /sigue por encima de 10 m\/s/.test(a.det), a.st + ' / ' + a.det);
  await page.evaluate(() => { const s = LAB.app.source; s.send({ type: 'sim.wind', value: 3 }); }); await d.adv(page, 20);
  const m = await page.evaluate(() => document.getElementById('safeDetail').textContent);
  t.ok('al bajar el viento se muestra la cuenta regresiva', /se levanta en \d+ s simulados/.test(m), m);
  await page.evaluate(() => LAB.app.source.send({ type: 'sim.speed', speed: 60 })); await d.adv(page, 40);
  const r = await page.evaluate(() => ({ stow: LAB.app.source.telemetry.safety.windStow, st: document.getElementById('safeState').textContent }));
  t.ok('pasados 120 s simulados con viento bajo se levanta y vuelve a «Normal»', !r.stow && /Normal/.test(r.st), JSON.stringify(r));
  // operar desde la interfaz real
  await page.evaluate(() => document.querySelector('[data-preset], .chips button').click ? 0 : 0);
  const sent = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Este 45/.test(x.textContent)); b.click(); return LAB.app.source.telemetry.tracker.targetAz; });
  await d.adv(page, 30);
  t.ok('el preset «Este 45°» vuelve a mover el seguidor', await page.evaluate(() => Math.abs(LAB.app.source.telemetry.tracker.az - 120) < 2 && Math.abs(LAB.app.source.telemetry.tracker.tilt - 45) < 2 && !LAB.app.source.telemetry.safety.windStow), String(sent));
  const dis = await page.evaluate(() => [...document.querySelectorAll('#azSlider, #tiltSlider, #btnSendNum')].filter((x) => x && x.disabled).length);
  t.eq('ningún control de movimiento queda deshabilitado', dis, 0);
  t.ok('sin errores de consola', errs.length === 0, errs.join('|'));
  await b.close(); t.done();
})();
