/* S2 y S3: transposicion Hay-Davies y IAM de Martin-Ruiz contra 200 vectores generados por pvlib. */
const { T } = require('./lib/harness.js');
const { loadSim } = require('./lib/loadsim.js');
const LAB = loadSim();
const t = new T('POA vs pvlib');
const S = LAB.sim.solar, cfg = LAB.config;
const D2R = Math.PI / 180;
let wC = 0, wI = 0, wG = 0, wB = 0, wAoi = 0, wIb = 0, wIs = 0, wIg = 0;
for (const v of LAB.data.pvlib.poacheck) {
  const el = 90 - v.zen;
  const sv = S.sunVector(v.saz, el), n = S.normalVector(v.az, v.tilt);
  const p = S.poa({ ghi: v.ghi, dni: v.dni, dhi: v.dhi, e0: v.e0 }, sv, n, v.tilt, cfg.site.albedo);
  wAoi = Math.max(wAoi, Math.abs(p.aoi - Math.min(v.aoi, 90)) * (v.aoi < 89.9 ? 1 : 0));
  wB = Math.max(wB, Math.abs(p.raw.beam - v.dni * Math.max(0, Math.cos(v.aoi * D2R))));
  wC = Math.max(wC, Math.abs(p.raw.circ - v.circ)); wI = Math.max(wI, Math.abs(p.raw.iso - v.iso)); wG = Math.max(wG, Math.abs(p.raw.ground - v.ground));
  const ib = v.aoi >= 90 ? 0 : v.iamBeam;
  wIb = Math.max(wIb, Math.abs(p.iamBeam - ib));
  wIs = Math.max(wIs, Math.abs(p.iamSky - v.iamSky)); wIg = Math.max(wIg, Math.abs(p.iamGround - v.iamGround));
}
t.ok('Hay-Davies circunsolar |Δ| ≤ 0.5 W/m² (200 vectores)', wC <= 0.5, wC.toExponential(2));
t.ok('Hay-Davies isotropica |Δ| ≤ 0.5 W/m²', wI <= 0.5, wI.toExponential(2));
t.ok('suelo |Δ| ≤ 0.5 W/m²', wG <= 0.5, wG.toExponential(2));
t.ok('haz |Δ| ≤ 0.5 W/m²', wB <= 0.5, wB.toExponential(2));
t.ok('ángulo de incidencia coincide (≤ 0.01°)', wAoi <= 0.01, wAoi.toExponential(2));
t.ok('IAM haz |Δ| ≤ 1e-4', wIb <= 1e-4, wIb.toExponential(2));
t.ok('IAM cielo |Δ| ≤ 1e-4', wIs <= 1e-4, wIs.toExponential(2));
t.ok('IAM suelo |Δ| ≤ 1e-4', wIg <= 1e-4, wIg.toExponential(2));
// barrido de IAM: theta 0..89, beta 0..90
const pyiam = (th) => (1 - Math.exp(-Math.cos(th * D2R) / 0.16)) / (1 - Math.exp(-1 / 0.16));
let wTh = 0; for (let th = 0; th <= 89; th++) wTh = Math.max(wTh, Math.abs(S.iam(Math.cos(th * D2R)) - pyiam(th)));
t.ok('IAM(θ) 0°..89° sigue la expresion de pvlib (1e-12)', wTh < 1e-12, wTh.toExponential(2));
t.ok('IAM(0°) = 1 y IAM(≥90°) = 0', Math.abs(S.iam(1) - 1) < 1e-12 && S.iam(0) === 0 && S.iam(-0.2) === 0);
let mono = true; for (let b = 1; b < 90; b++) { const a = S.iamDiffuse(b), c = S.iamDiffuse(b + 1); if (!(a.sky > 0 && a.sky < 1 && a.ground > 0 && a.ground < 1)) mono = false; }
t.ok('IAM difuso entre 0 y 1 para β 1°..90°', mono);
t.ok('E0 Spencer: ~1412 en enero y ~1322 en julio', S.extraRadiation(3) > 1405 && S.extraRadiation(3) < 1420 && S.extraRadiation(185) > 1315 && S.extraRadiation(185) < 1330, `${S.extraRadiation(3).toFixed(1)} / ${S.extraRadiation(185).toFixed(1)}`);
t.done();
