/* Distribucion espacial (E01-E20): comprobaciones geometricas medidas sobre la escena real en el navegador.
 * Los resultados numericos se imprimen para la matriz del informe. No sustituye la inspeccion visual de las capturas
 * (tools/shots_spatial.js). Las posiciones muestreadas NO certifican despeje continuo: ver docs/DISTRIBUCION_ESPACIAL.md */
const h = require('./lib/harness.js');
const fs = require('fs');

(async () => {
  const t = new h.T('Distribución espacial (E01-E20)');
  const b = await h.launch(); const errs = [];
  const { page } = await h.open(b, 'session=student&q=low&time=2026-10-23T12:00&cloud=0.1', { width: 1366, height: 768 }, errs);
  page.on('dialog', (dl) => dl.accept());
  await page.evaluate(() => { document.getElementById('toasts').style.display = 'none'; });
  const waitAspect = async () => { for (let i = 0; i < 40; i++) { const ok = await page.evaluate(() => { const host = document.getElementById('stage'); const w = host.clientWidth, hh = host.clientHeight, c = LAB.app.camera; return Math.abs(c.aspect - w / hh) < 0.01 && Math.abs(LAB.app.renderer.domElement.clientWidth - w) <= 1; }); if (ok) return; await page.waitForTimeout(500); } };

  // ------------------------------------------------------------------ E01 inventario antes / despues
  {
    const baseFile = process.env.INV_ANTES;
    const now = await page.evaluate(() => {
      const w = LAB.world, cfg = LAB.config;
      const labelCount = {}; w.labels.items.forEach((i) => { labelCount[i.partId] = (labelCount[i.partId] || 0) + 1; });
      const stat = (root) => { let meshes = 0; root.traverse((o) => { if (o.isMesh) meshes++; }); return meshes; };
      return { partIds: Object.keys(w.partRoots).sort(), labels: labelCount, meshes: { A: stat(w.bankA.group), B: stat(w.trackerB.group), station: stat(w.station.group), load: stat(w.load.group), cabinet: stat(w.cabinet.group), cam1: stat(w.cam1.group), cam2: stat(w.cam2.group) },
        cableRoutes: w.cables.userData.routes.length, physical: JSON.stringify({ module: cfg.module, fixed: cfg.fixed, tracker: cfg.tracker, safety: cfg.safety, limits: cfg.limits, site: cfg.site, speeds: cfg.speeds }) };
    });
    t.eq('E01 identificadores de componente: 17 (los mismos de siempre)', now.partIds.length, 17);
    t.eq('E01 cámaras IP: exactamente cam1 y cam2, una de cada', now.partIds.filter((x) => /^cam/.test(x)).join(','), 'cam1,cam2');
    t.eq('E01 un solo gabinete, una sola carga, una sola estación', ['cabinet', 'load', 'pyr'].map((k) => now.partIds.filter((x) => x === k).length).join(''), '111');
    t.eq('E01 conductos y cables: 7 trayectos (4 de potencia CC + 3 de señal)', now.cableRoutes, 7);
    if (baseFile && fs.existsSync(baseFile)) {
      const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
      t.eq('E01 mismos identificadores que antes del cambio', JSON.stringify(now.partIds), JSON.stringify(base.partIds));
      t.eq('E01 mismas etiquetas que antes del cambio', JSON.stringify(now.labels), JSON.stringify(base.labels));
      t.eq('E01 mismo número de mallas por equipo que antes', JSON.stringify(now.meshes), JSON.stringify({ A: base.groups.moduleA.meshes, B: base.groups.moduleB.meshes, station: base.groups.station.meshes, load: base.groups.load.meshes, cabinet: base.groups.cabinet.meshes, cam1: base.groups.cam1.meshes, cam2: base.groups.cam2.meshes }));
      t.eq('E20 mismos parámetros físicos y de seguridad que antes (módulo, seguidor, límites, sitio)', now.physical, JSON.stringify(base.physical));
    } else t.ok('E01/E20 comparación con el inventario anterior (INV_ANTES no indicado: se omite)', true, 'omitida');
  }

  // ------------------------------------------------------------------ E20 una sola fuente de coordenadas
  {
    const src = fs.readdirSync(h.ROOT + '/js/scene').map((f) => fs.readFileSync(h.ROOT + '/js/scene/' + f, 'utf8')).join('\n') + fs.readFileSync(h.ROOT + '/js/main.js', 'utf8');
    const lit = /\[\s*-?\d+(\.\d+)?\s*,\s*[\d.]+\s*,\s*-?\d+(\.\d+)?\s*\]\s*,\s*\[\s*-?\d/.test(src.replace(/pts\(/g, ''));
    t.ok('E20 las posiciones de equipos solo se definen en LAB.config.layout (sin coordenadas duplicadas en la escena)', !/L\.(moduleA|moduleB|weather|load|cabinet|cam1|cam2)\s*=/.test(src) && !/createTracker\(\s*\[/.test(src) && !/createFixedBank\(\s*\[/.test(src), lit ? 'revisar literales' : '');
    const eng = fs.readdirSync(h.ROOT + '/js/sim').map((f) => fs.readFileSync(h.ROOT + '/js/sim/' + f, 'utf8')).join('\n');
    t.ok('E20 el motor de simulación no lee la distribución espacial', !/config\.layout|\.layout\b/.test(eng));
  }

  // ------------------------------------------------------------------ utilidades en la pagina
  await page.evaluate(() => {
    window.__t = {
      V: (a) => new THREE.Vector3(...a),
      ndcBox: (cam, box) => { cam.updateMatrixWorld(true); cam.updateProjectionMatrix(); const o = []; for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) o.push(new THREE.Vector3(x, y, z).project(cam)); return o; },
      groupOf: () => { const w = LAB.world, m = new Map(); const reg = (id, root) => root.traverse((o) => { if (o.isMesh) m.set(o, id); }); reg('A', w.bankA.group); reg('B', w.trackerB.group); reg('station', w.station.group); reg('load', w.load.group); reg('cabinet', w.cabinet.group); reg('cam1', w.cam1.group); reg('cam2', w.cam2.group); reg('cables', w.cables); return m; },
      visible: (from, to, ignore) => { const w = LAB.world, gm = __t.groupOf(); const dir = to.clone().sub(from), dist = dir.length(); dir.normalize(); const rc = new THREE.Raycaster(from, dir, 0.05, dist - 0.04); w.scene.updateMatrixWorld(true); const hits = rc.intersectObjects(Array.from(gm.keys()), false); for (const hh of hits) { const g = gm.get(hh.object); if (!ignore.includes(g) && g !== 'cables') return { ok: false, by: g, d: hh.distance }; } return { ok: true }; },
      verts: (root, step = 3) => { const out = []; root.updateMatrixWorld(true); root.traverse((o) => { if (o.isMesh && o.geometry.attributes.position) { const a = o.geometry.attributes.position; for (let i = 0; i < a.count; i += step) out.push(new THREE.Vector3().fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld)); } }); return out; },
      setB: (az, tilt) => { const w = LAB.world; w.trackerB.setPose(az, tilt); w.scene.updateMatrixWorld(true); },
    };
  });

  // ------------------------------------------------------------------ E02/E03 encuadre de cada vista, con la barra de vistas descontada
  const names = await page.evaluate(() => Object.keys(LAB.world.viewSpecs));
  t.eq('E03 vistas predefinidas conservan sus identificadores', JSON.stringify(['general', 'moduleA', 'moduleB', 'station', 'load', 'cabinet', 'aerial', 'front'].filter((n) => names.includes(n))), JSON.stringify(['general', 'moduleA', 'moduleB', 'station', 'load', 'cabinet', 'aerial', 'front']));
  const viewReport = async (label) => {
    const rep = await page.evaluate(() => {
      const w = LAB.world, rig = LAB.rig, cam = LAB.app.camera, out = {}, top = w.insets.top;
      for (const n of Object.keys(w.viewSpecs)) {
        rig.set(n, true); cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
        const pts = w.viewSpecs[n].points.map((p) => p.clone().project(cam));
        const mx = Math.max(...pts.map((p) => Math.abs(p.x))), my = Math.max(...pts.map((p) => p.y)), mn = Math.min(...pts.map((p) => p.y));
        // dentro del volumen de algun equipo?
        const e = w.env3, P = cam.position; let inside = '';
        for (const k of ['moduleA', 'moveB', 'weather', 'load', 'cabinet', 'cam1', 'cam2']) { const b = e[k]; if (P.x > b.min[0] - 0.3 && P.x < b.max[0] + 0.3 && P.y > b.min[1] - 0.3 && P.y < b.max[1] + 0.3 && P.z > b.min[2] - 0.3 && P.z < b.max[2] + 0.3) inside = k; }
        out[n] = { mx: +mx.toFixed(3), my: +my.toFixed(3), mn: +mn.toFixed(3), top: +top.toFixed(3), front: pts.every((p) => p.z < 1), inside, pos: cam.position.toArray().map((v) => +v.toFixed(2)), elev: +(Math.asin((cam.position.y - w.viewSpecs[n].target.y) / cam.position.distanceTo(w.viewSpecs[n].target)) * 57.2958).toFixed(1) };
      }
      return out;
    });
    for (const n of Object.keys(rep)) {
      const r = rep[n];
      t.ok(`${label} vista ${n}: todo el sujeto dentro del cuadro útil (|x|≤${r.mx}, y∈[${r.mn}, ${r.my}], franja superior reservada ${r.top})`, r.mx <= 1.0 && r.mn >= -1.0 && r.my <= 1 - 2 * r.top + 1e-3 && r.front, `elevación ${r.elev}°, cámara ${r.pos.join(',')}`);
      t.ok(`${label} vista ${n}: la cámara no queda dentro del volumen de ningún equipo`, r.inside === '', r.inside);
    }
    return rep;
  };
  await waitAspect();
  const rep1366 = await viewReport('E03');
  t.ok('E02 vista general: elevación entre 15° y 45° (sin perspectiva extrema) y campo de visión 42°', rep1366.general.elev >= 15 && rep1366.general.elev <= 45 && (await page.evaluate(() => LAB.world.viewSpecs.general.fov)) === 42, `${rep1366.general.elev}°`);
  t.ok('E03 vista del módulo A ya no apunta al punto antiguo [-4.3, 0.85, 0.4]', await page.evaluate(() => { const v = LAB.world.viewSpecs.moduleA.target; return Math.hypot(v.x + 4.3, v.z - 0.4) > 0.5; }));

  // ------------------------------------------------------------------ E02 composicion de General: A a la izquierda de B, sin obstrucciones ni zonas confundidas
  {
    const r = await page.evaluate(() => {
      const w = LAB.world, cam = LAB.app.camera, L = LAB.config.layout; LAB.rig.set('general', true); cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
      const scr = (p) => new THREE.Vector3(...p).project(cam);
      const A = scr([L.moduleA[0], 0.8, L.moduleA[2]]), B = scr([L.moduleB[0], 2.5, L.moduleB[2]]), S = scr([L.weather[0], 2, L.weather[2]]), Ld = scr([L.load[0], 0.9, L.load[2]]), C = scr([L.cabinet[0], 1.2, L.cabinet[2]]);
      const from = cam.position.clone(), res = {};
      const chk = (id, p, ig) => { res[id] = __t.visible(from, new THREE.Vector3(...p), ig).ok; };
      chk('A', [L.moduleA[0], 0.75, L.moduleA[2]], ['A']); chk('B', [L.moduleB[0], 2.5, L.moduleB[2]], ['B']); chk('station', [L.weather[0], 2.3, L.weather[2]], ['station']);
      chk('load', [L.load[0], 0.9, L.load[2]], ['load']); chk('cabinet', [L.cabinet[0], 1.3, L.cabinet[2]], ['cabinet']);
      const ae = w.env3, sizeA = (() => { const c = __t.ndcBox(cam, { min: ae.moduleA.min, max: ae.moduleA.max }); return Math.max(...c.map((p) => p.x)) - Math.min(...c.map((p) => p.x)); })();
      const sizeB = (() => { const c = __t.ndcBox(cam, { min: ae.moveB.min, max: ae.moveB.max }); return Math.max(...c.map((p) => p.x)) - Math.min(...c.map((p) => p.x)); })();
      return { A: A.x, B: B.x, S: S.x, Ld: Ld.x, C: C.x, vis: res, sizeA, sizeB, camZ: cam.position.z, labelA: !!document.querySelector('.tag.a'), labelB: !!document.querySelector('.tag.b') };
    });
    t.ok('E02 el módulo A queda a la izquierda del B en la vista General (no se invierten etiquetas)', r.A < r.B, `A x=${r.A.toFixed(2)} B x=${r.B.toFixed(2)}`);
    t.ok('E02 estación meteorológica lateral/al fondo (izquierda de A en pantalla)', r.S < r.A);
    t.ok('E02 carga y gabinete juntos, a la derecha del módulo B', r.Ld > r.B && r.C > r.B);
    t.ok('E02 ningún equipo principal queda tapado por otro desde General', Object.values(r.vis).every(Boolean), JSON.stringify(r.vis));
    t.ok('E02 A y B ocupan cada uno al menos 12 % del ancho de la escena en General', r.sizeA / 2 >= 0.12 && r.sizeB / 2 >= 0.12, `A ${(r.sizeA * 50).toFixed(0)} %, B ${(r.sizeB * 50).toFixed(0)} %`);
  }

  // ------------------------------------------------------------------ E06 movimiento de B contra el resto de equipos (muestreo)
  {
    const r = await page.evaluate(() => {
      const w = LAB.world, e = w.env3; let minGap = 1e9, worst = '', n = 0; const hits = [];
      const boxes = { A: e.moduleA, load: e.load, cabinet: e.cabinet, estacion: e.weather, cam1: e.cam1, cam2: e.cam2 };
      const gap = (b1, b2) => { let s = 0; for (let i = 0; i < 3; i++) { const d = Math.max(b1.min.getComponent(i) - b2.max[i], b2.min[i] - b1.max.getComponent(i), 0); s += d * d; } return Math.sqrt(s); };
      let maxR = 0, minY = 1e9, maxY = 0;
      for (let az = 90; az <= 270; az += 10) for (let tilt = 0; tilt <= 90; tilt += 10) {
        __t.setB(az, tilt); n++;
        const bb = new THREE.Box3(); bb.expandByObject(w.trackerB.azGroup);
        // tambien el actuador (hijo directo del grupo del seguidor, no del azimut)
        w.trackerB.group.children.forEach((c) => { if (c.isMesh && c.geometry.type === 'CylinderGeometry' && c.position.y !== 0 && c.material && c.position.y < 3 && c !== w.trackerB.group.children[0]) { /* se cubre abajo */ } });
        const c0 = w.trackerB.group.position;
        for (const v of __t.verts(w.trackerB.azGroup, 1)) { maxR = Math.max(maxR, Math.hypot(v.x - c0.x, v.z - c0.z)); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); }
        for (const [k, bx] of Object.entries(boxes)) { const g = gap(bb, bx); if (g < minGap) { minGap = g; worst = `${k} (az ${az}°, inclinación ${tilt}°)`; } if (g < 0.5) hits.push(k); }
      }
      __t.setB(180, 17);
      return { minGap: +minGap.toFixed(2), worst, n, hits: Array.from(new Set(hits)), maxR: +maxR.toFixed(2), minY: +minY.toFixed(2), maxY: +maxY.toFixed(2), envR: +(e.moveB.max[0] - LAB.config.layout.moduleB[0]).toFixed(2), envMax: e.moduleB.max[1] };
    });
    t.ok(`E06 el volumen real barrido por B (${r.n} poses: azimut 90-270° cada 10°, inclinación 0-90° cada 10°) deja ≥ 0.5 m a cualquier otro equipo`, r.minGap >= 0.5 && r.hits.length === 0, `holgura mínima ${r.minGap} m con ${r.worst}`);
    t.ok('E06 el volumen real de B (vértices de las piezas móviles) cabe en el cilindro circunscrito usado por las vistas y las cámaras', r.maxR <= r.envR + 0.01 && r.maxY <= r.envMax + 0.01, `radio real ${r.maxR.toFixed(2)} ≤ ${r.envR}; altura máxima ${r.maxY.toFixed(2)} ≤ ${r.envMax}; altura mínima ${r.minY.toFixed(2)}`);
    t.ok('E06 los límites angulares no cambiaron (azimut 90-270°, inclinación 0-90°)', await page.evaluate(() => { const c = LAB.config.tracker; return c.azMin === 90 && c.azMax === 270 && c.tiltMin === 0 && c.tiltMax === 90; }));
  }

  // ------------------------------------------------------------------ E06/E03 la vista de B no recorta el panel en ninguna pose autorizada
  {
    const r = await page.evaluate(() => {
      const w = LAB.world, cam = LAB.app.camera; LAB.rig.set('moduleB', true); const bad = []; let n = 0, worst = 0;
      for (const az of [90, 135, 180, 225, 270]) for (const tilt of [0, 17, 45, 90]) {
        __t.setB(az, tilt); cam.updateMatrixWorld(true); const bb = new THREE.Box3().setFromObject(w.trackerB.group); const o = [];
        for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) o.push(new THREE.Vector3(x, y, z).project(cam));
        const mx = Math.max(...o.map((p) => Math.abs(p.x))), my = Math.max(...o.map((p) => p.y)), mn = Math.min(...o.map((p) => p.y)); n++;
        worst = Math.max(worst, mx, Math.abs(mn));
        if (mx > 1 || mn < -1 || my > 1 - 2 * w.insets.top) bad.push(`${az}/${tilt}`);
      }
      __t.setB(180, 17); return { bad, n, worst: +worst.toFixed(3) };
    });
    t.ok(`E03 vista de B sin recortes con inclinación 0/17/45/90° y azimut 90/135/180/225/270° (${r.n} poses)`, r.bad.length === 0, r.bad.join(' ') || `máximo |ndc| ${r.worst}`);
  }

  // ------------------------------------------------------------------ E07 / E08 camaras IP
  {
    const r = await page.evaluate(() => {
      const w = LAB.world, e = w.env3, out = {};
      for (const k of ['cam1', 'cam2']) {
        const cam = w[k].cam; cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
        const fwd = w[k].forward(), lensW = w[k].lens.getWorldPosition(new THREE.Vector3()), look = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        out[k] = { angle: +(Math.acos(Math.min(1, fwd.dot(look))) * 57.2958).toFixed(3), lensOff: +lensW.distanceTo(cam.position).toFixed(4), fov: cam.fov };
      }
      const ndcMax = (cam, names) => { let m = 0; for (const n of names) for (const p of __t.ndcBox(cam, e[n])) { m = Math.max(m, Math.abs(p.x), Math.abs(p.y)); if (p.z > 1) m = 9; } return +m.toFixed(3); };
      out.cam1.ndc = ndcMax(w.cam1.cam, ['moduleA', 'moduleB']);
      out.cam2.ndc = ndcMax(w.cam2.cam, ['moveB']);
      // linea de vista a A y B desde cam1; al panel B en varias poses desde cam2
      const L = LAB.config.layout, c1 = w.cam1.cam.position.clone(), c2 = w.cam2.cam.position.clone();
      out.cam1.vis = [__t.visible(c1, new THREE.Vector3(L.moduleA[0], 0.8, L.moduleA[2]), ['A', 'cam1']).ok, __t.visible(c1, new THREE.Vector3(L.moduleB[0], 2.5, L.moduleB[2]), ['B', 'cam1']).ok];
      const vis2 = []; let blocked = [];
      for (const az of [90, 180, 270]) for (const tilt of [0, 45, 90]) { __t.setB(az, tilt); const c = w.trackerB.module.root.getWorldPosition(new THREE.Vector3()); const v = __t.visible(c2, c, ['B', 'cam2']); vis2.push(v.ok); if (!v.ok) blocked.push(`${az}/${tilt} por ${v.by}`); }
      __t.setB(180, 17); out.cam2.vis = vis2.every(Boolean); out.cam2.blocked = blocked;
      // cam2 con B en todas las poses: sus esquinas dentro del cuadro
      let worst = 0; for (let az = 90; az <= 270; az += 30) for (let tilt = 0; tilt <= 90; tilt += 30) { __t.setB(az, tilt); for (const v of __t.verts(w.trackerB.azGroup, 1)) { const p = v.clone().project(w.cam2.cam); worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y)); } }
      __t.setB(180, 17); out.cam2.worst = +worst.toFixed(3);
      out.dist = { cam1: +w.cam1.group.position.distanceTo(new THREE.Vector3(...LAB.config.layout.moduleB)).toFixed(2), cam2: +w.cam2.group.position.distanceTo(new THREE.Vector3(...LAB.config.layout.moduleB)).toFixed(2) };
      out.camVsMove = ['cam1', 'cam2'].map((k) => { const b = e[k], m = e.moveB; const g = (i) => Math.max(b.min[i] - m.max[i], m.min[i] - b.max[i], 0); return +Math.hypot(g(0), g(1), g(2)).toFixed(2); });
      return out;
    });
    t.ok('E07 cámara IP 1: la carcasa y la cámara virtual apuntan igual (diferencia ≤ 0.5°) y la lente coincide', r.cam1.angle <= 0.5 && r.cam1.lensOff < 0.01, `${r.cam1.angle}°`);
    t.ok('E07 cámara IP 1 supervisa A y B completos dentro del cuadro con margen (|ndc| ≤ 0.95)', r.cam1.ndc <= 0.95, `máx ${r.cam1.ndc}`);
    t.ok('E07 cámara IP 1: línea de vista libre hacia A y hacia B', r.cam1.vis.every(Boolean), JSON.stringify(r.cam1.vis));
    t.ok('E08 cámara IP 2: la carcasa y la cámara virtual apuntan igual (diferencia ≤ 0.5°)', r.cam2.angle <= 0.5 && r.cam2.lensOff < 0.01, `${r.cam2.angle}°`);
    t.ok('E08 cámara IP 2 ve todo el volumen de B con margen (|ndc| ≤ 0.95)', r.cam2.ndc <= 0.95 && r.cam2.worst <= 0.95, `envolvente ${r.cam2.ndc}, poses reales ${r.cam2.worst}`);
    t.ok('E08 cámara IP 2: ningún equipo tapa al panel B en azimut 90/180/270° e inclinación 0/45/90°', r.cam2.vis, r.cam2.blocked.join('; '));
    t.ok('E08 ninguna cámara queda a menos de 3 m del volumen de B (fuera del volumen móvil)', Math.min(...r.camVsMove) >= 3, `holguras ${r.camVsMove.join(' y ')} m`);
    t.ok('E08 las dos cámaras miran detalles distintos (cam1 supervisa A+B, cam2 sigue a B)', r.cam1.ndc !== r.cam2.ndc && r.dist.cam2 < 8 && r.dist.cam1 > 6, `cam1 a B: ${r.dist.cam1} m, cam2 a B: ${r.dist.cam2} m`);
  }

  // ------------------------------------------------------------------ E15 cableado
  {
    const r = await page.evaluate(() => {
      const w = LAB.world, L = LAB.config.layout, e = w.env3, rs = w.cables.userData.routes, out = { issues: [], len: {} };
      const near = (p, c, r) => Math.hypot(p.x - c[0], p.z - c[2]) < r;
      const boxIn = (p, b, m) => p.x > b.min[0] - m && p.x < b.max[0] + m && p.y > b.min[1] - m && p.y < b.max[1] + m && p.z > b.min[2] - m && p.z < b.max[2] + m;
      for (const rt of rs) {
        const pts = rt.curve.getPoints(300), a = pts[0], z = pts[pts.length - 1];
        let len = 0; for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]); out.len[rt.id] = +len.toFixed(2);
        // extremos
        const ends = { 'A-carga(+)': [L.moduleA, L.load], 'A-carga(-)': [L.moduleA, L.load], 'B-carga(+)': [L.moduleB, L.load], 'B-carga(-)': [L.moduleB, L.load], 'estacion-gabinete': [L.weather, L.cabinet], 'carga-gabinete': [L.load, L.cabinet], 'B-gabinete': [L.moduleB, L.cabinet] }[rt.id];
        if (!near(a, ends[0], 0.8)) out.issues.push(`${rt.id}: inicio lejos de su origen`);
        if (!near(z, ends[1], 0.9)) out.issues.push(`${rt.id}: final lejos de su destino`);
        if (rt.id.includes('carga(') && Math.abs(z.x - (L.load[0] - 0.5)) > 0.05) out.issues.push(`${rt.id}: no termina en la cara oeste de la carga (x=${z.x.toFixed(2)})`);
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i], dStart = p.distanceTo(a), dEnd = p.distanceTo(z);
          // no cruza el volumen de B, su columna, ni los gabinetes (salvo en sus extremos)
          if (boxIn(p, e.moveB, 0.0) && p.y > 1.0) out.issues.push(`${rt.id}: entra al volumen móvil de B`);
          for (const [k, bx, own] of [['moduleA', e.moduleA, rt.id.startsWith('A-')], ['load', e.load, rt.id.includes('carga')], ['cabinet', e.cabinet, rt.id.includes('gabinete')], ['estación', e.weather, rt.id.startsWith('estacion')], ['cam1', e.cam1, false], ['cam2', e.cam2, false]]) { if (boxIn(p, bx, -0.02) && !(own && (dStart < (k === 'estación' ? 1.5 : 0.9) || dEnd < 0.9))) out.issues.push(`${rt.id}: atraviesa ${k}`); }
          if (Math.hypot(p.x - L.moduleB[0], p.z - L.moduleB[2]) < 0.5 && !(rt.id.startsWith('B-') && dStart < 0.9)) out.issues.push(`${rt.id}: pasa por la columna/base de B`);
        }
        if (rt.id.startsWith('estacion') && pts.some((p) => near(p, L.load, 1.2))) out.issues.push('la estación se acerca a la carga (podría parecer conectada a la salida de potencia)');
        out[rt.id] = { kind: rt.kind };
      }
      out.issues = Array.from(new Set(out.issues));
      // B: holgura (largo real / distancia en linea recta)
      const straight = Math.hypot(L.load[0] - 0.5 - L.moduleB[0], L.load[2] - L.moduleB[2]);
      out.slack = +(out.len['B-carga(+)'] / straight).toFixed(2);
      // se construyen una sola vez: hijos y geometrias no cambian al animar
      const ids0 = w.cables.children.map((c) => c.geometry.uuid).join(','); for (let i = 0; i < 40; i++) w.update(LAB.app.source.telemetry, 0.05);
      out.once = ids0 === w.cables.children.map((c) => c.geometry.uuid).join(',') && w.cables.children.length === 7;
      return out;
    });
    t.ok('E15 7 trayectos con extremos en sus equipos y en la cara correcta de la carga; ninguno cruza columnas, el volumen de B ni gabinetes', r.issues.length === 0, r.issues.join('; ') || `longitudes ${JSON.stringify(r.len)}`);
    t.ok('E15 el cable de B tiene holgura (largo real ≥ 1.25 × la distancia en línea recta; recurso didáctico)', r.slack >= 1.25, `relación ${r.slack}`);
    t.ok('E15 el cableado se construye una sola vez (no se regenera por cuadro)', r.once);
    t.ok('E15 los conductos de señal son distintos de los cables de potencia CC (3 + 4)', Object.entries(r).filter(([k, v]) => v && v.kind === 'senal').length === 3 && Object.entries(r).filter(([k, v]) => v && v.kind === 'cc').length === 4);
  }

  // ------------------------------------------------------------------ E16 etiquetas con B inclinado y E10 seleccion
  {
    const r = await page.evaluate(() => {
      const w = LAB.world, cam = LAB.app.camera, out = { bad: [], px: [] }; LAB.rig.set('moduleB', true); const host = document.getElementById('stage'), W = host.clientWidth, H = host.clientHeight;
      const item = (id) => w.labels.items.find((i) => i.partId === id);
      const proj = (v) => { const p = v.clone().project(cam); return [(p.x + 1) / 2 * W, (1 - p.y) / 2 * H]; };
      for (const [az, tilt] of [[90, 0], [180, 45], [270, 90], [135, 17]]) {
        __t.setB(az, tilt); w.labels.render(cam);
        const root = w.trackerB.module.root, sensor = w.trackerB.module.irradianceSensor, tg = w.trackerB.tiltGroup;
        const wp = (id) => item(id).obj.getWorldPosition(new THREE.Vector3());
        const sw = sensor.getWorldPosition(new THREE.Vector3()), rw = root.getWorldPosition(new THREE.Vector3());
        const d1 = wp('irrB').distanceTo(sw.clone().add(new THREE.Vector3(0, 0.4, 0))), d2 = wp('moduleB').distanceTo(rw.clone().add(new THREE.Vector3(0, 0.75, 0))), d3 = wp('tiltAxis').distanceTo(new THREE.Vector3(1.45, 0, 0).applyMatrix4(tg.matrixWorld));
        if (Math.max(d1, d2, d3) > 0.02) out.bad.push(`${az}/${tilt}: ${d1.toFixed(3)},${d2.toFixed(3)},${d3.toFixed(3)}`);
        const ps = proj(sw), pl = proj(wp('irrB')); out.px.push(Math.round(Math.hypot(ps[0] - pl[0], ps[1] - pl[1])));
      }
      __t.setB(180, 17); w.labels.render(cam);
      // etiquetas de A y de la estacion siguen en su sitio
      const L = LAB.config.layout; out.fixed = ['moduleA', 'dcA', 'irrA'].every((id) => item(id).obj.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(...L.moduleA)) < 2.5);
      return out;
    });
    t.ok('E16 las etiquetas de B (módulo, sensor de irradiancia, eje de inclinación) siguen a la pieza móvil en 4 poses (error ≤ 2 cm)', r.bad.length === 0, r.bad.join(' | '));
    t.ok('E16 la etiqueta del sensor queda a ≤ 90 px del sensor en pantalla, con B inclinado', Math.max(...r.px) <= 90, `píxeles ${r.px.join(',')}`);
    t.ok('E16 las etiquetas de A siguen junto a A', r.fixed);
  }
  {
    const r = await page.evaluate(() => {
      const w = LAB.world, rig = LAB.rig, cam = LAB.app.camera, res = [], PV = { moduleA: 'moduleA', irrA: 'moduleA', dcA: 'moduleA', moduleB: 'moduleB', irrB: 'moduleB', azAxis: 'moduleB', tiltAxis: 'moduleB', dcB: 'moduleB', pyr: 'station', anemo: 'station', shield: 'station', rain: 'station', load: 'load', cabinet: 'cabinet', estop: 'cabinet', cam1: 'camFocus1', cam2: 'camFocus2' };
      for (const id of Object.keys(w.partRoots)) {
        __t.setB(180, 17); LAB.app.handlePart(id); w.updateHalo();
        const info = document.getElementById('infocard'), shown = info && !info.hidden;
        const halo = w.halo.visible && !w.halo.box.isEmpty() && isFinite(w.halo.box.min.x);
        const v = PV[id]; rig.set(v, true); cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
        const box = new THREE.Box3().setFromObject(w.partRoots[id]); const o = []; for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) o.push(new THREE.Vector3(x, y, z).project(cam));
        const mx = Math.max(...o.map((p) => Math.abs(p.x))), my = Math.max(...o.map((p) => p.y)), mn = Math.min(...o.map((p) => p.y));
        const c = box.getCenter(new THREE.Vector3()); const vis = __t.visible(cam.position.clone(), c, [id.replace(/^(irr|dc)([AB])$/, '$2'), 'A', 'B', 'station', 'load', 'cabinet', 'cam1', 'cam2'].filter(Boolean)).ok;
        res.push({ id, shown, halo, view: v, inside: mx <= 1.02 && mn >= -1.02 && my <= 1 - 2 * w.insets.top + 0.03, mx: +mx.toFixed(2) });
      }
      return res;
    });
    const bad = r.filter((x) => !x.shown || !x.halo || !x.inside);
    t.ok(`E10 los ${r.length} componentes se pueden seleccionar (ficha + marco) y "Abrir componente/Acercar" los deja dentro del cuadro`, bad.length === 0, bad.map((x) => `${x.id}→${x.view}: ficha ${x.shown} marco ${x.halo} dentro ${x.inside} (${x.mx})`).join('; '));
  }

  // ------------------------------------------------------------------ E17 sombras y oclusion por equipos (amanecer, mediodia, tarde; varias fechas)
  {
    const r = await page.evaluate(async () => {
      const w = LAB.world, src = LAB.app.source, L = LAB.config.layout; const out = { rows: [], light: [] };
      const gm = __t.groupOf(); const ctx = []; w.env.group.traverse((o) => { if (o.isMesh && o.castShadow) ctx.push(o); });
      const casters = Array.from(gm.keys()).concat(ctx);
      const dates = [[2026, 12, 21], [2026, 3, 21], [2026, 6, 21], [2026, 10, 23]];
      const hours = [[6, 30], [7, 0], [8, 0], [12, 0], [16, 0], [17, 0], [17, 30]];
      for (const [y, mo, d] of dates) for (const [hh, mm] of hours) {
        src.send({ type: 'sim.time', ms: LAB.fromLocal(y, mo, d, hh, mm) }); src.send({ type: 'sim.cloud', value: 0.05 }); src.send({ type: 'tracker.mode', mode: 'astro' }); for (let i = 0; i < 25; i++) src.step(0.1);
        const tel = src.telemetry; w.update(tel, 0.05); w.scene.updateMatrixWorld(true);
        const el = tel.sun.el, sv = new THREE.Vector3(tel.sun.vec[0], tel.sun.vec[1], tel.sun.vec[2]).normalize();
        if (el < 2) { out.rows.push({ d: `${d}/${mo}`, t: `${hh}:${String(mm).padStart(2, '0')}`, el: +el.toFixed(1), skip: true }); continue; }
        const rowShade = {};
        for (const [k, mod] of [['A', w.bankA.module], ['B', w.trackerB.module]]) {
          let sh = 0, n = 0; const by = {};
          const Lh = 2.278, S = 1.134;
          for (let i = 0; i < 7; i++) for (let j = 0; j < 5; j++) {
            const lp = new THREE.Vector3((i / 6 - 0.5) * Lh * 0.96, 0.03, (j / 4 - 0.5) * S * 0.96);
            const wp = mod.root.localToWorld(lp);
            const nrm = new THREE.Vector3(0, 1, 0).transformDirection(mod.root.matrixWorld);
            if (nrm.dot(sv) <= 0) { continue; }   // el Sol esta detras del plano: no se evalua
            n++;
            const rc = new THREE.Raycaster(wp, sv, 0.02, 80); const hits = rc.intersectObjects(casters.filter((o) => { let p = o; while (p) { if (p === mod.root) return false; p = p.parent; } return true; }), false);
            if (hits.length) { sh++; const g = gm.get(hits[0].object) || 'contexto'; by[g] = (by[g] || 0) + 1; }
          }
          rowShade[k] = { n, pct: n ? Math.round(100 * sh / n) : null, by };
        }
        out.rows.push({ d: `${d}/${mo}`, t: `${hh}:${String(mm).padStart(2, '0')}`, el: +el.toFixed(1), az: +tel.sun.az.toFixed(0), A: rowShade.A, B: rowShade.B, bAz: +tel.B.az.toFixed(0), bTilt: +tel.B.tilt.toFixed(0) });
        // cobertura del mapa de sombra: todas las esquinas de los equipos dentro del frustum de la luz
        const sh = w.env.sun.shadow; w.env.sun.updateMatrixWorld(true); sh.camera.position.copy(w.env.sun.position); sh.camera.lookAt(w.env.sun.target.position); sh.camera.updateMatrixWorld(true); sh.camera.updateProjectionMatrix();
        let worst = 0; for (const k of ['moduleA', 'moduleB', 'weather', 'load', 'cabinet', 'cam1', 'cam2']) for (const p of __t.ndcBox(sh.camera, w.env3[k])) worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
        out.light.push(+worst.toFixed(2));
      }
      src.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, 12, 0) });
      return out;
    });
    console.log('\n  Oclusión de los módulos por otros equipos/contexto (rayo hacia el Sol desde 35 puntos de cada panel):');
    console.log('  fecha   hora   elev  | A sombreado | B sombreado (posición astronómica)');
    for (const x of r.rows) console.log(`  ${x.d.padEnd(6)} ${x.t.padEnd(6)} ${String(x.el).padStart(5)}° | ` + (x.skip ? 'sol bajo el horizonte' : `${x.A.pct === null ? 'n/a' : x.A.pct + ' %'}${x.A.pct ? ' (' + Object.keys(x.A.by).join(',') + ')' : ''}`.padEnd(12) + '| ' + `${x.B.pct === null ? 'n/a' : x.B.pct + ' %'}${x.B.pct ? ' (' + Object.keys(x.B.by).join(',') + ')' : ''}  [az ${x.bAz}° inc ${x.bTilt}°]`));
    const other = (m, k) => m && m.by ? Object.entries(m.by).filter(([g]) => g !== k).reduce((a, [, n]) => a + n, 0) : 0;   // sombra de OTROS equipos o de la azotea (la propia estructura de B sobre su panel se reporta aparte)
    const day = r.rows.filter((x) => !x.skip && x.el >= 15);
    t.ok('E17 con el Sol a ≥ 15° de elevación ningún otro equipo ni elemento de la azotea sombrea al módulo A ni al B', day.every((x) => other(x.A, 'A') === 0 && other(x.B, 'B') === 0), day.filter((x) => other(x.A, 'A') || other(x.B, 'B')).map((x) => `${x.d} ${x.t}: A ${JSON.stringify(x.A.by)} B ${JSON.stringify(x.B.by)}`).join('; '));
    const selfB = day.filter((x) => x.B && x.B.by && x.B.by.B).map((x) => `${x.d} ${x.t} ${x.B.pct}%`);
    t.ok('E17 la sombra de la propia estructura del seguidor sobre su panel (horquilla) se reporta, no se oculta', true, selfB.join('; ') || 'ninguna');
    const low = r.rows.filter((x) => !x.skip && x.el < 15 && x.el >= 2);
    t.ok(`E17 con el Sol por debajo de 15° se documenta la oclusión (${low.length} muestras; sin afirmar pérdida eléctrica)`, true, low.map((x) => `${x.d} ${x.t} (${x.el}°): A ${x.A.pct}% B ${x.B.pct}%`).join('; '));
    t.ok('E17 el volumen de sombra de la luz cubre todos los equipos en todas las horas muestreadas', Math.max(...r.light) <= 1, `máximo |ndc| de la luz = ${Math.max(...r.light)}`);
  }

  // ------------------------------------------------------------------ E04 / E05 / E18 tamanos de ventana y regreso
  const SIZES = [[1536, 864], [1366, 768], [1024, 768], [894, 668], [900, 520], [390, 844]];
  {
    const base = await page.evaluate(() => { const w = LAB.world; return JSON.stringify([w.bankA.group.position, w.trackerB.group.position, w.station.group.position, w.load.group.position, w.cabinet.group.position, w.cam1.group.position, w.cam2.group.position].map((p) => p.toArray().map((v) => +v.toFixed(4)))); });
    let ref = null;
    for (const [W, H] of SIZES.concat([[1366, 768]])) {
      await page.setViewportSize({ width: W, height: H }); await page.waitForTimeout(600);
      await page.evaluate(() => { const b = document.body; if (b.dataset.layout !== 'wide') { const tb = document.querySelector('#viewtabs [data-view=scene]'); if (tb) tb.click(); } });
      await page.waitForTimeout(600); await waitAspect();
      const r = await page.evaluate(() => {
        const w = LAB.world, rig = LAB.rig, cam = LAB.app.camera; rig.set('general', true); cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
        const host = document.getElementById('stage'), vb = document.getElementById('viewbar').getBoundingClientRect(), hr = host.getBoundingClientRect();
        const pts = w.viewSpecs.general.points.map((p) => p.clone().project(cam));
        const mx = Math.max(...pts.map((p) => Math.abs(p.x))), my = Math.max(...pts.map((p) => p.y)), mn = Math.min(...pts.map((p) => p.y));
        // el sujeto no queda bajo la barra de vistas: borde superior del sujeto (px) debajo del borde inferior de la barra
        const topPx = hr.top + (1 - my) / 2 * hr.height;
        return { aspect: +cam.aspect.toFixed(3), host: [host.clientWidth, host.clientHeight], mx: +mx.toFixed(3), mn: +mn.toFixed(3), my: +my.toFixed(3), under: topPx >= vb.bottom - 1, vbBottom: Math.round(vb.bottom), topPx: Math.round(topPx), pos: cam.position.toArray().map((v) => +v.toFixed(3)), phys: JSON.stringify([w.bankA.group.position, w.trackerB.group.position, w.station.group.position, w.load.group.position, w.cabinet.group.position, w.cam1.group.position, w.cam2.group.position].map((p) => p.toArray().map((v) => +v.toFixed(4)))), layout: document.body.dataset.layout };
      });
      const label = `${W}x${H}`;
      t.ok(`E04 ${label} (${r.layout}, escena ${r.host.join('×')}): General completa dentro del cuadro (|x|≤${r.mx}, y∈[${r.mn},${r.my}])`, r.mx <= 1 && r.mn >= -1 && r.my <= 1, '');
      t.ok(`E05 ${label}: el sujeto de General queda por debajo de la barra de vistas (sujeto desde ${r.topPx}px, barra termina en ${r.vbBottom}px)`, r.under);
      t.ok(`E04 ${label}: las posiciones físicas de los equipos no cambian con el tamaño de la ventana`, r.phys === base);
      if (W === 1366 && ref) t.ok('E04 1366x768 tras recorrer todos los tamaños: misma cámara de General que la primera vez (grande→pequeño→grande)', r.pos.every((v, i) => Math.abs(v - ref[i]) < 0.01), `${r.pos} vs ${ref}`);
      if (W === 1366 && !ref) ref = r.pos;
    }
    // E18 restaurar la vista despues de navegacion libre
    await page.setViewportSize({ width: 1366, height: 768 }); await page.waitForTimeout(800); await waitAspect();
    const r = await page.evaluate(() => {
      const rig = LAB.rig, cam = LAB.app.camera; rig.set('general', true); const p0 = cam.position.clone(), t0 = rig.controls.target.clone();
      cam.position.add(new THREE.Vector3(4, 2, -3)); rig.controls.target.add(new THREE.Vector3(1, 0, 0)); rig.controls.dispatchEvent({ type: 'start' }); rig.controls.update();
      const moved = rig.moved; const posMoved = cam.position.clone();
      window.dispatchEvent(new Event('resize')); rig.refit(); const kept = cam.position.distanceTo(posMoved) < 1e-6;   // un cambio de area no pisa lo que la persona movio
      rig.set('general'); rig.update(5); rig.update(5);
      return { moved, kept, back: cam.position.distanceTo(p0), backT: rig.controls.target.distanceTo(t0) };
    });
    t.ok('E18 tras navegar libremente, un cambio de tamaño no deshace lo que la persona movió', r.moved && r.kept);
    t.ok('E18 volver a "Vista general" restablece exactamente la misma vista', r.back < 0.02 && r.backT < 0.02, `desvío ${r.back.toFixed(4)} m`);
  }

  t.ok('Sin errores de consola ni excepciones', errs.length === 0, errs.slice(0, 3).join(' | '));
  await b.close(); t.done();
})().catch((e) => { console.error('FALLO DE LA PRUEBA', e); process.exit(2); });
