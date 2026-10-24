/* Analisis puro de corridas y barridos registrados (C12-C15). Recibe objetos de dominio, nunca la telemetria viva:
 * lo que se analiza o se imprime es lo que quedo registrado, no el estado accidental del simulador (T30). */
(function () {
  'use strict';
  LAB.core = LAB.core || {};
  const COLS = () => LAB.core.RUN_COLS;
  const MIN_EA_WH = 1;           // por debajo de esta energia de referencia la razon E_B/E_A no significa nada

  const colIndex = (run) => { const m = {}; (run.cols || COLS()).forEach((c, i) => (m[c] = i)); return m; };
  const dayOf = (ms) => { const l = LAB.localTime(ms); return `${l.year}-${String(l.month).padStart(2, '0')}-${String(l.day).padStart(2, '0')}`; };

  /** Razon porcentual null-segura: devuelve {v, note}. Nunca -0.0 ni NaN. */
  function ratioPct(num, den, what) {
    if (!Number.isFinite(num) || !Number.isFinite(den)) return { v: null, note: `No disponible: falta ${what}.` };
    if (den < MIN_EA_WH) return { v: null, note: `No disponible: ${what} es menor que ${MIN_EA_WH} Wh (denominador insuficiente).` };
    let v = (num / den - 1) * 100; if (Math.abs(v) < 0.05) v = 0;
    return { v, note: '' };
  }

  /**
   * Resumen de una corrida: energia por modulo, consumo del seguidor y ganancias, sumando los segmentos
   * (cada puesta a cero abre un segmento nuevo, asi que sumar segmentos no pierde energia).
   */
  LAB.core.runSummary = function (run) {
    const segs = run.segments || [];
    let eA = 0, eB = 0, mot = 0, withData = 0;
    for (const s of segs) {
      if (!s.start || !s.end) continue;
      withData++;
      eA += s.end.eA - s.start.eA; eB += s.end.eB - s.start.eB; mot += s.end.motorWh - s.start.motorWh;
    }
    const idx = colIndex(run), S = run.samples || [];
    const t0 = S.length ? S[0][idx.simMs] : null, t1 = S.length ? S[S.length - 1][idx.simMs] : null;
    const gross = ratioPct(eB, eA, 'la energía del módulo A');
    const net = ratioPct(eB - mot, eA, 'la energía del módulo A');
    return {
      id: run.id, label: run.label || '', status: run.status, n: S.length, segments: segs.length, hasEnergy: withData > 0,
      EA: withData ? eA : null, EB: withData ? eB : null, motorWh: withData ? mot : null,
      grossPct: withData ? gross.v : null, netPct: withData ? net.v : null, grossNote: withData ? gross.note : 'Esta corrida no guardó acumuladores por segmento.', netNote: withData ? net.note : '',
      t0, t1, day: t0 != null ? dayOf(t0) : null,
      altered: LAB.core.runAlterations(run),
    };
  };

  /** Razones por las que una corrida NO debe mezclarse en una comparacion valida (C12). */
  LAB.core.runAlterations = function (run) {
    const out = [];
    const reasons = { reanudacion: 'se detuvo y se reanudó (el reloj pudo avanzar)', salto_de_tiempo: 'hubo un salto del reloj simulado', escenario: 'se aplicó un escenario a mitad de la corrida', energia_a_cero: 'se pusieron a cero los contadores a mitad de la corrida' };
    (run.segments || []).forEach((s, i) => { if (i > 0 && reasons[s.reason] && !out.includes(reasons[s.reason])) out.push(reasons[s.reason]); });
    const idx = colIndex(run);
    if ((run.samples || []).some((r) => r[idx.safety] && r[idx.safety] !== 'NORMAL')) out.push('el sistema de seguridad intervino (paro, viento o enlace)');
    if (run.status === 'limit') out.push('llegó al límite de muestras');
    if (run.status === 'stopped' && (run.events || []).some((e) => /paro|e-stop|emergencia/i.test(e.text))) out.push('se interrumpió por paro de emergencia');
    return out;
  };

  /** Condiciones comunes que definen "mismo escenario": las que deben coincidir para comparar estrategias. */
  LAB.core.runConditions = function (run) {
    const s0 = (run.segments || [])[0], c = s0 && s0.ctx ? s0.ctx : {}, idx = colIndex(run), S = run.samples || [];
    const t0 = S.length ? S[0][idx.simMs] : null;
    return {
      profileId: run.profileId || null, scenarioId: c.scenarioId != null ? c.scenarioId : (run.scenario ? run.scenario.id : null), seed: c.seed != null ? c.seed : run.seed,
      day: t0 != null ? dayOf(t0) : null, startSimMs: t0, cloud: c.cloud != null ? c.cloud : null, windBase: c.windBase != null ? c.windBase : null,
      speed: c.speed != null ? c.speed : null,
      // diferencias deliberadas (variable de estudio):
      trackerMode: c.trackerMode || null, lockAz: !!c.lockAz, lockTilt: !!c.lockTilt,
    };
  };

  /** Compara corridas: lista lo que difiere en las condiciones comunes (=> experimentos distintos) y lo deliberado. */
  LAB.core.compareRuns = function (runs) {
    const conds = runs.map(LAB.core.runConditions), common = ['scenarioId', 'seed', 'day', 'cloud', 'windBase'], names = { scenarioId: 'escenario', seed: 'semilla', day: 'fecha simulada', cloud: 'nubes', windBase: 'viento medio' };
    const differs = []; common.forEach((k) => { if (new Set(conds.map((c) => String(c[k]))).size > 1) differs.push(names[k]); });
    const varied = []; if (new Set(conds.map((c) => c.trackerMode)).size > 1) varied.push('modo de seguimiento');
    if (new Set(conds.map((c) => `${c.lockAz}/${c.lockTilt}`)).size > 1) varied.push('eje inmovilizado');
    const altered = runs.map((r) => ({ id: r.id, reasons: LAB.core.runAlterations(r) })).filter((a) => a.reasons.length);
    return { conds, differs, varied, altered, comparable: differs.length === 0 && altered.length === 0 && runs.length >= 2 };
  };

  /** Anotaciones de una corrida para la grafica: eventos, cambios de segmento, de modo de carga/seguimiento y de estado de seguridad. */
  LAB.core.runAnnotations = function (run) {
    const idx = colIndex(run), S = run.samples || [], out = [];
    (run.segments || []).forEach((s) => { if (s.reason !== 'inicio') out.push({ n: s.firstSample, kind: 'segmento', text: `Segmento ${s.id}: ${s.reason.replace(/_/g, ' ')}` }); });
    let prev = null;
    S.forEach((r) => {
      const cur = { tr: r[idx.trMode], ld: r[idx.loadMode], sf: r[idx.safety] };
      if (prev) {
        if (cur.ld !== prev.ld) out.push({ n: r[idx.n], kind: 'carga', text: `Carga: ${prev.ld} → ${cur.ld}` });
        if (cur.tr !== prev.tr) out.push({ n: r[idx.n], kind: 'seguimiento', text: `Seguimiento: ${prev.tr} → ${cur.tr}` });
        if (cur.sf !== prev.sf) out.push({ n: r[idx.n], kind: 'seguridad', text: `Seguridad: ${prev.sf} → ${cur.sf}` });
      }
      prev = cur;
    });
    (run.events || []).forEach((e) => { if (e.type !== 'segmento' && e.type !== 'adquisicion') out.push({ n: e.n, kind: e.type, text: e.text }); });
    return out.sort((a, b) => a.n - b.n);
  };

  /** Series de una corrida listas para graficar. Parte las lineas en los saltos del reloj y en cambios de segmento (no se unen). */
  LAB.core.runSeries = function (run) {
    const idx = colIndex(run), S = run.samples || [], names = ['simMs', 'gA', 'gB', 'pA', 'pB', 'vA', 'iA', 'vB', 'iB', 'tcA', 'tcB', 'ta', 'wind', 'azB', 'tiltB'];
    const o = {}; names.forEach((k) => (o[k] = new Array(S.length)));
    S.forEach((r, i) => names.forEach((k) => { o[k][i] = r[idx[k]]; }));
    o.seg = S.map((r) => r[idx.segmentId]);
    return o;
  };

  /** CSV de una seleccion de muestras [i0,i1] de una corrida (misma estructura que la corrida completa). */
  LAB.core.runSliceCsv = function (run, i0, i1) {
    const sub = { ...run, samples: run.samples.slice(i0, i1 + 1), events: (run.events || []).filter((e) => e.n >= run.samples[i0][0] && e.n <= run.samples[i1][0]), label: (run.label || '') + ` [muestras ${i0}-${i1}]` };
    return LAB.core.runToCsv(sub);
  };

  /** Barridos: condiciones por barrido y diferencias entre dos (C14). */
  LAB.core.sweepConditionDiffs = function (a, b) {
    const d = [];
    const g = (s) => s.cond && s.cond.start ? s.cond.start : null, x = g(a), y = g(b);
    if (!x || !y) return ['No hay condiciones guardadas en uno de los barridos.'];
    if (Math.abs(x.gA - y.gA) > 0.1 * Math.max(x.gA, y.gA, 50)) d.push(`irradiancia G_A ${x.gA.toFixed(0)} vs ${y.gA.toFixed(0)} W/m²`);
    if (Math.abs(x.gB - y.gB) > 0.1 * Math.max(x.gB, y.gB, 50)) d.push(`irradiancia G_B ${x.gB.toFixed(0)} vs ${y.gB.toFixed(0)} W/m²`);
    if (Math.abs(x.tA - y.tA) > 3) d.push(`temperatura de celda A ${x.tA.toFixed(1)} vs ${y.tA.toFixed(1)} °C`);
    return d;
  };
  LAB.core.ratioPct = ratioPct;
})();
