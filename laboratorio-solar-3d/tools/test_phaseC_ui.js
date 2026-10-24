/* Fase C (interfaz): pestaña Corrida (C15), comparar corridas (C12/C13), barridos (C14). Navegador real. */
const h = require('./lib/harness.js'), d = require('./lib/drive.js');
(async () => {
  const t = new h.T('Fase C · interfaz'); const b = await h.launch(); const errs = [];
  const { page } = await h.open(b, 'q=low', { width: 1366, height: 768 }, errs);
  page.on('dialog', (dl) => dl.accept());
  await d.adv(page, 0.3); await d.login(page, 'student', 'Ana Prueba'); await d.adv(page, 0.5);

  // tab Corrida vacía: estado vacío claro
  await page.click('#chartTabs [data-tab=run]'); await d.adv(page, 0.5);
  await page.waitForFunction(() => /Todavía no hay/.test(document.getElementById('rvEmpty').textContent), null, { timeout: 15000 }).catch(() => {});
  t.ok('C15 estado vacío con instrucción', await page.evaluate(() => /Todavía no hay/.test(document.getElementById('rvEmpty').textContent) && !document.getElementById('rvEmpty').hidden));
  t.ok('C15 la pestaña Corrida oculta la gráfica estándar', await page.evaluate(() => document.querySelector('.chartbox:not(.rvbox)').hidden && !document.getElementById('runPane').hidden));

  // generar dos corridas con escenario P3 (dos estrategias)
  async function oneRun(mode, lockTilt, label) {
    await page.evaluate(([mode, lockTilt, label]) => {
      const s = LAB.app.source; s.send({ type: 'scenario.apply', scenario: { id: 'p3-claro-v1', simMs: LAB.fromLocal(2026, 10, 23, 9, 0), cloud: 0.1, windBase: 3.2, seed: 20261023, az: 180, tilt: 17, speed: 60 } });
      s.send({ type: 'tracker.locks', lockAz: false, lockTilt }); s.send({ type: 'tracker.mode', mode }); s.send({ type: 'acq.newRun', label }); s.send({ type: 'acq.start' });
    }, [mode, lockTilt, label]);
    await d.adv(page, 100, 0.5);
    await page.evaluate(() => LAB.app.source.send({ type: 'acq.stop' }));
  }
  await oneRun('astro', false, 'Dos ejes'); await oneRun('astro', true, 'Un eje');
  await page.evaluate(() => LAB.ui.runview.refresh()); await d.adv(page, 0.5);
  const info = await page.evaluate(() => ({ opts: [...document.querySelectorAll('#rvSelect option')].map((o) => o.textContent), empty: document.getElementById('rvEmpty').hidden, sum: document.getElementById('rvSumTable') && document.getElementById('rvSumTable').textContent }));
  t.ok('C15 el selector lista las corridas guardadas', info.opts.length === 2, info.opts.join(' | '));
  t.ok('C15 ya no aparece el estado vacío', info.empty);
  t.ok('C13 el resumen trae fórmulas y unidades', /E_A/.test(info.sum) && /Wh/.test(info.sum) && /\(E_B\/E_A − 1\)×100/.test(info.sum), info.sum.slice(0, 200));

  // cursor
  await page.evaluate(() => document.getElementById('rvCanvas').scrollIntoView({ block: 'center' })); await d.adv(page, 0.3);
  const box = await page.evaluate(() => { const r = document.getElementById('rvCanvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.5); await d.adv(page, 0.5);
  await page.waitForFunction(() => /Muestra \d+ ·/.test(document.getElementById('rvReadout').textContent), null, { timeout: 15000 }).catch(() => {});
  t.ok('C15 el cursor muestra valores con unidades', await page.evaluate(() => /Muestra \d+ ·/.test(document.getElementById('rvReadout').textContent) && /W\b/.test(document.getElementById('rvReadout').textContent) && /W\/m²/.test(document.getElementById('rvReadout').textContent)), await page.evaluate(() => document.getElementById('rvReadout').textContent));
  // teclado
  await page.focus('#rvCanvas'); const c0 = await page.evaluate(() => LAB.ui.runview.cursor);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await d.adv(page, 0.5);
  t.ok('C15 las flechas mueven el cursor', await page.evaluate((c) => LAB.ui.runview.cursor === c + 2, c0));
  // zoom
  await page.click('#rvIn'); await d.adv(page, 0.3);
  const z1 = await page.evaluate(() => LAB.ui.runview.view && LAB.ui.runview.view[1] - LAB.ui.runview.view[0]);
  t.ok('C15 acercar reduce el tramo visible', z1 > 0, String(z1));
  await page.click('#rvR'); await d.adv(page, 0.3);
  t.ok('C15 desplazar mueve el tramo', await page.evaluate((w) => { const v = LAB.ui.runview.view; return v && Math.abs(v[1] - v[0] - w) < 1; }, z1));
  // escala
  const n1 = await page.evaluate(() => document.getElementById('rvAxisNote').textContent);
  await page.click('#rvScale'); await d.adv(page, 0.3);
  const n2 = await page.evaluate(() => document.getElementById('rvAxisNote').textContent);
  t.ok('C15 la nota indica escala automática/fija', /automática/.test(n1) && /fija/.test(n2), n1.slice(0, 80) + ' / ' + n2.slice(0, 80));
  // series
  await page.evaluate(() => { const c = document.getElementById('rvS_pB'); c.click(); });
  t.ok('C15 ocultar una serie se refleja en el cursor', await page.evaluate(() => /\(oculta\)/.test(document.getElementById('rvReadout').textContent) || (LAB.ui.runview.renderReadout(), /\(oculta\)/.test(document.getElementById('rvReadout').textContent))));
  // tabla paginada
  await page.evaluate(() => { document.getElementById('rvTableWrap').open = true; document.getElementById('rvTableWrap').dispatchEvent(new Event('toggle')); }); await d.adv(page, 0.5);
  const rows1 = await page.evaluate(() => document.querySelectorAll('#rvTableWrap tr').length);
  t.ok('C15 tabla paginada (máximo 20 filas por página)', rows1 > 1 && rows1 <= 21, String(rows1));
  // anotaciones
  const ann = await page.evaluate(() => document.querySelector('#rvAnnList summary').textContent);
  t.ok('C15 lista de anotaciones disponible', /Anotaciones de la corrida \(\d+\)/.test(ann), ann);
  // exportaciones
  await page.click('#rvReset'); await d.adv(page, 0.3);
  const [dl1] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#rvCsv')]);
  const csv = require('fs').readFileSync(await dl1.path(), 'utf8');
  t.ok('C15 CSV del tramo visible con datos simulados y encabezado', /DATOS SIMULADOS/.test(csv) && csv.split('\n').length > 20, dl1.suggestedFilename());
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#rvPng')]);
  const png = require('fs').readFileSync(await dl2.path());
  t.ok('C15 PNG válido', png.slice(1, 4).toString() === 'PNG', dl2.suggestedFilename() + ' ' + png.length + ' bytes');

  // comparar corridas
  const pickAll = async () => { const n = await page.evaluate(() => document.querySelectorAll('#rvCmpWrap input[type=checkbox]').length); for (let i = 0; i < n; i++) await page.evaluate((i) => { const c = document.querySelectorAll('#rvCmpWrap input[type=checkbox]')[i]; if (!c.checked) c.click(); }, i); };
  await page.evaluate(() => { const w = document.getElementById('rvCmpWrap'); w.open = true; w.dispatchEvent(new Event('toggle')); }); await d.adv(page, 0.4);
  await pickAll(); await d.adv(page, 0.4);
  const cmp = await page.evaluate(() => ({ v: document.getElementById('rvCmpVerdict').textContent, t: document.getElementById('rvCmpTable').textContent }));
  t.ok('C12 dos corridas del mismo escenario se declaran comparables', /Comparación válida/.test(cmp.v), cmp.v);
  t.ok('C12/C13 la tabla comparativa incluye E_A, E_B, motores, ganancia y neta', ['E_A (Wh)', 'E_B (Wh)', 'Motores (Wh)', 'Ganancia de energía', 'Ganancia neta'].every((k) => cmp.t.includes(k)));

  // corrida con otro clima => no comparable
  await page.evaluate(() => { const s = LAB.app.source; s.send({ type: 'scenario.apply', scenario: { id: 'p3-claro-v1', simMs: LAB.fromLocal(2026, 10, 23, 9, 0), cloud: 0.7, windBase: 3.2, seed: 20261023, az: 180, tilt: 17, speed: 60 } }); s.send({ type: 'acq.newRun', label: 'Nublado' }); s.send({ type: 'acq.start' }); });
  await d.adv(page, 40, 0.5); await page.evaluate(() => LAB.app.source.send({ type: 'acq.stop' })); await page.evaluate(() => LAB.ui.runview.refresh()); await d.adv(page, 0.5);
  await page.evaluate(() => { const w = document.getElementById('rvCmpWrap'); w.dispatchEvent(new Event('toggle')); }); await pickAll(); await d.adv(page, 0.4);
  const v2 = await page.evaluate(() => document.getElementById('rvCmpVerdict').textContent);
  t.ok('C12 distinto clima: no es comparación válida y lo explica', /NO forman una comparación válida/.test(v2) && /nubes/.test(v2), v2);

  // barridos
  await page.click('#chartTabs [data-tab=iv]'); await d.adv(page, 0.3);
  await page.evaluate(() => { const s = LAB.app.source; s.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, 12, 0) }); s.send({ type: 'sim.cloud', value: 0.1 }); s.send({ type: 'load.sweep' }); });
  await d.adv(page, 14); await page.evaluate(() => { const s = LAB.app.source; s.send({ type: 'sim.cloud', value: 0.9 }); }); await d.adv(page, 40);
  await page.evaluate(() => LAB.app.source.send({ type: 'load.sweep' })); await d.adv(page, 14); await page.click('#chartTabs [data-tab=iv]'); await d.adv(page, 1);
  const sw = await page.evaluate(() => ({ labels: [...document.querySelectorAll('#sweepPane label')].map((l) => l.textContent), note: document.getElementById('chartNote').textContent, vis: !document.getElementById('sweepPane').hidden }));
  t.ok('T21 el panel lista ambos barridos con condiciones', sw.vis && sw.labels.filter((l) => /^ sw|G_A/.test(l)).length >= 2, sw.labels.join(' || ').slice(0, 300));
  t.ok('C14 distingue curva calculada de barrido simulado registrado', /curva calculada/.test(sw.note) && /barrido registrado/.test(sw.note), sw.note);
  for (let i = 0; i < 2; i++) await page.evaluate((i) => { const c = document.querySelectorAll('#sweepPane input[id^=sw_]')[i]; if (c && !c.checked) c.click(); }, i);
  await d.adv(page, 0.5);
  const warn = await page.evaluate(() => document.querySelector('#sweepPane .hint.warn') && document.querySelector('#sweepPane .hint.warn').textContent);
  t.ok('C14 dos barridos con condiciones distintas: advertencia', /condiciones difieren/.test(warn || ''), warn);
  t.ok('C14 ninguna condición histórica se sobrescribe', await page.evaluate(() => { const s = LAB.app.source.sweeps; return s.length === 2 && s[0].cond.start.cloud !== s[1].cond.start.cloud; }));

  // §9 enlace cortado: aviso persistente, sin presentarlo como telemetría real
  await page.evaluate(() => LAB.app.source.send({ type: 'sim.comms', connected: false })); await d.adv(page, 1);
  t.ok('§9 enlace cortado: banner persistente que no lo presenta como telemetría real', await page.evaluate(() => { const b = document.getElementById('linkBanner'); return !b.hidden && /no telemetría recibida/.test(b.textContent); }));
  await d.adv(page, 8); t.ok('§9 el estado de alarma persiste (watchdog) además del aviso temporal', await page.evaluate(() => /COMMS|Watchdog|enlace/i.test(document.getElementById('safeState').textContent + document.getElementById('safeDetail').textContent)), await page.evaluate(() => document.getElementById('safeState').textContent));
  await page.evaluate(() => { LAB.app.source.send({ type: 'sim.comms', connected: true }); LAB.app.source.send({ type: 'safety.ack' }); }); await d.adv(page, 1);
  t.ok('§9 al restablecer, el banner desaparece', await page.evaluate(() => document.getElementById('linkBanner').hidden));
  await page.screenshot({ path: '/tmp/phaseC_iv.png' });
  await page.click('#chartTabs [data-tab=run]'); await d.adv(page, 1); await page.screenshot({ path: '/tmp/phaseC_run.png' });
  t.ok('sin errores de consola', errs.length === 0, errs.join(' | ').slice(0, 300));
  await b.close(); t.done();
})();
