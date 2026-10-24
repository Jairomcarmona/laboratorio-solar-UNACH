/* Inventario de la escena: node tools/inventory.js > inventario.json  (LAB_ROOT apunta a otra copia del proyecto para comparar "antes/despues") */
const h = require('./lib/harness.js');
(async () => {
  const b = await h.launch();
  const { page } = await h.open(b, 'session=student&q=low', { width: 1366, height: 768 }, []);
  const inv = await page.evaluate(() => {
    const w = LAB.world, cfg = LAB.config, r3 = (v) => Math.round(v * 1000) / 1000;
    const stat = (root) => { let meshes = 0; root.traverse((o) => { if (o.isMesh) meshes++; }); root.updateMatrixWorld(true); const bx = new THREE.Box3().setFromObject(root), s = bx.getSize(new THREE.Vector3()); return { meshes, size: [r3(s.x), r3(s.y), r3(s.z)] }; };
    const groups = { moduleA: w.bankA.group, moduleB: w.trackerB.group, station: w.station.group, load: w.load.group, cabinet: w.cabinet.group, cam1: w.cam1.group, cam2: w.cam2.group };
    const g = {}; for (const [k, v] of Object.entries(groups)) g[k] = stat(v);
    const labelCount = {}; w.labels.items.forEach((i) => { labelCount[i.partId] = (labelCount[i.partId] || 0) + 1; });
    const pick = {}; for (const m of w.picker.meshes) pick[m.userData.part] = (pick[m.userData.part] || 0) + 1;
    const physical = { module: cfg.module, fixed: cfg.fixed, tracker: cfg.tracker, safety: cfg.safety, limits: cfg.limits, site: cfg.site, speeds: cfg.speeds };
    return { appVersion: cfg.appVersion, partIds: Object.keys(w.partRoots).sort(), labels: labelCount, pickableMeshes: pick, groups: g, cablesChildren: w.cables.children.length,
      views: Object.keys(w.viewSpecs || w.views).sort(), sceneTopLevel: w.scene.children.length, physical };
  });
  console.log(JSON.stringify(inv, null, 1));
  await b.close();
})();
