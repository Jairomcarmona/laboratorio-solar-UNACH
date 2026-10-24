/* S14: calibracion cruzada A = B. B se lleva a la orientacion de A (LAB.config.fixed), espera 10 min, registra >= 600 muestras con
 * G > 300 W/m2 en ambos planos y guarda k = sum(P_B)/sum(P_A). Con k, la ganancia corregida es E_B/(k·E_A) - 1: lo que B gana de verdad
 * descontando que dos modulos "iguales" no entregan exactamente lo mismo. La incertidumbre de k la define O1 (aun no existe):
 * mientras tanto solo se guardan k y el numero de muestras, marcados «incertidumbre pendiente». */
(function () {
  'use strict';
  LAB.core = LAB.core || {};
  const MIN_G = 300, SETTLE_S = 600, MIN_SAMPLES = 600, POSE_TOL = 0.3, KEY = 'labsolar.v2.calibration';
  const colIndex = (run) => { const m = {}; (run.cols || LAB.core.RUN_COLS).forEach((c, i) => (m[c] = i)); return m; };

  /** k de una corrida de calibracion. ok=false si faltan muestras validas. Las muestras de distinto segmento no se mezclan con discontinuidades. */
  function calibrationFromRun(run, opts = {}) {
    const minG = opts.minG || MIN_G, need = opts.minSamples || MIN_SAMPLES, idx = colIndex(run), S = run.samples || [];
    let sA = 0, sB = 0, n = 0, t0 = null, t1 = null;
    for (const r of S) {
      const gA = r[idx.gA], gB = r[idx.gB], pA = r[idx.pA], pB = r[idx.pB];
      if (!(gA > minG && gB > minG) || !Number.isFinite(pA) || !Number.isFinite(pB) || r[idx.safety] !== 'NORMAL') continue;
      sA += pA; sB += pB; n++; if (t0 == null) t0 = r[idx.simMs]; t1 = r[idx.simMs];
    }
    const base = { nValid: n, nTotal: S.length, needed: need, minG, startMs: t0, endMs: t1, uncertainty: null, uncertaintyNote: 'incertidumbre pendiente (O1)' };
    if (n < need) return { ...base, ok: false, k: null, reason: `Solo ${n} de ${need} muestras válidas (G > ${minG} W/m² en A y B, sistema en NORMAL).` };
    if (!(sA > 0)) return { ...base, ok: false, k: null, reason: 'La energía de A es cero: no se puede calcular k.' };
    return { ...base, ok: true, k: sB / sA };
  }

  const memo = { cal: null };
  const get = () => { if (memo.cal) return memo.cal; try { const s = window.localStorage.getItem(KEY); if (s) memo.cal = JSON.parse(s); } catch (e) { /* sin almacenamiento */ } return memo.cal; };
  const save = (cal) => { memo.cal = cal; try { window.localStorage.setItem(KEY, JSON.stringify(cal)); } catch (e) { /* solo en memoria */ } return cal; };
  const clear = () => { memo.cal = null; try { window.localStorage.removeItem(KEY); } catch (e) { /* nada */ } };

  /** Ganancia (%) cruda y corregida por k. null si no hay calibracion o E_A es insuficiente. */
  function correctedGainPct(EA, EB, cal) {
    if (!cal || !(cal.k > 0)) return { v: null, note: 'Sin calibración A = B: la ganancia mostrada es cruda.' };
    const r = LAB.core.ratioPct(EB / cal.k, EA, 'la energía del módulo A');
    return r;
  }

  /** Orquestador: lleva B a la orientacion de A, espera, graba y calcula k. Usa solo comandos existentes (sirve igual con el banco real). */
  class Calibrator {
    constructor(source, hooks = {}) {
      this.src = source; this.hooks = hooks; this.phase = 'idle'; this.t = 0; this.runId = null; this.result = null; this.msg = ''; this.lastCheck = 0; this.sent = false;
    }
    get active() { return !['idle', 'done', 'failed', 'aborted'].includes(this.phase); }
    say(m) { this.msg = m; if (this.hooks.log) this.hooks.log(m); }
    start() {
      if (this.active) return { ok: false, reason: 'Ya hay una calibración en curso.' };
      const tel = this.src.telemetry;
      if (!tel.safety.canOperate) return { ok: false, reason: tel.safety.blockReason || 'No puedes operar el banco ahora.' };
      if (tel.sun.el < 20) return { ok: false, reason: 'El Sol está muy bajo (< 20°): la calibración necesita G > 300 W/m² en los dos módulos.' };
      this.phase = 'moving'; this.t = 0; this.result = null; this.runId = null; this.sent = false;
      const f = LAB.config.fixed;
      const r1 = this.src.send({ type: 'tracker.mode', mode: 'manual' });
      if (r1 && r1.ok === false) { this.phase = 'failed'; return r1; }
      const r2 = this.src.send({ type: 'tracker.target', az: f.az, tilt: f.tilt });
      if (r2 && r2.ok === false) { this.phase = 'failed'; return r2; }
      this.say(`B se lleva a la orientación de A (${f.az}° / ${f.tilt}°).`);
      return { ok: true };
    }
    abort(why) { if (!this.active) return; if (this.phase === 'recording') this.src.send({ type: 'acq.stop' }); this.phase = 'aborted'; this.say('Calibración cancelada' + (why ? `: ${why}` : '.')); }
    /** dt en segundos del reloj de la fuente (simulado o real) */
    update(dt) {
      if (!this.active) return;
      const tel = this.src.telemetry, f = LAB.config.fixed;
      if (!tel.safety.canOperate && this.phase !== 'recording') return this.fail('el banco dejó de admitir comandos');
      if (tel.safety.state !== 'NORMAL') return this.fail(`seguridad ${tel.safety.state}`);
      if (this.phase === 'moving') {
        this.t += dt;
        if (Math.abs(tel.tracker.az - f.az) < POSE_TOL && Math.abs(tel.tracker.tilt - f.tilt) < POSE_TOL) { this.phase = 'settling'; this.t = 0; this.say(`B en posición; espera de ${SETTLE_S / 60} min para que se estabilice la temperatura.`); }
        else if (this.t > 1800) this.fail('B no llegó a la orientación de A en 30 min');
      } else if (this.phase === 'settling') {
        this.t += dt;
        if (this.t >= SETTLE_S) {
          const r1 = this.src.send({ type: 'acq.newRun', label: 'Calibración A=B', practiceId: 'calibration' });
          if (r1 && r1.ok === false) return this.fail(r1.reason);
          const r2 = this.src.send({ type: 'acq.start' });
          if (r2 && r2.ok === false) return this.fail(r2.reason);
          this.phase = 'recording'; this.t = 0; this.say('Registrando muestras (se necesitan ' + MIN_SAMPLES + ' con G > ' + MIN_G + ' W/m²).');
        }
      } else if (this.phase === 'recording') {
        this.t += dt;
        this.runId = this.runId || tel.acq.runId;
        if (this.t - this.lastCheck >= 5) {
          this.lastCheck = this.t;
          const run = this.src.getRun ? this.src.getRun(this.runId) : null;
          if (run && run.samples) {
            const c = calibrationFromRun(run);
            this.progress = c.nValid;
            if (c.ok) { this.src.send({ type: 'acq.stop' }); this.result = save({ ...c, runId: this.runId, dateMs: tel.simMs, dateIso: new Date().toISOString(), bank: tel.source }); this.phase = 'done'; this.say(`Calibración lista: k = ${c.k.toFixed(4)} con ${c.nValid} muestras (incertidumbre pendiente, O1).`); }
          }
          if (this.t > 4 * 3600) this.fail('no se reunieron 600 muestras válidas en 4 h');
        }
      }
    }
    fail(why) { if (this.phase === 'recording') this.src.send({ type: 'acq.stop' }); this.phase = 'failed'; this.say('La calibración falló: ' + why + '.'); }
  }

  LAB.core.calibration = { fromRun: calibrationFromRun, get, save, clear, correctedGainPct, Calibrator, MIN_G, SETTLE_S, MIN_SAMPLES };
})();
