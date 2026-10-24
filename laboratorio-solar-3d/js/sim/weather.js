/* Condiciones ambientales: temperatura, humedad, viento, nubosidad y lluvia (clima de Tuxtla Gutierrez). */
(function () {
  'use strict';
  const { clamp, noise1 } = LAB.util;

  // Climatologia aproximada de Tuxtla Gutierrez (medias mensuales ene..dic)
  const TMEAN = [23.5, 24.8, 26.8, 28.2, 28.4, 27.2, 26.8, 26.8, 26.2, 25.6, 24.6, 23.4];
  const TAMP = [6.5, 7.4, 8.0, 7.2, 5.8, 4.2, 4.6, 4.6, 4.2, 4.8, 5.6, 6.2];
  const RHBASE = [58, 52, 50, 55, 66, 77, 74, 75, 80, 77, 69, 62];

  // Niveles de lluvia: intensidad (mm/h), nubosidad minima, viento adicional (m/s) y parametros visuales
  const RAIN_LEVELS = [
    { name: 'Sin lluvia', mmh: 0, cloud: 0, wind: 0, op: 0, frac: 0, len: 0.4, fall: 14 },
    { name: 'Llovizna', mmh: 1.5, cloud: 0.8, wind: 0, op: 0.2, frac: 0.3, len: 0.3, fall: 10 },
    { name: 'Moderada', mmh: 7.5, cloud: 0.92, wind: 0.8, op: 0.32, frac: 0.6, len: 0.55, fall: 14 },
    { name: 'Fuerte', mmh: 25, cloud: 0.97, wind: 2.5, op: 0.42, frac: 0.85, len: 0.8, fall: 17 },
    { name: 'Tormenta', mmh: 60, cloud: 1, wind: 5, op: 0.52, frac: 1, len: 1.1, fall: 20 },
  ];

  class Weather {
    constructor() {
      this.cloud = 0.12;          // fraccion de cielo cubierto [0,1] (ajustable)
      this.windBase = 3.2;        // m/s, viento medio (ajustable)
      this.gustUntil = 0;         // s reales
      this.gustPeak = 0;
      this.rainOn = false;
      this.rainLevel = 0;
      this.rainMm = 0;
      this.realT = 0;
      this.wind = 3.2;
      this.windDir = 70;          // grados desde donde sopla
      this.Ta = 27;
      this.RH = 60;
      this.flicker = 0;
    }

    /** Restaura el estado dinamico (reloj del clima, rafagas, temperatura) para un escenario reproducible */
    reset(localT) {
      this.realT = 0; this.gustUntil = 0; this.gustPeak = 0; this.gustStart = 0;
      this.windDir = 70; this.flicker = 0;
      const m = localT.month - 1;
      this.Ta = TMEAN[m] + TAMP[m] * (1 - 0.45 * this.cloud) * Math.sin(2 * Math.PI * (localT.hours - 9.5) / 24);
      this.RH = clamp(RHBASE[m] - 2.8 * (this.Ta - TMEAN[m]) + 18 * this.cloud, 20, 100);
      this.wind = this.windBase;
    }

    triggerGust(peak = 19, seconds = 14) {
      this.gustPeak = peak;
      this.gustUntil = this.realT + seconds;
      this.gustStart = this.realT;
    }

    setRain(level) {
      this.rainLevel = Math.max(0, Math.min(RAIN_LEVELS.length - 1, Math.round(level) || 0));
      this.rainOn = this.rainLevel > 0;
      this.cloud = Math.max(this.cloud, RAIN_LEVELS[this.rainLevel].cloud);
    }
    get rainRate() { return RAIN_LEVELS[this.rainLevel].mmh; }

    update(dtReal, dtSim, localT, simSpeed) {
      this.realT += dtReal;
      const t = this.realT;
      // viento: base + turbulencia lenta + rafaga con rampa de subida y bajada
      let w = this.windBase * (1 + 0.28 * noise1(t / 6, 3) + 0.12 * noise1(t / 1.7, 8));
      if (t < this.gustUntil) {
        const u = (t - this.gustStart) / (this.gustUntil - this.gustStart);
        w = Math.max(w, this.gustPeak * Math.sin(Math.PI * clamp(u, 0, 1)) ** 0.6);
      }
      w += RAIN_LEVELS[this.rainLevel].wind * (1 + 0.3 * noise1(t / 4, 11));   // la lluvia fuerte viene con viento
      this.wind = clamp(w, 0, 40);
      this.windDir = (this.windDir + noise1(t / 20, 1) * 6 * dtReal + 360) % 360;

      // pasos de nube: se atenuan cuando el tiempo corre muy rapido (promedio)
      const sec = localT.hours * 3600;
      const amp = 1 / (1 + simSpeed / 60);
      this.flicker = amp * (noise1(sec / 170, 5) * 0.6 + noise1(sec / 45, 9) * 0.4);

      // temperatura y humedad: ciclo diario, menos amplitud con nubes y lluvia
      const m = localT.month - 1;
      const cloudDamp = 1 - 0.45 * this.cloud;
      let Ta = TMEAN[m] + TAMP[m] * cloudDamp * Math.sin(2 * Math.PI * (localT.hours - 9.5) / 24);
      if (this.rainOn) Ta -= 1 + 0.5 * this.rainLevel;
      this.Ta += (Ta - this.Ta) * (1 - Math.exp(-dtReal / 1.5));
      let RH = RHBASE[m] - 2.8 * (this.Ta - TMEAN[m]) + 18 * this.cloud;
      if (this.rainOn) RH = 96;
      this.RH = clamp(RH, 20, 100);

      this.rainMm += this.rainRate * dtSim / 3600;
    }
  }

  LAB.sim.Weather = Weather;
  LAB.sim.RAIN_LEVELS = RAIN_LEVELS;
})();
