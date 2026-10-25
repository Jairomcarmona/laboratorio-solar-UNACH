/* Multimetro virtual para Voc e Isc (punto 7). Funciones puras + una maquina de estados sin DOM.
 * No tiene fisica propia: lee el punto de operacion que ya entrega la carga programable en modo oc / sc (el mismo modelo del banco real,
 * pero al ser la carga la unica que impone el punto, el multimetro la pone en oc o sc con el comando real load.set y restituye el modo anterior).
 * El instrumento anade lo que un instrumento real anade: rango, resolucion, incertidumbre y signo segun la polaridad de las puntas. */
(function () {
  'use strict';
  LAB.core = LAB.core || {};
  const DEF = {
    scMaxS: 10,                 // duracion maxima del cortocircuito que el multimetro mantiene (s); la entrada de 20 A de un multimetro de mano suele admitir 30 s
    settleS: 1.2,               // espera tras cambiar la carga antes de tomar muestras (s)
    samples: 5, sampleEveryS: 0.25,
    v: { ranges: [{ max: 6, res: 0.001 }, { max: 60, res: 0.01 }, { max: 600, res: 0.1 }], pct: 0.5, digits: 2 },   // Vcc: ±(0.5 % lect. + 2 dig.)
    i: { ranges: [{ max: 20, res: 0.01 }], pct: 1.5, digits: 5 },                                                   // Icc entrada de 20 A: ±(1.5 % lect. + 5 dig.)
  };
  const spec = () => ({ ...DEF, ...((LAB.config && LAB.config.meter) || {}) });

  /** Puntos de medida de cada modulo: +/- en el conector de salida (ilustrativo hasta tener fotos del banco) */
  const POINTS = ['A+', 'A-', 'B+', 'B-'];
  const moduleOf = (pt) => (pt ? pt[0] : null);
  const signOf = (pt) => (pt ? pt[1] : null);

  /** Lectura de un instrumento: x = valor verdadero (V o A, con signo de la polaridad). fn: 'voc' | 'isc'. */
  function read(fn, x) {
    const S = spec(), cfg = fn === 'isc' ? S.i : S.v, unit = fn === 'isc' ? 'A' : 'V';
    if (!Number.isFinite(x)) return { ok: false, value: NaN, text: '—', unit, ol: false, unc: NaN, res: NaN };
    const ax = Math.abs(x), rg = cfg.ranges.find((r) => ax <= r.max) || null;
    if (!rg) return { ok: true, value: x, text: 'OL', unit, ol: true, unc: NaN, res: NaN };
    const res = rg.res, v = Math.round(x / res) * res, dec = Math.max(0, Math.round(-Math.log10(res)));
    return { ok: true, value: v === 0 ? 0 : v, text: (v === 0 ? 0 : v).toFixed(dec), unit, ol: false, unc: cfg.pct / 100 * Math.abs(v) + cfg.digits * res, res, range: rg.max };
  }

  /** Estado de las puntas: valido si estan en el + y el − del MISMO modulo (invertidas dan lectura negativa) */
  function probes(red, black) {
    if (!red || !black) return { valid: false, reason: 'missing' };
    if (moduleOf(red) !== moduleOf(black)) return { valid: false, reason: 'modules' };
    if (signOf(red) === signOf(black)) return { valid: false, reason: 'same' };
    return { valid: true, module: moduleOf(red), sign: signOf(red) === '+' ? 1 : -1 };
  }

  /** Maquina de medida. send(cmd) -> {ok, ...} (el comando real load.set). now: reloj en s (el de la interfaz, no el simulado). */
  class Measurement {
    constructor(fn, module, sign, prev, send) {
      this.fn = fn; this.module = module; this.sign = sign; this.prev = prev; this.send = send;
      this.target = fn === 'isc' ? 'sc' : 'oc'; this.state = 'start'; this.t = 0; this.samples = []; this.next = 0; this.result = null; this.reason = ''; this.held = 0;
    }
    get scActive() { return this.fn === 'isc' && ['settling', 'sampling'].includes(this.state); }
    /** Avanza dt s con la telemetria actual; devuelve el estado ('settling' | 'sampling' | 'done' | 'aborted') */
    tick(tel, dt) {
      const S = spec();
      if (this.state === 'done' || this.state === 'aborted') return this.state;
      if (this.state === 'start') {
        const r = this.send({ type: 'load.set', mode: this.target });
        if (r && r.ok === false) return this._abort(r.reason || 'rejected');
        this.state = 'settling'; this.t = 0;
      }
      this.t += dt;
      const sf = tel.safety;
      if (sf.estop || sf.state !== 'NORMAL') return this._abort(sf.estop ? 'estop' : 'safety');
      if (tel.quality && tel.quality.includes('stale')) return this._abort('stale');
      if (this.fn === 'isc' && this.t > S.scMaxS) return this._abort('limit');
      if (tel.load.sweeping) return this._abort('sweep');
      if (this.state === 'settling') {
        if (tel.load.mode === this.target && this.t >= S.settleS) { this.state = 'sampling'; this.next = this.t; }
        else if (this.t > S.settleS + 6) return this._abort('timeout');       // en red el acuse y el cambio de carga pueden tardar; no se espera para siempre
        return this.state;
      }
      if (tel.load.mode !== this.target) return this._abort('changed');         // alguien cambio la carga durante la medida
      if (this.t >= this.next) {
        const m = tel[this.module], x = this.fn === 'isc' ? m.i : m.v;
        if (Number.isFinite(x)) this.samples.push(x);
        this.next += S.sampleEveryS;
      }
      if (this.samples.length >= S.samples) {
        const mean = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
        this.result = read(this.fn, this.sign * mean); this.result.module = this.module; this.result.fn = this.fn; this.result.n = this.samples.length;
        this._restore(); this.state = 'done';
      }
      return this.state;
    }
    _abort(reason) { this.reason = reason; this._restore(); this.state = 'aborted'; return this.state; }
    _restore() {
      if (this.restored) return; this.restored = true;
      const p = this.prev || { mode: 'mppt' };
      if (p.mode && p.mode !== this.target) this.send({ type: 'load.set', mode: p.mode, ...(p.setpoint != null && ['cv', 'cr'].includes(p.mode) ? { setpoint: p.setpoint } : {}) });
    }
    cancel() { if (this.state !== 'done' && this.state !== 'aborted') this._abort('cancelled'); }
  }

  LAB.core.meter = { spec, read, probes, Measurement, POINTS, moduleOf, signOf };
})();
