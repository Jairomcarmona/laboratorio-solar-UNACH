/* S1: el modelo de un diodo del navegador contra pvlib.singlediode (tabla ivcheck generada por tools/gen_pvlib_data.py),
 * criterios de aceptacion de la especificacion y consistencia de LAB.config con server/contract/v1/physics.json (fuente unica). */
const fs = require('fs'), path = require('path');
const { T } = require('./lib/harness.js');
const { loadSim, ROOT } = require('./lib/loadsim.js');
const LAB = loadSim();
const t = new T('Diodo vs pvlib');
const pv = LAB.data.pvlib, PV = LAB.sim.pv;

let worst = { p: 0, v: 0, i: 0 };
for (const r of pv.ivcheck) {
  const c = PV.curve(r.g, r.t, 90);
  worst.p = Math.max(worst.p, Math.abs(c.pmp / r.pmp - 1)); worst.v = Math.max(worst.v, Math.abs(c.voc / r.voc - 1)); worst.i = Math.max(worst.i, Math.abs(c.isc / r.isc - 1));
}
t.ok('|ΔPmp| ≤ 0.2 % en 28 puntos G×T', worst.p <= 0.002, `peor ${(worst.p * 100).toFixed(4)} %`);
t.ok('|ΔVoc| ≤ 0.1 %', worst.v <= 0.001, `peor ${(worst.v * 100).toFixed(4)} %`);
t.ok('|ΔIsc| ≤ 0.1 %', worst.i <= 0.001, `peor ${(worst.i * 100).toFixed(4)} %`);

const c25 = PV.curve(1000, 25, 90), c45 = PV.curve(1000, 45, 90), c200 = PV.curve(200, 25, 90);
t.ok('Pmp(1000, 25 °C) = 500 W ± 0.5 %', Math.abs(c25.pmp / 500 - 1) <= 0.005, c25.pmp.toFixed(2));
const beta = (c45.voc / c25.voc - 1) / 20 * 100, gamma = (c45.pmp / c25.pmp - 1) / 20 * 100;
t.ok('β_Voc = −0.26 ± 0.01 %/K', Math.abs(beta + 0.26) <= 0.01, beta.toFixed(4));
t.ok('γ_Pmp = −0.30 ± 0.02 %/K', Math.abs(gamma + 0.30) <= 0.02, gamma.toFixed(4));
const eff = (c200.pmp / 200) / (c25.pmp / 1000);
t.ok('eficiencia relativa a 200 W/m² ≥ 0.97', eff >= 0.97, eff.toFixed(4));
t.ok('el ajuste usa 66 celdas y EgRef = 1.121 eV', pv.sdm.cellsEff === 66 && Math.abs(pv.sdm.EgRef - 1.121) < 1e-9);

// fuente unica de parametros: config.js debe coincidir con physics.json (nadie copia numeros a mano)
const phys = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'server/contract/v1/physics.json'), 'utf8'));
const cf = LAB.config;
t.ok('thermal de config.js = physics.json', ['u0', 'u1', 'C', 'deltaT'].every((k) => cf.thermal[k] === phys.thermal[k]), JSON.stringify(phys.thermal).slice(0, 80));
t.ok('IAM a_r y albedo de config.js = physics.json', cf.module.iamAr === phys.iam.ar && cf.site.albedo === phys.albedo.value);
t.ok('sensores de config.js = physics.json', ['poaA', 'poaB'].every((k) => ['type', 'epsCal', 'alpha', 'noise'].every((f) => cf.sensors[k][f] === phys.sensors[k][f])));
t.ok('sdm de physics.json = data/pvlib_tuxtla.js', phys.sdm.IL === pv.sdm.IL && phys.sdm.Rs === pv.sdm.Rs);
t.done();
