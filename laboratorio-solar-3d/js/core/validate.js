/* Validacion previa de comandos (S15): funcion PURA, sin estado ni DOM. La usan el motor local y las fuentes de red
 * (WsSource) antes de enviar. Es comodidad y rechazo temprano: la autoridad final siempre es el controlador local (PLC).
 * Devuelve null si el comando es valido, o {ok:false, reason, kind:'validation', field}. Nunca muta nada.
 * El mismo conjunto de reglas esta en server/contract/v1 (JSON Schema) y se prueba contra los mismos casos. */
(function () {
  'use strict';
  const { isNum } = LAB.util;
  LAB.core = LAB.core || {};

  /** Tipos de comando por fuente. 'real' = lo que el banco real admite (el resto se rechaza con kind 'unsupported'). */
  const REAL = ['session.start', 'session.end', 'acq.start', 'acq.stop', 'acq.newRun', 'tracker.target', 'tracker.mode', 'tracker.locks',
    'load.set', 'load.sweep', 'load.sweep.abort', 'safety.estop', 'safety.ack'];
  const SIM_ONLY = ['sim.speed', 'sim.play', 'sim.time', 'sim.cloud', 'sim.wind', 'sim.gust', 'sim.rain', 'sim.seed', 'sim.comms', 'sim.resetEnergy', 'sim.resetRain',
    'scenario.apply', 'safety.reset', 'acq.discard'];
  const REPLAY = ['replay.play', 'replay.pause', 'replay.seek', 'replay.speed'];
  const MODES = ['manual', 'astro', 'sensor', 'fixed'];
  const LOAD_MODES = ['mppt', 'cv', 'cr', 'oc', 'sc'];
  const CR_MIN = 0.4, CR_MAX = 30.4, CV_MIN = 0.05, CV_MAX = 1;
  const RAIN_LEVELS = 5;
  const ROLES = ['visitor', 'student', 'teacher', 'tech'];
  const bad = (reason, field, kind = 'validation') => ({ ok: false, reason, kind, field });

  function validateCmd(cmd, cfg = LAB.config) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return bad('Comando sin tipo.', 'type');
    const num = (v, name) => (isNum(v) ? null : bad(`${name} no es un número finito.`, name));
    switch (cmd.type) {
      case 'sim.speed': return cfg.speeds.includes(cmd.speed) ? null : bad(`Velocidad no admitida (${cfg.speeds.join(', ')}).`, 'speed');
      case 'sim.play': return typeof cmd.on === 'boolean' || cmd.toggle === true ? null : bad('Valor de reloj no válido.', 'on');
      case 'sim.time': return num(cmd.ms, 'La hora') || (cmd.ms < Date.UTC(2000, 0, 1) || cmd.ms > Date.UTC(2100, 0, 1) ? bad('Fecha fuera de 2000–2100.', 'ms') : null);
      case 'sim.cloud': return num(cmd.value, 'La nubosidad') || (cmd.value < 0 || cmd.value > 1 ? bad('La nubosidad debe estar entre 0 y 100 %.', 'cloud') : null);
      case 'sim.wind': return num(cmd.value, 'El viento') || (cmd.value < 0 || cmd.value > cfg.limits.windMax ? bad(`El viento medio debe estar entre 0 y ${cfg.limits.windMax} m/s.`, 'wind') : null);
      case 'sim.gust': return num(cmd.peak, 'El pico') || num(cmd.seconds, 'La duración') || (cmd.peak < 5 || cmd.peak > 40 || cmd.seconds < 1 || cmd.seconds > 60 ? bad('Ráfaga fuera de 5–40 m/s y 1–60 s.', 'peak') : null);
      case 'sim.rain': { const l = cmd.level != null ? cmd.level : (cmd.on ? 2 : 0); return Number.isInteger(l) && l >= 0 && l < RAIN_LEVELS ? null : bad('Nivel de lluvia no válido.', 'level'); }
      case 'sim.seed': return Number.isInteger(cmd.seed) && cmd.seed >= 0 && cmd.seed < 4294967296 ? null : bad('La semilla debe ser un entero entre 0 y 4294967295.', 'seed');
      case 'tracker.target': {
        if (cmd.az == null && cmd.tilt == null) return bad('Indica un azimut, una inclinación o ambos.', 'az');
        if (cmd.az != null && !isNum(cmd.az)) return bad('El azimut no es un número finito.', 'az');
        if (cmd.tilt != null && !isNum(cmd.tilt)) return bad('La inclinación no es un número finito.', 'tilt');
        return null;
      }
      case 'tracker.mode': return MODES.includes(cmd.mode) ? null : bad('Modo de seguidor desconocido.', 'mode');
      case 'tracker.locks': return null;
      case 'load.set': {
        if (!LOAD_MODES.includes(cmd.mode)) return bad('Modo de carga desconocido.', 'mode');
        if (cmd.setpoint != null) {
          if (!isNum(cmd.setpoint)) return bad('La consigna no es un número finito.', 'setpoint');
          if (cmd.mode === 'cv' && (cmd.setpoint < CV_MIN || cmd.setpoint > CV_MAX)) return bad(`La tensión debe estar entre ${CV_MIN * 100} y ${CV_MAX * 100} % de Voc.`, 'setpoint');
          if (cmd.mode === 'cr' && (cmd.setpoint < CR_MIN || cmd.setpoint > CR_MAX)) return bad(`La resistencia debe estar entre ${CR_MIN} y ${CR_MAX} Ω.`, 'setpoint');
          const bank = cfg.load && cfg.load.bank;
          if (cmd.mode === 'cr' && bank && !bank.some((r) => Math.abs(r - cmd.setpoint) < 1e-9)) return bad(`Con banco de cargas solo se admiten las resistencias disponibles (${bank.join(', ')} Ω).`, 'setpoint');
        }
        return null;
      }
      case 'session.start': return ROLES.includes(cmd.role) ? null : bad('Rol de demostración desconocido.', 'role');
      case 'safety.estop': case 'safety.reset': case 'safety.ack': case 'session.end': case 'acq.start': case 'acq.stop': case 'acq.newRun':
      case 'load.sweep': case 'load.sweep.abort': case 'sim.comms': case 'sim.resetEnergy': case 'sim.resetRain': case 'scenario.apply': case 'acq.discard':
        return null;
      case 'replay.play': case 'replay.pause': return null;
      case 'replay.seek': return num(cmd.ms, 'La posición');
      case 'replay.speed': return cfg.speeds.includes(cmd.speed) || cmd.speed === 0.5 ? null : bad('Velocidad de reproducción no admitida.', 'speed');
      default: return bad(`Comando desconocido: ${cmd.type}`, 'type');
    }
  }

  /** ¿Admite la fuente este tipo de comando? 'sim' admite todos los de simulador y banco; 'real' solo los del banco; 'replay' solo replay.* */
  function admits(source, type) {
    if (source === 'sim') return REAL.includes(type) || SIM_ONLY.includes(type);
    if (source === 'real' || source === 'ws') return REAL.includes(type);
    if (source === 'replay') return REPLAY.includes(type);
    return false;
  }

  LAB.core.validateCmd = validateCmd;
  LAB.core.cmdAdmits = admits;
  LAB.core.CMD = { REAL, SIM_ONLY, REPLAY, MODES, LOAD_MODES, CR_MIN, CR_MAX, CV_MIN, CV_MAX };
})();
