/* Carga los modulos del simulador en el contexto global de Node (sin navegador) para las pruebas de dominio. */
const vm = require('vm'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const FILES = ['js/config.js', 'data/pvlib_tuxtla.js', 'js/sim/solar.js', 'js/sim/pvmodel.js', 'js/sim/sensors.js', 'js/sim/shade.js', 'js/sim/weather.js', 'js/sim/control.js',
  'js/sim/safety.js', 'js/core/validate.js', 'js/core/exporters.js', 'js/core/calibration.js', 'js/core/analysis.js', 'js/core/store.js', 'js/sim/engine.js', 'js/data/wsSource.js', 'js/data/dataSource.js'];
function loadSim(extra = []) {
  global.window = global;
  if (!global.localStorage) global.localStorage = { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  for (const f of FILES.concat(extra)) vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  return global.LAB;
}
module.exports = { loadSim, ROOT };
