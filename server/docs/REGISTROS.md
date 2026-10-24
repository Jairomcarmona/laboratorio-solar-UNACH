# Mapa de registros del PLC (PROVISIONAL)

> **Provisional hasta O5.** La especificación definitiva de control y seguridad para el PLC la entrega la tarea O5 y la firma la persona responsable de ingeniería. Este mapa lo usan hoy el banco virtual y el controlador Modbus; cambiar de PLC (Siemens S7-1200 recomendado, no confirmado) es cambiar `server/labsolar/bridge/registers.py` o el YAML de direcciones, no el puente.

Generado desde `registers.py`. Modbus TCP, unidad 1; enteros de 16 bits sin signo; ángulos en centésimas (×100).

## Registros de entrada (FC4, solo lectura desde el puente)

| Dirección | Nombre |
|---|---|
| 0 | `IR_HB_ECHO` |
| 1 | `IR_STATE` |
| 2 | `IR_APPLIED_MODE` |
| 3 | `IR_AZ` |
| 4 | `IR_TILT` |
| 5 | `IR_TARGET_AZ` |
| 6 | `IR_TARGET_TILT` |
| 7 | `IR_FLAGS` |
| 8 | `IR_FAULT_CODE` |
| 9 | `IR_WIND` |
| 10 | `IR_CMD_SEQ_ECHO` |
| 11 | `IR_AZ_MIN` |
| 12 | `IR_AZ_MAX` |
| 13 | `IR_TILT_MIN` |
| 14 | `IR_TILT_MAX` |
| 15 | `IR_REJECT_CODE` |
| 16 | `IR_LOAD_MODE` |
| 17 | `IR_LOAD_SETPOINT` |
| 18 | `IR_SWEEP_STATE` |

## Registros de retención (FC3/FC6/FC16, escritos por el puente)

| Dirección | Nombre |
|---|---|
| 0 | `HR_HB` |
| 1 | `HR_CMD_SEQ` |
| 2 | `HR_REQ_AZ` |
| 3 | `HR_REQ_TILT` |
| 4 | `HR_REQ_MASK` |
| 5 | `HR_REQ_MODE` |
| 6 | `HR_REQ_LOCKS` |
| 10 | `HR_LOAD_MODE` |
| 11 | `HR_LOAD_SETPOINT` |
| 12 | `HR_LOAD_SEQ` |

## Máscara de solicitud (`HR_REQ_MASK`)

| Bit | Nombre |
|---|---|
| 0 | `REQ_AZ` |
| 1 | `REQ_TILT` |
| 2 | `REQ_MODE` |
| 3 | `REQ_LOCKS` |
| 4 | `REQ_STOP` |
| 5 | `REQ_ACK` |
| 6 | `REQ_LINK_LOST` |

## Estados y modos

- Estados (`IR_STATE`): 0=NORMAL, 1=WIND_STOW, 2=COMMS_STOW, 3=ESTOP, 4=FAULT
- Modos (`IR_APPLIED_MODE`): 0=manual, 1=astro, 2=sensor, 3=fixed, 4=night, 5=stow, 6=estop

## Reglas que el PLC debe cumplir (el resto del sistema solo las refleja)

1. El PLC es la autoridad final: valida rangos, rampas y finales de carrera, aunque el puente, la pasarela y el navegador ya lo hayan hecho.
2. **Watchdog:** el puente escribe `HR_HB` alternando un valor y el PLC lo devuelve en `IR_HB_ECHO`. Si deja de cambiar, el PLC entra solo a `COMMS_STOW` (posición segura) sin intervención de nadie.
3. Una solicitud se aplica cuando `HR_CMD_SEQ` cambia; el PLC responde `IR_CMD_SEQ_ECHO` y, si la rechaza, `IR_REJECT_CODE`.
4. El paro de emergencia físico corta energía por cableado y **no pasa por este mapa**. Solo el personal en sitio lo restablece (llave).
5. Viento sobre el umbral: el PLC lleva el seguidor a posición segura y la libera con histéresis (ver `docs/CONTRATO_DATOS.md`).
6. Los límites del seguidor (`IR_AZ_MIN` etc.) los publica el PLC; el puente y el navegador solo guardan una copia informativa.

## Pendiente de la especificación O5

Direcciones definitivas, tiempos del watchdog, rampas, política de reintentos, códigos de falla (`IR_FAULT_CODE`, `IR_REJECT_CODE`) y el programa del PLC (diagramas de enclavamientos) están **sin especificar**: no se inventaron.
