/* Las afirmaciones numéricas de la guía de prácticas contra el motor del simulador (sin navegador).
 * Si cambia el modelo (nubes, sensores, módulo, ruido), el texto de la guía deja de ser cierto: esta prueba lo detecta.
 * Ejecutar: node tools/test_guide_claims.js   (código de salida distinto de cero si algo falla) */
const { T } = require('./lib/harness.js');
const { loadSim } = require('./lib/loadsim.js');
const LAB = loadSim();
const t = new T('Afirmaciones numéricas de la guía contra el motor');

const mk = () => { const e = new LAB.sim.Engine(); e.send({ type: 'session.start', role: 'student', user: 'Ana', profileId: LAB.core.store.profileId('student', 'Ana') }); return e; };
const rec = (sw) => { const pa = sw.pts.A.reduce((m, p) => (p.p > m.p ? p : m), { p: 0, v: 0, i: 0 }); return { Pmax: pa.p, G: (sw.cond.start.gA + sw.cond.end.gA) / 2, Voc: Math.max(...sw.pts.A.map((p) => p.v)), Isc: Math.max(...sw.pts.A.map((p) => p.i)) }; };
const sweep = (e) => { e.send({ type: 'load.sweep' }); for (let i = 0; i < 400; i++) e.step(0.1); return rec(e.sweeps[e.sweeps.length - 1]); };
const area = LAB.config.module.area;
const stats = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); return { m, sd, cv: sd / m * 100 }; };
const setup = (h, m, cloud, mode = 'astro') => { const e = mk(); e.send({ type: 'sim.time', ms: LAB.fromLocal(2026, 10, 23, h, m) }); e.send({ type: 'sim.cloud', value: cloud }); e.send({ type: 'sim.speed', speed: 1 }); e.send({ type: 'tracker.mode', mode }); e.send({ type: 'load.set', mode: 'mppt' }); for (let i = 0; i < 1500; i++) e.step(0.1); return e; };

// ---------------------------------------------------------------- P1: dos barridos con nubes 10 % y 60 %
{
  const e = setup(11, 30, 0.1); const a = sweep(e);
  e.send({ type: 'sim.cloud', value: 0.6 }); for (let i = 0; i < 1500; i++) e.step(0.1); const b = sweep(e);
  const d = (x, y) => (y / x - 1) * 100, ff = (s) => s.Pmax / (s.Voc * s.Isc), eta = (s) => s.Pmax / (s.G * area) * 100, kg = (s) => s.Isc / s.G * 1000;
  t.ok('P1 el segundo barrido tiene al menos 15 % menos de irradiancia (condición del paso «nubes»)', d(a.G, b.G) <= -15, d(a.G, b.G).toFixed(1));
  t.ok('P1 Isc/G es casi igual en los dos barridos (≤ 3 %) y ronda 13.0 mA por W/m²', Math.abs(kg(b) / kg(a) - 1) < 0.03 && Math.abs(kg(a) - 13.0) < 0.4 && Math.abs(kg(b) - 13.0) < 0.4, `${kg(a).toFixed(3)} ${kg(b).toFixed(3)}`);
  t.ok('P1 Voc casi no cambia (< 1 %) y ronda 46 V', Math.abs(d(a.Voc, b.Voc)) < 1 && a.Voc > 44 && a.Voc < 48, `${a.Voc.toFixed(2)} ${b.Voc.toFixed(2)}`);
  t.ok('P1 Pmax cae casi como G (a menos de 6 puntos) y η cambia poco (< 8 %)', Math.abs(d(a.Pmax, b.Pmax) - d(a.G, b.G)) < 6 && Math.abs(d(eta(a), eta(b))) < 8, `${d(a.Pmax, b.Pmax).toFixed(1)} vs ${d(a.G, b.G).toFixed(1)}; η ${eta(a).toFixed(2)} → ${eta(b).toFixed(2)}`);
  t.ok('P1 «FF cercano a 0.75 y η cercana a 18 %»: FF en 0.70–0.80 y η en 16–20 %', ff(a) > 0.70 && ff(a) < 0.80 && eta(a) > 16 && eta(a) < 20, `${ff(a).toFixed(3)} ${eta(a).toFixed(2)}`);
}

// ---------------------------------------------------------------- P2: razón P_B/P_A, ventana de 10 s y ley del coseno
{
  const e = setup(11, 0, 0.05, 'manual'); e.send({ type: 'tracker.target', az: 180, tilt: 17 });
  const r = Math.PI / 180, cosA = (sa, se, az, tl) => Math.sin(se * r) * Math.cos(tl * r) + Math.cos(se * r) * Math.sin(tl * r) * Math.cos((sa - az) * r);
  const pose = (az, tilt) => { e.send({ type: 'tracker.target', az, tilt }); for (let i = 0; i < 1500; i++) e.step(0.1); const w = []; for (let i = 0; i < 100; i++) { e.step(0.1); if (i % 5 === 4) w.push(e.telemetry.B.p / e.telemetry.A.p); } const s = stats(w); return { ratio: s.m, sd: s.sd, sunAz: e.telemetry.sun.az, sunEl: e.telemetry.sun.el }; };
  const base = pose(180, 17), f = LAB.config.fixed;
  t.ok('P2 la línea base P_B/P_A es ≈ 1 (± 1 %) y la desviación de la ventana de 10 s es pequeña (< 1 %)', Math.abs(base.ratio - 1) < 0.01 && base.sd < 0.01, `${base.ratio.toFixed(4)} σ=${base.sd.toFixed(4)}`);
  t.ok('P2 el Sol de las 11:00 está cerca de 150–160° de azimut (como dice la observación esperada)', base.sunAz > 145 && base.sunAz < 165, base.sunAz.toFixed(0));
  const rows = [[120, 17], [150, 17], [210, 17], [240, 17], [180, 0], [180, 40], [180, 60], [150, 30]].map(([az, tl]) => { const p = pose(az, tl); return { az, tl, pr: p.ratio / base.ratio, cr: cosA(p.sunAz, p.sunEl, az, tl) / cosA(p.sunAz, p.sunEl, f.az, f.tilt) }; });
  t.ok('P2 el cociente de cos θ se parece al de potencias (≤ 0.07) y la potencia real no queda por debajo del coseno (texto de la referencia)', rows.every((x) => x.pr - x.cr > -0.012 && x.pr - x.cr < 0.07), rows.map((x) => `${x.az}/${x.tl}: ${x.pr.toFixed(3)} vs ${x.cr.toFixed(3)}`).join(' · '));
  const best = rows.reduce((m, x) => (x.pr > m.pr ? x : m)); t.ok('P2 el mejor punto está cerca del azimut del Sol (150°)', best.az === 150, `${best.az}/${best.tl}`);
}

