/* Mecánica didáctica de las prácticas en el navegador: referencia solo después de contestar, predicción bloqueada,
 * cálculos del alumno contra su propia corrida, rúbrica y autoevaluación, y prácticas de una versión anterior.
 * Ejecutar: node tools/test_practices_core.js */
const h = require('./lib/harness.js');
const d = require('./lib/drive.js');
(async () => {
  const t = new h.T('Prácticas · mecánica didáctica (navegador)');
  const b = await h.launch(), errs = [];
  const { page, ctx } = await h.open(b, 'q=low', undefined, errs);
  page.on('dialog', (dl) => dl.accept());
  await d.login(page, 'student', 'Ana Núcleo');
  await d.openPractice(page, 'p1');
  const ST = () => page.evaluate(() => { const s = LAB.ui.practices.state(); return { status: s.ps.status, steps: s.ps.steps, answers: s.ps.answers, measures: s.ps.measures, self: s.ps.self }; });
  const refBtn = (q) => page.evaluate((q) => { const ta = document.getElementById('ta_' + q); const b = ta.parentElement.querySelector('.report button[aria-expanded]'); return b ? { hidden: b.hidden, txt: b.textContent } : null; }, q);

  // ---- predicción: se guarda, se bloquea y su resultado no aparece antes de medir
  t.ok('la primera tarea de P1 es una predicción obligatoria', await page.evaluate(() => /Predicción obligatoria/.test(document.querySelector('#practiceGuide li.cur .q label').textContent)));
  t.ok('antes de guardar no hay botón de resultado', (await refBtn('p1pred')).hidden);
  await page.fill('#ta_p1pred', 'corta'); await page.click('#ta_p1pred ~ .report button');
  t.ok('una predicción demasiado corta se rechaza', !(await ST()).answers.p1pred || !(await ST()).answers.p1pred.submitted);
  await d.submitQuestion(page, 'p1pred');
  let st = await ST();
  t.ok('la predicción queda guardada y bloqueada (solo lectura, sin botón Editar)', !!st.answers.p1pred.submitted && await page.evaluate(() => { const ta = document.getElementById('ta_p1pred'); const eb = Array.from(ta.parentElement.querySelectorAll('.report button')).find((x) => /Editar/.test(x.textContent)); return ta.readOnly && eb.hidden; }));
  t.ok('con la predicción guardada, el resultado sigue oculto hasta hacer la medición', (await refBtn('p1pred')).hidden);

  // ---- la referencia de una pregunta normal solo existe después de contestar
  for (let i = 0; i < 40; i++) { const turn = await page.evaluate(() => { const s = LAB.ui.practices.state(), def = LAB.ui.practices.list.find((p) => p.id === s.current); const cur = def.steps.find((x) => !x.optional && !s.ps.steps[x.id]); return cur && cur.id; }); if (turn === 'calc') break; await d.turn(page); }
  st = await ST();
  t.ok('llegamos al cálculo de FF y η con el barrido hecho', st.steps.mpp && !st.steps.calc, JSON.stringify(st.steps));
  t.ok('pregunta de P1 sin contestar: la referencia está oculta', (await refBtn('p1q1')).hidden);
  await page.fill('#ta_p1q1', 'Respuesta de prueba suficientemente larga para registrarse'); await d.adv(page, 0.5);
  t.ok('un borrador sin guardar no desbloquea la referencia', (await refBtn('p1q1')).hidden);
  await page.click('#ta_p1q1 ~ .report button'); await d.adv(page, 0.5);
  t.ok('al guardar la respuesta aparece el botón de referencia', !(await refBtn('p1q1')).hidden);
  await page.evaluate(() => { const ta = document.getElementById('ta_p1q1'); ta.parentElement.querySelector('.report button[aria-expanded]').click(); });
  t.ok('la referencia usa los datos del barrido del alumno y se congela al abrirse', await page.evaluate(() => { const a = LAB.ui.practices.state().ps.answers.p1q1; return /Vmp\/Voc/.test(a.ref) && a.ref === document.getElementById('ta_p1q1').parentElement.querySelector('p.hint').textContent; }));

  // ---- cálculos del alumno: errores, tres intentos y acierto
  const fields = () => page.evaluate(() => Array.from(document.querySelectorAll('#practiceGuide li.cur .measure input')).map((i) => i.id));
  t.ok('el paso de cálculo muestra una casilla por magnitud (FF y η)', (await fields()).length === 2, JSON.stringify(await fields()));
  const fillBad = async () => { await page.evaluate(() => { for (const i of document.querySelectorAll('#practiceGuide li.cur .measure input')) { i.value = '999'; i.dispatchEvent(new Event('input', { bubbles: true })); } document.querySelector('#practiceGuide li.cur .measure button:not([hidden])').click(); }); await d.adv(page, 0.5); };
  await page.evaluate(() => { for (const i of document.querySelectorAll('#practiceGuide li.cur .measure input')) { i.value = 'abc'; } document.querySelector('#practiceGuide li.cur .measure button').click(); });
  t.ok('texto que no es número: se pide un número y no cuenta como intento', await page.evaluate(() => /Escribe un número/.test(document.querySelector('#practiceGuide li.cur .measure .qhint:last-child').textContent) && !(LAB.ui.practices.state().ps.measures.p1calc && LAB.ui.practices.state().ps.measures.p1calc.attempts)));
  await fillBad();
  t.ok('un valor equivocado se marca sin revelar el correcto y el paso no avanza', await page.evaluate(() => { const m = LAB.ui.practices.state().ps.measures.p1calc, txt = document.querySelector('#practiceGuide li.cur .measure').textContent; return m.attempts === 1 && !m.ok && /intento 1 de 3/.test(txt) && !LAB.ui.practices.state().ps.steps.calc; }));
  await fillBad(); await page.evaluate(() => { const i = document.querySelector('#practiceGuide li.cur .measure input'); i.value = '998'; i.dispatchEvent(new Event('input', { bubbles: true })); }); await page.evaluate(() => document.querySelector('#practiceGuide li.cur .measure button:not([hidden])').click()); await d.adv(page, 0.5);
  st = await ST();
  t.ok('al tercer intento fallido el paso se puede continuar y se muestra el valor de su corrida', st.measures.p1calc.attempts === 3 && st.steps.calc === true && !st.measures.p1calc.ok);
  t.ok('…y las casillas quedan bloqueadas con el valor de la corrida visible', await page.evaluate(() => { const li = Array.from(document.querySelectorAll('#practiceGuide li')).find((x) => x.querySelector('.measure input')); return li.querySelector('.measure input').readOnly && /el de tu corrida/.test(li.querySelector('.measure').textContent); }));

  // ---- terminar P1 con los valores correctos en el resto de cálculos y comprobar el cierre
  await d.doOperative(page);
  st = await ST();
  t.ok('los cálculos correctos se aceptan al primer intento y quedan guardados con su referencia', st.measures.p1iscg.ok === true && st.measures.p1iscg.attempts === 1 && st.measures.p1iscg.refs.iscg1 > 12 && st.measures.p1iscg.refs.iscg1 < 14);
  t.ok('la referencia de la predicción aparece ahora, con los dos barridos del alumno', !(await refBtn('p1pred')).hidden);
  await page.evaluate(() => { const ta = document.getElementById('ta_p1pred'); ta.parentElement.querySelector('.report button[aria-expanded]').click(); });
  t.ok('…y compara con cifras de sus barridos', await page.evaluate(() => /Isc .* → .* A/.test(LAB.ui.practices.state().ps.answers.p1pred.ref)));
  await d.answerAll(page); await d.adv(page, 1);
  st = await ST();
  t.eq('con predicción, cálculos y respuestas la práctica se cierra', st.status, 'completed');
  t.ok('al cerrar, el cierre congela los cálculos y la referencia de la predicción', await page.evaluate(() => { const c = LAB.ui.practices.state().ps.closure; return c.measures.p1calc.attempts === 3 && !!c.answers.p1pred.ref; }));

  // ---- rúbrica y autoevaluación
  t.ok('la guía muestra la rúbrica de la práctica', await page.evaluate(() => document.querySelectorAll('#practiceGuide details.rubric li').length === 3));
  t.ok('al cerrar aparece la autoevaluación con un nivel por criterio', await page.evaluate(() => document.querySelectorAll('#practiceGuide .selfassess select').length === 3));
  await page.selectOption('#self_0', '2'); await page.selectOption('#self_1', '1'); await d.adv(page, 0.5);
  t.ok('la autoevaluación se guarda en el progreso', (await ST()).self['0'] === 2 && (await ST()).self['1'] === 1);
  const md = await page.evaluate(() => { const orig = URL.createObjectURL; let text = ''; return new Promise((res) => { URL.createObjectURL = (blob) => { blob.text().then((x) => { text = x; }); return orig.call(URL, blob); }; LAB.ui.practices.download(); setTimeout(() => res(text), 300); }); });
  t.ok('el reporte incluye la predicción con su resultado, los cálculos verificados y la autoevaluación', /Predicciones y resultados/.test(md) && /Resultado de tus datos/.test(md) && /Cálculos verificados/.test(md) && /no coincide/.test(md) && /Autoevaluación/.test(md) && /Logrado/.test(md));
  t.ok('el reporte no repite la predicción dentro de «Respuestas»', (md.split('## Respuestas')[1] || '').indexOf('Predice') < 0 && !/\*\*Escribe tu predicción/.test(md.split('## Respuestas')[1] || ''));

  // ---- P4: serie didáctica y cálculos de calidad (valores de referencia)
  await d.openPractice(page, 'p4');
  const refs = await page.evaluate(() => { const p = LAB.ui.practices.list.find((x) => x.id === 'p4'), f = p.steps.find((s) => s.id === 'defects').measure.fields; return Object.fromEntries(f.map((x) => [x.k, x.ref()])); });
  t.ok('la serie didáctica tiene 2 atípicos, 3 huecos y un piranómetro que lee ~6 % bajo (k ≈ 1.064)', refs.out === 2 && refs.gap === 3 && Math.abs(refs.k - 1 / 0.94) < 0.01, JSON.stringify(refs));
  await d.doOperative(page, 60); await d.answerAll(page); await d.adv(page, 1);
  st = await ST();
  t.ok('P4 se completa por la interfaz con repetibilidad, serie didáctica e incertidumbre', st.status === 'completed' && st.measures.p4rep.ok && st.measures.p4def.ok && st.measures.p4unc.ok);
  const unc = await page.evaluate(() => LAB.ui.practices.state().ps.measures.p4unc.refs.u);
  t.ok('u(η)/η queda dominada por el piranómetro (≈ 5 %)', unc > 4.9 && unc < 5.6, String(unc));
  t.ok('la tabla de la serie didáctica advierte que no son datos del banco ni del simulador', await page.evaluate(() => /no es una corrida/.test(document.querySelector('#practiceGuide .pgextra').textContent)));

  // ---- prácticas de una versión anterior
  const old = await page.evaluate(() => {
    const s = LAB.ui.practices.state(), pr = s.progress.practices;
    pr.p3 = { practiceId: 'p3', defVersion: 2, status: 'in_progress', steps: { session: true, 'r-astro': true }, answers: {}, evidence: { runs: [], pending: null, cur: null }, closure: null, setupDone: true, runIds: [], createdAtUtc: new Date().toISOString(), updatedAtUtc: new Date().toISOString() };
    pr.p2 = { practiceId: 'p2', defVersion: 2, completionVersion: 2, status: 'completed', steps: { session: true }, answers: { p2q1: { submitted: 'respuesta anterior larga' } }, evidence: { points: {} }, closure: { answers: { p2q1: { submitted: 'respuesta anterior larga' } }, evidence: {} }, runIds: [], createdAtUtc: new Date().toISOString(), updatedAtUtc: new Date().toISOString() };
    return true;
  });
  await d.click(page, '#btnPractices'); await page.waitForSelector('#practiceDrawer:not([hidden])');
  const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#practiceDrawer .pcard')).map((c) => c.textContent));
  t.ok('una práctica en curso de la versión anterior se marca «la definición cambió»', /la definición cambió/.test(cards[2]), cards[2]);
  t.ok('una práctica completada con la versión anterior lo dice y ofrece descargar sus resultados y hacer la versión nueva', /versión anterior/.test(cards[1]) && /Descargar resultados anteriores/.test(cards[1]) && /Hacer la versión nueva/.test(cards[1]) && !/Consultar resultados/.test(cards[1]), cards[1]);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => Array.from(document.querySelectorAll('#practiceDrawer .pcard'))[1].querySelector('button').click())]);
  t.ok('los resultados anteriores se descargan en JSON con su respuesta', /resultados_version_anterior\.json$/.test(dl.suggestedFilename()) && /respuesta anterior larga/.test(require('fs').readFileSync(await dl.path(), 'utf8')), dl.suggestedFilename());
  await page.evaluate(() => { document.querySelector('#practiceDrawer .x').click(); });

  // ---- idioma: las prácticas nuevas existen en inglés
  await page.evaluate(() => LAB.i18n.set('en', false)); await d.adv(page, 0.3);
  t.ok('en inglés: título de P4 y rúbricas traducidos', await page.evaluate(() => { const p = LAB.ui.practices.list.find((x) => x.id === 'p4'); return p.title === 'Measurement quality and uncertainty' && p.rubric.every((r) => /^I /.test(r)) && LAB.ui.practices.list.find((x) => x.id === 'p1').steps.find((s) => s.id === 'pred').question.text.startsWith('Write your prediction'); }));
  t.ok('Sin errores de consola ni excepciones', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close(); await b.close(); t.done();
})().catch((e) => { console.error('FALLO DE LA PRUEBA', e); process.exit(2); });
