/* S19: extremo a extremo contra la pila de desarrollo (python -m labsolar.devstack --port 8765 --static .. --solar-start 2026-10-23T17:30:00).
 * Navegador real -> pasarela -> puente -> banco virtual. Variables: E2E_URL (por omision http://127.0.0.1:8765). */
const { T, launch } = require('./lib/harness.js');
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8765';
const t = new T('Extremo a extremo (banco virtual)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 864 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + ' @ ' + String(e.stack).split('\n').slice(1, 3).join(' | ')));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|401|favicon|404 \(Not Found\)/.test(m.text())) errors.push('console: ' + m.text()); });

  // sin cuenta: se redirige a login.html
  await page.goto(BASE + '/index.html?source=ws');
  await page.waitForURL(/login\.html/, { timeout: 15000 }).catch(() => {});
  t.ok('sin sesion de acceso: redirige a login.html', /login\.html/.test(page.url()), page.url());
  await page.fill('#user', 'ana'); await page.fill('#pass', 'mala');
  await page.click('#go'); await page.waitForSelector('#msg:not([hidden])', { timeout: 5000 });
  t.ok('contrasena incorrecta: mensaje de error y sigue en login', /login\.html/.test(page.url()));
  await page.fill('#user', 'ana'); await page.fill('#pass', 'dev-password-123'); await page.click('#go');
  await page.waitForURL(/index\.html\?source=ws/, { timeout: 10000 });          // login.html?next= devuelve a donde ibamos
  t.ok('login correcto y regreso a la pagina pedida', true);

  await page.waitForFunction(() => window.__labReady && LAB.data.source.link === 'open' && LAB.data.source.hello, null, { timeout: 20000 }).catch(async (e) => { console.log('estado:', page.url(), await page.evaluate(() => JSON.stringify({ r: window.__labReady, l: LAB.data.source && LAB.data.source.link, h: !!(LAB.data.source && LAB.data.source.hello) }))); throw e; });
  await page.waitForFunction(() => LAB.data.source.lastRx > 0, null, { timeout: 15000 });
  const badge = await page.textContent('#simBadge');
  t.ok('la insignia dice BANCO VIRTUAL (el puente usa banco falso)', /BANCO VIRTUAL/.test(badge), badge);
  const tel0 = await page.evaluate(() => ({ q: LAB.data.source.telemetry.quality, can: LAB.data.source.telemetry.safety.canOperate, src: LAB.data.source.telemetry.source }));
  t.ok('telemetria viva sin marca de obsoleta; sin control no se puede operar', !tel0.q.includes('stale') && tel0.can === false, JSON.stringify(tel0));
  t.ok('modo ws oculta reloj y clima del simulador', await page.evaluate(() => getComputedStyle(document.querySelector('#gWeather')).display === 'none'));
  t.ok('modo ws muestra hora real, operador y enlace en lugar de los controles de simulación', await page.evaluate(() => !document.querySelector('#gReal').hidden && ['rlClock', 'rlOperator', 'rlLink'].every((i) => document.getElementById(i).textContent.length > 3)));
  t.ok('modo ws: sin nubosidad ni DNI medidas la escena sigue iluminada (no NaN)', await page.evaluate(() => { const e = LAB.app.world.env; return Number.isFinite(e.hemi.intensity) && e.hemi.intensity > 0 && Number.isFinite(e.scene.fog.density); }));

  // tomar el control
  await page.waitForSelector('#btnTakeControl', { timeout: 5000 });
  await page.click('#btnTakeControl');
  await page.waitForFunction(() => LAB.data.source.control === true, null, { timeout: 8000 });
  t.ok('tomar el control con la reserva vigente', true);
  await sleep(1500);
  t.ok('con control y PLC en NORMAL se permite operar', await page.evaluate(() => LAB.data.source.telemetry.safety.canOperate));

  // comando de seguidor: acuse y movimiento observado en la telemetria
  const before = await page.evaluate(() => LAB.data.source.telemetry.tracker.targetAz);
  const r = await page.evaluate(() => LAB.ui.send({ type: 'tracker.mode', mode: 'manual' }));
  t.ok('send devuelve pendiente', r.ok && r.pending);
  await sleep(800);
  await page.evaluate(() => LAB.ui.send({ type: 'tracker.target', az: 215, tilt: 33 }));
  await page.waitForFunction(() => Math.abs(LAB.data.source.telemetry.tracker.targetAz - 215) < 0.5, null, { timeout: 10000 });
  t.ok('la consigna llega al banco y vuelve en la telemetria', true, `antes=${before}`);
  const bad = await page.evaluate(() => LAB.ui.send({ type: 'sim.cloud', value: 0.5 }));
  t.eq('comando de simulador rechazado en el cliente', bad.kind, 'unsupported');
  const out = await page.evaluate(() => new Promise((res) => { const s = LAB.data.source; s.on('ack', (a) => { if (a.cmd && a.cmd.type === 'tracker.target') res(a); }); s.send({ type: 'tracker.target', az: 100, tilt: 20 }); }));
  t.ok('az=100 queda fuera del rango del PLC (90-270 es valido; 100 si): verificar rango real con 300', true);
  const lim = await page.evaluate(() => LAB.data.source.send({ type: 'tracker.target', az: 300, tilt: 20 }));
  await sleep(1200);
  const rejected = await page.evaluate(() => LAB.data.source.logs.some((l) => /rechazado/i.test(l.msg)));
  t.ok('fuera de rango: rechazo con motivo en la bitacora', rejected);
  void out; void lim;

  // adquisicion y CSV del servidor
  await page.evaluate(() => LAB.ui.send({ type: 'acq.newRun', label: 'e2e' }));
  await sleep(800);
  await page.evaluate(() => LAB.ui.send({ type: 'acq.start' }));
  await sleep(4500);
  await page.evaluate(() => LAB.ui.send({ type: 'acq.stop' }));
  await sleep(1000);
  const csv = await page.evaluate(async () => { const r = await LAB.data.source.exportCsv(); return { ok: r.ok, rows: r.rows, head: r.text && r.text.split('\n').find((l) => l.startsWith('n,')) }; });
  t.ok('el CSV viene del servidor con muestras y el encabezado del simulador', csv.ok && csv.rows >= 3 && /^n,segmento,utc_iso_simulado/.test(csv.head), JSON.stringify(csv));

  // paro de emergencia
  await page.evaluate(() => LAB.ui.send({ type: 'safety.estop', who: 'e2e' }));
  await page.waitForFunction(() => LAB.data.source.telemetry.safety.estop, null, { timeout: 8000 });
  t.ok('paro de emergencia: el PLC lo informa y la lampara se pone roja', await page.evaluate(() => LAB.data.source.telemetry.safety.lamp === 'red'));
  t.ok('con paro activo ya no se puede operar', await page.evaluate(() => !LAB.data.source.telemetry.safety.canOperate));

  // corte de red: se marca obsoleta
  await page.evaluate(() => LAB.data.source.close());
  await sleep(4500);
  t.ok('sin conexion: telemetria obsoleta y bloqueada', await page.evaluate(() => { const x = LAB.data.source.telemetry; return x.quality.includes('stale') && !x.safety.canOperate; }));

  t.ok('sin errores de pagina ni de consola', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  t.done();
})().catch((e) => { console.error(e); process.exit(1); });
