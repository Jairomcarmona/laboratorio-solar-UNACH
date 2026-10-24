/* Capturas de la escena para comparar distribuciones: node tools/shots_spatial.js <carpeta> [ancho] [alto]
 * Mismas condiciones siempre: 23/10/2026 12:00 local, nubosidad 0.1, panel B en su pose inicial, calidad por defecto. */
const h = require('./lib/harness.js');
const fs = require('fs');
const path = require('path');
(async () => {
  const [out = 'shots', W = '1366', H = '768', only = ''] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const b = await h.launch(); const errs = [];
  const { page } = await h.open(b, 'session=student' + (process.env.SHOT_PANELS ? '' : '&panels=0') + '&time=2026-10-23T12:00&cloud=0.1' + (process.env.SHOT_QUERY || ''), { width: +W, height: +H }, errs);
  await page.evaluate(() => { document.getElementById('toasts').style.display = 'none'; });
  const shot = async (name, js) => {
    if (only && !name.includes(only)) return;
    await page.evaluate(js); await page.waitForTimeout(4500);
    await page.screenshot({ path: path.join(out, `${name}_${W}x${H}.png`) }); console.log('captura', name);
  };
  const views = await page.evaluate(() => Object.keys(LAB.app.world.views));
  for (const v of views) await shot(v, `LAB.app.setPip(false); LAB.app.rig.set('${v}', true)`);
  await shot('pov_cam1', `LAB.app.rig.set('general', true); LAB.app.rig.enterPov('cam1')`);
  await shot('pov_cam2', `LAB.app.rig.exitPov(true); LAB.app.rig.enterPov('cam2')`);
  await shot('general_pip_cam1', `LAB.app.rig.exitPov(true); LAB.app.rig.set('general', true); LAB.app.setPip(true, 'cam1')`);
  await shot('general_pip_cam2', `LAB.app.setPip(true, 'cam2')`);
  // B inclinado y girado (vistas de B y camara IP 2), y hora del dia (amanecer de equinoccio, tarde de invierno, noche)
  const move = (az, tilt) => `(() => { const s = LAB.app.source; s.send({ type: 'tracker.target', az: ${az}, tilt: ${tilt} }); for (let i = 0; i < 700; i++) s.step(0.1); })()`;
  await shot('moduleB_az270_tilt90', `LAB.app.rig.exitPov(true); LAB.app.rig.set('moduleB', true); ${move(270, 90)}`);
  await shot('moduleB_az135_tilt45', `${move(135, 45)}`);
  await shot('pov_cam2_az270_tilt90', `${move(270, 90)}; LAB.app.rig.enterPov('cam2')`);
  await shot('pov_cam2_az90_tilt45', `${move(90, 45)}`);
  await shot('general_az270_tilt90', `LAB.app.rig.exitPov(true); LAB.app.rig.set('general', true); ${move(270, 90)}`);
  const at = (y, mo, d, hh, mm) => `(() => { const s = LAB.app.source; s.send({ type: 'sim.time', ms: LAB.fromLocal(${y}, ${mo}, ${d}, ${hh}, ${mm}) }); s.send({ type: 'tracker.mode', mode: 'astro' }); for (let i = 0; i < 700; i++) s.step(0.1); })()`;
  await shot('general_equinoccio_0715', `${at(2026, 3, 21, 7, 15)}`);
  await shot('general_invierno_1600', `${at(2026, 12, 21, 16, 0)}`);
  await shot('general_noche_2200', `${at(2026, 10, 23, 22, 0)}`);
  console.log(errs.slice(0, 5).join('\n') || 'sin errores de consola');
  await b.close();
})();
