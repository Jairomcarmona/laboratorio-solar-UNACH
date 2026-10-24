# Formato persistido y migraciones

`schemaVersion` actual: **2**. `appVersion`: ver `LAB.config.appVersion`.

## Dónde se guarda

| Qué | Dónde | Clave |
|---|---|---|
| Progreso (prácticas, respuestas, evidencia) | `localStorage` | `labsolar.v2.<profileId>.progress` |
| Corridas y barridos | `IndexedDB` `labsolar-unach` | almacenes `runs`, `sweeps` |
| Criterio anterior (solo lectura) | `localStorage` | `labsolar.practices` → se convierte a `status: 'completed_legacy'` |

`profileId = 'u' + hash(rol | nombre en minúsculas)`. **No es una cuenta**: dos personas que escriban el mismo rol y nombre comparten el avance. El aislamiento entre perfiles evita mezclar datos en un equipo compartido, no protege nada.

## Progreso (`kind: "labsolar-progress"`)

```json
{
  "schemaVersion": 2, "appVersion": "...", "kind": "labsolar-progress", "profileId": "...", "updatedAtUtc": "...",
  "activePractice": "p1" | null,
  "practices": {
    "p1": {
      "practiceId": "p1", "defVersion": 2, "status": "in_progress|completed|completed_legacy", "source": "sim",
      "createdAtUtc": "...", "updatedAtUtc": "...", "completedAtUtc": "...", "completionVersion": 2,
      "sessionId": "...", "runIds": ["run_..."], "setupDone": true,
      "steps":   { "<stepId>": true },
      "answers": { "<questionId>": { "draft": "...", "submitted": "..." | null, "submittedAtUtc": "...", "dirty": false } },
      "evidence": { ... },                       // serializable; los Set se guardan como listas
      "closure": { "completedAtUtc", "completionVersion", "simLocal", "user", "role", "answers", "evidence", "runIds" } | null
    }
  }
}
```

* **Completada** = todos los pasos operativos obligatorios **y** todas las preguntas obligatorias registradas. Los pasos opcionales no cuentan.
* `closure` es una **copia congelada**: el reporte la usa, no la telemetría actual.
* `defVersion` guarda con qué definición de la práctica se trabajó; si la definición sube, la práctica en curso se marca (`outdated`) y las completadas conservan su versión.

## Corrida (`kind: "labsolar-run"`)

Ver `docs/CONTRATO_DATOS.md`. Campos: `id, sessionId, profileId, user, role, practiceId, label, createdAtUtc, closedAtUtc, status, site, appVersion, source, sampling{basis,everyS}, limit, seed, scenario, cols, samples, segments, events`.

### Campos añadidos en la fase C (todos opcionales: las corridas anteriores siguen cargando)

* **Segmento** (`run.segments[]`): además de `{id, startedSimMs, startedAtUtc, reason, firstSample}` ahora lleva
  `start: {eA, eB, motorWh, simMs}` (acumuladores al abrirse), `end: {eA, eB, motorWh, simMs, n}` (último valor visto) y
  `ctx: {trackerMode, lockAz, lockTilt, loadMode, cloud, windBase, speed, scenarioId, seed}` (condiciones del tramo).
  Con ellos `LAB.core.runSummary(run)` obtiene E_A, E_B, consumo de motores y ganancias **sumando segmentos**.
  Una corrida guardada con la versión anterior no tiene `start/end/ctx`: el resumen dice «No disponible» en vez de inventar valores.
* **Práctica** (`practices[id]`): `hints: {stepId: n}` (pistas pedidas, para no repetirlas) y, en `closure`:
  `incidents[]` (alarmas de la sesión al cerrar), `sweepIds[]` y `runs[]: [{id, n, summary}]` (número de muestras y resumen congelados).
  El reporte usa solo estos datos si la práctica está completada.
* La importación sigue validando tipo y versión; los campos nuevos no cambian `schemaVersion` porque son aditivos.

## Copia de seguridad (`kind: "labsolar-backup"`)

`{kind, schemaVersion, appVersion, exportedAtUtc, profileId, note, progress, runs[], sweeps[]}`. Al importar se **valida antes de usar**: tipo, versión (una versión mayor se rechaza), identificadores `[A-Za-z0-9_-]{1,64}`, forma de las muestras. Un archivo inválido se rechaza sin tocar el estado guardado.

## Migraciones

`store.js → migrate()`: hoy solo acepta v≤2 y normaliza. Al subir de versión se encadenan funciones `vN → vN+1`; un archivo de versión mayor a la conocida nunca se interpreta. Datos corruptos: se conserva una copia `…progress.corrupt.<ts>`, se empieza limpio y se avisa.

## Fallos de almacenamiento

Sin `localStorage` o con cuota agotada, la aplicación sigue funcionando en memoria y **lo dice** (`store.status.error`, indicador junto a la guía y en el listado de prácticas), ofreciendo exportar la copia JSON. `IndexedDB` no disponible: las corridas quedan en memoria; el CSV sigue disponible.
