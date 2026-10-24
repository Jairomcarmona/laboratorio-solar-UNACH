/* Practicas guiadas. Cada practica es un conjunto de DATOS (pasos con id estable, condiciones, ayudas y preguntas).
 * El estado de una practica (PS) es serializable y se guarda por perfil (js/core/store.js):
 *   PS = { practiceId, defVersion, status, steps{id:true}, answers{id:{draft,submitted,submittedAtUtc}}, evidence{}, closure, ... }
 * Reglas (C03-C06):
 *   - ocultar la guia NO abandona la practica; reiniciar es una accion explicita
 *   - escribir solo guarda un borrador; la respuesta se registra con "Guardar respuesta y continuar"
 *   - requisitos operativos, preguntas obligatorias y pasos opcionales se cuentan por separado
 *   - al completar se congela una copia de la evidencia: el reporte no cambia si el simulador sigue corriendo */
(function () {
  'use strict';
  const { fmt, pad2, esc } = LAB.util;
  const $ = (s) => document.querySelector(s);
  const ui = LAB.ui;
  const store = LAB.core.store;
  const MIN_ANSWER = 10;           // caracteres (sin espacios sobrantes) para registrar una respuesta

  let app, source, send, tel;
  let current = null;              // definicion de la practica activa
  let ps = null;                   // estado de la practica activa
  let E = {};                      // evidencia (ps.evidence)
  let profile = { id: null, user: null, role: null, sessionId: null };
  let progress = null;             // {practices:{}, activePractice}
  let guideOpen = false;
  let guideMin = false;
  let saveTimer = 0;
  let built = null;                // referencias a los nodos de la guia (se construye una vez por practica)
  let acc = 0;
  let lastOpener = null;

  // ---------------------------------------------------------------- utilidades de las practicas
  const lt = () => tel.local;
  const setTime = (h, m = 0) => { const l = lt(); return send({ type: 'sim.time', ms: LAB.fromLocal(l.year, l.month, l.day, h, m) }); };
  const canOperate = () => !!(tel && tel.safety.session.active && tel.safety.role && tel.safety.role.canOperate);
  const settled = () => !tel.tracker.moving.az && !tel.tracker.moving.tilt;
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const has = (arr, x) => Array.isArray(arr) && arr.includes(x);
  const add = (arr, x) => { if (!arr.includes(x)) arr.push(x); };
  /** Motivo por el que hoy un comando de operacion se rechazaria ('' = se aceptaria). Se revisa antes de preparar nada. */
  const guard = () => (tel.safety.blockReason || (tel.safety.canOperate ? '' : 'El banco no acepta comandos ahora.'));
  const guarded = (fn) => () => { const why = guard(); if (why) { ui.toast('No se puede hacer ahora: ' + why, 'warn', 6000); return; } fn(); };

  const sessionStep = {
    id: 'session',
    text: 'Inicia una sesión de demostración como Estudiante o Docente para poder operar el banco simulado.',
    why: 'En el laboratorio real el acceso exige autenticación y una reserva; aquí el rol es solo local. Sin sesión, el interlock rechaza todos los comandos.',
    check: () => canOperate(),
    assist: { label: 'Abrir inicio de sesión', run: () => ui.openLogin && ui.openLogin() },
  };

  // ---------------------------------------------------------------- escenario comparable de la practica 3 (C12)
  const P3_SCENARIO = { id: 'p3-claro-v1', y: 2026, mo: 10, d: 23, startH: 7, startM: 0, endHours: 17.5, cloud: 0.1, windBase: 3.2, seed: 20261023, az: 180, tilt: 17, speed: 600 };
  const p3Scenario = () => ({ id: P3_SCENARIO.id, simMs: LAB.fromLocal(P3_SCENARIO.y, P3_SCENARIO.mo, P3_SCENARIO.d, P3_SCENARIO.startH, P3_SCENARIO.startM), cloud: P3_SCENARIO.cloud, windBase: P3_SCENARIO.windBase, seed: P3_SCENARIO.seed, az: P3_SCENARIO.az, tilt: P3_SCENARIO.tilt, speed: P3_SCENARIO.speed });
  const P3_KINDS = {
    astro: { label: 'Astronómico · 2 ejes', mode: 'astro', lockAz: false, lockTilt: false },
    'astro-1eje': { label: 'Astronómico · 1 eje (solo azimut)', mode: 'astro', lockAz: false, lockTilt: true },
    sensor: { label: 'Sensores · 2 ejes', mode: 'sensor', lockAz: false, lockTilt: false },
  };
  function p3Prepare(kind) {
    const why = guard(); if (why) { ui.toast('No se puede preparar la corrida: ' + why, 'warn', 6500); return; }
    const k = P3_KINDS[kind];
    if (E.cur) p3Interrupt('se preparó otra corrida');
    const r = send({ type: 'scenario.apply', scenario: p3Scenario() });
    if (!r.ok) return;
    send({ type: 'tracker.locks', lockAz: k.lockAz, lockTilt: k.lockTilt });
    send({ type: 'tracker.mode', mode: k.mode });
    E.pending = { kind, label: k.label, mode: k.mode, lockAz: k.lockAz, lockTilt: k.lockTilt, scenarioId: P3_SCENARIO.id };
    ui.toast(`Escenario "${P3_SCENARIO.id}" aplicado (23/10/2026 07:00, nubes 10 %, viento 3.2 m/s, semilla ${P3_SCENARIO.seed}). Deja correr hasta las 17:30.`, 'ok', 6500);
  }
  function p3Interrupt(cause) {
    if (!E.cur) return;
    E.runs.push({ kind: E.cur.kind, label: E.cur.label, status: 'interrupted', cause, startSimMs: E.cur.startSimMs, endSimMs: tel.simMs, scenarioId: E.cur.scenarioId, seed: E.cur.seed });
    E.cur = null; ui.toast(`Corrida interrumpida: ${cause}. No cuenta para la comparación; prepárala de nuevo.`, 'warn', 7000);
  }
  function p3Tick() {
    const T = tel.tracker, l = lt();
    if (E.pending && tel.settings.scenarioId === E.pending.scenarioId && Math.abs(tel.energy.startedSimMs - tel.simMs) < 120000 && T.requestedMode === E.pending.mode) {
      E.cur = { ...E.pending, startSimMs: tel.simMs, lastSim: tel.simMs, resets: tel.energy.resets, cloud: tel.settings.cloud, windBase: tel.settings.windBase, seed: tel.settings.seed, day: l.day };
      E.pending = null;
    }
    const c = E.cur; if (!c) return;
    let cause = '';
    if (!tel.safety.session.active) cause = 'se cerró la sesión';
    else if (tel.settings.scenarioId !== c.scenarioId) cause = 'se cambió o reaplicó el escenario';
    else if (tel.energy.resets !== c.resets) cause = 'se puso la energía a cero a mitad de la corrida';
    else if (tel.simMs < c.lastSim - 1000 || tel.simMs - c.lastSim > 40 * 60000) cause = 'se saltó el reloj solar';
    else if (T.requestedMode !== c.mode || T.lockAz !== c.lockAz || T.lockTilt !== c.lockTilt) cause = 'cambió el modo o los ejes del seguidor';
    else if (Math.abs(tel.settings.cloud - c.cloud) > 0.001 || Math.abs(tel.settings.windBase - c.windBase) > 0.001) cause = 'se modificó la nubosidad o el viento medio';
    else if (tel.settings.seed !== c.seed) cause = 'se cambió la semilla';
    else if (tel.load.mode !== 'mppt') cause = 'se cambió el modo de carga';
    else if (tel.safety.state !== 'NORMAL') cause = 'hubo una condición de seguridad (' + tel.safety.state + ')';
    else if (l.day !== c.day) cause = 'cambió el día simulado';
    if (cause) { p3Interrupt(cause); return; }
    c.lastSim = tel.simMs;
    if (l.hours >= P3_SCENARIO.endHours) {
      const EA = tel.A.wh, EB = tel.B.wh, mot = T.motorWh;
      E.runs = E.runs.filter((r) => !(r.kind === c.kind && r.status === 'complete'));
      E.runs.push({ kind: c.kind, label: c.label, status: 'complete', startSimMs: c.startSimMs, endSimMs: tel.simMs, EA, EB, motor: mot, gainPct: EA >= 1 ? (EB / EA - 1) * 100 : null, netPct: EA >= 1 ? ((EB - mot) / EA - 1) * 100 : null, cloud: c.cloud, windBase: c.windBase, scenarioId: c.scenarioId, seed: c.seed });
      E.cur = null; ui.toast(`Corrida registrada: ${c.label}.`, 'ok'); ui.announce(`Corrida registrada: ${c.label}`);
    }
  }
  const pct = (v) => (v == null ? 'No disponible' : (v >= 0 ? '+' : '') + fmt(v, 1) + ' %');

  // ---------------------------------------------------------------- definiciones
  const PART_VIEW = { pyr: 'station', anemo: 'station', shield: 'station', rain: 'station', cabinet: 'cabinet', estop: 'cabinet', load: 'load', moduleA: 'moduleA', moduleB: 'moduleB' };
  const PRACTICES = [
    {
      id: 'p1', n: 1, version: 2, title: 'Caracterización eléctrica de un módulo', dur: '≈ 10 min (real: 60–90 min)',
      goal: 'Obtener la curva I‑V/P‑V de un módulo fotovoltaico y localizar su punto de máxima potencia.',
      ilos: ['Interpretar las variables eléctricas y ambientales de un módulo.', 'Explicar el efecto de irradiancia, temperatura y carga.', 'Calcular potencia y energía a partir de datos.', 'Identificar la región de máxima potencia.', 'Comunicar resultados con gráficas y conclusiones.'],
      setup() { setTime(11, 30); send({ type: 'sim.cloud', value: 0.1 }); send({ type: 'sim.speed', speed: 1 }); send({ type: 'tracker.mode', mode: 'astro' }); send({ type: 'load.set', mode: 'mppt' }); app.rig.set('general'); ui.markViews('general'); },
      fresh: () => ({ parts: [], cams: {}, cond: null, ocT: 0, scT: 0, voc: null, isc: null, sweep: null, sweeps: 0, ivViewed: false }),
      steps: [
        sessionStep,
        {
          id: 'cond',
          text: 'Revisa las condiciones: abre el piranómetro y el anemómetro (clic en sus etiquetas) y confirma que la irradiancia en el plano del módulo A (POA) supera 600 W/m² y que el viento es menor que 8 m/s.',
          why: 'Una curva I‑V solo es comparable si la irradiancia es estable y suficiente. La POA es la irradiancia sobre el plano inclinado del módulo (distinta de la GHI horizontal).',
          parts: ['pyr', 'anemo'],
          status: () => `Ahora: POA A = ${fmt(tel.A.poa, 0)} W/m² (necesitas > 600) · viento = ${fmt(tel.env.wind, 1)} m/s (necesitas < 8)`,
          check: () => has(E.parts, 'pyr') && has(E.parts, 'anemo') && tel.A.poa > 600 && tel.env.wind < 8,
          warn: () => (has(E.parts, 'pyr') && has(E.parts, 'anemo') && !(tel.A.poa > 600 && tel.env.wind < 8) ? 'Las fichas están abiertas pero las condiciones no se cumplen: aumenta la hora hacia el mediodía o reduce nubes y viento.' : ''),
        },
        {
          id: 'cam1',
          text: 'Verifica el banco con la cámara IP 1: pulsa "Cámara 1", observa y luego sal de la cámara (botón "Salir de la cámara") para volver a la vista general.',
          why: 'Antes de operar se confirma por imagen que el banco está libre y en condición segura. Cuenta la entrada y la salida de la cámara.',
          status: () => `Entrada: ${E.cams.cam1 && E.cams.cam1.entered ? '✓' : '○'} · Salida: ${E.cams.cam1 && E.cams.cam1.exited ? '✓' : '○'}`,
          check: () => !!(E.cams.cam1 && E.cams.cam1.entered && E.cams.cam1.exited),
          assist: { label: 'Ver cámara 1', run: () => document.getElementById('btnCam1').click() },
        },
        {
          id: 'oc',
          text: 'Pon la carga en CIRCUITO ABIERTO durante al menos 3 s y observa Voc de cada módulo.',
          why: 'Voc es la tensión máxima: la corriente es cero y no hay potencia.',
          status: () => `Circuito abierto estable: ${fmt(Math.min(E.ocT, 3), 1)} / 3 s`,
          check: () => E.ocT >= 3,
          assist: { label: 'Poner circuito abierto', run: guarded(() => send({ type: 'load.set', mode: 'oc' })) },
        },
        {
          id: 'sc',
          text: 'Pasa a CORTOCIRCUITO controlado durante al menos 3 s y observa Isc.',
          why: 'Isc es la corriente máxima: la tensión es cero y tampoco hay potencia.',
          status: () => `Cortocircuito estable: ${fmt(Math.min(E.scT, 3), 1)} / 3 s`,
          check: () => E.scT >= 3,
          assist: { label: 'Poner cortocircuito', run: guarded(() => send({ type: 'load.set', mode: 'sc' })) },
        },
        {
          id: 'sweep',
          text: 'Lanza el barrido I‑V automático (10 s) y espera a que termine completo.',
          why: 'La carga recorre la tensión de 0 a Voc y registra I en cada punto. La irradiancia debe permanecer constante. Un barrido interrumpido no cuenta.',
          status: () => (tel.load.sweeping ? `Barriendo… ${fmt(tel.load.sweepT, 0)} / 10 s` : (E.sweep ? 'Barrido completo registrado.' : 'Aún no hay un barrido completo.')),
          check: () => !!E.sweep,
          assist: { label: 'Iniciar barrido', run: guarded(() => send({ type: 'load.sweep' })) },
        },
        {
          id: 'mpp',
          text: 'Abre la pestaña I‑V / P‑V y localiza el punto de máxima potencia (◆).',
          why: 'El MPP está en la "rodilla" de la curva: allí el producto V·I es máximo. La curva punteada es la calculada ahora; los puntos son el barrido registrado.',
          check: () => !!E.sweep && E.ivViewed,
          assist: { label: 'Mostrar I‑V', run: () => document.querySelector('#chartTabs [data-tab=iv]').click() },
          question: {
            id: 'p1q1', text: '¿A qué fracción de Voc (Vmp/Voc) está el punto de máxima potencia y por qué la potencia es cero en Voc e Isc?',
            ref: () => { const A = tel.A; return `Vmp/Voc ≈ ${fmt(A.vmp / A.voc, 2)} (Vmp ${fmt(A.vmp, 1)} V, Voc ${fmt(A.voc, 1)} V, valores calculados ahora). En Voc I = 0 y en Isc V = 0, así que P = V·I = 0. Factor de forma FF = Pmp/(Voc·Isc) ≈ ${fmt(A.pmp / (A.voc * A.isc), 2)}.`; },
          },
        },
        {
          id: 'opt-nubes', optional: true,
          text: 'Opcional: cambia las nubes a 60 % y repite el barrido. ¿Cómo cambian Isc, Voc y Pmax?',
          why: 'Isc crece casi linealmente con la irradiancia; Voc solo varía de forma logarítmica y baja con la temperatura.',
          check: () => E.sweeps >= 2,
        },
      ],
      tick(dt) {
        if (tel.load.mode === 'oc' && !tel.load.sweeping && tel.safety.state === 'NORMAL') E.ocT += dt; else if (tel.load.mode !== 'oc') E.ocT = 0;
        if (tel.load.mode === 'sc' && !tel.load.sweeping && tel.safety.state === 'NORMAL') E.scT += dt; else if (tel.load.mode !== 'sc') E.scT = 0;
        if (E.ocT >= 3 && E.voc == null) E.voc = { A: tel.A.v, B: tel.B.v, G: tel.A.poa, T: tel.A.tcell };
        if (E.scT >= 3 && E.isc == null) E.isc = { A: tel.A.i, B: tel.B.i };
      },
      onSweep(sw) {
        if (sw.status !== 'complete') { ui.toast(`Barrido interrumpido (${sw.cause}). Se conservaron ${sw.pts.A.length} puntos, pero no cuenta: repítelo.`, 'warn', 7000); return; }
        const pa = sw.pts.A.reduce((m, p) => (p.p > m.p ? p : m), { p: 0, v: 0, i: 0 });
        E.sweep = { id: sw.id, Pmax: pa.p, Vmp: pa.v, Imp: pa.i, G: (sw.cond.start.gA + sw.cond.end.gA) / 2, T: sw.cond.start.tA, Voc: Math.max(...sw.pts.A.map((p) => p.v)), Isc: Math.max(...sw.pts.A.map((p) => p.i)) };
        E.sweeps = (E.sweeps || 0) + 1;
      },
      report(D) {
        const s = D.sweep;
        const L = ['## Datos medidos (módulo A, simulados)'];
        if (D.voc) L.push(`- Circuito abierto: Voc A = ${fmt(D.voc.A, 1)} V, Voc B = ${fmt(D.voc.B, 1)} V (POA = ${fmt(D.voc.G, 0)} W/m², T celda = ${fmt(D.voc.T, 1)} °C)`);
        if (D.isc) L.push(`- Cortocircuito: Isc A = ${fmt(D.isc.A, 2)} A, Isc B = ${fmt(D.isc.B, 2)} A`);
        if (s) {
          const ff = s.Pmax / (s.Voc * s.Isc);
          const eta = s.Pmax / (s.G * LAB.config.module.area) * 100;
          L.push(`- Barrido I‑V (${s.id}): Pmax = ${fmt(s.Pmax, 0)} W en Vmp = ${fmt(s.Vmp, 1)} V, Imp = ${fmt(s.Imp, 2)} A`);
          L.push(`- Factor de forma FF = Pmax/(Voc·Isc) = ${fmt(ff, 3)}`, `- Eficiencia del módulo = Pmax/(POA·A) = ${fmt(eta, 1)} % (POA = ${fmt(s.G, 0)} W/m², A = ${fmt(LAB.config.module.area, 2)} m²)`);
        } else L.push('- Barrido I‑V: no completado.');
        return L;
      },
    },

    {
      id: 'p2', n: 2, version: 2, title: 'Efecto de la orientación', dur: '≈ 12 min (real: 60–90 min)',
      goal: 'Cuantificar cuánta potencia se gana o se pierde al cambiar el azimut y la inclinación, comparando el módulo móvil con el fijo.',
      ilos: ['Relacionar la geometría solar con la orientación del módulo.', 'Operar un posicionador remoto dentro de límites seguros.', 'Comparar simultáneamente un sistema fijo y uno orientable.', 'Cuantificar pérdidas o ganancias por orientación.', 'Distinguir variaciones geométricas de las ambientales.'],
      setup() { setTime(11, 0); send({ type: 'sim.cloud', value: 0.05 }); send({ type: 'sim.speed', speed: 1 }); send({ type: 'tracker.locks', lockAz: false, lockTilt: false }); send({ type: 'tracker.mode', mode: 'manual' }); send({ type: 'load.set', mode: 'mppt' }); send({ type: 'tracker.target', az: 180, tilt: 17 }); document.querySelector('#chartTabs [data-tab=power]').click(); },
      fresh: () => ({ ack1: false, points: {}, hold: 0, astroPoint: null }),
      steps: [
        sessionStep,
        {
          id: 'sun',
          text: 'Anota la posición del Sol (barra superior: elevación y azimut). ¿Hacia dónde conviene orientar el módulo B?',
          why: 'Un módulo capta más cuando su normal apunta al Sol: azimut ≈ azimut solar e inclinación ≈ ángulo cenital.',
          check: () => E.ack1, manual: 'Ya la anoté',
        },
        {
          id: 'base',
          text: 'Calibra el par: deja el módulo B igual que A (azimut 180°, inclinación 17°) con carga MPPT y espera a que se estabilice.',
          why: 'Dos módulos "idénticos" nunca lo son del todo. Con la misma orientación, la razón P_B/P_A es tu línea base y se usa para corregir el resto.',
          status: () => holdStatus(),
          check: () => !!E.points['180|17'],
          assist: { label: 'Mover B a 180° / 17°', run: guarded(() => send({ type: 'tracker.target', az: 180, tilt: 17 })) },
        },
        {
          id: 'az',
          text: 'Barrido de AZIMUT: con la inclinación en 17°, coloca B en al menos 4 azimuts distintos (p. ej. 120°, 150°, 210°, 240°) esperando en cada uno hasta que el punto quede registrado.',
          why: 'La tabla de abajo se llena sola cuando el seguidor se detiene y la potencia se mantiene estable durante 5 s.',
          status: () => holdStatus(`${azPoints().length} / 4 azimuts`),
          check: () => azPoints().length >= 4 && spread(azPoints().map((p) => p.az)) >= 60,
          assist: { label: 'Siguiente azimut', run: guarded(() => nextOf('az')) },
          warn: () => (tel.tracker.lockAz ? 'El azimut está inmovilizado (modo "Solo inclinación"): elige "Dos ejes" o "Solo azimut" en el panel Seguidor.' : ''),
        },
        {
          id: 'tilt',
          text: 'Barrido de INCLINACIÓN: con el azimut en 180°, prueba al menos 4 inclinaciones (0°, 20°, 40°, 60°, 80°).',
          why: 'Mide cuánto pesa la inclinación frente al azimut para esta fecha y latitud.',
          status: () => holdStatus(`${tiltPoints().length} / 4 inclinaciones`),
          check: () => tiltPoints().length >= 4 && spread(tiltPoints().map((p) => p.tilt)) >= 50,
          assist: { label: 'Siguiente inclinación', run: guarded(() => nextOf('tilt')) },
          warn: () => (tel.tracker.lockTilt ? 'La inclinación está inmovilizada (modo "Solo azimut"): elige "Dos ejes" o "Solo inclinación" en el panel Seguidor.' : ''),
        },
        {
          id: 'astro',
          text: 'Apunta B directamente al Sol (modo Astronómico) y espera a que quede registrado el punto para compararlo con tu mejor punto manual.',
          why: 'Es el "máximo teórico" del sistema de dos ejes para esta hora.',
          status: () => holdStatus(),
          check: () => !!E.astroPoint,
          assist: { label: 'Activar astronómico', run: guarded(() => send({ type: 'tracker.mode', mode: 'astro' })) },
          question: {
            id: 'p2q1', text: '¿En qué orientación fue máxima la razón P_B/P_A y cómo se compara con la posición del Sol? ¿Qué parte de la diferencia podría deberse al ambiente y no a la geometría?',
            ref: () => { const best = bestPoint(E); return `Mejor punto manual: ${best ? `${best.az}°/${best.tilt}° con ${fmt(best.ratio, 3)}×` : '—'}. Sol: azimut ${fmt(tel.sun.az, 0)}°, cenit ${fmt(tel.sun.zenith, 0)}°. Como A y B se miden a la vez, el viento, la temperatura y las nubes afectan a ambos por igual; por eso se usa la razón y no la potencia absoluta.`; },
          },
        },
      ],
      tick(dt) {
        const T = tel.tracker;
        if (T.appliedMode !== 'manual' && T.appliedMode !== 'astro') { E.hold = 0; return; }
        if (!settled() || tel.load.mode !== 'mppt' || tel.A.p < 40 || tel.safety.state !== 'NORMAL') { E.hold = 0; return; }
        E.hold += dt;
        if (E.hold >= 5) {
          const az = Math.round(T.az), tilt = Math.round(T.tilt);
          if (T.appliedMode === 'astro') E.astroPoint = { az, tilt, ratio: tel.B.p / tel.A.p };
          else E.points[`${az}|${tilt}`] = { az, tilt, ratio: tel.B.p / tel.A.p, pA: tel.A.p, pB: tel.B.p, G: tel.B.poa };
          E.hold = -9999;
        }
        if (T.moving.az || T.moving.tilt) E.hold = 0;
      },
      extra(D) {
        const rows = Object.values(D.points).sort((a, b) => a.az - b.az || a.tilt - b.tilt);
        if (!rows.length) return '';
        return `<table class="mini"><caption class="sr">Posiciones registradas</caption><tr><th scope="col">Az</th><th scope="col">Incl</th><th scope="col">P_A</th><th scope="col">P_B</th><th scope="col">P_B/P_A</th></tr>${rows.map((r) => `<tr><td>${r.az}°</td><td>${r.tilt}°</td><td>${fmt(r.pA, 0)}</td><td>${fmt(r.pB, 0)}</td><td><b>${fmt(r.ratio, 3)}</b></td></tr>`).join('')}</table>`;
      },
      report(D) {
        const rows = Object.values(D.points).sort((a, b) => a.az - b.az || a.tilt - b.tilt);
        const L = ['## Tabla de posiciones (simulada)', '| Azimut | Inclinación | P_A (W) | P_B (W) | POA plano B | P_B/P_A |', '|---|---|---|---|---|---|'];
        rows.forEach((r) => L.push(`| ${r.az}° | ${r.tilt}° | ${fmt(r.pA, 0)} | ${fmt(r.pB, 0)} | ${fmt(r.G, 0)} | ${fmt(r.ratio, 3)} |`));
        const base = D.points['180|17']; const best = bestPoint(D);
        if (base) L.push('', `Línea base (misma orientación): P_B/P_A = ${fmt(base.ratio, 3)}`);
        if (best && base) L.push(`Mejor orientación manual: ${best.az}°/${best.tilt}° con ${fmt(best.ratio, 3)}×; ganancia corregida por la línea base: ${fmt((best.ratio / base.ratio - 1) * 100, 1)} %`);
        if (D.astroPoint) L.push(`Seguimiento astronómico: ${D.astroPoint.az}°/${D.astroPoint.tilt}° → ${fmt(D.astroPoint.ratio, 3)}×`);
        if (D.sunAtClose) L.push(`Posición solar al cierre: azimut ${fmt(D.sunAtClose.az, 0)}°, elevación ${fmt(D.sunAtClose.el, 0)}°`);
        return L;
      },
    },

    {
      id: 'p3', n: 3, version: 2, title: 'Fijo contra estrategias de seguimiento', dur: '≈ 6 min (real: horas)',
      goal: 'Comparar la energía diaria de un módulo fijo con distintas estrategias de seguimiento, en un escenario idéntico, y valorar la ganancia frente a la complejidad y el consumo auxiliar.',
      ilos: ['Diferenciar estrategias de seguimiento solar.', 'Interpretar series temporales de irradiancia, posición y potencia.', 'Calcular y comparar energía acumulada.', 'Analizar el compromiso entre ganancia y complejidad.', 'Sustentar una decisión técnica con datos.'],
      setup() { /* cada corrida aplica su propio escenario */ },
      fresh: () => ({ runs: [], pending: null, cur: null }),
      steps: [
        sessionStep,
        {
          id: 'r-astro',
          text: 'CORRIDA 1: seguimiento astronómico de dos ejes. Pulsa "Preparar corrida" (aplica el escenario común: 23/10/2026 07:00, nubes 10 %, viento 3.2 m/s, semilla fija, energía en cero, ×600) y deja correr hasta las 17:30.',
          why: 'El módulo A fijo es la referencia. La energía se integra en Wh. Las tres corridas usan exactamente el mismo escenario, así que sus diferencias se deben solo a la estrategia.',
          status: () => runStatus('astro'),
          check: () => hasRun('astro'),
          assist: { label: 'Preparar corrida (dos ejes)', run: () => p3Prepare('astro') },
        },
        {
          id: 'r-1eje',
          text: 'CORRIDA 2: un solo eje (inclinación inmovilizada en 17°, solo azimut). Mismo escenario.',
          why: 'Un eje es más barato y fiable; ¿cuánta de la ganancia conserva?',
          status: () => runStatus('astro-1eje'),
          check: () => hasRun('astro-1eje'),
          assist: { label: 'Preparar corrida (un eje)', run: () => p3Prepare('astro-1eje') },
        },
        {
          id: 'r-sensor',
          text: 'CORRIDA 3: seguimiento por sensores en el mismo escenario (nubes 10 %).',
          why: 'Los sensores se "pierden" cuando la irradiancia directa cae: observa el estado del sensor. Se usa el mismo cielo para que la comparación sea válida.',
          status: () => runStatus('sensor'),
          check: () => hasRun('sensor'),
          assist: { label: 'Preparar corrida (sensores)', run: () => p3Prepare('sensor') },
          question: {
            id: 'p3q1', text: 'Considerando la ganancia neta (restando el consumo de los motores), ¿qué estrategia recomendarías para una instalación en Chiapas y por qué? Menciona complejidad y mantenimiento.',
            ref: () => { const r = E.runs.filter((x) => x.status === 'complete'); return r.length ? r.map((x) => `${x.label}: ganancia de energía ${pct(x.gainPct)}, neta ${pct(x.netPct)}`).join(' · ') + '. El consumo de motores es pequeño frente a la ganancia, pero cada eje añade piezas móviles, mantenimiento y riesgo ante viento fuerte.' : 'Aún no hay corridas completas.'; },
          },
        },
      ],
      tick() { p3Tick(); },
      extra(D) {
        if (!D.runs.length && !D.cur) return '<p class="hint">Cuando una corrida llegue a las 17:30 se registra aquí automáticamente. Las interrumpidas también aparecen, marcadas, y no cuentan.</p>';
        const rows = D.runs.map((r) => (r.status === 'complete'
          ? `<tr><td>${esc(r.label)}</td><td>${fmt(r.EA, 0)}</td><td>${fmt(r.EB, 0)}</td><td>${fmt(r.motor, 1)}</td><td><b>${pct(r.gainPct)}</b></td><td>${pct(r.netPct)}</td></tr>`
          : `<tr class="bad"><td>${esc(r.label)}</td><td colspan="5">Interrumpida: ${esc(r.cause)}</td></tr>`)).join('');
        const cur = D.cur ? `<p class="hint">En curso: ${esc(D.cur.label)}.</p>` : '';
        return `${cur}<table class="mini"><caption class="sr">Corridas del día simulado</caption><tr><th scope="col">Estrategia</th><th scope="col">E_A (Wh)</th><th scope="col">E_B (Wh)</th><th scope="col">Motores (Wh)</th><th scope="col">Ganancia de energía</th><th scope="col">Neta</th></tr>${rows}</table>`;
      },
      report(D) {
        const L = ['## Corridas del día simulado (escenario común)', `Escenario: ${P3_SCENARIO.id}, 23/10/2026 07:00–17:30, nubes ${P3_SCENARIO.cloud * 100} %, viento medio ${P3_SCENARIO.windBase} m/s, semilla ${P3_SCENARIO.seed}.`, '',
          '| Estrategia | Estado | E_A (Wh) | E_B (Wh) | Motores (Wh) | Ganancia de energía E_B/E_A−1 | Ganancia neta |', '|---|---|---|---|---|---|---|'];
        D.runs.forEach((r) => L.push(r.status === 'complete' ? `| ${r.label} | completa | ${fmt(r.EA, 0)} | ${fmt(r.EB, 0)} | ${fmt(r.motor, 1)} | ${pct(r.gainPct)} | ${pct(r.netPct)} |` : `| ${r.label} | interrumpida (${r.cause}) | — | — | — | No disponible | No disponible |`));
        return L;
      },
    },

    {
      id: 'p4', n: 4, version: 2, title: 'Operación segura y calidad de datos', dur: '≈ 10 min (real: 45–60 min)',
      goal: 'Entender cómo se protege un laboratorio remoto: enclavamientos, watchdog, posición segura y bitácora, y evaluar la confiabilidad de los datos.',
      ilos: ['Describir la arquitectura funcional del laboratorio.', 'Interpretar eventos y registros de una sesión.', 'Reconocer el papel de límites, permisos, watchdog e interlocks.', 'Identificar fuentes de error en los datos.', 'Proponer mejoras de operación o documentación.'],
      setup() { setTime(12, 0); send({ type: 'sim.cloud', value: 0.15 }); send({ type: 'sim.wind', value: 3 }); send({ type: 'sim.speed', speed: 1 }); send({ type: 'tracker.mode', mode: 'manual' }); app.rig.set('general'); ui.markViews('general'); },
      fresh: () => ({ parts: [], cams: {}, windStow: false, watchdog: false, reconnected: false, estopPressed: false, estopReset: false, logOpened: false, csv: null, rejectedRange: false }),
      steps: [
        sessionStep,
        {
          id: 'parts',
          text: 'Reconoce el banco: abre las fichas del gabinete de control, del anemómetro y del paro local (clic en sus etiquetas).',
          why: 'Los límites críticos viven en el gabinete local; el anemómetro alimenta la decisión de posición segura.',
          parts: ['cabinet', 'anemo', 'estop'],
          check: () => ['cabinet', 'anemo', 'estop'].every((p) => has(E.parts, p)),
        },
        {
          id: 'move',
          text: 'Ejecuta una orden autorizada: mueve B a 150° / 30°, espera a que llegue y contrasta con la cámara IP 2 (entra y sal de la cámara).',
          why: 'La telemetría dice dónde "cree" estar el seguidor; la cámara es la comprobación independiente.',
          status: () => `Posición ${fmt(tel.B.az, 0)}°/${fmt(tel.B.tilt, 0)}° · cámara 2: entrada ${E.cams.cam2 && E.cams.cam2.entered ? '✓' : '○'}, salida ${E.cams.cam2 && E.cams.cam2.exited ? '✓' : '○'}`,
          check: () => !!(E.cams.cam2 && E.cams.cam2.entered && E.cams.cam2.exited) && near(tel.B.az, 150, 2) && near(tel.B.tilt, 30, 2),
          assist: { label: 'Mover y abrir cámara 2', run: guarded(() => { send({ type: 'tracker.target', az: 150, tilt: 30 }); document.getElementById('btnCam2').click(); }) },
        },
        {
          id: 'range',
          text: 'Intenta un comando fuera de rango (azimut 20°). Observa que el interlock lo rechaza y queda en la bitácora.',
          why: 'El cliente web nunca es la última defensa: el controlador local vuelve a validar cada comando. El rango autorizado es 90°–270°.',
          check: () => E.rejectedRange,
          assist: { label: 'Enviar azimut 20°', run: guarded(() => send({ type: 'tracker.target', az: 20 })) },
        },
        {
          id: 'gust',
          text: 'Provoca una ráfaga (botón "Ráfaga") y observa cómo el sistema lleva el seguidor a posición segura por sí solo.',
          why: 'El umbral de protección (14 m/s) vive en el controlador y no se puede modificar. La ráfaga es solo un parámetro didáctico del simulador: no cambia el viento medio.',
          check: () => E.windStow,
          assist: { label: 'Generar ráfaga (20 m/s, 16 s)', run: guarded(() => send({ type: 'sim.gust', peak: 20, seconds: 16 })) },
        },
        {
          id: 'comms',
          text: 'Corta el enlace (botón "Cortar enlace"), espera al watchdog y luego restablece el enlace y reconoce la falla.',
          why: 'Si el operador desaparece con el seguidor en movimiento, el watchdog lo lleva a posición segura.',
          status: () => (tel.safety.commsCut ? `Enlace cortado: watchdog en ${fmt(LAB.config.safety.commsTimeoutS - tel.safety.commsAge, 0)} s` : (E.watchdog ? 'Watchdog disparado: restablece el enlace y reconoce la falla.' : '')),
          check: () => E.watchdog && E.reconnected,
          assist: { label: 'Cortar enlace', run: () => send({ type: 'sim.comms', connected: false }) },
        },
        {
          id: 'estop',
          text: 'Acciona el paro de emergencia (en la etiqueta del gabinete o con el botón rojo) y restablécelo con "Simular intervención del técnico".',
          why: 'El paro corta motores y carga; en el banco real solo se rearma en sitio, nunca desde la web. Aquí la intervención del técnico es simulada.',
          check: () => E.estopPressed && E.estopReset,
          assist: { label: 'Accionar paro', run: () => send({ type: 'safety.estop', who: 'Práctica 4' }) },
        },
        {
          id: 'log',
          text: 'Revisa la bitácora (botón "Bitácora") y descarga los datos de la corrida (CSV). Para que haya datos, inicia la adquisición unos segundos antes.',
          why: 'Cada comando, alarma y evento queda con hora: es la evidencia de la sesión. El CSV solo se cuenta si realmente contiene muestras.',
          status: () => `Bitácora: ${E.logOpened ? '✓' : '○'} · CSV con muestras: ${E.csv ? '✓ (' + E.csv.rows + ' filas)' : '○'}`,
          check: () => E.logOpened && !!E.csv && E.csv.rows > 0,
          assist: { label: 'Abrir bitácora', run: () => ui.openLog && ui.openLog() },
          question: {
            id: 'p4q1', text: 'Menciona dos fuentes de error o pérdida de calidad en los datos de este laboratorio (por ejemplo: sincronización, calibración, latencia, ruido, suciedad) y una mejora para cada una.',
            ref: () => `Ejemplos: (1) Desajuste de los sensores de irradiancia → calibración periódica y jornada de referencia A=B. (2) Latencia del enlace (${fmt(tel.comms.latency, 0)} ms ahora) → estampas de tiempo en el origen y NTP. (3) Suciedad en un módulo → limpieza programada y comparación con el piranómetro.`,
          },
        },
      ],
      tick() {
        if (tel.safety.state === 'WIND_STOW') E.windStow = true;
        if (tel.safety.watchdog) E.watchdog = true;
        if (E.watchdog && !tel.safety.watchdog && !tel.safety.commsCut) E.reconnected = true;
        if (tel.safety.estop) E.estopPressed = true;
        if (E.estopPressed && !tel.safety.estop) E.estopReset = true;
      },
      onLog(e) { if (e.src === 'Interlock' && /rango/i.test(e.msg)) E.rejectedRange = true; },
      report(D) {
        return ['## Eventos de seguridad observados', `- Posición segura por viento: ${D.windStow ? 'sí' : 'no'}`, `- Watchdog de enlace: ${D.watchdog ? 'disparado' : 'no'}; reconocimiento: ${D.reconnected ? 'sí' : 'no'}`,
          `- Paro de emergencia accionado: ${D.estopPressed ? 'sí' : 'no'}; restablecido (intervención del técnico simulada): ${D.estopReset ? 'sí' : 'no'}`, `- Comando fuera de rango rechazado: ${D.rejectedRange ? 'sí' : 'no'}`,
          `- CSV exportado: ${D.csv ? D.csv.rows + ' filas (corrida ' + D.csv.runId + ')' : 'no'}`];
      },
    },
  ];

  // ---------------------------------------------------------------- objetivo / observación esperada / evidencia / pistas (C16)
  // Las pistas son graduales: la primera orienta, la segunda dice dónde mirar. Nunca contienen la respuesta de la pregunta.
  const STEP_META = {
    session: { expect: 'La barra superior muestra tu nombre y rol; los controles del banco se habilitan.', evidence: 'Sesión activa con identidad de demostración.', hints: ['Pulsa el botón de acceso y elige Estudiante o Docente.', 'El rol Visitante solo observa y no puede operar.'] },
    cond: { expect: 'POA mayor que 600 W/m² y viento menor que 8 m/s; si no, cambia la hora o las nubes.', evidence: 'POA, viento y hora quedan guardados con la práctica.', hints: ['Los valores de G y viento están en la tarjeta de ambiente y en las etiquetas 3D.', 'Haz clic en la etiqueta «Piranómetro» y en «Anemómetro y veleta» para abrir sus fichas.'] },
    cam1: { expect: 'La imagen de la cámara muestra el banco libre y los módulos en posición.', evidence: 'Se registra la entrada y la salida de la cámara.', hints: ['El botón «Cámara 1» está en la barra de vistas.', 'Para salir usa «Salir de la cámara» o la tecla Escape.'] },
    oc: { expect: 'Corriente ≈ 0 A, potencia ≈ 0 W y tensión máxima (Voc, alrededor de 40 V por módulo).', evidence: 'Voc de A y B tras ≥ 3 s en circuito abierto.', hints: ['Panel «Carga CC»: modo Circuito abierto.', 'Espera 3 s para que la lectura se estabilice antes de leer.'] },
    sc: { expect: 'Tensión ≈ 0 V, potencia ≈ 0 W y corriente máxima (Isc, un poco mayor que la de operación).', evidence: 'Isc de A y B tras ≥ 3 s en cortocircuito controlado.', hints: ['Panel «Carga CC»: modo Cortocircuito.', 'La corriente de cortocircuito es proporcional a la irradiancia.'] },
    sweep: { expect: 'La gráfica I‑V se llena de puntos de 0 V a Voc y la barra de progreso llega al final.', evidence: 'Barrido completo guardado con sus condiciones (irradiancia, temperatura).', hints: ['Botón «Barrido I‑V» en el panel de carga.', 'No cambies nubes, hora ni modo mientras corre: el barrido se interrumpe y no cuenta.'] },
    mpp: { expect: 'El rombo ◆ está en la rodilla de la curva, donde la curva P‑V alcanza su máximo.', evidence: 'Se registra que abriste la pestaña I‑V / P‑V.', hints: ['La pestaña es «I‑V / P‑V» del panel de datos.', 'Busca el máximo de la curva punteada (potencia).'] },
    'opt-nubes': { expect: 'Isc y Pmax bajan mucho; Voc casi no cambia.', evidence: 'Segundo barrido con condiciones distintas, guardado aparte.', hints: ['Usa el deslizador de nubes.', 'Compara los dos barridos en el panel de barridos de la pestaña I‑V.'] },
    sun: { expect: 'El azimut solar cambia con la hora; la elevación sube hacia el mediodía.', evidence: 'Posición solar registrada al consultarla.', hints: ['La barra superior muestra elevación y azimut.', 'Piensa hacia dónde debería mirar la normal del módulo.'] },
    base: { expect: 'P_B/P_A cercano a 1.00 pero no exacto: esa diferencia es tu línea base.', evidence: 'Razón de línea base con la misma orientación.', hints: ['Pon B en azimut 180° e inclinación 17° (botón «Lat. 17°»).', 'Deja el modo de carga en MPPT y espera unos segundos.'] },
    az: { expect: 'La razón P_B/P_A sube cuando B se acerca al azimut del Sol y baja al alejarse.', evidence: 'Cuatro o más puntos de azimut en la tabla.', hints: ['Usa el deslizador de azimut o la orden numérica.', 'El punto se registra solo cuando el seguidor se detiene y la potencia es estable 5 s.'] },
    tilt: { expect: 'Hay una inclinación intermedia donde la razón es máxima.', evidence: 'Cuatro o más puntos de inclinación en la tabla.', hints: ['Mantén el azimut en 180°.', 'Prueba extremos (0° y 80°) y valores intermedios.'] },
    astro: { expect: 'La razón del punto astronómico iguala o supera a tu mejor punto manual.', evidence: 'Punto en modo Astronómico en la tabla.', hints: ['Modo de control «Astronómico».', 'Espera a que el seguidor termine de moverse.'] },
    'r-astro': { expect: 'E_B mayor que E_A al final del día; la gráfica «Día» muestra a B por encima de A.', evidence: 'Corrida completa de 07:00 a 17:30 con E_A, E_B, motores y ganancias.', hints: ['Pulsa «Preparar corrida (dos ejes)»: aplica el escenario común.', 'Deja correr el reloj a ×600 sin saltar la hora.'] },
    'r-1eje': { expect: 'Ganancia menor que con dos ejes, pero no despreciable.', evidence: 'Corrida del mismo escenario con el eje de inclinación inmovilizado.', hints: ['Pulsa «Preparar corrida (un eje)».', 'Las corridas con salto de reloj o paro de emergencia no cuentan.'] },
    'r-sensor': { expect: 'El seguimiento por sensores pierde eficacia cuando la irradiancia directa cae.', evidence: 'Corrida del mismo escenario con sensores.', hints: ['Pulsa «Preparar corrida (sensores)».', 'Observa el estado del sensor en el panel del seguidor.'] },
    parts: { expect: 'Cada ficha explica función y estado del componente.', evidence: 'Fichas abiertas: gabinete, anemómetro, paro local.', hints: ['Las etiquetas 3D son clicables.', 'El botón «Abrir …» del paso te lleva a la siguiente ficha.'] },
    move: { expect: 'La telemetría llega a 150°/30° y la cámara IP 2 muestra el mismo giro.', evidence: 'Posición alcanzada y entrada/salida de la cámara 2.', hints: ['Usa la orden numérica Az/Incl y «Enviar».', 'Espera «En posición» antes de abrir la cámara.'] },
    range: { expect: 'El comando se rechaza con un mensaje y queda en la bitácora; el seguidor no se mueve.', evidence: 'Rechazo registrado en la bitácora.', hints: ['Escribe 20 en Az y pulsa «Enviar».', 'Abre la bitácora para ver el rechazo.'] },
    gust: { expect: 'Con viento ≥ 14 m/s el seguidor va solo a posición segura y se muestra la alarma de viento.', evidence: 'Posición segura por viento registrada.', hints: ['Botón «Ráfaga» del panel de entorno.', 'Observa el estado de seguridad (lámpara ámbar).'] },
    comms: { expect: 'Tras ~6 s sin latido, el watchdog lleva el seguidor a posición segura; al restablecer hay que reconocer la falla.', evidence: 'Disparo del watchdog y reconocimiento.', hints: ['Botón «Cortar enlace».', 'Después usa «Restablecer enlace» y «Reconocer».'] },
    estop: { expect: 'Motores y carga se detienen; el restablecimiento solo ocurre con la intervención simulada del técnico.', evidence: 'Paro accionado y restablecido (simulado).', hints: ['El botón rojo está en el panel de seguridad y en el gabinete 3D.', 'El restablecimiento se llama «Simular intervención del técnico».'] },
    log: { expect: 'La bitácora lista comandos y alarmas con hora; el CSV tiene filas con datos.', evidence: 'CSV descargado con muestras reales.', hints: ['Inicia la adquisición unos segundos antes de descargar.', 'El botón «Descargar CSV» está bajo la gráfica.'] },
  };
  PRACTICES.forEach((pr) => pr.steps.forEach((st) => Object.assign(st, STEP_META[st.id] || {})));

  // ---------------------------------------------------------------- ayudas de las practicas
  const azPoints = () => Object.values(E.points).filter((p) => near(p.tilt, 17, 3));
  const tiltPoints = () => Object.values(E.points).filter((p) => near(p.az, 180, 3));
  const spread = (a) => Math.max(...a) - Math.min(...a);
  const bestPoint = (D) => Object.values(D.points).sort((a, b) => b.ratio - a.ratio)[0];
  const hasRun = (kind) => E.runs.some((r) => r.kind === kind && r.status === 'complete');
  function holdStatus(extra) {
    const T = tel.tracker;
    let s;
    if (T.moving.az || T.moving.tilt) s = 'Esperando estabilización: el seguidor se está moviendo…';
    else if (tel.load.mode !== 'mppt') s = 'Pon la carga en MPPT para registrar puntos.';
    else if (tel.A.p < 40) s = 'Potencia demasiado baja para registrar (necesita > 40 W en A).';
    else if (E.hold < 0) s = 'Punto registrado: mueve el módulo a otra posición.';
    else s = `Esperando estabilización: ${fmt(Math.max(0, E.hold), 0)} / 5 s`;
    return extra ? `${extra} · ${s}` : s;
  }
  function runStatus(kind) {
    if (hasRun(kind)) return 'Corrida completa registrada.';
    const c = E.cur;
    if (c && c.kind === kind) return `En curso: ${fmt(lt().hours, 1)} h de 17.5 h`;
    if (E.pending && E.pending.kind === kind) return 'Escenario aplicado; esperando el primer paso del simulador…';
    const bad = E.runs.filter((r) => r.kind === kind && r.status === 'interrupted').pop();
    return bad ? `Última corrida interrumpida: ${bad.cause}` : 'Sin corrida.';
  }
  function nextOf(axis) {
    const why = guard(); if (why) return;
    send({ type: 'tracker.locks', lockAz: false, lockTilt: false });
    const seq = axis === 'az' ? [120, 150, 210, 240] : [0, 20, 40, 60, 80];
    const have = (axis === 'az' ? azPoints() : tiltPoints()).map((p) => (axis === 'az' ? p.az : p.tilt));
    const next = seq.find((v) => !have.some((h) => near(h, v, 2)));
    const v = next != null ? next : seq[0];
    send(axis === 'az' ? { type: 'tracker.target', az: v, tilt: 17 } : { type: 'tracker.target', az: 180, tilt: v });
  }

  // ---------------------------------------------------------------- estado y persistencia
  const defOf = (id) => PRACTICES.find((p) => p.id === id);
  function freshPS(p) {
    const now = new Date().toISOString();
    return { practiceId: p.id, defVersion: p.version, status: 'in_progress', source: 'sim', createdAtUtc: now, updatedAtUtc: now, sessionId: profile.sessionId, steps: {}, answers: {}, evidence: p.fresh(), closure: null, setupDone: false, runIds: [] };
  }
  function commit(now) {
    clearTimeout(saveTimer);
    const run = () => { if (!progress || !profile.id) return; if (ps) ps.updatedAtUtc = new Date().toISOString(); progress.activePractice = current && ps && ps.status === 'in_progress' ? current.id : progress.activePractice; store.saveProgress(profile.id, progress); renderSaveState(); };
    if (now) run(); else saveTimer = setTimeout(run, 400);
  }
  function renderSaveState() {
    const el = document.getElementById('saveState'); if (!el) return;
    const s = store.status;
    if (!profile.id) { el.textContent = ''; return; }
    if (s.error) { el.className = 'savestate bad'; el.textContent = '⚠ ' + s.error; }
    else if (s.lastSavedAt) { el.className = 'savestate'; el.textContent = 'Guardado en este navegador · ' + new Date(s.lastSavedAt).toLocaleTimeString('es-MX'); }
    else { el.className = 'savestate'; el.textContent = 'Se guarda automáticamente en este navegador.'; }
  }

  function summaryOf(p, st) {
    if (!st) return { text: 'Sin iniciar', cls: '' };
    if (st.status === 'completed_legacy') return { text: 'Completada con el criterio anterior (sin respuestas ni evidencia guardadas)', cls: 'done' };
    const m = metrics(p, st);
    if (st.status === 'completed') return { text: `Completada · ${m.stepsDone}/${m.stepsReq} pasos · ${m.ansDone}/${m.ansReq} respuestas`, cls: 'done' };
    return { text: `En curso · ${m.stepsDone}/${m.stepsReq} pasos · ${m.ansDone}/${m.ansReq} respuestas`, cls: 'cur' };
  }
  function metrics(p, st) {
    const req = p.steps.filter((s) => !s.optional), qs = p.steps.filter((s) => s.question);
    return {
      stepsReq: req.length, stepsDone: req.filter((s) => st.steps && st.steps[s.id]).length,
      ansReq: qs.length, ansDone: qs.filter((s) => st.answers && st.answers[s.question.id] && st.answers[s.question.id].submitted).length,
      optReq: p.steps.length - req.length, optDone: p.steps.filter((s) => s.optional && st.steps && st.steps[s.id]).length,
    };
  }

  // ---------------------------------------------------------------- guia (se construye una vez, se actualiza en sitio)
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (v === true) n.setAttribute(k, ''); else if (v !== false && v != null) n.setAttribute(k, v); }
    kids.flat().forEach((c) => c && n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  };

  function buildGuide() {
    const g = $('#practiceGuide'), p = current;
    g.textContent = '';
    g.setAttribute('role', 'region'); g.setAttribute('aria-label', `Guía de la práctica ${p.n}`);
    const refs = { steps: [] };
    refs.hide = el('button', { class: 'x', type: 'button', 'aria-label': 'Ocultar la guía (la práctica sigue en curso)', title: 'Ocultar la guía: la práctica sigue en curso y puedes reanudarla desde "Prácticas"', text: '×' });
    refs.min = el('button', { class: 'mn', type: 'button', 'aria-label': 'Minimizar o expandir la guía', 'aria-expanded': 'true', title: 'Minimizar / expandir' });
    refs.title = el('h3', { text: `Práctica ${p.n} · ${p.title}` });
    refs.sub = el('div', { class: 'sub', text: p.dur });
    refs.summary = el('div', { class: 'pgsum', 'aria-live': 'off' });
    refs.overview = el('button', { class: 'btn', type: 'button', id: 'btnOverview', text: 'Ver todos los pasos y resultados de aprendizaje' });
    refs.overview.addEventListener('click', () => openOverview());
    refs.bar = el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Progreso de la práctica' }, el('i'));
    const ilos = el('details', {}, el('summary', { text: 'Resultados de aprendizaje' }), el('ul', { class: 'ilos' }, p.ilos.map((x) => el('li', { text: x }))));
    const ol = el('ol', { class: 'steps' });
    p.steps.forEach((s, i) => {
      const r = {};
      r.li = el('li');
      r.c = el('span', { class: 'c', 'aria-hidden': 'true' });
      r.t = el('div', { class: 't' }); r.t.textContent = s.text;
      if (s.optional) r.t.appendChild(el('em', { class: 'opt', text: ' (opcional)' }));
      r.state = el('span', { class: 'sr' });
      r.d = el('div', { class: 'd', text: s.why || '' });
      r.st = el('div', { class: 'pgstatus', 'aria-live': 'off' });
      r.warn = el('div', { class: 'pwarn', role: 'status' });
      r.chips = el('div', { class: 'partchips' });
      r.btns = el('div', { class: 'stepbtns' });
      r.hintBtn = el('button', { class: 'btn', type: 'button', text: 'Necesito una pista' }); r.hintTxt = el('p', { class: 'hint pghint', 'aria-live': 'polite', hidden: true });
      r.hintBtn.addEventListener('click', () => { const h = s.hints || [], k = (ps.hints && ps.hints[s.id]) || 0; if (!h.length) return; ps.hints = ps.hints || {}; ps.hints[s.id] = Math.min(h.length, k + 1); commit(); updateGuide(); });
      r.btns.appendChild(r.hintBtn);
      const body = el('div', { class: 'body' }, r.t, r.state, r.d, r.st, r.warn, r.chips, r.btns, r.hintTxt);
      if (s.parts) { r.partChipEls = s.parts.map((id) => el('span', { text: (LAB.scene.PART_INFO[id] || {}).title || id })); r.partChipEls.forEach((c) => r.chips.appendChild(c)); r.partsBtn = el('button', { class: 'btn', type: 'button' }); r.btns.appendChild(r.partsBtn); r.partsBtn.addEventListener('click', () => openNextPart(s)); }
      if (s.assist) { r.assist = el('button', { class: 'btn', type: 'button', text: s.assist.label }); r.btns.appendChild(r.assist); r.assist.addEventListener('click', () => { if (s.id !== 'session' && !canOperate()) ui.toast('Primero inicia una sesión de Estudiante o Docente para operar.', 'warn'); s.assist.run(); }); }
      if (s.manual) { r.manual = el('button', { class: 'btn', type: 'button', text: s.manual }); r.btns.appendChild(r.manual); r.manual.addEventListener('click', () => { E.ack1 = true; evaluate(true); }); }
      if (s.question) buildQuestion(s.question, r, body);
      r.li.append(r.c, body);
      ol.appendChild(r.li); refs.steps.push(r);
    });
    refs.extra = el('div', { class: 'pgextra' });
    refs.closure = el('div', { class: 'q closure', hidden: true });
    refs.foot = el('div', { class: 'pgfoot' });
    refs.save = el('span', { id: 'saveState', class: 'savestate', role: 'status' });
    refs.restart = el('button', { class: 'btn', type: 'button', text: 'Reiniciar práctica' });
    refs.draft = el('button', { class: 'btn', type: 'button', text: 'Descargar borrador (.md)' });
    refs.draftHtml = el('button', { class: 'btn', type: 'button', id: 'btnDraftHtml', text: 'Ver borrador imprimible' });
    refs.draftHtml.addEventListener('click', () => openReport());
    refs.foot.append(refs.save, el('div', { class: 'row3' }, refs.draftHtml, refs.draft, refs.restart));
    refs.live = el('div', { class: 'sr', 'aria-live': 'polite', id: 'pgLive' });
    g.append(refs.hide, refs.min, refs.title, refs.sub, ilos, refs.summary, refs.overview, refs.bar, ol, refs.extra, refs.closure, refs.foot, refs.live);
    refs.hide.addEventListener('click', () => hideGuide());
    refs.min.addEventListener('click', () => { guideMin = !guideMin; applyMin(); });
    refs.restart.addEventListener('click', () => restart(p.id));
    refs.draft.addEventListener('click', () => download());
    built = refs; applyMin();
  }
  function applyMin() { const g = $('#practiceGuide'); g.classList.toggle('min', guideMin); if (built) { built.min.textContent = guideMin ? '+' : '–'; built.min.setAttribute('aria-expanded', String(!guideMin)); } }

  function buildQuestion(q, r, body) {
    const id = 'ta_' + q.id;
    r.q = {};
    r.q.box = el('div', { class: 'q' });
    r.q.label = el('label', { for: id }, el('b', { text: 'Pregunta obligatoria. ' }), document.createTextNode(q.text));
    r.q.ta = el('textarea', { id, rows: '3', placeholder: 'Escribe tu respuesta (mínimo ' + MIN_ANSWER + ' caracteres) y pulsa "Guardar respuesta y continuar"…', 'aria-describedby': id + '_h', autocomplete: 'off', spellcheck: 'true' });
    r.q.hint = el('div', { class: 'qhint', id: id + '_h', 'aria-live': 'polite' });
    r.q.submit = el('button', { class: 'btn accent', type: 'button', text: 'Guardar respuesta y continuar' });
    r.q.edit = el('button', { class: 'btn', type: 'button', text: 'Editar respuesta', hidden: true });
    r.q.ref = el('button', { class: 'btn', type: 'button', 'aria-expanded': 'false', text: 'Ver respuesta de referencia' });
    r.q.refTxt = el('p', { class: 'hint', hidden: true });
    r.q.box.append(r.q.label, r.q.ta, r.q.hint, el('div', { class: 'report' }, r.q.submit, r.q.edit, r.q.ref), r.q.refTxt);
    body.appendChild(r.q.box);
    r.q.ta.addEventListener('input', () => {                         // solo borrador: no completa nada ni reconstruye el formulario
      const a = answerOf(q.id); a.draft = r.q.ta.value; a.dirty = !!a.submitted && a.draft.trim() !== a.submitted;
      updateQuestion(q, r.q); commit();
    });
    r.q.submit.addEventListener('click', () => {
      const a = answerOf(q.id), t = r.q.ta.value.trim();
      if (t.length < MIN_ANSWER) { r.q.hint.textContent = `La respuesta no puede estar vacía: escribe al menos ${MIN_ANSWER} caracteres.`; r.q.ta.setAttribute('aria-invalid', 'true'); r.q.ta.focus(); return; }
      a.draft = r.q.ta.value; a.submitted = t; a.submittedAtUtc = new Date().toISOString(); a.dirty = false;
      r.q.ta.removeAttribute('aria-invalid'); r.q.ta.readOnly = true;
      ui.announce('Respuesta guardada'); commit(true); evaluate(true);
      r.q.edit.focus();
    });
    r.q.edit.addEventListener('click', () => { if (ps.status === 'completed') { ui.toast('La práctica está cerrada. Reinícala para cambiar la respuesta.', 'info'); return; } r.q.ta.readOnly = false; r.q.ta.focus(); });
    r.q.ref.addEventListener('click', () => {
      const open = r.q.refTxt.hidden; r.q.refTxt.hidden = !open; r.q.ref.setAttribute('aria-expanded', String(open)); r.q.ref.textContent = (open ? 'Ocultar' : 'Ver') + ' respuesta de referencia';
      if (open) r.q.refTxt.textContent = q.ref();
    });
  }
  const answerOf = (qid) => (ps.answers[qid] = ps.answers[qid] || { draft: '', submitted: null, submittedAtUtc: null });
  function updateQuestion(q, rq) {
    const a = ps.answers[q.id] || { draft: '', submitted: null };
    if (document.activeElement !== rq.ta && rq.ta.value !== a.draft) rq.ta.value = a.draft || '';
    const n = rq.ta.value.trim().length;
    const saved = !!a.submitted && !a.dirty;
    rq.ta.readOnly = saved || ps.status === 'completed';
    rq.submit.hidden = saved; rq.edit.hidden = !saved || ps.status === 'completed';
    rq.submit.disabled = ps.status === 'completed';
    if (!rq.ta.getAttribute('aria-invalid') || n >= MIN_ANSWER) {
      rq.hint.textContent = saved ? 'Respuesta registrada ✓' : (a.submitted && a.dirty ? 'Tienes cambios sin guardar en tu respuesta.' : (n ? `Borrador (${n} caracteres): aún no cuenta hasta que la guardes.` : 'Respuesta pendiente.'));
      if (n >= MIN_ANSWER) rq.ta.removeAttribute('aria-invalid');
    }
  }

  function openNextPart(s) {
    const next = s.parts.find((id) => !has(E.parts, id)); if (!next) return;
    const view = PART_VIEW[next]; if (view) { app.rig.set(view); ui.markViews(view); }
    app.handlePart(next);
  }

  function updateGuide() {
    if (!built || !current) return;
    const p = current, m = metrics(p, ps);
    const firstOpen = p.steps.findIndex((s) => !s.optional && !ps.steps[s.id]);
    const total = m.stepsReq + m.ansReq, done = m.stepsDone + m.ansDone;
    built.bar.firstChild.style.width = (total ? done / total * 100 : 0) + '%';
    built.bar.setAttribute('aria-valuenow', String(Math.round(total ? done / total * 100 : 0)));
    const pendingAns = m.ansReq - m.ansDone;
    built.summary.textContent = ps.status === 'completed' ? 'Práctica cerrada. Resultados congelados.' : `${firstOpen >= 0 ? `Paso actual ${firstOpen + 1} de ${p.steps.length}` : 'Pasos operativos completos'} · ${m.stepsDone}/${m.stepsReq} requisitos operativos · ${m.ansDone}/${m.ansReq} respuestas${pendingAns ? ` (${pendingAns} pendiente${pendingAns > 1 ? 's' : ''})` : ''}${m.optReq ? ` · ${m.optDone}/${m.optReq} opcional` : ''}`;
    p.steps.forEach((s, i) => {
      const r = built.steps[i], isDone = !!ps.steps[s.id], isCur = i === firstOpen && ps.status === 'in_progress';
      r.li.className = isDone ? 'ok' : isCur ? 'cur' : '';
      const mark = isDone ? '✓' : String(i + 1);
      if (r.c.textContent !== mark) r.c.textContent = mark;
      r.state.textContent = isDone ? ' (completado)' : isCur ? ' (paso actual)' : '';
      r.d.hidden = !(isCur || isDone);
      const st = (isCur || isDone) && s.status ? s.status() : '';
      if (r.st.textContent !== st) r.st.textContent = st;
      const w = isCur && s.warn ? s.warn() : '';
      if (r.warn.textContent !== (w ? '⚠ ' + w : '')) r.warn.textContent = w ? '⚠ ' + w : '';
      r.warn.hidden = !w;
      if (r.partChipEls) {
        r.chips.hidden = !isCur;
        s.parts.forEach((id, k) => { const on = has(E.parts, id), c = r.partChipEls[k], txt = `${on ? '✓' : '○'} ${(LAB.scene.PART_INFO[id] || {}).title || id}`; if (c.textContent !== txt) { c.textContent = txt; c.className = on ? 'ok' : ''; } });
        const miss = s.parts.find((id) => !has(E.parts, id));
        r.partsBtn.hidden = !isCur || !miss; if (miss) r.partsBtn.textContent = 'Abrir ' + ((LAB.scene.PART_INFO[miss] || {}).title || miss);
      }
      { const h = s.hints || [], k = (ps.hints && ps.hints[s.id]) || 0; r.hintTxt.hidden = !(isCur && k > 0); r.hintTxt.textContent = k ? 'Pista ' + k + ' de ' + h.length + ': ' + h[k - 1] : '';
        r.hintBtn.hidden = !isCur || !h.length || k >= h.length; r.hintBtn.textContent = k ? 'Otra pista' : 'Necesito una pista'; }
      if (r.assist) r.assist.hidden = !isCur;
      if (r.manual) r.manual.hidden = !isCur;
      r.btns.hidden = !Array.from(r.btns.children).some((b) => !b.hidden);
      if (r.q) { r.q.box.hidden = !(isCur || isDone || (s.question && ps.answers[s.question.id])); updateQuestion(s.question, r.q); }
    });
    if (p.extra) { const h = p.extra(E); if (built.extra.dataset.h !== h) { built.extra.innerHTML = h; built.extra.dataset.h = h; } }
    const c = built.closure;
    c.hidden = ps.status !== 'completed' && !(m.stepsDone === m.stepsReq && m.ansDone < m.ansReq);
    if (!c.hidden) {
      if (ps.status === 'completed') {
        if (!c.dataset.done) {
          c.dataset.done = '1'; c.textContent = '';
          const rev = el('button', { class: 'btn accent', type: 'button', id: 'btnReportHtml', text: 'Revisar e imprimir reporte' }), rep = el('button', { class: 'btn', type: 'button', text: 'Descargar reporte (.md)' }), nx = el('button', { class: 'btn', type: 'button', text: 'Siguiente práctica' });
          rev.addEventListener('click', () => openReport()); rep.addEventListener('click', () => download()); nx.addEventListener('click', () => nextPractice());
          c.append(el('b', { class: 'okt', text: '¡Práctica completada! ' }), document.createTextNode('El reporte usa los datos congelados al cerrar.'), el('div', { class: 'report' }, rev, rep, nx));
        }
      } else { delete c.dataset.done; c.textContent = `Los requisitos operativos están completos. Falta registrar ${pendingAns} respuesta${pendingAns > 1 ? 's' : ''} obligatoria${pendingAns > 1 ? 's' : ''} con "Guardar respuesta y continuar".`; }
    } else delete c.dataset.done;
    built.restart.hidden = false;
    renderSaveState();
  }

  function evaluate(force) {
    if (!current || !ps) return;
    let changed = false;
    if (ps.status === 'in_progress') {
      current.steps.forEach((s) => {
        if (!ps.steps[s.id]) {
          let ok = false; try { ok = !!s.check(E); } catch (e) { console.error('check', s.id, e); }
          if (ok) { ps.steps[s.id] = true; changed = true; ui.announce(`Paso completado: ${s.text.slice(0, 60)}`); }
        }
      });
      const m = metrics(current, ps);
      if (m.stepsDone === m.stepsReq && m.ansDone === m.ansReq) closePractice();
    }
    if (changed || force) { commit(); }
    updateGuide();
  }

  function closePractice() {
    ps.status = 'completed'; ps.completedAtUtc = new Date().toISOString(); ps.completionVersion = current.version;
    const snap = store.plain(E); snap.sunAtClose = { az: tel.sun.az, el: tel.sun.el };
    ps.closure = { completedAtUtc: ps.completedAtUtc, completionVersion: current.version, simLocal: `${lt().day}/${lt().month}/${lt().year} ${pad2(lt().hour)}:${pad2(lt().minute)}`, user: profile.user, role: profile.role, answers: store.plain(ps.answers), evidence: snap, runIds: ps.runIds.slice(),
      incidents: incidentsNow(ps.sessionId), sweepIds: source.sweeps.filter((w) => w.sessionId === ps.sessionId).map((w) => w.id), runs: ps.runIds.map((id) => source.getRun(id)).filter(Boolean).map((r) => ({ id: r.id, n: r.samples.length, summary: store.plain(LAB.core.runSummary(r)) })) };
    progress.activePractice = null;
    commit(true);
    ui.toast(`Práctica ${current.n} completada. Descarga tu reporte.`, 'ok', 6500);
    ui.announce(`Práctica ${current.n} completada`);
  }

  // ---------------------------------------------------------------- acciones
  function hideGuide() { guideOpen = false; $('#practiceGuide').hidden = true; refreshChip(); if (lastOpener && document.contains(lastOpener)) lastOpener.focus(); }
  function showGuide() { guideOpen = true; $('#practiceGuide').hidden = false; refreshChip(); if (ui.layout) { ui.layout.onGuideShown(); ui.layout.focusGuide(); } }
  function refreshChip() {
    const b = $('#btnPractices'); if (!b) return;
    const active = current && ps && ps.status === 'in_progress';
    b.textContent = active ? `Práctica ${current.n} ▸` : 'Prácticas';
    b.title = active ? `Práctica ${current.n} en curso${guideOpen ? '' : ': pulsa para abrir el listado y continuarla'}` : 'Prácticas guiadas';
  }

  function open(id, { restartIt } = {}) {
    const p = defOf(id); if (!p || !progress) return;
    const old = progress.practices[id];
    if (current && ps && current.id !== id && ps.status === 'in_progress') commit(true);
    current = p;
    if (!old || restartIt || old.status === 'completed_legacy') {
      ps = freshPS(p); progress.practices[id] = ps;
    } else { ps = old; if (!ps.evidence) ps.evidence = p.fresh(); ps.evidence = Object.assign(p.fresh(), ps.evidence); }
    E = ps.evidence;
    if (ps.defVersion < p.version && ps.status === 'in_progress') ps.outdated = true;
    if (ps.status === 'in_progress' && !ps.setupDone) { if (canOperate()) { ps.setupDone = true; p.setup(); } }
    progress.activePractice = ps.status === 'in_progress' ? id : progress.activePractice;
    buildGuide(); showGuide(); evaluate(true); commit(true);
  }
  function restart(id) {
    if (!confirm('¿Reiniciar esta práctica? Se borrarán el progreso, las respuestas y la evidencia de esta práctica (las corridas ya adquiridas se conservan).')) return;
    open(id, { restartIt: true });
  }
  function nextPractice() {
    const i = PRACTICES.indexOf(current), nx = PRACTICES[(i + 1) % PRACTICES.length];
    commit(true);
    const st = progress.practices[nx.id];
    open(nx.id, st && st.status !== 'completed_legacy' ? {} : {});
  }
  function consult(id) {
    const p = defOf(id); current = p; ps = progress.practices[id]; E = ps.evidence; buildGuide(); showGuide(); updateGuide();
  }

  // ---------------------------------------------------------------- vista de todos los pasos (C16): siempre accesible, también con la guía minimizada
  function openOverview() {
    const p = current, body = $('#ovBody'), dlg = $('#overviewDlg'); if (!p || !ps) return;
    body.textContent = '';
    const m = metrics(p, ps);
    body.append(el('h2', { id: 'ovTitle', text: `Práctica ${p.n} · ${p.title}` }), el('p', { class: 'hint', text: `${p.goal} Avance: ${m.stepsDone}/${m.stepsReq} requisitos operativos y ${m.ansDone}/${m.ansReq} respuestas.` }));
    const t = el('table'); t.appendChild(el('caption', { class: 'sr', text: 'Todos los pasos de la práctica' }));
    const hr = el('tr'); ['Paso', 'Objetivo', 'Acción', 'Observación esperada', 'Evidencia', 'Estado'].forEach((h) => hr.appendChild(el('th', { scope: 'col', text: h }))); t.appendChild(hr);
    p.steps.forEach((s, i) => {
      const done = !!ps.steps[s.id], tr = el('tr', { class: done ? 'ok' : '' });
      [`${i + 1}${s.optional ? ' (opc.)' : ''}`, s.why || '', s.text, s.expect || '—', s.evidence || (s.question ? 'Respuesta registrada' : '—'), done ? '✓ completado' : (s.question && ps.answers[s.question.id] && ps.answers[s.question.id].draft ? 'borrador' : 'pendiente')].forEach((v) => tr.appendChild(el('td', { text: v })));
      t.appendChild(tr);
    });
    body.append(t, el('h3', { text: 'Resultados de aprendizaje' }), el('ul', {}, p.ilos.map((x) => el('li', { text: x }))));
    ui.showModal(dlg);
  }

  // ---------------------------------------------------------------- reporte imprimible (C16)
  /** Alarmas e incidentes de la bitácora de una sesión (se congelan al cerrar la práctica: T30) */
  function incidentsNow(sessionId) {
    return source.logs.filter((e) => e.sessionId === sessionId && (e.level === 'warn' || e.level === 'bad' || e.src === 'Seguridad' || e.src === 'Red')).slice(-40).map((e) => `${pad2(e.local.hour)}:${pad2(e.local.minute)} · ${e.src}: ${e.msg}`);
  }
  async function reportContext() {
    const p = current, snap = ps.closure ? ps.closure.evidence : E, ans = ps.closure ? ps.closure.answers : ps.answers, l = lt();
    const pid = profile.id, saved = pid ? await store.listRuns(pid) : [], live = source.runs.slice(), ids = new Set(live.map((r) => r.id));
    const all = saved.filter((r) => !ids.has(r.id)).concat(live), want = new Set(ps.closure ? ps.closure.runIds : ps.runIds);
    const frozen = {}; if (ps.closure && ps.closure.runs) ps.closure.runs.forEach((x) => (frozen[x.id] = x));
    const runs = all.filter((r) => want.has(r.id) && r.samples).sort((a, b) => String(a.createdAtUtc).localeCompare(String(b.createdAtUtc)))
      .map((r) => (frozen[r.id] ? { ...r, samples: r.samples.slice(0, frozen[r.id].n), _frozen: frozen[r.id].summary } : r));
    const sv = pid ? await store.listSweeps(pid) : [], sids = new Set(source.sweeps.map((w) => w.id));
    const sweeps = sv.filter((w) => !sids.has(w.id)).concat(source.sweeps).filter((w) => w.sessionId === ps.sessionId && (!ps.closure || !ps.closure.sweepIds || ps.closure.sweepIds.includes(w.id))).sort((a, b) => a.startSimMs - b.startSimMs);
    const incidents = ps.closure && ps.closure.incidents ? ps.closure.incidents : incidentsNow(ps.sessionId);
    const complete = ps.status === 'completed';
    return { practice: p, ps, snap, answers: ans, complete, mt: metrics(p, ps), user: profile.user, role: profile.role, version: LAB.config.appVersion, site: LAB.config.site.name, tz: LAB.config.site.tzHours,
      simLocal: ps.closure ? ps.closure.simLocal : `${l.day}/${l.month}/${l.year} ${pad2(l.hour)}:${pad2(l.minute)}`, realDate: complete ? ps.completedAtUtc : new Date().toISOString(), runs, sweeps, incidents };
  }
  async function openReport() {
    if (!current || !ps) return;
    const ctx = await reportContext(), html = LAB.ui.reportHtml(ctx), dlg = $('#reportDlg'), fr = $('#rpFrame');
    fr.srcdoc = html; dlg._html = html; dlg._name = `reporte_practica${current.n}${ctx.complete ? '' : '_borrador'}`;
    $('#rpTitle').textContent = `Reporte · Práctica ${current.n}${ctx.complete ? '' : ' (borrador incompleto)'}`;
    $('#rpNote').textContent = ctx.complete ? 'Revisa tus respuestas y datos. Este reporte usa la evidencia congelada al cerrar la práctica.' : 'La práctica no está completa: este documento queda marcado como borrador incompleto.';
    ui.showModal(dlg);
  }
  function bindReportDialogs() {
    const rd = $('#reportDlg'), od = $('#overviewDlg');
    rd.querySelector('.x').addEventListener('click', () => ui.hideModal(rd)); od.querySelector('.x').addEventListener('click', () => ui.hideModal(od));
    const save = (text, ext, mime) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = `${rd._name}_${lt().year}${pad2(lt().month)}${pad2(lt().day)}.${ext}`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
    $('#rpPrint').addEventListener('click', () => { const w = $('#rpFrame').contentWindow; if (w) { w.focus(); w.print(); } });
    $('#rpHtml').addEventListener('click', () => save(rd._html, 'html', 'text/html;charset=utf-8'));
    $('#rpMd').addEventListener('click', () => download());
  }

  // ---------------------------------------------------------------- reporte (datos congelados)
  function reportMarkdown(draft) {
    const p = current, snap = ps.closure ? ps.closure.evidence : E, ans = ps.closure ? ps.closure.answers : ps.answers, l = lt();
    const complete = ps.status === 'completed';
    const mt = metrics(p, ps);
    return [`# Reporte · Práctica ${p.n}: ${p.title}${complete ? '' : ' (BORRADOR INCOMPLETO)'}`, '',
      ...(complete ? [] : [`> **Borrador incompleto:** ${mt.stepsDone}/${mt.stepsReq} requisitos operativos y ${mt.ansDone}/${mt.ansReq} respuestas registradas al momento de descargar. No es un reporte final.`, '']),
      `- Laboratorio Remoto Solar UNACH · EU‑COLMEV WP3 — **modo simulador (pvlib)**`,
      `- Identidad de demostración: ${profile.user || '—'} (${profile.role || '—'}; rol local, no es una autenticación)`,
      `- ${complete ? 'Cerrada' : 'Descargada'} en tiempo simulado: ${ps.closure ? ps.closure.simLocal : `${l.day}/${l.month}/${l.year} ${pad2(l.hour)}:${pad2(l.minute)}`} (UTC${LAB.config.site.tzHours}) · fecha real: ${complete ? ps.completedAtUtc : new Date().toISOString()}`,
      `- Sitio: ${LAB.config.site.name} · Versión de la aplicación ${LAB.config.appVersion} · definición de la práctica v${p.version} · sesión ${ps.sessionId || '—'}`, '',
      `**Objetivo.** ${p.goal}`, '', ...(p.report ? p.report(snap) : []), '', '## Respuestas',
      ...p.steps.filter((x) => x.question).map((x) => { const a = ans[x.question.id]; return `**${x.question.text}**\n\n${a && a.submitted ? a.submitted : (a && a.draft ? `_(borrador sin registrar)_ ${a.draft}` : '_(sin respuesta)_')}\n`; }),
      '## Resultados de aprendizaje', ...p.ilos.map((x) => `- ${x}`), ''].join('\n');
    void draft;
  }
  function download() {
    const l = lt(), md = reportMarkdown();
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    a.download = `reporte_practica${current.n}${ps.status === 'completed' ? '' : '_borrador'}_${l.year}${pad2(l.month)}${pad2(l.day)}.md`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------------------------------------------------------------- listado de practicas
  function renderDrawer() {
    const d = $('#practiceDrawer');
    d.textContent = '';
    d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Prácticas guiadas'); d.setAttribute('aria-modal', 'false');
    const x = el('button', { class: 'x', type: 'button', 'aria-label': 'Cerrar el listado de prácticas', text: '×' });
    x.addEventListener('click', () => closeDrawer());
    d.append(x, el('h3', { text: 'Prácticas guiadas' }), el('p', { text: 'Los pasos se marcan solos cuando el simulador detecta que los completaste; las preguntas se responden y se registran con su botón. Tu avance se guarda en este navegador, por perfil de demostración.' }));
    if (!progress) d.appendChild(el('p', { class: 'pwarn', text: 'Inicia una sesión de demostración para guardar tu avance y empezar una práctica.' }));
    PRACTICES.forEach((p) => {
      const st = progress && progress.practices[p.id], sm = summaryOf(p, st);
      const card = el('div', { class: 'pcard ' + sm.cls });
      card.append(el('div', { class: 'n', 'aria-hidden': 'true', text: st && (st.status === 'completed' || st.status === 'completed_legacy') ? '✓' : String(p.n) }), el('b', { text: `Práctica ${p.n} · ${p.title}` }), el('p', { text: p.goal }), el('span', { class: 'meta', text: `${p.dur} · ${sm.text}${st && st.outdated ? ' · la definición cambió desde que la iniciaste' : ''}` }));
      const row = el('div', { class: 'pbtns' });
      const b = (txt, fn, cls) => { const e = el('button', { class: 'btn ' + (cls || ''), type: 'button', text: txt }); e.addEventListener('click', fn); row.appendChild(e); };
      if (!progress) { /* sin perfil */ }
      else if (!st || st.status === 'completed_legacy') b(st ? 'Comenzar de nuevo (criterio nuevo)' : 'Comenzar', () => { open(p.id, { restartIt: true }); closeDrawer(true); }, 'accent');
      else if (st.status === 'in_progress') { b('Continuar', () => { open(p.id); closeDrawer(true); }, 'accent'); b('Reiniciar', () => { closeDrawer(true); restart(p.id); }); }
      else { b('Consultar resultados', () => { consult(p.id); closeDrawer(true); }, 'accent'); b('Repetir (reinicia)', () => { closeDrawer(true); restart(p.id); }); }
      card.appendChild(row); d.appendChild(card);
    });
    // copia de seguridad
    const bk = el('div', { class: 'backup' }, el('b', { text: 'Copia de seguridad' }), el('p', { class: 'hint', text: 'Exporta o importa tu avance y tus corridas (JSON). El archivo se valida antes de usarse.' }));
    const ex = el('button', { class: 'btn', type: 'button', text: 'Exportar copia (JSON)' }), im = el('button', { class: 'btn', type: 'button', text: 'Importar copia…' });
    const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true, 'aria-label': 'Archivo de copia de seguridad' });
    ex.addEventListener('click', exportBackup); im.addEventListener('click', () => file.click());
    file.addEventListener('change', () => importBackupFile(file.files[0]));
    ex.disabled = im.disabled = !progress;
    bk.append(el('div', { class: 'row3' }, ex, im), file, el('div', { id: 'saveState2', class: 'savestate', role: 'status', text: store.status.error ? '⚠ ' + store.status.error : '' }));
    d.appendChild(bk);
    return x;
  }
  async function exportBackup() {
    const data = await store.exportAll(profile.id, progress);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = `lab-solar-unach_copia_${profile.id}_${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    ui.toast('Copia de seguridad descargada.', 'ok');
  }
  async function importBackupFile(f) {
    if (!f) return;
    if (f.size > 60e6) { ui.toast('El archivo es demasiado grande para importarlo.', 'warn'); return; }
    let obj; try { obj = JSON.parse(await f.text()); } catch (e) { ui.toast('El archivo no es un JSON válido.', 'warn'); return; }
    const v = store.validateBackup(obj);
    if (!v.ok) { ui.toast('Copia rechazada: ' + v.errors.join(' · '), 'bad', 9000); return; }
    if (!confirm('Importar esta copia reemplaza el avance guardado de este perfil. ¿Continuar?')) return;
    const r = await store.importBackup(obj, profile.id);
    if (r.ok) { progress = r.progress; current = null; ps = null; $('#practiceGuide').hidden = true; ui.toast(`Copia importada (${r.runs} corridas, ${r.sweeps} barridos).`, 'ok'); renderDrawer(); refreshChip(); }
  }
  function closeDrawer(noFocus) { const d = $('#practiceDrawer'); if (d.hidden) return; if (noFocus) { const i = 0; void i; d.hidden = true; ui.dropModal(d); } else ui.hideModal(d); }

  // ---------------------------------------------------------------- API publica
  ui.practices = {
    list: PRACTICES, defs: defOf, MIN_ANSWER,
    init(a) {
      app = a; source = a.source; send = ui.send; tel = source.telemetry;
      source.on('sweep', (sw) => { if (current && ps && ps.status === 'in_progress' && current.onSweep) { current.onSweep(sw); evaluate(false); } });
      source.on('acq', (e) => { if (current && ps && e.runId && !ps.runIds.includes(e.runId) && ps.status === 'in_progress') { ps.runIds.push(e.runId); commit(); } });
      store.onStatus(renderSaveState); bindReportDialogs();
    },
    /** Llamado al iniciar o terminar una sesion: carga el avance del perfil correspondiente (aislado por perfil) */
    onSession(phase, entry) {
      if (phase === 'end') {
        if (progress && profile.id) commit(true);
        current = null; ps = null; E = {}; progress = null; profile = { id: null }; $('#practiceGuide').hidden = true; guideOpen = false; refreshChip(); return;
      }
      profile = { id: entry.profileId, user: entry.user, role: entry.role, sessionId: entry.id };
      progress = store.loadProgress(profile.id);
      if (progress.warning) ui.toast(progress.warning, 'warn', 9000);
      const act = progress.activePractice && progress.practices[progress.activePractice];
      if (act && act.status === 'in_progress') ui.toast(`Tienes la práctica ${defOf(act.practiceId).n} en curso: ábrela en "Prácticas" → Continuar.`, 'info', 7000);
      refreshChip();
    },
    openFromUrl(id) { if (progress && defOf(id)) { const st = progress.practices[id]; if (st && st.status === 'in_progress') open(id); else open(id, { restartIt: !st || st.status === 'completed_legacy' }); } },
    toggleDrawer(opener) {
      const d = $('#practiceDrawer');
      if (!d.hidden) { closeDrawer(); return; }
      lastOpener = opener || document.activeElement;
      renderDrawer(); ui.showModal(d);
    },
    closeDrawer,
    drawerOpen: () => !$('#practiceDrawer').hidden,
    guideOpen: () => guideOpen,
    hideGuide, openReport, openOverview,
    reopenGuide() { if (current && ps) { if (!built) buildGuide(); showGuide(); } },
    state: () => ({ current: current && current.id, ps, E, progress, profile }),
    notify(type, data) {
      if (!current || !ps || ps.status !== 'in_progress') return;
      if (type === 'part') { add(E.parts, data); acc = 1; }
      else if (type === 'pov') { const c = (E.cams[data.id] = E.cams[data.id] || {}); if (data.phase === 'enter') c.entered = true; else if (data.phase === 'exit' && c.entered) c.exited = true; acc = 1; }
      else if (type === 'tab' && data === 'iv') { E.ivViewed = true; acc = 1; }
      else if (type === 'csv' && data && data.rows > 0) { E.csv = { rows: data.rows, runId: data.runId }; acc = 1; }
      else if (type === 'logOpened') { E.logOpened = true; acc = 1; }
      else if (type === 'log' && current.onLog) current.onLog(data);
    },
    tick(t, dt) {
      tel = t;
      if (!current || !ps || !profile.id) return;
      if (ps.status !== 'in_progress') { return; }
      if (!ps.setupDone && canOperate()) { ps.setupDone = true; current.setup(); commit(); }
      if (current.tick) current.tick(dt);
      acc += dt;
      if (acc < 0.4) return; acc = 0;
      evaluate(false);
    },
    download,
  };
})();
