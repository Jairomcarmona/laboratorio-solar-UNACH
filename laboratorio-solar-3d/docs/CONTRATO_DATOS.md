# Contrato de datos y comandos (fuente `sim` ↔ interfaz ↔ futura fuente real)

La escena 3D y la interfaz **solo** conocen esta interfaz (`js/data/dataSource.js`):

| Elemento | Descripción |
|---|---|
| `source.telemetry` | Instantánea del estado (esquema abajo). Se actualiza en cada `step`. |
| `source.step(dt)` | Avanza la fuente. El simulador calcula; una fuente real solo procesa mensajes. |
| `source.send(cmd)` | Ejecuta un comando. Devuelve `{ok, reason?, kind?, field?}`. **Un comando rechazado no muta el estado.** `kind`: `validation` (tipo/rango), `interlock` (permiso, sesión, seguridad), `internal`. |
| `source.on(evt, fn)` | Eventos: `log`, `sweep`, `acq`, `run`, `session`. |
| `source.exportCsv([runId])` | Resultado de aplicación `{ok, rows, runId, filename, text, mime}` o `{ok:false, reason}`. |
| `source.exportSweepCsv([id])` | Igual, para un barrido conservado. |
| `source.runs`, `source.sweeps`, `source.sessionsArchive`, `source.getRun(id)` | Conjuntos conservados (solo simulador). |

## Cambios de la versión 2.0.0-fase-A respecto a la anterior

* **Rechazado sin mutar:** los comandos se validan (tipos finitos, rangos, modos) *antes* de tocar el estado.
* **Eliminados de la telemetría:** `gain` (mezclaba potencia instantánea con energía acumulada). Sustituido por `comparison`.
* **`sim.resetEnergy`** ya no borra el registro ni la lluvia: abre un **segmento** nuevo. La lluvia se pone a cero con `sim.resetRain`.
* **`sim.time`** (salto del reloj) abre un segmento y corta las gráficas; no pone la energía a cero.
* **`session.start`** acepta `profileId`; la sesión nueva **no hereda** corridas ni muestras de la anterior.
* **`session.end`** detiene la adquisición, conserva las corridas y devuelve `final` (estado en ese instante; `trackerMoving` indica si la posición final aún no se alcanzó).
* El ruido de medición es **determinista**: `hashNoise(seed, bucket_de_tiempo_real, canal)`; no usa `Math.random`.

## Comandos

Entorno (solo simulador): `sim.speed {speed}`, `sim.play {on}` o `sim.play {toggle:true}` (**pausa el reloj solar**, no el banco; el interruptor lo resuelve el motor, no la copia local de la telemetría), `sim.time {ms}`, `sim.cloud {value 0–1}`, `sim.wind {value 0–25 m/s}` (consigna del viento **medio**), `sim.gust {peak 5–40, seconds 1–60}`, `sim.rain {level 0–4}`, `sim.seed {seed}`, `sim.comms {connected}`, `sim.resetEnergy`, `sim.resetRain`.

Escenario: `scenario.apply {scenario:{id, simMs, cloud, windBase, seed, az, tilt, speed}}` — aplica de forma **atómica** fecha/hora, nubes, viento medio, semilla, posición inicial, energía a cero, reloj meteorológico y generador de ruido. Se rechaza si hay paro, posición segura, watchdog, enlace cortado, barrido en curso, sin sesión o sin permiso de operar.

Seguridad: `safety.estop {who}`, `safety.reset` (en el banco real solo lo hace el técnico en sitio; aquí es una **intervención simulada**), `safety.ack`.

Sesión: `session.start {role, user, profileId}`, `session.end {why?}`.

Adquisición: `acq.start`, `acq.stop`, `acq.newRun {label?, practiceId?}`, `acq.discard {runId}`.

Operación (pasan por el interlock): `tracker.target {az?, tilt?}`, `tracker.mode {mode}`, `tracker.locks {lockAz, lockTilt}`, `load.set {mode, setpoint?}`, `load.sweep`, `load.sweep.abort`.

Rangos de carga: `cv` 5–100 % de Voc (`setpoint` 0.05–1), `cr` 0.4–30.4 Ω. Rangos del seguidor: azimut 90°–270°, inclinación 0°–90° (`LAB.config.tracker`; los controles de la interfaz leen los mismos).

## Telemetría (campos nuevos o cambiados)

