/* Banco real: consola de operación (objetivo preparado y enviado con «Mover», avance del movimiento, bloqueos) y visor de cámaras IP (HLS).
  * (usa una pila recién iniciada: si otra prueba dejó paro de emergencia, el seguidor no se mueve) Usa la pila de desarrollo (E2E_URL, por omisión http://127.0.0.1:8765); si no responde se omite con aviso. Con ffmpeg sirve un HLS de prueba en /cam/cam2/. */
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { T, launch } = require('./lib/harness.js');
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8765';
const t = new T('Banco real: consola y cámaras IP');

(async () => {
  const up = await fetch(BASE + '/api/health').then(() => true).catch(() => false);
  if (!up) { console.log('AVISO: sin pila de desarrollo en ' + BASE + ': se omite'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-'));
  const ff = cp.spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '10', path.join(dir, 'index.m3u8')]);
  const haveHls = ff.status === 0;
  const b = await launch(), errs = [];
  const ctx = await b.newContext({ viewport: { width: 1366, height: 768 } }), page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/401|Failed to load resource|WebSocket|favicon/.test(m.text())) errs.push(m.text()); });
  let camOn = false;
  await page.route('**/cam/cam2/**', (r) => {
    const f = path.join(dir, new URL(r.request().url()).pathname.split('/').pop());
    if (!camOn || !haveHls || !fs.existsSync(f)) return r.fulfill({ status: 404 });
    r.fulfill({ body: fs.readFileSync(f), contentType: f.endsWith('m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
  });
  await page.goto(BASE + '/login.html?next=' + encodeURIComponent('/index.html?source=ws'));
  await page.fill('#user', 'ana'); await page.fill('#pass', 'dev-password-123'); await page.click('#go');
  await page.waitForURL(/index\.html/, { timeout: 10000 });
  await page.waitForFunction(() => window.__labReady === true, null, { timeout: 90000 });
  await page.waitForFunction(() => LAB.data.source.linkState() === 'connected', null, { timeout: 20000 });

  // solo lectura: no se puede mover y no hay aviso de simulado
  const ro = await page.evaluate(() => ({ dis: document.getElementById('btnMove').disabled, fake: !!document.getElementById('fakeBanner'), badge: document.getElementById('simBadge').textContent }));
  t.ok('sin control el botón Mover está desactivado', ro.dis);
  t.ok('no hay franja permanente de «simulado»; la insignia dice BANCO VIRTUAL', !ro.fake && /BANCO VIRTUAL/.test(ro.badge) && !/SIMULADO/.test(ro.badge), ro.badge);
  t.ok('en banco real se ocultan los deslizadores y las cámaras virtuales', await page.evaluate(() => ['azSlider', 'tiltSlider', 'numAz'].every((i) => document.getElementById(i).offsetParent === null) && document.getElementById('btnCam1').offsetParent === null && document.getElementById('btnIpCam').offsetParent !== null));
  t.ok('cámara sin flujo: rótulo claro, no video', await page.evaluate(() => /Sin flujo de video/.test(document.getElementById('camStatus').textContent) && document.getElementById('camView').dataset.state === 'none'));

  await page.getByText('Tomar el control').click();
  await page.waitForFunction(() => !document.getElementById('btnMove').disabled || document.getElementById('btnMove').textContent.length > 0, null, { timeout: 10000 });
  await page.evaluate(() => LAB.app.source.send({ type: 'tracker.target', az: 180, tilt: 17 }));
  await page.waitForFunction(() => Math.abs(LAB.data.source.telemetry.tracker.az - 180) < 0.6 && Math.abs(LAB.data.source.telemetry.tracker.tilt - 17) < 0.6, null, { timeout: 150000 });
  t.ok('en posición: «Ya está en ese objetivo» y barra al 100 %', await page.evaluate(() => /Ya está/.test(document.getElementById('btnMove').textContent) && document.getElementById('moveBar').getAttribute('aria-valuenow') === '100'));

  await page.click('#trConsole .stepper[data-axis="az"] [data-d="-5"]');
  await page.click('#trConsole .stepper[data-axis="tilt"] [data-d="5"]');
  const staged = await page.evaluate(() => ({ btn: document.getElementById('btnMove').textContent, tgt: LAB.data.source.telemetry.tracker.targetAz }));
  t.ok('los pasos solo preparan el objetivo (no se envía nada)', /Mover a 175° \/ 22°/.test(staged.btn) && staged.tgt === 180, JSON.stringify(staged));
  await page.click('#trPresets button[data-az="120"]');
  t.ok('un preset también solo prepara', await page.evaluate(() => /Mover a 120° \/ 45°/.test(document.getElementById('btnMove').textContent) && LAB.data.source.telemetry.tracker.targetAz === 180));
  await page.click('#btnMove');
  await page.waitForFunction(() => document.getElementById('moveBar').classList.contains('run'), null, { timeout: 20000 });
  const mv = await page.evaluate(() => ({ txt: document.getElementById('moveTxt').textContent, btn: document.getElementById('btnMove').textContent, hot: document.getElementById('camPanel').classList.contains('hot'), tgt: LAB.data.source.telemetry.tracker.targetAz }));
  t.ok('al mover: «Moviéndose, en curso», objetivo enviado y cámara del seguidor resaltada', /Moviéndose, en curso/.test(mv.txt) && mv.tgt === 120 && mv.hot && /Moviéndose/.test(mv.btn), JSON.stringify(mv));
  await page.waitForFunction(() => document.getElementById('moveBar').classList.contains('done'), null, { timeout: 150000 });
  t.ok('al llegar: «En posición» y se quita el resalte', await page.evaluate(() => /En posición · objetivo 120° \/ 45°/.test(document.getElementById('moveTxt').textContent) && !document.getElementById('camPanel').classList.contains('hot')));

  if (haveHls) {
    camOn = true;
    await page.waitForFunction(() => document.getElementById('camView').dataset.state === 'live', null, { timeout: 30000 });
    t.ok('con flujo HLS real el visor reproduce y marca EN VIVO', await page.evaluate(() => !document.getElementById('camLive').hidden && document.getElementById('camVideo').currentTime > 0));
  } else console.log('AVISO: sin ffmpeg: se omite la reproducción HLS');
  t.ok('sin errores de consola ni de página', errs.length === 0, errs.join(' | '));
  await b.close(); fs.rmSync(dir, { recursive: true, force: true });
  t.done();
})().catch((e) => { console.error(e); process.exit(1); });
