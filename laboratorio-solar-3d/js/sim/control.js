/* Seguidor solar de dos ejes: modos manual, fijo, astronomico y por sensores, bloqueo de ejes,
 * finales de carrera, rampas de los motorreductores y posicion segura. */
(function () {
  'use strict';
  const { clamp, angDiff, D2R, R2D } = LAB.util;
  const cfg = LAB.config.tracker;
  const S = LAB.sim.solar;

  const MODES = {
    manual: 'Manual / remoto', fixed: 'Fijo (mantener)', astro: 'Astronómico', sensor: 'Por sensores',
  };

  class Tracker {
    constructor() {
      this.az = 180; this.tilt = 17;
      this.vAz = 0; this.vTilt = 0;                 // velocidades actuales (deg/s)
      this.targetAz = 180; this.targetTilt = 17;
      this.mode = 'manual';
      this.lockAz = false; this.lockTilt = false;  // modos de un solo eje
      this.holdAz = 180; this.holdTilt = 17;       // valor del eje inmovilizado
      this.sensor = { lock: false, state: 'IDLE', errX: 0, errY: 0 };
      this.northSide = null;                       // lado elegido cuando el Sol pasa al norte (ver astroOrientation)
      this.limitHit = { az: 0, tilt: 0 };          // contadores de final de carrera
      this.powerW = 0;
      this.stowing = false;
      this.enabled = true;                         // false con paro de emergencia
      this.moving = { az: false, tilt: false };
    }

    get limits() { return { azMin: cfg.azMin, azMax: cfg.azMax, tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax }; }
    inRange(az, tilt) { return az >= cfg.azMin && az <= cfg.azMax && tilt >= cfg.tiltMin && tilt <= cfg.tiltMax; }

    setMode(mode) {
      this.mode = mode;
      if (mode === 'fixed') { this.targetAz = this.az; this.targetTilt = this.tilt; }
    }
    setTarget(az, tilt) {
      if (az != null && !this.lockAz) this.targetAz = az;
      if (tilt != null && !this.lockTilt) this.targetTilt = tilt;
    }
    setLocks(lockAz, lockTilt) {
      this.lockAz = lockAz; this.lockTilt = lockTilt;
      if (lockAz) { this.holdAz = this.targetAz; }
      if (lockTilt) { this.holdTilt = this.targetTilt; }
    }

    /** Orientacion astronomica alcanzable dentro de los finales de carrera (az en [azMin, azMax]).
     *  En Tuxtla el Sol pasa al norte de la linea este-oeste del 24 de marzo al 17 de septiembre (cerca del mediodia del 3 de mayo
     *  al 8 de agosto): ahi el azimut del Sol no es alcanzable y el mejor es un final de carrera.
     *  Se elige el lado del que esta el Sol (este del norte -> azMin, oeste del norte -> azMax) y se cambia solo al cruzar el norte
     *  con una banda de histeresis, sin oscilar. La inclinacion es la que minimiza el angulo de incidencia PARA ESE azimut
     *  (antes era el cenit del Sol aunque el plano no mirara al Sol). Ley provisional: la especificacion definitiva es O5. */
    astroOrientation(sun) {
      let tAz;
      if (sun.az >= cfg.azMin && sun.az <= cfg.azMax) { tAz = sun.az; this.northSide = null; }
      else {
        const d = angDiff(sun.az, 0);                    // + al este del norte, - al oeste
        let side = this.northSide;
        if (side == null) side = Math.abs(this.az - cfg.azMin) <= Math.abs(this.az - cfg.azMax) ? cfg.azMin : cfg.azMax;
        if (Math.abs(d) > cfg.northHystDeg) side = d >= 0 ? cfg.azMin : cfg.azMax;
        this.northSide = side; tAz = side;
      }
      const el = sun.el * D2R;
      const tilt = Math.atan2(Math.cos(el) * Math.cos((sun.az - tAz) * D2R), Math.sin(el)) * R2D;
      return { tAz, tTilt: clamp(tilt, cfg.tiltMin, cfg.tiltMax) };
    }

    /** Calcula los objetivos de cada eje segun el modo. ctx: {sun, irr, stow} */
    computeTargets(dt, ctx) {
      const sun = ctx.sun;
      let tAz = this.targetAz, tTilt = this.targetTilt;
      this.sensor.state = 'IDLE';

      if (ctx.stow) {
        tAz = cfg.stow.az; tTilt = cfg.stow.tilt;
        this.stowing = true;
      } else {
        this.stowing = false;
        if (this.mode === 'astro' || this.mode === 'sensor') {
          if (sun.el < 2) {                         // noche: estacionamiento horizontal mirando al este
            tAz = 90; tTilt = 0; this.sensor.state = 'NIGHT';
          } else if (this.mode === 'astro') {
            ({ tAz, tTilt } = this.astroOrientation(sun));
          } else {
            ({ tAz, tTilt } = this.sensorTargets(dt, ctx, tAz, tTilt));
          }
          if (this.lockAz) tAz = this.holdAz;
          if (this.lockTilt) tTilt = this.holdTilt;
        } else {
          if (this.lockAz) tAz = this.holdAz;
          if (this.lockTilt) tTilt = this.holdTilt;
        }
      }
      this.targetAz = tAz; this.targetTilt = tTilt;
    }

    /** Seguimiento por sensor de cuatro cuadrantes: corrige segun el error medido en el plano del modulo */
    sensorTargets(dt, ctx, tAz, tTilt) {
      const sun = ctx.sun;
      const s = S.sunVector(sun.az, sun.el);
      const n = S.normalVector(this.az, this.tilt);
      const g = this.az * D2R, b = this.tilt * D2R;
      const ex = [Math.cos(g), 0, Math.sin(g)];
      const ey = [Math.cos(b) * Math.sin(g), -Math.sin(b), -Math.cos(b) * Math.cos(g)];
      const cosAoi = S.dot(s, n);
      const beamOk = ctx.irr.dni > 140;
      const errX = Math.asin(clamp(S.dot(s, ex), -1, 1)) * R2D;
      const errY = Math.asin(clamp(S.dot(s, ey), -1, 1)) * R2D;
      this.sensor.errX = errX; this.sensor.errY = errY;
      if (cosAoi < 0.34) {                          // fuera del campo de vision (~70 deg): adquisicion con efemerides
        this.sensor.state = 'ACQUIRE'; this.sensor.lock = false;
        return this.astroOrientation(sun);
      }
      if (!beamOk) {                                // nube: el sensor pierde la senal, se mantiene la posicion
        this.sensor.state = 'NO_SIGNAL'; this.sensor.lock = false;
        return { tAz: this.az, tTilt: this.tilt };
      }
      this.sensor.lock = true;
      this.sensor.state = 'TRACK';
      const dead = 0.35;
      const sinB = Math.max(Math.sin(b), 0.18);
      const dAz = Math.abs(errX) > dead ? errX / sinB : 0;
      const dTilt = Math.abs(errY) > dead ? errY : 0;
      return { tAz: this.az + clamp(dAz, -30, 30), tTilt: this.tilt + clamp(dTilt, -20, 20) };
    }

    axisStep(pos, vel, target, rate, accel, dt, min, max) {
      if (!this.enabled) return { pos, vel: 0, hit: false };
      const t = clamp(target, min, max);
      const err = t - pos;
      let desired = clamp(err * 2.2, -rate, rate);
      if (Math.abs(err) < 0.02) desired = 0;
      vel += clamp(desired - vel, -accel * dt, accel * dt);
      let np = pos + vel * dt;
      if ((err > 0 && np > t) || (err < 0 && np < t)) { np = t; vel = 0; }
      let hit = false;
      if (np <= min) { np = min; if (vel < 0) { vel = 0; hit = true; } }
      if (np >= max) { np = max; if (vel > 0) { vel = 0; hit = true; } }
      return { pos: np, vel, hit };
    }

    /** dt en segundos FISICOS. H01: los motores tienen su velocidad real; al acelerar el reloj se calculan mas pasos, no motores mas rapidos */
    update(dt, ctx) {
      this.computeTargets(dt, ctx);
      const k = 1;
      const stowK = this.stowing ? 1.4 : 1;
      const ra = cfg.azRate * k * stowK, rt = cfg.tiltRate * k * stowK;
      const a = this.axisStep(this.az, this.vAz, this.targetAz, ra, ra * 1.6, dt, cfg.azMin, cfg.azMax);
      const t = this.axisStep(this.tilt, this.vTilt, this.targetTilt, rt, rt * 1.6, dt, cfg.tiltMin, cfg.tiltMax);
      this.az = a.pos; this.vAz = a.vel; this.tilt = t.pos; this.vTilt = t.vel;
      if (a.hit) this.limitHit.az++;
      if (t.hit) this.limitHit.tilt++;
      this.moving.az = Math.abs(this.vAz) > 0.05;
      this.moving.tilt = Math.abs(this.vTilt) > 0.05;
      this.powerW = 4 + cfg.motorPowerW * (Math.abs(this.vAz) / (cfg.azRate * k) + Math.abs(this.vTilt) / (cfg.tiltRate * k)) * 0.5;
      if (!this.enabled) this.powerW = 0;
    }
  }

  LAB.sim.Tracker = Tracker;
  LAB.sim.TRACKER_MODES = MODES;
})();