// ---------------------------------------------------------------- P3: cuatro corridas (despejado y nublado)
{
  const BASE = { y: 2026, mo: 10, d: 23, seed: 20261023 };
  const run = (kind, cloud) => {
    const e = mk(), k = { astro: ['astro', false, false], one: ['astro', false, true], sensor: ['sensor', false, false] }[kind];
    const r = e.send({ type: 'scenario.apply', scenario: { id: 'x', simMs: LAB.fromLocal(BASE.y, BASE.mo, BASE.d, 7, 0), cloud, windBase: 3.2, seed: BASE.seed, az: 180, tilt: 17, speed: 600 } }); if (!r.ok) throw new Error(JSON.stringify(r));
    e.send({ type: 'tracker.locks', lockAz: k[1], lockTilt: k[2] }); e.send({ type: 'tracker.mode', mode: k[0] });
    let ns = 0, last = e.simMs;
    for (let i = 0; i < 300000; i++) {
      e.step(0.1); const x = e.telemetry, dts = (x.simMs - last) / 1000; last = x.simMs;
      if (x.local.hours < 17.5 && x.tracker.sensor && x.tracker.sensor.state === 'NO_SIGNAL') ns += dts;
      if (x.local.hours >= 17.5) return { EA: x.A.wh, EB: x.B.wh, mot: x.tracker.motorWh, gain: (x.B.wh / x.A.wh - 1) * 100, nsMin: ns / 60, state: x.safety.state };
    }
    throw new Error('la corrida no terminó');
  };
  const c = { astro: run('astro', 0.1), sensor: run('sensor', 0.1), one: run('one', 0.1) }, n = { astro: run('astro', 0.6), sensor: run('sensor', 0.6) };
  t.ok('P3 ninguna corrida pasa por una condición de seguridad (si no, no contaría)', [...Object.values(c), ...Object.values(n)].every((x) => x.state === 'NORMAL'));
  t.ok('P3 con cielo despejado el seguimiento de dos ejes gana entre 25 y 40 %', c.astro.gain > 25 && c.astro.gain < 40, c.astro.gain.toFixed(1));
  t.ok('P3 con 60 % de nubes la ganancia es positiva pero mucho menor (menos de la mitad)', n.astro.gain > 2 && n.astro.gain < c.astro.gain / 2, `${n.astro.gain.toFixed(1)} vs ${c.astro.gain.toFixed(1)}`);
  t.ok('P3 un solo eje (solo azimut) gana menos que dos ejes pero algo («no despreciable»)', c.one.gain > 3 && c.one.gain < c.astro.gain, c.one.gain.toFixed(1));
  t.ok('P3 los sensores entregan casi la misma energía que el astronómico (≤ 1 %) en los dos cielos: es lo que dice la referencia', Math.abs(c.sensor.EB / c.astro.EB - 1) < 0.01 && Math.abs(n.sensor.EB / n.astro.EB - 1) < 0.01, `${c.sensor.EB.toFixed(0)}/${c.astro.EB.toFixed(0)} y ${n.sensor.EB.toFixed(0)}/${n.astro.EB.toFixed(0)}`);
  t.ok('P3 con nubes el sensor pasa muchos minutos sin señal; despejado, pocos', n.sensor.nsMin > 60 && c.sensor.nsMin < 15, `${n.sensor.nsMin.toFixed(0)} y ${c.sensor.nsMin.toFixed(0)}`);
  t.ok('P3 el consumo de los motores es pequeño frente a la ganancia en energía', c.astro.mot < 0.1 * (c.astro.EB - c.astro.EA) && n.astro.mot < 0.25 * (n.astro.EB - n.astro.EA), `${c.astro.mot.toFixed(1)} Wh`);
}

// ---------------------------------------------------------------- P4: repetibilidad de barridos consecutivos
{
  const e = setup(11, 30, 0.1); const R = []; for (let k = 0; k < 5; k++) R.push(sweep(e));
  const s = stats(R.map((x) => x.Pmax)), s3 = stats(R.slice(0, 3).map((x) => x.Pmax));
  t.ok('P4 los barridos consecutivos quedan dentro de ±3 % de irradiancia (se cuentan como válidos)', R.every((x) => Math.abs(x.G / R[0].G - 1) <= 0.03), R.map((x) => x.G.toFixed(0)).join(' '));
  t.ok('P4 la repetibilidad de Pmax es de décimas de porciento (CV entre 0.05 y 1.5 %), muy por debajo del 5 % supuesto del piranómetro', s.cv > 0.05 && s.cv < 1.5 && s3.cv < 1.5, `${s.cv.toFixed(2)} % (3: ${s3.cv.toFixed(2)} %)`);
}
t.done();
