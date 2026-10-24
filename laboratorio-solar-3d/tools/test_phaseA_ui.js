/* Fase A en el navegador: arranque, parametros de URL, respuestas, persistencia, camara, exportacion, ciclo de las 4 practicas. */
const h = require('./lib/harness.js');
const d = require('./lib/drive.js');
(async () => {
  const t = new h.T('Fase A (navegador)');
  const b = await h.launch();
  const errs = [];

  // ---- T01
  {
    const { page, ctx } = await h.open(b, 'q=low', undefined, errs);
    t.ok('T01 sin parámetros: aparece el acceso', await page.evaluate(() => !document.getElementById('loginModal').hidden));
    t.ok('T01 el indicador SIMULACIÓN es visible', await page.isVisible('#simBadge'));
    t.ok('T01 el rol se rotula como demostración', /rol/i.test(await page.textContent('#loginModal .lead')));
    await d.login(page, 'visitor'); await d.adv(page, 0.5);
    t.ok('T01 sesión visitante: muestra el rol', /Visitante/.test(await page.textContent('#sessionTxt')), await page.textContent('#sessionTxt'));
    t.ok('T01 banner de solo lectura con el motivo', await page.isVisible('#roBanner') && /Visitante/.test(await page.textContent('#roTxt')), await page.textContent('#roTxt'));
    await ctx.close();
    const bad = await h.open(b, 'session=hacker&practice=zzz&tab=%3Cb%3E&q=ultra&panels=0', undefined, errs);
    t.ok('T01 parámetros inválidos: la app arranca y pide acceso', await bad.page.evaluate(() => !document.getElementById('loginModal').hidden && window.__labReady === true));
    t.ok('T01 se avisa de los parámetros ignorados', (await bad.page.evaluate(() => LAB.app.source.logs.filter((l) => l.src === 'URL').length)) === 3);
    await bad.ctx.close();
    const ok = await h.open(b, 'session=student&q=low', undefined, errs);
    await d.adv(ok.page, 0.5);
    t.ok('T01 session=student válida inicia la sesión y los botones de rol funcionan una sola vez', await ok.page.evaluate(() => LAB.app.source.telemetry.session.active && document.getElementById('loginModal').hidden));
    await ok.ctx.close();
  }

  // ---- escenario principal: P1
  const { page, ctx } = await h.open(b, 'q=low', undefined, errs);
  page.on('dialog', (dl) => dl.accept());
  await d.login(page, 'student', 'Ana Prueba');
  t.ok('T22 abrir práctica 1 desde el listado', /Comenzar/.test(await d.openPractice(page, 'p1')));
  await d.doOperative(page);
  let st = await d.state(page);
  t.ok('P1 requisitos operativos completos', ['session', 'pred', 'cond', 'cam1', 'oc', 'sc', 'sweep', 'mpp', 'calc', 'nubes', 'interp'].every((k) => st.steps[k]), JSON.stringify(st.steps));
  t.eq('T06 con las operaciones hechas y sin respuesta la práctica NO está completada', st.status, 'in_progress');
  t.ok('T06 la guía muestra la respuesta pendiente', /1 pendiente/.test(await page.textContent('#practiceGuide .pgsum')) || /Respuesta pendiente/.test(await page.textContent('#practiceGuide')), await page.textContent('#practiceGuide .pgsum'));

  // T04: escritura extensa
  const long = 'La potencia máxima aparece en la rodilla de la curva porque ahí el producto V por I es máximo; '.repeat(4);
  await page.focus('#ta_p1q1');
  await page.keyboard.type(long, { delay: 4 });
  await d.adv(page, 3);
  const act = await page.evaluate(() => ({ id: document.activeElement.id, len: document.getElementById('ta_p1q1').value.length, status: LAB.ui.practices.state().ps.status, submitted: LAB.ui.practices.state().ps.answers.p1q1.submitted }));
  t.eq('T04 el foco se queda en el campo mientras se escribe', act.id, 'ta_p1q1');
  t.eq('T04 no se pierde texto', act.len, long.length);
  t.ok('T04 escribir no registra la respuesta ni avanza', act.submitted === null && act.status === 'in_progress');
  await page.keyboard.press('Control+Z').catch(() => {});
  // Respuesta vacía no se admite
  await page.fill('#ta_p1q1', '   ');
  await page.click('#ta_p1q1 ~ .report button');
  t.ok('T04 la respuesta vacía se rechaza con aviso y marca el campo', await page.evaluate(() => document.getElementById('ta_p1q1').getAttribute('aria-invalid') === 'true' && LAB.ui.practices.state().ps.status === 'in_progress'));
  await page.fill('#ta_p1q1', long);
  await page.click('#ta_p1q1 ~ .report button');
  await d.adv(page, 1);
  st = await d.state(page);
  t.eq('T04/T06 con una sola de las dos respuestas la práctica sigue en curso', st.status, 'in_progress');
  await d.submitQuestion(page, 'p1q2'); await d.adv(page, 1);
  st = await d.state(page);
  t.eq('T04/T06 con las respuestas registradas se cierra la práctica', st.status, 'completed');

  // T05/T22 recarga
  const wait = async (pg) => pg.waitForFunction('window.__labReady === true', null, { timeout: 90000 });
  const url = page.url();
  await page.reload(); await wait(page);
  await d.login(page, 'student', 'Ana Prueba');
  t.ok('T05 tras recargar, el mismo perfil recupera el avance', await page.evaluate(() => { const s = LAB.ui.practices.state(); return s.progress && s.progress.practices.p1 && s.progress.practices.p1.status === 'completed' && s.progress.practices.p1.answers.p1q1.submitted.length > 50; }));
  t.ok('T05 la adquisición y el movimiento NO se reanudan solos', await page.evaluate(() => LAB.app.source.telemetry.acq.status === 'stopped' && LAB.app.source.telemetry.acq.runId === null));
  await d.click(page, '#btnPractices'); await page.waitForSelector('#practiceDrawer:not([hidden])');
  t.ok('T22 el listado ofrece "Consultar resultados" para la práctica cerrada', /Consultar resultados/.test(await page.textContent('#practiceDrawer .pcard:nth-of-type(1)')) || (await page.textContent('#practiceDrawer')).includes('Consultar resultados'));
  await page.evaluate(() => { document.querySelector('#practiceDrawer .pcard button').click(); });
  await d.adv(page, 0.3);
  t.ok('T22 consultar muestra la respuesta guardada, solo lectura', await page.evaluate(() => { const ta = document.getElementById('ta_p1q1'); return ta.value.length > 50 && ta.readOnly; }));
  // aislamiento por perfil
  await page.evaluate(() => { LAB.app.source.send({ type: 'session.end' }); });
  await d.adv(page, 0.3);
  await d.login(page, 'student', 'Otra Persona');
  t.ok('T11/T22 otro perfil no ve el avance de Ana', await page.evaluate(() => { const s = LAB.ui.practices.state(); return !s.progress.practices.p1; }));
  await page.evaluate(() => { LAB.app.source.send({ type: 'session.end' }); });
  await d.adv(page, 0.3);
  await d.login(page, 'student', 'Ana Prueba');

  // ---- P1 reiniciada: T07 ambiente insuficiente + T08 cámara
  await d.click(page, '#btnPractices'); await page.waitForSelector('#practiceDrawer:not([hidden])');
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#practiceDrawer .pcard button')).find((x) => /Repetir/.test(x.textContent)); b.click(); });
  await d.adv(page, 0.5);
  st = await d.state(page);
  t.ok('T22 repetir reinicia solo esa práctica y limpia su evidencia', st.status === 'in_progress' && !st.steps.cond && st.E.sweeps === 0);
  t.ok('P1 la predicción del alumno se guarda y queda bloqueada', await d.submitQuestion(page, 'p1pred') && await page.evaluate(() => { const ta = document.getElementById('ta_p1pred'); return ta.readOnly && document.querySelector('#ta_p1pred ~ .report button:not([hidden])') === null; }));
  await page.evaluate(() => { LAB.app.source.send({ type: 'sim.cloud', value: 0.97 }); });
  await d.adv(page, 20);
  for (let i = 0; i < 3; i++) { await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#practiceGuide li.cur .stepbtns button')).find((x) => !x.hidden && /Abrir/.test(x.textContent)); if (b) b.click(); }); await d.adv(page, 0.5); }
  await d.adv(page, 1);
  st = await d.state(page);
  t.ok('T07 fichas abiertas pero ambiente insuficiente: el paso NO se marca', st.E.parts.includes('pyr') && st.E.parts.includes('anemo') && !st.steps.cond, `POA=${await page.evaluate(() => LAB.app.source.telemetry.A.poa.toFixed(0))}`);
  t.ok('T07 la guía explica la condición pendiente', /necesitas > 600/.test(await page.textContent('#practiceGuide li.cur .pgstatus')) && /no se cumplen/.test(await page.textContent('#practiceGuide li.cur .pwarn')), await page.textContent('#practiceGuide li.cur .pgstatus'));
  await page.evaluate(() => { LAB.app.source.send({ type: 'sim.cloud', value: 0.1 }); });
  await d.adv(page, 25); st = await d.state(page);
  t.ok('T07 al cumplirse la condición el paso se marca', st.steps.cond === true);
  // T08
  await d.click(page, '#btnCam1'); await d.adv(page, 1);
  st = await d.state(page);
  t.ok('T08 solo entrar a la cámara no basta', st.E.cams.cam1.entered === true && !st.steps.cam1);
  await d.click(page, '#povExit'); await d.adv(page, 1); st = await d.state(page);
  t.ok('T08 entrar y salir completa el paso y devuelve la vista', st.steps.cam1 === true && await page.evaluate(() => !LAB.app.rig.pov && document.getElementById('povOverlay').hidden));

  // ocultar guía no abandona
  await page.keyboard.press('Escape'); // foco en body: no cierra la guía
  await page.evaluate(() => { document.querySelector('#practiceGuide .x').click(); });
  await d.adv(page, 0.3);
  t.ok('C03 ocultar la guía no reinicia ni abandona', await page.evaluate(() => document.getElementById('practiceGuide').hidden && LAB.ui.practices.state().ps.status === 'in_progress' && LAB.ui.practices.state().ps.steps.cond === true));
  t.ok('C03 el botón de prácticas indica la práctica en curso', /Práctica 1/.test(await page.textContent('#btnPractices')));
  await page.evaluate(() => { LAB.app.source.send({ type: 'tracker.target', az: 150, tilt: 30 }); });

  // ---- T09/T10/T12 desde la interfaz
  const csvBefore = await page.evaluate(() => LAB.app.source.exportCsv().ok);
  t.ok('T09 exportar sin muestras no cuenta como evidencia', !csvBefore);
  await page.evaluate(() => { document.getElementById('btnCsv').click(); });
  t.ok('T09 aviso útil visible', /inicia la adquisición/i.test(await page.evaluate(() => document.getElementById('toasts').textContent)));
  await d.click(page, '#btnAcq'); await d.adv(page, 6);
  t.ok('T12 el botón de adquisición cambia el estado y cuenta muestras', await page.evaluate(() => /Grabando/.test(document.getElementById('acqState').textContent) && LAB.app.source.telemetry.acq.samples >= 5), await page.textContent('#acqCount'));
  await d.click(page, '#btnAcq'); await d.adv(page, 3);
  t.ok('T12 detener muestra Detenido', /Detenido/.test(await page.textContent('#acqState')));
  const [dl] = await Promise.all([page.waitForEvent('download'), d.click(page, '#btnCsv')]);
  t.ok('T09 con muestras se descarga un CSV', /\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());

  // T18 consignas separadas
  await page.evaluate(() => { LAB.app.source.send({ type: 'sim.wind', value: 9 }); LAB.app.source.send({ type: 'sim.cloud', value: 0.4 }); });
  await d.adv(page, 2);
  t.ok('T18 el control de viento refleja la consigna y el panel muestra el viento instantáneo aparte', await page.evaluate(() => document.getElementById('windSlider').value === '9' && /consigna 9/.test(document.getElementById('eWindSet').textContent) && /instantáneo/.test(document.getElementById('windOut').textContent)));
  t.ok('T18 la nubosidad queda sincronizada', await page.evaluate(() => document.getElementById('cloudSlider').value === '40'));
  await page.evaluate(() => { LAB.app.source.send({ type: 'sim.wind', value: 3 }); LAB.app.source.send({ type: 'sim.cloud', value: 0.1 }); });

  // T19 UI: campo numérico
  await page.fill('#numAz', '20'); await page.fill('#numTilt', '45'); await page.click('#btnNumGo');
  t.ok('T19 valor fuera de rango: no se envía, el campo queda marcado y conserva lo escrito', await page.evaluate(() => document.getElementById('numAz').value === '20' && document.getElementById('numAz').getAttribute('aria-invalid') === 'true' && document.getElementById('numTilt').value === '45'), await page.textContent('#trNum .ferr'));
  await page.fill('#numAz', '160'); await page.click('#btnNumGo'); await d.adv(page, 1);
  t.ok('T19 valores válidos se envían y se limpian', await page.evaluate(() => document.getElementById('numAz').value === '' && Math.abs(LAB.app.source.telemetry.tracker.targetAz - 160) < 0.01));

  // T16/T17 parte de Fase A: la tecla espacio en un botón no alterna el reloj; la cámara libre ignora Espacio
  await page.focus('#btnLabels');
  const playing0 = await page.evaluate(() => LAB.app.source.telemetry.playing);
  await page.keyboard.press('Space'); await d.adv(page, 0.3);
  t.eq('T16 Espacio sobre un botón no acciona el atajo global de pausa', await page.evaluate(() => LAB.app.source.telemetry.playing), playing0);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Space'); await d.adv(page, 0.3);
  t.eq('C10 Espacio con el foco en la escena sí pausa el reloj solar', await page.evaluate(() => LAB.app.source.telemetry.playing), !playing0);
  await page.keyboard.press('Space'); await d.adv(page, 0.3);
  await page.keyboard.press('Control+f'); await d.adv(page, 0.2);
  t.ok('C10 Ctrl+F no activa la cámara libre', await page.evaluate(() => !LAB.app.rig.free));
  await page.keyboard.press('f'); await d.adv(page, 0.3);
  t.ok('T17 F activa la cámara libre', await page.evaluate(() => LAB.app.rig.free));
  const y0 = await page.evaluate(() => LAB.app.camera.position.y);
  await page.keyboard.down('Space'); await page.waitForTimeout(400); await page.keyboard.up('Space');
  await page.evaluate(() => LAB.app.rig.update(0.2));
  t.ok('C10 Espacio ya no asciende en cámara libre', await page.evaluate((y0) => Math.abs(LAB.app.camera.position.y - y0) < 1e-6, y0));
  await page.keyboard.down('w'); await page.waitForTimeout(150);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.keyboard.up('w');
  const p0 = await page.evaluate(() => LAB.app.camera.position.toArray());
  await page.evaluate(() => LAB.app.rig.update(0.5));
  const p1 = await page.evaluate(() => LAB.app.camera.position.toArray());
  t.ok('T17 al perder el foco no quedan teclas atascadas ni movimiento residual', Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) < 1e-6);
  await page.keyboard.press('Escape'); await d.adv(page, 0.3);
  t.ok('C10 Escape cierra la cámara libre', await page.evaluate(() => !LAB.app.rig.free));

  // T25 etiquetas en las respuestas
  await page.evaluate(() => { document.getElementById('practiceGuide').hidden = false; });
  await d.doOperative(page);
  const hostile = '<img src=x onerror="window.__xss=1"> <b>negrita</b> &amp; "x"';
  await page.fill('#ta_p1q1', hostile); await page.click('#ta_p1q1 ~ .report button'); await d.adv(page, 1);
  t.ok('T25 el texto con etiquetas se conserva literal y no ejecuta nada', await page.evaluate((h) => window.__xss === undefined && document.getElementById('ta_p1q1').value === h && !document.querySelector('#practiceGuide img') && LAB.ui.practices.state().ps.answers.p1q1.submitted === h, hostile));
  // el reporte conserva el texto literal
  const [rep] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => LAB.ui.practices.download())]);
  const fs = require('fs'); const md = fs.readFileSync(await rep.path(), 'utf8');
  t.ok('T25 el reporte Markdown incluye la respuesta literal y los datos simulados', md.includes(hostile) && /simulador/.test(md) && /Pmax/.test(md));

  // T29 terminar sesión
  await page.evaluate(() => { document.getElementById('btnAcq').click(); });
  await d.adv(page, 3);
  await page.evaluate(() => { LAB.app.source.send({ type: 'session.end' }); }); await d.adv(page, 0.5);
  t.ok('T29 al terminar la sesión: adquisición detenida y corrida conservada', await page.evaluate(() => LAB.app.source.telemetry.acq.status === 'stopped' && LAB.app.source.runs.length >= 1 && LAB.app.source.runs.every((r) => r.status !== 'open')));
  t.ok('T29 la evidencia queda guardada en el navegador', await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('labsolar.v2.') && k.endsWith('.progress'))));
  t.ok('T29 aparece el acceso de nuevo', await page.evaluate(() => !document.getElementById('loginModal').hidden));
  await ctx.close();

  // ---- ciclo de las 4 prácticas (T06, T28 por la interfaz)
  {
    const c2 = await h.open(b, 'q=low', undefined, errs); const p = c2.page; p.on('dialog', (dl) => dl.accept());
    await d.login(p, 'teacher', 'Docente Ciclo');
    for (const id of ['p2', 'p3', 'p4']) {
      await d.openPractice(p, id);
      const done = await d.doOperative(p, 120); const s2 = await d.state(p);
      const def = await p.evaluate((id) => LAB.ui.practices.list.find((x) => x.id === id).steps.filter((s) => !s.optional).map((s) => s.id), id);
      t.ok(`${id} requisitos operativos completos por la interfaz`, done && def.every((k) => s2.steps[k]), JSON.stringify(Object.keys(s2.steps)) + ' ' + JSON.stringify(s2.E.runs ? s2.E.runs.map((r) => r.status + ':' + (r.cause || r.kind)) : ''));
      t.eq(`T06 ${id} sin respuesta: queda en curso, no completada`, s2.status, 'in_progress');
      await d.answerAll(p); const s3 = await d.state(p);
      t.eq(`${id} con respuesta registrada se completa`, s3.status, 'completed');
    }
    const s4 = await p.evaluate(() => LAB.ui.practices.state().progress.practices);
    t.ok('P3 corridas completas con el mismo escenario', s4.p3.evidence.runs.filter((r) => r.status === 'complete').length === 4 && new Set(s4.p3.evidence.runs.map((r) => r.scenarioId + r.seed + r.cloud)).size === 2, JSON.stringify(s4.p3.evidence.runs.map((r) => [r.kind, r.status, r.gainPct && r.gainPct.toFixed(1)])));
    t.ok('P4 los tres barridos repetidos y los cálculos del alumno quedaron guardados', s4.p4.evidence.sweepList.length >= 3 && s4.p4.measures.p4rep.ok && s4.p4.measures.p4def.ok && s4.p4.measures.p4unc.ok, JSON.stringify(s4.p4.measures));
    t.ok('P2 los puntos registran la media y la desviación de una ventana de 10 s', Object.values(s4.p2.evidence.points).every((p) => p.n >= 15 && p.sd >= 0 && p.sd < 0.05), JSON.stringify(Object.values(s4.p2.evidence.points).map((p) => [p.n, p.sd])));
    t.ok('P3 registra los minutos sin señal del sensor en la corrida nublada', s4.p3.evidence.runs.find((r) => r.kind === 'sensor-nub').noSignalMin > 10, JSON.stringify(s4.p3.evidence.runs.map((r) => [r.kind, r.noSignalMin])));
    await c2.ctx.close();
  }

  t.ok('Sin errores de consola ni excepciones', errs.length === 0, errs.slice(0, 3).join(' | '));
  await b.close();
  t.done();
})().catch((e) => { console.error('FALLO DE LA PRUEBA', e); process.exit(2); });
