/* E09-E14: las cuatro practicas guiadas con la nueva distribucion, conducidas por la interfaz real; en cada una se comprueba que
 * lo que la practica pide ver (camaras IP, sensores, componentes) esta realmente a la vista y que las posiciones no se mueven. */
const h = require('./lib/harness.js');
const d = require('./lib/drive.js');

(async () => {
  const t = new h.T('Distribución espacial · prácticas y cámaras (E09-E14)');
  const b = await h.launch(); const errs = [];
  const { page, ctx } = await h.open(b, 'q=low&panels=0', { width: 1366, height: 768 }, errs);
  page.on('dialog', (dl) => dl.accept());
  await page.evaluate(() => { document.getElementById('toasts').style.display = 'none'; });
  await d.login(page, 'teacher', 'Distribución');
  const phys = () => page.evaluate(() => { const w = LAB.world; return JSON.stringify([w.bankA.group, w.trackerB.group, w.station.group, w.load.group, w.cabinet.group, w.cam1.group, w.cam2.group].map((g) => g.position.toArray().map((v) => +v.toFixed(4)))); });
  const base = await phys();
  // fraccion de vertices de las piezas MOVILES de B dentro del cuadro de la camara IP indicada (ndc <= 0.95)
  const seen = (cam) => page.evaluate((k) => { const w = LAB.world; w.scene.updateMatrixWorld(true); const c = w[k].cam; c.updateMatrixWorld(true); let n = 0, ok = 0; for (const v of __vv(w.trackerB.azGroup)) { const p = v.clone().project(c); n++; if (Math.abs(p.x) <= 0.95 && Math.abs(p.y) <= 0.95 && p.z < 1) ok++; } return ok / n; }, cam);
  await page.evaluate(() => { window.__vv = (root) => { const out = []; root.updateMatrixWorld(true); root.traverse((o) => { if (o.isMesh && o.geometry.attributes.position) { const a = o.geometry.attributes.position; for (let i = 0; i < a.count; i += 2) out.push(new THREE.Vector3().fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld)); } }); return out; }; });
  const povOk = (k) => page.evaluate((k) => { const w = LAB.world, a = w[k].forward(), c = w[k].cam, look = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion); return Math.acos(Math.min(1, a.dot(look))) * 57.2958 < 0.5 && LAB.rig.pov === k; }, k);

  // ---- E09 vista previa (PiP) y camaras en modo POV
  for (const k of ['cam1', 'cam2']) {
    await page.evaluate((k) => { LAB.rig.set('general', true); LAB.app.setPip(true, k); }, k); await d.adv(page, 0.5);
    const r = await page.evaluate((k) => { const p = LAB.app.pip.rect; return { inside: p.x >= 0 && p.y >= 0 && p.x + p.z <= 1 && p.y + p.w <= 1, cam: LAB.app.pip.cam, same: LAB.world.camPov(k) === LAB.world[k].cam, uni: LAB.app.finalPass.uniforms.tPip.value === LAB.app.pipRT.texture }; }, k);
    t.ok(`E09 vista previa de ${k}: dentro de la escena, usa la cámara virtual de ${k} y está encendida y muestra su propia textura (antes salía negra)`, r.inside && r.cam === k && r.same && r.uni);
  }
  await page.evaluate(() => LAB.app.setPip(false));
  for (const k of ['cam1', 'cam2']) {
    await d.click(page, k === 'cam1' ? '#btnCam1' : '#btnCam2'); await d.adv(page, 0.5);
    t.ok(`E09 "Ver cámara" ${k}: modo POV activo y la carcasa apunta igual que la imagen`, await povOk(k));
    await d.click(page, '#povExit'); await d.adv(page, 0.5);
  }

  // ---- P1..P4
  const PR = {
    p1: async () => {
      // sensores desde la P1: se abren las fichas de irradiancia A/B y del piranometro y se comprueba el acercamiento
      const r = await page.evaluate(() => { const w = LAB.world, rig = LAB.rig, res = []; for (const id of ['irrA', 'irrB', 'pyr']) { LAB.app.handlePart(id); const shown = !document.getElementById('infocard').hidden; document.getElementById('icFocus').click(); rig.update(5); rig.update(5); const box = new THREE.Box3().setFromObject(w.partRoots[id]), c = box.getCenter(new THREE.Vector3()).project(LAB.app.camera); res.push(shown && Math.abs(c.x) < 0.9 && c.y < 0.9 && c.y > -0.9); } return res; });
      t.ok('E11 P1: las fichas de los sensores de irradiancia A, B y el piranómetro abren y "Acercar" los deja a la vista', r.every(Boolean), JSON.stringify(r));
      t.ok('E11 P1: la cámara IP 1 ve A y B completos', await page.evaluate(() => { const w = LAB.world; let m = 0; for (const k of ['moduleA', 'moduleB']) for (const p of __t_ndc(w.cam1.cam, w.env3[k])) m = Math.max(m, Math.abs(p.x), Math.abs(p.y)); return m <= 0.95; }));
    },
    p2: async () => { t.ok('E12 P2: con el seguidor en movimiento la cámara IP 2 ve el 100 % de las piezas móviles', (await seen('cam2')) === 1, String(await seen('cam2'))); },
    p3: async () => { t.ok('E13 P3: tras las cuatro corridas (dos cielos) el seguidor sigue a la vista de la cámara IP 2 y nada se movió de lugar', (await seen('cam2')) >= 0.99 && (await phys()) === base); },
    p4: async () => {
      t.ok('E14 P4: barridos repetidos y análisis de calidad completados sin que cambie la distribución', (await phys()) === base);
    },
  };
  await page.evaluate(() => { window.__t_ndc = (cam, box) => { cam.updateMatrixWorld(true); cam.updateProjectionMatrix(); const o = []; for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) o.push(new THREE.Vector3(x, y, z).project(cam)); return o; }; });
  for (const id of ['p1', 'p2', 'p3', 'p4']) {
    await d.openPractice(page, id);
    // durante el paso de movimiento de P4 y P2 se muestrea la camara IP 2 mientras B se mueve
    let minSeen = 1, nSamples = 0;
    if (id === 'p4' || id === 'p2') {
      await d.doOperative(page, 120);
      // barrido de movimiento: B va a tres posiciones lejanas y se muestrea la camara IP 2 cada 2 s simulados
      const r = await page.evaluate(() => { const s = LAB.app.source, w = LAB.world, c = w.cam2.cam; let min = 1, n = 0; s.send({ type: 'tracker.mode', mode: 'manual' });
        for (const [az, tilt] of [[120, 20], [250, 80], [180, 0], [270, 90]]) { s.send({ type: 'tracker.target', az, tilt }); for (let i = 0; i < 700; i++) { s.step(0.1); if (i % 20 === 0) { const m = s.telemetry.tracker.moving; if (!m.az && !m.tilt) continue; w.update(s.telemetry, 0.1); let tot = 0, ok = 0; for (const v of __vv(w.trackerB.azGroup)) { const p = v.clone().project(c); tot++; if (Math.abs(p.x) <= 0.95 && Math.abs(p.y) <= 0.95 && p.z < 1) ok++; } min = Math.min(min, ok / tot); n++; } } }
        s.send({ type: 'tracker.target', az: 180, tilt: 17 }); for (let i = 0; i < 700; i++) s.step(0.1); return { min, n }; });
      minSeen = r.min; nSamples = r.n;
      t.ok(`${id === 'p2' ? 'E12' : 'E14'} ${id.toUpperCase()}: mientras B se mueve, la cámara IP 2 lo mantiene dentro del cuadro (mínimo ${(minSeen * 100).toFixed(0)} % de las piezas móviles)`, minSeen >= 0.99 && nSamples >= 3, `${nSamples} muestras`);
    } else await d.doOperative(page, 120);
    await d.answerAll(page);
    t.eq(`${id.toUpperCase()} completada por la interfaz con la nueva distribución`, await page.evaluate(() => LAB.ui.practices.state().ps.status), 'completed');
    await PR[id]();
    // el tamaño de la ventana no mueve nada y la practica sigue usable
    await page.setViewportSize({ width: 1024, height: 768 }); await page.waitForTimeout(800);
    t.ok(`${id.toUpperCase()}: con la ventana a 1024×768 las posiciones físicas no cambian`, (await phys()) === base);
    await page.setViewportSize({ width: 1366, height: 768 }); await page.waitForTimeout(800);
  }
  t.ok('Sin errores de consola ni excepciones', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close(); await b.close(); t.done();
})().catch((e) => { console.error('FALLO DE LA PRUEBA', e); process.exit(2); });
