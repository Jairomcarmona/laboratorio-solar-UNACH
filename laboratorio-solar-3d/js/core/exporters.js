/* Exportadores puros: reciben objetos de dominio (corrida, barrido) y devuelven texto. No leen la telemetria viva,
 * asi un archivo descargado hoy describe lo que se registro y no el estado accidental del simulador al descargarlo. */
(function () {
  'use strict';
  const { pad2, esc } = LAB.util;
  LAB.core = LAB.core || {};

  /** Columnas de una muestra, en el orden en que se guardan. Unidades en el nombre. */
  const COLS = ['n', 'segmentId', 'simMs', 'realMs', 'gA', 'gB', 'tcA', 'tcB', 'ta', 'rh', 'wind', 'windDir', 'vA', 'iA', 'pA', 'eA', 'vB', 'iB', 'pB', 'eB', 'azB', 'tiltB', 'trMode', 'loadMode', 'safety', 'cloud', 'shA', 'shB'];
  const CSV_HEAD = ['n', 'segmento', 'utc_iso_simulado', 'hora_local_sitio', 'utc_iso_registro_real', 'G_A_Wm2', 'G_B_Wm2', 'Tcel_A_C', 'Tcel_B_C', 'Tamb_C', 'HR_pct', 'viento_ms', 'dir_viento_deg',
    'V_A_V', 'I_A_A', 'P_A_W', 'E_A_Wh', 'V_B_V', 'I_B_A', 'P_B_W', 'E_B_Wh', 'azimut_B_deg', 'inclinacion_B_deg', 'modo_seguidor_aplicado', 'modo_carga', 'estado_seguridad', 'nubes_consigna_pct', 'sombra_mutua_A_frac', 'sombra_mutua_B_frac', 'evento'];
  const DEC = { gA: 1, gB: 1, tcA: 1, tcB: 1, ta: 1, rh: 0, wind: 1, windDir: 0, vA: 2, iA: 3, pA: 1, eA: 2, vB: 2, iB: 3, pB: 1, eB: 2, azB: 1, tiltB: 1, cloud: 0, shA: 2, shB: 2 };

  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const iso = (ms) => new Date(ms).toISOString();
  const local = (ms) => { const l = LAB.localTime(ms); return `${l.year}-${pad2(l.month)}-${pad2(l.day)} ${pad2(l.hour)}:${pad2(l.minute)}:${pad2(l.second)}`; };

  /** CSV de una corrida: comentarios de contexto + una fila por muestra, con la columna de evento y el segmento. */
  LAB.core.runToCsv = function (run) {
    const idx = {}; (run.cols || COLS).forEach((c, i) => (idx[c] = i));
    const evByN = {};
    (run.events || []).forEach((e) => { (evByN[e.n] = evByN[e.n] || []).push(e.text); });
    const lines = [
      '# Laboratorio Remoto Solar UNACH - DATOS SIMULADOS (no son mediciones del banco real)',
      `# corrida=${run.id} sesion=${run.sessionId} practica=${run.practiceId || '-'} etiqueta=${csvCell(run.label || '')}`,
      `# identidad_demostracion=${csvCell(run.user || '')} (rol local, no es autenticacion)`,
      `# muestreo=una muestra por segundo de ${run.sampling ? run.sampling.basis : 'tiempo real'}; estado=${run.status}; muestras=${run.samples.length}; limite=${run.limit}`,
      `# semilla=${run.seed != null ? run.seed : '-'} escenario=${run.scenario ? run.scenario.id : '-'} version_app=${run.appVersion || '-'} esquema=${run.schemaVersion}`,
      '# E_A_Wh y E_B_Wh son contadores de energia: vuelven a cero al "Poner energia a cero" (nuevo segmento). Un cambio de segmento marca una discontinuidad: no unir con lineas.',
      '# segmentos: ' + (run.segments || []).map((s) => `${s.id}(${s.reason})`).join(' '),
      CSV_HEAD.join(','),
    ];
    run.samples.forEach((r, k) => {
      const out = [];
      out.push(r[idx.n], r[idx.segmentId], iso(r[idx.simMs]), local(r[idx.simMs]), iso(r[idx.realMs]));
      for (const c of COLS.slice(4)) {
        const v = r[idx[c]];
        out.push(typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(DEC[c] != null ? DEC[c] : 2) : '') : csvCell(v));
      }
      out.push(csvCell((evByN[r[idx.n]] || []).join(' | ')));
      lines.push(out.join(','));
    });
    // eventos que ocurrieron sin muestra asociada (p. ej. al detener) se anexan como comentarios
    const lastN = run.samples.length ? run.samples[run.samples.length - 1][idx.n] : -1;
    (run.events || []).filter((e) => e.n > lastN).forEach((e) => lines.push(`# evento despues de la ultima muestra (${iso(e.realMs)}): ${e.text}`));
    return lines.join('\n') + '\n';
  };

  /** CSV de un barrido I-V registrado (A y B, puntos medidos en el simulador). */
  LAB.core.sweepToCsv = function (sw) {
    const L = [
      '# Laboratorio Remoto Solar UNACH - BARRIDO I-V SIMULADO REGISTRADO (no es medicion fisica)',
      `# barrido=${sw.id} sesion=${sw.sessionId} corrida=${sw.runId || '-'} estado=${sw.status}${sw.cause ? ' (' + sw.cause + ')' : ''}`,
      `# inicio_local=${local(sw.startSimMs)} G_A_inicio=${sw.cond.start.gA.toFixed(0)} G_B_inicio=${sw.cond.start.gB.toFixed(0)} W/m2 Tcel_A=${sw.cond.start.tA.toFixed(1)} C nubes=${(sw.cond.start.cloud * 100).toFixed(0)}%`,
      `# fin: G_A=${sw.cond.end.gA.toFixed(0)} G_B=${sw.cond.end.gB.toFixed(0)} W/m2 (si difieren del inicio, las condiciones cambiaron durante el barrido)`,
      'modulo,punto,V_V,I_A,P_W,G_Wm2',
    ];
    for (const k of ['A', 'B']) sw.pts[k].forEach((p, i) => L.push(`${k},${i},${p.v.toFixed(3)},${p.i.toFixed(4)},${p.p.toFixed(2)},${p.g != null ? p.g.toFixed(1) : ''}`));
    return L.join('\n') + '\n';
  };

  LAB.core.localStr = local;
  LAB.core.isoStr = iso;
  LAB.core.RUN_COLS = COLS;
  void esc;
})();
