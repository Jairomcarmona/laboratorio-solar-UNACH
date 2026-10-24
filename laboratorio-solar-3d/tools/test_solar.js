// Valida solar.js contra las posiciones de referencia calculadas con pvlib.
// Uso: node tools/test_solar.js
global.window = global; global.THREE = { Color: class { convertSRGBToLinear() { return this; } } };
const load = (f) => { const vm = require('vm'), fs = require('fs'); vm.runInThisContext(fs.readFileSync(__dirname + '/../' + f, 'utf8'), { filename: f }); };
['js/config.js', 'data/pvlib_tuxtla.js', 'js/sim/solar.js'].forEach(load);
let worst = 0;
for (const c of LAB.data.pvlib.check) {
  const p = LAB.sim.solar.position(c.ms);
  const dz = Math.abs(p.zenith - c.zenith), da = Math.abs(LAB.util.angDiff(p.az, c.azimuth));
  worst = Math.max(worst, dz, c.zenith < 88 ? da : 0);
  console.log(c.utc.slice(0, 16), 'zen js/pvlib', p.zenith.toFixed(3), c.zenith.toFixed(3), ' az', p.az.toFixed(3), c.azimuth.toFixed(3));
}
console.log('peor diferencia (deg):', worst.toFixed(3));
const lt = LAB.localTime(LAB.fromLocal(2026, 6, 21, 12, 0));
const cs = LAB.sim.solar.clearsky(lt, 70);
console.log('cielo despejado 21-jun 12:00 local:', cs);
if (worst > 0.1) { console.error('FALLO'); process.exit(1); }
console.log('OK');
