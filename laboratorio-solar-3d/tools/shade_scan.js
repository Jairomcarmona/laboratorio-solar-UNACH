/* Oclusion geometrica de los modulos A y B por otros equipos y por la azotea, a lo largo del dia (rayo hacia el Sol desde 35 puntos
 * de cada panel, B en seguimiento astronomico). Mide solo GEOMETRIA: la sombra dibujada no entra al modelo electrico.
 * Uso: node tools/shade_scan.js [--json]   (LAB_ROOT=otra copia para comparar distribuciones) */
const h = require('./lib/harness.js');
(async () => {
  const b = await h.launch();
  const { page } = await h.open(b, 'session=student&q=low&cloud=0.05', { width: 1366, height: 768 }, []);
  const res = await page.evaluate(() => {
    const w = LAB.world, src = LAB.app.source; const gm = new Map();
    const reg = (id, root) => root.traverse((o) => { if (o.isMesh) gm.set(o, id); });
    reg('A', w.bankA.group); reg('B', w.trackerB.group); reg('estación', w.station.group); reg('carga', w.load.group); reg('gabinete', w.cabinet.group); reg('cam1', w.cam1.group); reg('cam2', w.cam2.group);
    const ctx = []; w.env.group.traverse((o) => { if (o.isMesh && o.castShadow) { ctx.push(o); gm.set(o, 'azotea'); } });
    const casters = Array.from(gm.keys());
    const out = [];
    for (const [y, mo, d] of [[2026, 12, 21], [2026, 3, 21], [2026, 6, 21], [2026, 10, 23]]) {
      for (let mins = 6 * 60; mins <= 18 * 60; mins += 15) {
        src.send({ type: 'sim.time', ms: LAB.fromLocal(y, mo, d, Math.floor(mins / 60), mins % 60) }); src.send({ type: 'tracker.mode', mode: 'astro' });
        for (let i = 0; i < 25; i++) src.step(0.1);
        const tel = src.telemetry; w.update(tel, 0.05); w.scene.updateMatrixWorld(true);
        const el = tel.sun.el; if (el < 5) continue;
        const sv = new THREE.Vector3(...tel.sun.vec).normalize(), row = { date: `${d}/${mo}`, t: `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`, el: +el.toFixed(1), az: +tel.sun.az.toFixed(0) };
        for (const [k, mod] of [['A', w.bankA.module], ['B', w.trackerB.module]]) {
          const nrm = new THREE.Vector3(0, 1, 0).transformDirection(mod.root.matrixWorld); if (nrm.dot(sv) <= 0.02) { row[k] = null; continue; }
          const ok = casters.filter((o) => { let p = o; while (p) { if (p === mod.root) return false; p = p.parent; } return true; });
          let sh = 0, n = 0; const by = {};
          for (let i = 0; i < 7; i++) for (let j = 0; j < 5; j++) {
            const wp = mod.root.localToWorld(new THREE.Vector3((i / 6 - 0.5) * 2.278 * 0.96, 0.03, (j / 4 - 0.5) * 1.134 * 0.96)); n++;
            const hit = new THREE.Raycaster(wp, sv, 0.02, 90).intersectObjects(ok, false)[0];
            if (hit) { sh++; const g = gm.get(hit.object); by[g] = (by[g] || 0) + 1; }
          }
          row[k] = { pct: Math.round(100 * sh / n), by };
        }
        out.push(row);
      }
    }
    return out;
  });
  // resumen: minutos con sombra de OTROS equipos (excluye la propia estructura del seguidor B sobre B)
  const cross = (r, k) => r[k] && Object.entries(r[k].by).filter(([g]) => g !== k).reduce((s, [, n]) => s + n, 0) > 0;
  const rows = res.filter((r) => r.el >= 5);
  const sum = (k, thr) => rows.filter((r) => r.el >= thr && cross(r, k)).length * 15;
  const tot = (thr) => rows.filter((r) => r.el >= thr).length * 15;
  console.log(`Muestras cada 15 min, 4 fechas (21/12, 21/3, 21/6, 23/10), Sol ≥ 5°: ${rows.length}`);
  for (const thr of [5, 10, 15, 20]) console.log(`  elevación ≥ ${String(thr).padStart(2)}°: ${tot(thr)} min muestreados | sombra de otros equipos/azotea sobre A: ${sum('A', thr)} min | sobre B: ${sum('B', thr)} min`);
  const worst = rows.filter((r) => (cross(r, 'A') || cross(r, 'B')) && r.el >= 10).map((r) => `${r.date} ${r.t} (${r.el}°, az ${r.az}°): A ${r.A ? r.A.pct + '% ' + JSON.stringify(r.A.by) : '—'} B ${r.B ? r.B.pct + '% ' + JSON.stringify(r.B.by) : '—'}`);
  console.log('  casos con Sol ≥ 10° y sombra cruzada:'); worst.forEach((x) => console.log('    ' + x));
  if (process.argv.includes('--json')) console.log(JSON.stringify(res));
  await b.close();
})();
