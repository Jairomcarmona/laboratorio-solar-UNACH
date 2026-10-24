/* Controles del tiempo con clics reales y el bucle real (sin avanzar el motor a mano): pausa, play, velocidad, saltos y teclado.
 * Comprueba que el reloj solar sigue al tiempo real aunque los cuadros sean lentos (renderizado por software ~1-5 fps). */
const h = require('./lib/harness.js');
(async () => {
  const t = new h.T('Controles del tiempo (clics reales)'); const b = await h.launch(); const errs = [];
  const { page } = await h.open(b, 'q=low&session=student', { width: 1366, height: 768 }, errs);
  page.on('dialog', (x) => x.accept());
  await page.evaluate(() => { document.getElementById('toasts').style.display = 'none'; });
  const S = () => page.evaluate(() => { const e = LAB.app.source; return { ms: e.simMs, t: performance.now(), pl: e.playing, sp: e.speed, btn: document.getElementById('btnPlay').textContent }; });
  const run = async (ms) => { const a = await S(); await page.waitForTimeout(ms); const c = await S(); return { dSim: (c.ms - a.ms) / 1000, dReal: (c.t - a.t) / 1000, pl: c.pl, sp: c.sp, btn: c.btn }; };
  // con ~1 fps el hilo principal tarda en atender el clic: se espera a que el estado cambie antes de medir
  const until = (pl) => page.waitForFunction((p) => LAB.app.source.playing === p, pl, { timeout: 15000 });
  const near = (r, speed) => r.dSim >= 0.4 * r.dReal * speed - 1.2 && r.dSim <= 1.15 * r.dReal * speed + 1.2;
  let r = await run(5000);
  t.ok('Avanza a tiempo real (x1) sin tocar nada', near(r, 1), `simulado ${r.dSim.toFixed(1)} s en ${r.dReal.toFixed(1)} s reales`);
  await page.click('#btnPlay'); await until(false); r = await run(3000);
  t.ok('Pausa: el reloj se detiene y el botón muestra ▶', r.dSim === 0 && !r.pl && r.btn === '▶');
  await page.click('#btnPlay'); await until(true); r = await run(5000);
  t.ok('Play después de pausar: vuelve a avanzar a tiempo real y el botón muestra ❚❚', r.pl && near(r, 1) && r.btn === '❚❚', `simulado ${r.dSim.toFixed(1)} s en ${r.dReal.toFixed(1)}`);
  await page.click('#speedSeg button[data-s="600"]'); r = await run(4000);
  t.ok('x600: avanza 600 veces más rápido', r.sp === 600 && near(r, 600), `simulado ${r.dSim.toFixed(0)} s en ${r.dReal.toFixed(1)}`);
  await page.click('#btnPlay'); await until(false); await page.click('#qNoon'); await page.waitForTimeout(1500);
  const pausedAt = await S(); t.ok('Saltar a mediodía estando en pausa mantiene la pausa', !pausedAt.pl);
  await page.click('#btnPlay'); await until(true); r = await run(4000);
  t.ok('Play después de pausa + salto: avanza', r.pl && r.dSim > 0 && near(r, 600));
  await page.fill('#dateIn', '2026-06-21'); await page.dispatchEvent('#dateIn', 'change'); r = await run(3000);
  t.ok('Cambiar la fecha no detiene el reloj', r.pl && r.dSim > 0);
  await page.click('#vtData').catch(() => {}); await page.click('#btnPlay'); await until(false); await page.waitForTimeout(1200); await page.click('#btnPlay'); await until(true); r = await run(4000);
  t.ok('Pausa y play tras cambiar de pestaña/vista', r.pl && near(r, 600), JSON.stringify(r));
  await page.focus('#btnPlay'); await page.keyboard.press('Space'); await until(false); let s = await S();
  t.ok('Espacio sobre el botón pausa una sola vez (no se anula)', !s.pl);
   await page.keyboard.press('Space'); await until(true); r = await run(3000);
  t.ok('Espacio otra vez reanuda', r.pl && r.dSim > 0, JSON.stringify(r));
  const fast = await page.evaluate(() => { const e = LAB.app.source, a = e.playing; e.send({ type: 'sim.play', toggle: true }); e.send({ type: 'sim.play', toggle: true }); const b = e.playing; e.send({ type: 'sim.play', toggle: true }); const c = e.playing; e.send({ type: 'sim.play', on: true }); return [a, b, c, e.playing]; });
  t.ok('Dos conmutaciones seguidas, sin cuadro entre ellas, se anulan y la tercera pausa (el motor decide, no la copia local)', fast[1] === fast[0] && fast[2] === !fast[0] && fast[3] === true, JSON.stringify(fast));
  t.ok('Sin errores de consola', errs.length === 0, errs.slice(0, 2).join('|'));
  await b.close(); t.done();
})().catch((e) => { console.error(e); process.exit(2); });
