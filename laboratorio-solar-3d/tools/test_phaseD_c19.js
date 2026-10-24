/* Fase D · C19: entrada guiada, recorrido, glosario, ayudas 3D, DNI/DHI como derivadas. */
const h = require('./lib/harness.js'), d = require('./lib/drive.js');
(async () => {
  const t = new h.T('Fase D · C19'); const b = await h.launch(); const errs = [];
  const { page } = await h.open(b, 'q=low', { width: 1366, height: 768 }, errs);
  page.on('dialog', (dl) => dl.accept());
  await d.adv(page, 0.3);
  // entrada
  const e = await page.evaluate(() => ({ items: [...document.querySelectorAll('#entryBox button')].map((x) => x.querySelector('b').textContent), ab: document.getElementById('abLegend').textContent, vis: !document.getElementById('practiceEmpty').hidden }));
  t.ok('C19 tres entradas claras', ['Explorar el laboratorio', 'Realizar una práctica', 'Crear experimento'].every((k) => e.items.includes(k)), e.items.join('|'));
  t.ok('C19 el texto identifica A (fijo) y B (móvil)', /A · fijo/.test(e.ab) && /B · móvil/.test(e.ab));
  // sin sesión: práctica pide sesión (no se rompe)
  await page.evaluate(() => { document.getElementById('loginModal').hidden = true; });
  await page.evaluate(() => document.getElementById('btnEntryPractice').click()); await d.adv(page, 0.3);
  t.ok('C19 elegir práctica sin sesión pide iniciar sesión', await page.evaluate(() => !document.getElementById('loginModal').hidden));
  await d.login(page, 'student', 'Nuevo Usuario'); await d.adv(page, 0.5);
  // explorar
  await page.evaluate(() => document.getElementById('btnEntryExplore').click()); await d.adv(page, 0.6);
  t.ok('C19 Explorar: etiquetas visibles y ficha del módulo A', await page.evaluate(() => LAB.app.world.labels.mode === 'all' && !document.getElementById('infocard').hidden && /Módulo A/i.test(document.getElementById('icTitle').textContent)), await page.evaluate(() => document.getElementById('icTitle').textContent));
  // práctica
  await page.evaluate(() => document.getElementById('btnEntryPractice').click()); await d.adv(page, 0.6);
  t.ok('C19 Realizar una práctica abre el listado', await page.evaluate(() => LAB.ui.practices.drawerOpen()));
  await page.keyboard.press('Escape'); await d.adv(page, 0.3);
  // experimento
  await page.evaluate(() => document.getElementById('btnEntryExperiment').click()); await d.adv(page, 0.4);
  t.ok('C19 Crear experimento muestra los pasos', await page.evaluate(() => { const c = document.getElementById('expCard'); return c && !c.hidden && c.querySelectorAll('li').length === 5; }));
  await page.evaluate(() => document.getElementById('btnExpScenario').click()); await d.adv(page, 0.3);
  t.ok('C19 el experimento puede partir del escenario común reproducible', await page.evaluate(() => LAB.app.source.telemetry.settings.scenarioId === 'experimento-base' && LAB.app.source.telemetry.settings.seed === 20261023));
  await page.evaluate(() => document.getElementById('btnExpRun').click()); await d.adv(page, 0.3);
  t.ok('C19 crea la corrida «Experimento libre»', await page.evaluate(() => { const r = LAB.app.source.activeRun(); return !!r && r.label === 'Experimento libre'; }));
  // recorrido
  await page.evaluate(() => document.getElementById('btnTour').click()); await d.adv(page, 0.4);
  t.ok('C19 el recorrido abre en el paso 1 de 5 con foco en Siguiente', await page.evaluate(() => !document.getElementById('tourPop').hidden && /^1\/5/.test(document.getElementById('tourTitle').textContent) && document.activeElement.id === 'tourNext'));
  const titles = [];
  for (let i = 0; i < 5; i++) { titles.push(await page.evaluate(() => document.getElementById('tourTitle').textContent)); if (i < 4) { await page.click('#tourNext'); await d.adv(page, 0.2); } }
  t.ok('C19 recorrido: A/B, controles, resultados, guardado y siguiente paso', ['Módulos A y B', 'Controles', 'Resultados', 'Guardado', 'siguiente paso'].every((k, i) => titles[i].includes(k)), titles.join(' | '));
  await page.click('#tourNext'); await d.adv(page, 0.3);
  t.ok('C19 «Terminar» cierra el recorrido y quita el resaltado', await page.evaluate(() => document.getElementById('tourPop').hidden && !document.querySelector('.tour-hl')));
  await page.evaluate(() => document.getElementById('btnTour').click()); await d.adv(page, 0.2); await page.keyboard.press('Escape'); await d.adv(page, 0.2);
  t.ok('C19 se puede omitir con Escape y se puede reabrir', await page.evaluate(() => document.getElementById('tourPop').hidden));
  await page.evaluate(() => document.getElementById('btnTour').click()); await d.adv(page, 0.2);
  t.ok('C19 reabrir el recorrido funciona', await page.evaluate(() => !document.getElementById('tourPop').hidden));
  await page.click('#tourSkip');
  // glosario
  const terms = await (async () => { await page.evaluate(() => document.getElementById('btnGloss').click()); await d.adv(page, 0.3); return page.evaluate(() => [...document.querySelectorAll('#glossBody dt')].map((x) => x.textContent)); })();
  t.ok('C19 el glosario cubre irradiancia, azimut, inclinación, MPPT, Voc, Isc, GHI, DNI y DHI', ['Irradiancia', 'Azimut', 'Inclinación', 'MPPT', 'Voc', 'Isc', 'GHI', 'DNI', 'DHI'].every((k) => terms.some((x) => x.includes(k))), terms.join(' | '));
  const gl = await page.evaluate(() => document.getElementById('glossBody').textContent);
  t.ok('C19 el glosario clasifica consignas, medidas simuladas y derivadas', /Consignas/.test(gl) && /Medidas simuladas/.test(gl) && /Resultados derivados/.test(gl) && /Consigna \(tú la fijas\)/.test(gl));
  t.ok('C19 DNI y DHI se declaran derivadas del modelo, no medidas por el piranómetro', /DNI[\s\S]{0,40}Derivada[\s\S]{0,200}no una medición/.test(gl) && /DHI[\s\S]{0,60}Derivada/.test(gl));
  await page.keyboard.press('Escape'); await d.adv(page, 0.3);
  // glosario contextual desde la etiqueta GHI
  await page.focus('[data-gloss=ghi]'); await page.keyboard.press('Enter'); await d.adv(page, 0.4);
  t.ok('C19 glosario contextual: la etiqueta GHI abre su entrada', await page.evaluate(() => !document.getElementById('glossDlg').hidden && document.activeElement.id === 'gl_ghi'));
  await page.keyboard.press('Escape'); await d.adv(page, 0.3);
  // piranómetro: sin DNI/DHI «medidos»
  await page.evaluate(() => LAB.app.handlePart('pyr', false)); await d.adv(page, 0.4);
  const pyr = await page.evaluate(() => document.getElementById('infocard').textContent);
  t.ok('C19 la ficha del piranómetro no atribuye DNI/DHI como mediciones', /derivada del modelo/.test(pyr) && !/DNI \(directa\)/.test(pyr), pyr.slice(0, 260));
  // ayudas 3D
  await page.evaluate(() => { LAB.app.world.aidsMode = 'off'; document.getElementById('infocard').hidden = true; });
  await page.evaluate(() => LAB.app.handlePart('moduleB', false)); await d.adv(page, 0.5);
  const mode0 = await page.evaluate(() => LAB.app.world.aidsMode);
  await page.evaluate(() => document.getElementById('btnAids').click()); await d.adv(page, 0.3);   // off -> auto
  await page.evaluate(() => { LAB.app.source.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, 11, 0) }); }); await d.adv(page, 2);
  await page.waitForFunction(() => LAB.app.world.aids.shown, null, { timeout: 20000 }).catch(() => {});
  const a1 = await page.evaluate(() => ({ mode: LAB.app.world.aidsMode, shown: LAB.app.world.aids.shown, txt: document.getElementById('aidsTxt').textContent }));
  t.ok('C19 modo «auto»: con la ficha del módulo B abierta aparecen las ayudas 3D', mode0 === 'off' && a1.mode === 'auto' && a1.shown, JSON.stringify(a1));
  const geo = await page.evaluate(() => { const g = LAB.app.world.aids.group; const B = LAB.app.source.telemetry.B, S = LAB.app.source.telemetry.sun; const items = LAB.app.world.labels.items.filter((i) => /^aid-/.test(i.partId)).map((i) => i.el.textContent); return { children: g.children.length, items, aoi: B.aoi, el: S.el }; });
  t.ok('C19 ayudas: normal, rayo, arcos y ángulo de incidencia con valor', geo.items.some((x) => /θ [\d.]+° (\(ángulo de incidencia\)|· entre la normal)/.test(x)) && geo.items.some((x) => /normal del panel/.test(x)) && geo.items.some((x) => /Az \d+° · inclinación \d+°/.test(x)), geo.items.join(' | '));
  // coherencia numérica del ángulo de incidencia con la geometría
  const chk = await page.evaluate(() => { const tel = LAB.app.source.telemetry, S = LAB.sim.solar; const n = S.sunVector(tel.B.az, 90 - tel.B.tilt), s = tel.sun.vec; const dot = n[0] * s[0] + n[1] * s[1] + n[2] * s[2]; return { calc: Math.acos(Math.min(1, dot)) * 180 / Math.PI, aoi: tel.B.aoi }; });
  t.ok('C19 el ángulo de incidencia mostrado coincide con la normal y el rayo (±0.5°)', Math.abs(chk.calc - chk.aoi) < 0.5, `${chk.calc.toFixed(2)} vs ${chk.aoi.toFixed(2)}`);
  // arco de azimut limpio incluso con 180° (norte y sur opuestos): finito y a ≤1.2 m del pedestal
  const arc = await page.evaluate(() => { const m = LAB.app.world.aids.group.children.filter((c) => c.geometry && c.geometry.type === 'TubeGeometry')[1]; const p = m.geometry.attributes.position, base = LAB.app.world.trackerB.group.getWorldPosition(new THREE.Vector3()); m.updateMatrixWorld(true); let mx = 0, ok = true; const v = new THREE.Vector3(); for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld); if (!Number.isFinite(v.x + v.y + v.z)) ok = false; mx = Math.max(mx, Math.hypot(v.x - base.x, v.z - base.z)); } return { ok, mx, az: LAB.app.source.telemetry.B.az }; });
  t.ok('C19 el arco de azimut es una semicircunferencia limpia en torno al pedestal con 180°', arc.ok && arc.az === 180 && arc.mx > 1.0 && arc.mx < 1.25, JSON.stringify(arc));
  await page.evaluate(() => { document.getElementById('btnAids').click(); }); await d.adv(page, 0.3);  // auto -> on
  await page.evaluate(() => { document.getElementById('btnAids').click(); }); await d.adv(page, 0.5);  // on -> off
  await page.waitForFunction(() => !LAB.app.world.aids.shown, null, { timeout: 20000 }).catch(() => {});
  t.ok('C19 ocultar las ayudas no pierde el estado (se vuelven a ver igual)', await page.evaluate(() => !LAB.app.world.aids.shown && LAB.app.world.aidsMode === 'off'));
  await page.evaluate(() => { document.getElementById('btnAids').click(); }); await d.adv(page, 0.5);
  await page.waitForFunction(() => LAB.app.world.aids.shown, null, { timeout: 20000 }).catch(() => {});
  t.ok('C19 reactivar las ayudas las muestra de nuevo', await page.evaluate(() => LAB.app.world.aids.shown));
  await page.evaluate(() => { LAB.app.world.aidsMode = 'on'; LAB.app.rig.set('moduleB', true); }); await page.waitForTimeout(1500); await d.adv(page, 1);
  await page.screenshot({ path: '/tmp/phaseD_aids.png' });
  t.ok('sin errores de consola', errs.length === 0, errs.join(' | ').slice(0, 300));
  await b.close(); t.done();
})();
