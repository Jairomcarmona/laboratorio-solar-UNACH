/* Seguridad y permisos. Reproduce la logica que, en el banco real, vive en el controlador local:
 * paro de emergencia, posicion segura por viento, watchdog de comunicacion, interlock de sesion,
 * limites de maniobra y registro de eventos. El usuario remoto no puede modificar estos limites. */
(function () {
  'use strict';
  const cfg = LAB.config.safety;
  const TC = LAB.config.tracker;

  const ROLES = {
    visitor: { label: 'Visitante', canOperate: false },
    student: { label: 'Estudiante', canOperate: true },
    teacher: { label: 'Docente', canOperate: true },
    tech: { label: 'Técnico (en sitio)', canOperate: true },
  };

  class Safety {
    constructor(log) {
      this.log = log;
      this.estop = false;
      this.windStow = false;
      this.windHighT = 0;       // s reales con viento sobre el umbral
      this.windLowSim = 0;      // s simulados con viento bajo el umbral de reanudacion
      this.commsCut = false;    // el usuario simula el corte del enlace
      this.commsAge = 0;        // s reales sin latido
      this.watchdogTrip = false;
      this.session = { active: false, id: null, profileId: null, role: null, user: null, since: null };
      this.limitWarn = '';
      this.resumeIn = 0;        // s simulados que faltan para levantar la posicion segura por viento
    }

    get role() { return this.session.active ? ROLES[this.session.role] : null; }

    /** Estado global: NORMAL, WIND_STOW, COMMS_STOW, ESTOP */
    get state() {
      if (this.estop) return 'ESTOP';
      if (this.watchdogTrip) return 'COMMS_STOW';
      if (this.windStow) return 'WIND_STOW';
      return 'NORMAL';
    }
    get lamp() {
      if (this.estop) return 'red';
      if (this.watchdogTrip || this.windStow) return 'amber';
      return 'green';
    }
    get stowRequired() { return this.windStow || this.watchdogTrip; }

    update(dtReal, dtSim, wind, simMs) {
      this.lastWind = wind;
      // viento
      if (!this.windStow) {
        this.windHighT = wind >= cfg.windStow ? this.windHighT + dtReal : 0;
        if (this.windHighT >= 1.5) {
          this.windStow = true; this.windLowSim = 0;
          this.log('warn', `Viento ${wind.toFixed(1)} m/s ≥ ${cfg.windStow} m/s: el controlador local lleva el seguidor a posición segura.`, 'Seguridad');
        }
      } else {
        this.windLowSim = wind < cfg.windResume ? this.windLowSim + Math.max(dtSim, dtReal) : 0;
        this.resumeIn = wind < cfg.windResume ? Math.max(0, cfg.windHoldSimSec - this.windLowSim) : cfg.windHoldSimSec;
        if (this.windLowSim >= cfg.windHoldSimSec) {
          this.windStow = false; this.resumeIn = 0;
          this.log('ok', 'Viento por debajo del umbral de reanudación: se levanta la posición segura.', 'Seguridad');
        }
      }
      // watchdog de comunicacion
      if (this.commsCut) {
        this.commsAge += dtReal;
        if (!this.watchdogTrip && this.commsAge >= cfg.commsTimeoutS) {
          this.watchdogTrip = true;
          this.log('bad', `Watchdog: ${cfg.commsTimeoutS} s sin latido del cliente. Posición segura y comandos bloqueados.`, 'Seguridad');
        }
      } else {
        this.commsAge = 0;
      }
    }

    pressEstop(who = 'Operador') {
      if (this.estop) return;
      this.estop = true;
      this.log('bad', `PARO DE EMERGENCIA accionado (${who}). Motores sin energía, carga desconectada.`, 'Seguridad');
    }
    resetEstop() {
      if (!this.estop) return false;
      this.estop = false;
      this.log('ok', 'Intervención del técnico SIMULADA: paro de emergencia restablecido. En el banco real solo lo hace personal en sitio con la llave.', 'Seguridad');
      return true;
    }
    setComms(connected) {
      if (this.commsCut === !connected) return;
      this.commsCut = !connected;
      if (!connected) this.log('warn', 'Enlace con el cliente interrumpido (simulado). El watchdog está contando.', 'Red');
      else this.log('ok', 'Enlace restablecido.' + (this.watchdogTrip ? ' El sistema sigue en posición segura hasta que se reconozca la falla.' : ''), 'Red');
    }
    acknowledgeFault() {
      if (!this.watchdogTrip) return false;
      if (this.commsCut) return false;
      this.watchdogTrip = false;
      this.log('ok', 'Falla de comunicación reconocida. Se reanudan los comandos.', 'Seguridad');
      return true;
    }

    startSession(role, user, id, profileId) {
      this.session = { active: true, id: id || null, profileId: profileId || null, role, user: user || ROLES[role].label, since: Date.now() };
      this.log('ok', `Sesión de demostración iniciada: ${this.session.user} (${ROLES[role].label}). El rol es local y no es una autenticación.`, 'Acceso');
    }
    endSession() {
      if (!this.session.active) return;
      this.log('info', 'Sesión finalizada. El banco queda en la condición que tenía en ese momento.', 'Acceso');
      this.session = { active: false, id: null, profileId: null, role: null, user: null, since: null };
    }


    /** Texto de por qué sigue la posición segura por viento y qué falta para levantarla (el usuario no debe creer que quedó atascada) */
    windResumeText() {
      const w = this.lastWind != null ? this.lastWind : 0;
      if (w >= cfg.windResume) return `El viento actual (${w.toFixed(1)} m/s) sigue por encima de ${cfg.windResume} m/s: la posición segura se levanta cuando baje de ${cfg.windResume} m/s y se mantenga ${cfg.windHoldSimSec} s simulados.`;
      return `Viento ${w.toFixed(1)} m/s (< ${cfg.windResume}): se levanta en ${Math.ceil(this.resumeIn)} s simulados si se mantiene bajo.`;
    }

    /** Por que se rechazaria hoy un comando de operacion ('' si se aceptaria). Sirve para avisar antes de acumular rechazos. */
    blockReason() {
      if (this.estop) return 'Paro de emergencia activo: solo el técnico en sitio puede restablecerlo (aquí puedes simularlo).';
      if (!this.session.active) return 'No hay sesión: inicia una sesión de demostración para operar.';
      if (!ROLES[this.session.role].canOperate) return 'Tu rol (Visitante) es de solo observación.';
      if (this.watchdogTrip) return 'Watchdog activo: restablece el enlace y reconoce la falla.';
      if (this.windStow) return `Posición segura por viento activa (umbral ${cfg.windStow} m/s). ${this.windResumeText()}`;
      return '';
    }

    /** Valida un comando de movimiento o de carga antes de ejecutarlo */
    allow(kind, args = {}) {
      if (this.estop) return { ok: false, reason: 'Paro de emergencia activo: solo el personal en sitio puede restablecerlo.' };
      if (kind === 'ack') return { ok: true };
      if (!this.session.active) return { ok: false, reason: 'Interlock: no hay sesión activa. Inicia sesión y reserva para operar.' };
      if (!ROLES[this.session.role].canOperate) return { ok: false, reason: 'Tu rol (Visitante) es de solo observación.' };
      if (this.watchdogTrip) return { ok: false, reason: 'Watchdog activo: reconoce la falla de comunicación tras restablecer el enlace.' };
      if (kind === 'move' || kind === 'mode') {
        if (this.windStow) return { ok: false, reason: `Posición segura por viento activa (umbral ${cfg.windStow} m/s). ${this.windResumeText()}` };
      }
      if (kind === 'move') {
        const { az, tilt } = args;
        if (az != null && (az < TC.azMin || az > TC.azMax))
          return { ok: false, reason: `Azimut ${az.toFixed(0)}° fuera del rango autorizado (${TC.azMin}°–${TC.azMax}°).` };
        if (tilt != null && (tilt < TC.tiltMin || tilt > TC.tiltMax))
          return { ok: false, reason: `Inclinación ${tilt.toFixed(0)}° fuera del rango autorizado (${TC.tiltMin}°–${TC.tiltMax}°).` };
      }
      return { ok: true };
    }
  }

  LAB.sim.Safety = Safety;
  LAB.sim.ROLES = ROLES;
})();
