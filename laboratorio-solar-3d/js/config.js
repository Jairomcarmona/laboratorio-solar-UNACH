/* Configuracion global y utilidades compartidas. Todo cuelga del espacio de nombres LAB. */
(function () {
  'use strict';
  const LAB = (window.LAB = window.LAB || {});
  LAB.scene = LAB.scene || {};
  LAB.sim = LAB.sim || {};
  LAB.data = LAB.data || {};
  LAB.ui = LAB.ui || {};

  const D2R = Math.PI / 180;

  const cfg = (LAB.config = {
    // Versiones: la aplicacion y el formato de los datos guardados (ver docs/FORMATO_PERSISTIDO.md)
    appVersion: '2.0.0-fase-D',
    schemaVersion: 2,
    sweepSeconds: 10,                   // s reales que dura un barrido I-V
    acq: { sampleEveryS: 1, limit: 20000, basis: 'tiempo real del navegador' },   // adquisicion: una muestra por segundo real
    speeds: [1, 10, 60, 600, 3600],
    // Tiempo fisico (H01): el motor avanza el mundo en pasos fisicos, no en cuadros. PROVISIONAL: se confirma por convergencia (docs/AUDITORIA_H01_H10.md).
    physics: { stepS: 0.1, maxSubsteps: 100 },     // paso fisico nominal (s) y tope de pasos por cuadro (a x3600 el paso crece a 3.6 s)
    // Criterios provisionales para dar por comparables dos corridas (H03); los fija el protocolo de cada practica
    compare: { startTolS: 120, durTolFrac: 0.05, durTolMinS: 30, minDurS: 60 },
    limits: { windMax: 25, cloudMax: 100 },          // rangos de las consignas del entorno (el motor y la interfaz leen los mismos)
    views: ['general', 'moduleA', 'moduleB', 'station', 'load', 'cabinet', 'aerial'],
    roles: ['visitor', 'student', 'teacher'],        // roles de demostracion admitidos por URL y por el acceso

    site: { name: 'FCFM-UNACH, Tuxtla Gutiérrez, Chiapas', lat: 16.7516, lon: -93.1161, alt: 530, tzHours: -6,
      albedo: 0.3 },                    // PROVISIONAL: azotea de concreto claro; S28 lo calibra con datos medidos

    // Modulo comercial ~500 Wp (se refina con LAB.data.pvlib.sdm si esta disponible)
    module: { Wp: 500, long: 2.278, short: 1.134, thick: 0.035, cols: 22, rows: 6, area: 2.278 * 1.134,
      iamAr: 0.16 },                    // IAM de Martin-Ruiz, a_r tipico (pvlib.iam.martin_ruiz); PROVISIONAL hasta medir

    // Modelo termico dinamico (S4): C dT/dt = (U0 + U1 v)(Tss - T), T = temperatura de MODULO (cara posterior).
    // u0/u1: Faiman, coeficientes por defecto de pvlib. C = 11.1 kg/m2 x 840 J/(kg K) (masa por defecto de pvlib.temperature.prilliman x vidrio):
    // PROVISIONAL, la recalibra O2. deltaT = 3 C a 1000 W/m2 (tabla Sandia, vidrio/polimero, estructura abierta).
    thermal: { u0: 25, u1: 6.84, C: 9300, deltaT: 3 },

    // Sensores de irradiancia del plano (S5). PROVISIONALES sin hoja de datos: alpha 0.05 %/K, ruido 0.4 %
    sensors: {
      poaA: { type: 'refcell', epsCal: 0, alpha: 0.0005, noise: 0.004 },
      poaB: { type: 'refcell', epsCal: 0, alpha: 0.0005, noise: 0.004 },
    },

    // Banco de cargas discreto (S7): null = carga electronica continua; o lista de resistencias en ohm
    load: { bank: null },

    fixed: { az: 180, tilt: 17 },

    tracker: {
      azMin: 90, azMax: 270,            // final de carrera por software y hardware (E a W pasando por S)
      northHystDeg: 2,                  // banda (grados de azimut solar alrededor del norte) donde no se cambia de lado
      tiltMin: 0, tiltMax: 90,
      azRate: 4.0, tiltRate: 3.0,       // deg/s velocidades maximas de los motorreductores
      stow: { az: 180, tilt: 0 },       // posicion segura
      motorPowerW: 35,                  // consumo por eje en movimiento (para la practica 3)
    },

    safety: {
      windStow: 14, windResume: 10,     // m/s: umbral de posicion segura y de reanudacion
      windHoldSimSec: 120,              // tiempo simulado con viento bajo antes de reanudar
      commsTimeoutS: 6,                 // s reales: watchdog
    },

    // Distribucion espacial DIDACTICA de la azotea (metros). +X este, +Y arriba, +Z sur (el banco mira al sur).
    // Es una propuesta de claridad visual para el simulador: NO son distancias de seguridad, de instalacion ni de norma.
    // Unica fuente de las posiciones: escena, camaras IP, cableado, vistas y pruebas leen de aqui.
    // Zonas: generacion al centro (A a la izquierda, B a la derecha), instrumentacion (carga + gabinete) a la derecha,
    // estacion meteorologica lateral izquierda y al fondo, camaras IP en los extremos delanteros.
    layout: {
      id: 'frontal-instrumentacion-lateral',
      moduleA: [-3.5, 0, 0],
      moduleB: [3.5, 0, 0],
      weather: [-6.2, 0, -3.4],
      load: [6.6, 0, 0],
      cabinet: [6.6, 0, -2.6],
      cam1: [-8.0, 0, 4.6],
      cam2: [8.8, 0, 4.6],
      rose: [-1.2, 6.1],                 // rosa de los vientos pintada (x, z)
      roof: { w: 26, d: 18, h: 0.45 },
    },

    colors: {
      uni: 0x0b3b6f, accent: 0x2fb4ff, solar: 0xffb020, ok: 0x35d07f, warn: 0xffb020, bad: 0xff4d4d,
    },
  });

  /** Volumenes de ocupacion (cajas min/max en metros) de cada equipo segun la disposicion y las dimensiones del modelo.
   *  Sirven para encuadrar las vistas, apuntar las camaras IP y comprobar despejes; no son distancias de seguridad.
   *  moveB es el volumen que barre el panel B con cualquier azimut e inclinacion autorizados (cilindro circunscrito). */
  const envelopes = (lay) => {
    const m = cfg.module, box = (c, hx, y0, y1, hz) => ({ min: [c[0] - hx, y0, c[2] - hz], max: [c[0] + hx, y1, c[2] + hz] });
    const rB = Math.hypot(m.long / 2, m.short / 2) + 0.2;      // esquina del panel + motorreductor
    const axisY = 2.47;                                        // eje de inclinacion sobre la azotea (tracker.js: 1.92 + 0.55)
    return {
      moduleA: box(lay.moduleA, m.long / 2 + 0.2, 0, 1.25, 0.8),
      moduleB: box(lay.moduleB, rB, 0, axisY + m.short / 2 + 0.15, rB),
      moveB: box(lay.moduleB, rB, axisY - m.short / 2 - 0.15, axisY + m.short / 2 + 0.15, rB),
      weather: box(lay.weather, 0.9, 0, 4.15, 0.9),
      load: box(lay.load, 0.55, 0, 1.6, 0.4),
      cabinet: box(lay.cabinet, 0.5, 0, 2.45, 0.35),
      cam1: box(lay.cam1, 0.3, 0, 3.4, 0.3),
      cam2: box(lay.cam2, 0.3, 0, 3.4, 0.3),
      axisY,
    };
  };
  cfg.envelopes = envelopes;
  /** Posiciones que necesita el modelo de sombra mutua. El motor de simulación no lee la distribución espacial directamente (prueba E20): la recibe de aquí. */
  cfg.shadeSites = () => ({ moduleA: cfg.layout.moduleA, moduleB: cfg.layout.moduleB, axisY: envelopes(cfg.layout).axisY });

  LAB.util = {
    D2R, R2D: 180 / Math.PI,
    clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
    lerp: (a, b, t) => a + (b - a) * t,
    smoothstep: (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); },
    /** Diferencia angular con signo en [-180, 180] */
    angDiff: (a, b) => ((((a - b) % 360) + 540) % 360) - 180,
    /** Color sRGB hexadecimal a THREE.Color lineal (el pipeline de color es lineal, ver main.js) */
    col: (hex) => new THREE.Color(hex).convertSRGBToLinear(),
    pad2: (n) => String(n).padStart(2, '0'),
    /** Ruido suave y determinista (suma de senos) para nubes, viento y ruido de medicion */
    noise1: (x, seed = 0) =>
      (Math.sin(x * 1.0 + seed) * 0.5 + Math.sin(x * 2.3 + seed * 1.7) * 0.3 + Math.sin(x * 4.1 + seed * 0.6) * 0.2),
    fmt: (v, d = 1) => { if (!Number.isFinite(v)) return '—'; const s = v.toFixed(d); return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s; },   // nunca muestra -0.0
    /** Escapa texto para insertarlo como HTML. El texto libre del usuario siempre debe pasar por aqui o usar textContent */
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"'`]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch])),
    /** true si el elemento es un control con el que el teclado ya hace algo propio (campos, botones, enlaces, dialogos) */
    isInteractive: (el) => !!(el && el.closest && el.closest('input,textarea,select,button,a[href],summary,[contenteditable="true"],[role="slider"],[role="tab"],dialog[open]')),
    isNum: (v) => typeof v === 'number' && Number.isFinite(v),
    /** Identificador corto y unico (no criptografico) */
    uid: (prefix = 'id') => prefix + '_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
    /** Generador pseudoaleatorio con semilla (mulberry32): reproducible, no usa Math.random */
    mulberry32: (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; },
    /** Ruido gaussiano aproximado, determinista en (semilla, indice, canal): no depende de cuantos cuadros se dibujaron */
    hashNoise: (seed, k, ch) => {
      let s = 0;
      for (let j = 0; j < 4; j++) { let h = (seed * 374761393 + k * 668265263 + ch * 2246822519 + j * 3266489917) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; s += (h >>> 0) / 4294967296; }
      return (s - 2) * 1.732;
    },
  };

  // Textos: centralizados para poder anadir otros idiomas (es por defecto)
  LAB.i18n = { lang: 'es', dict: { es: {}, en: {} } };
  LAB.t = (key, fallback) => (LAB.i18n.dict[LAB.i18n.lang][key] ?? LAB.i18n.dict.es[key] ?? fallback ?? key);

  /** Hora local del sitio a partir de milisegundos UTC (sin depender de la zona del navegador) */
  LAB.localTime = (ms) => {
    const d = new Date(ms + LAB.config.site.tzHours * 3600000);
    return {
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
      hours: d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600,
      dayOfYear: Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
        Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000),
    };
  };
  LAB.fromLocal = (y, mo, d, h = 0, mi = 0, s = 0) =>
    Date.UTC(y, mo - 1, d, h, mi, s) - LAB.config.site.tzHours * 3600000;
})();
