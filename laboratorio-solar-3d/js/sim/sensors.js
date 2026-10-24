/* Sensor de irradiancia del plano (S5). La irradiancia VERDADERA en el plano (poaTrue, con IAM, la que ve el modulo)
 * no es lo que mide el instrumento: una celda de referencia tiene su propia calibracion, deriva con la temperatura y ruido;
 * un piranometro mide la irradiancia sin IAM del modulo. Parametros en LAB.config.sensors (PROVISIONALES sin hoja de datos).
 *
 *   G_med = G_efectiva * (1 + eps_cal) * (1 + alpha_s * (Tsens - 25)) * (1 + noise * ruido)        (celda de referencia)
 *   G_med = G_sin_IAM  * (1 + eps_cal) * (1 + noise * ruido)                                         (piranometro)
 */
(function () {
  'use strict';
  const T_SENS_REF = 25;

  /** comp: resultado de LAB.sim.solar.poa(); cfgSensor: {type, epsCal, alpha, noise}; tSens: C; noise: ruido unitario */
  function poaSensor(comp, cfgSensor, tSens, noise) {
    const c = cfgSensor || { type: 'refcell', epsCal: 0, alpha: 0, noise: 0 };
    const ruido = 1 + (c.noise != null ? c.noise : 0.004) * (noise || 0);
    const cal = 1 + (c.epsCal || 0);
    if (c.type === 'pyranometer') {
      const raw = comp.raw || { beam: comp.beam, circ: 0, iso: comp.sky, ground: comp.ground };
      return Math.max(0, (raw.beam + raw.circ + raw.iso + raw.ground) * cal * ruido);
    }
    return Math.max(0, comp.total * cal * (1 + (c.alpha || 0) * (tSens - T_SENS_REF)) * ruido);
  }

  LAB.sim.sensors = { poaSensor };
})();