```
settings   { cloud, windBase, rainLevel, speed, clockPlaying, seed, scenarioId }      consignas (lo que se PIDIÓ)
env        { ghi, dni, dhi, ta, rh, wind, windDir, cloud, rain, rainLevel, rainRate, rainMm }   mediciones (lo que HAY)
clock      { playing, speed, simMs, tzHours }
A / B      { ..., poa (medida con ruido), poaTrue, wh, p, v, i, tcell, curve }
comparison { powerDiffPct, energyGainPct, netGainPct, powerNote, energyNote }         null cuando no hay referencia suficiente
energy     { A, B, motor, startedSimMs, resets }
tracker    { requestedMode, appliedMode, blockCause, mode(alias), ... }               appliedMode ∈ manual|astro|sensor|fixed|night|stow|estop
safety     { state, canOperate, blockReason, resumeIn, session, ... }
session    { active, id, user, role, roleLabel, profileId, demo:true }
acq        { status: 'stopped'|'recording', runId, segmentId, samples, limit, elapsedReal, reason, everyS, basis, runs }
load       { mode, setpoint, sweeping, sweepT, sweepSeconds }
```

* `comparison.powerDiffPct = P_B/P_A − 1` (instantánea; `null` si P_A < 5 W).
* `comparison.energyGainPct = E_B/E_A − 1` (desde el último cero de energía; `null` si E_A < 1 Wh).
* `comparison.netGainPct = (E_B − E_motores)/E_A − 1`.
* La interfaz muestra `null` como «No disponible» con el motivo; nunca «−0.0 %».

## Modelo de datos adquiridos

* **Sesión** → una identidad de demostración local y su periodo (`id` propio, `profileId`).
* **Corrida** (`labsolar-run`) → conjunto de muestras adquiridas; `id` propio; estado `open|stopped|limit|closed`.
* **Segmento** → tramo continuo dentro de una corrida. Se abre al iniciar/reanudar la adquisición, poner la energía a cero, aplicar un escenario o saltar el reloj.
* **Muestra** → una por segundo **de tiempo real del navegador** (`acq.basis`), no de tiempo simulado. Columnas en `LAB.core.RUN_COLS`.
* **Límite** → 20 000 muestras por corrida. Al llegar: advertencia en bitácora, la adquisición **se detiene** (no se trunca en silencio) y `acq.reason = 'limite'`. Reanudar crea una corrida nueva.
* **Barrido** (`labsolar-sweep`) → `id`, `sessionId`, `runId?`, `status` (`complete|interrupted`), `cause`, `cond.start/end` (irradiancia, temperatura, nubes, viento, orientación), `pts.A/B` (puntos medidos) y `model` (curva calculada al terminar, solo referencia).

## Fase C: escenarios comparables, análisis y reporte

* `scenario.apply` (sin cambios de contrato) reinicia reloj, nubes, viento medio, rachas, temperaturas, posición del seguidor, carga y acumuladores; la semilla fija el ruido.
* Cada segmento de una corrida guarda `start`, `end` y `ctx` (ver `FORMATO_PERSISTIDO.md`).
* Funciones puras en `js/core/analysis.js` (no leen telemetría viva): `runSummary`, `runAlterations`, `runConditions`, `compareRuns`, `runAnnotations`, `runSeries`, `runSliceCsv`, `sweepConditionDiffs`, `ratioPct`.
* **Fórmulas** (energías en Wh, referencia = módulo A fijo de la misma corrida): ganancia de energía = (E_B/E_A − 1)×100; ganancia neta = ((E_B − E_motores)/E_A − 1)×100; diferencia de potencia ahora = (P_B/P_A − 1)×100. Si E_A < 1 Wh el resultado es `null` con motivo («No disponible»); nunca se muestra −0.0 %.
* **Comparabilidad**: dos corridas son comparables si coinciden escenario, semilla, fecha simulada, nubes y viento medio y ninguna está alterada (salto de reloj, reanudación, escenario a mitad, reinicio de contadores, intervención de seguridad, límite). Lo que puede variar a propósito es el modo de seguimiento y el eje inmovilizado.
* `js/ui/report.js` genera el reporte HTML autocontenido a partir de evidencia congelada.

## Fuente real (pendiente)

Una fuente MQTT/API debe publicar la misma telemetría y aceptar los mismos comandos. Los límites críticos y la validación final **siempre** viven en el controlador local; la validación del cliente es solo comodidad.
