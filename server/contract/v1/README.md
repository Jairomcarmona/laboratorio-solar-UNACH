# Contrato de mensajes v1

Es la única frontera entre la web, la pasarela, el puente y los servicios. Cada pieza solo conoce esto; el simulador del navegador, el banco virtual y el banco físico producen los mismos mensajes. Los JSON Schema (`*.schema.json`, draft 2020-12) son la fuente de verdad; `labsolar/contract.py` los valida y `tests/test_contract_examples.py` los prueba contra `examples/valid` e `examples/invalid` (se generan con `python tools/gen_examples.py`).

## Tópicos MQTT

Prefijo `labsolar/v1/<banco>/` (banco por omisión: `lab1`). Quien publica es el **único** usuario con permiso de escritura en la ACL (`deploy/mosquitto/acl`); `tests/test_hardware.py` comprueba que ACL y contrato coincidan.

| Tópico | Esquema | QoS | Retenido | Publica | Contenido |
|---|---|---|---|---|---|
| `tele` | `tele` | 0 | no | puente | Telemetría 1 Hz (`source`: `real`, `mixed`, `fake`, `sim`, `replay`, `twin`) |
| `state` | `state` | 1 | sí | puente | Estado del puente y del PLC (con testamento `offline`) |
| `event` | `event` | 1 | no | puente | Eventos del banco |
| `event/gw` | `event` | 1 | no | pasarela | Eventos de la pasarela (p. ej. `session.lost`). Tópico propio: la pasarela no puede suplantar eventos del puente |
| `cmd/req` | `req` | 1 | no | pasarela | Órdenes en nombre de una sesión validada |
| `cmd/ack` | `ack` | 1 | no | puente | Acuse (aceptado o rechazado con motivo) |
| `sweep` | `sweep` | 1 | no | puente | Barrido I-V |
| `twin` | `twin` | 0 | no | gemelo | Comparación banco frente a modelo |
| `hb/gateway` | `hb` | 0 | no | pasarela | Latido pasarela → puente (el puente va a posición segura si falta) |
| `daq/<nombre>` | — | — | no | usuario `daq` | Lecturas crudas de un equipo de adquisición externo (`daq.driver: mqtt`) |

El registrador lee todo lo que se registra (`tele`, `event`, `event/gw`, `cmd/req`, `cmd/ack`, `sweep`) y no escribe nada.

## Sobre del navegador (WebSocket)

`{"t": <tipo>, "v": 1, "d": <carga>}`. Tipos: `tele state event ack sweep twin hello bye cmd hb` (`envelope.schema.json`). Los comandos del navegador (`cmd`) los valida la pasarela con `cmd.schema.json` (JSON estricto, campos extra rechazados) y los reenvía como `req` con la sesión y el rol que fija el servidor, nunca el navegador.

## Versionado

- La versión va en el tópico (`v1`) y en el sobre (`"v": 1`). Un cambio incompatible crea `v2` (otro prefijo y otro directorio); `v1` no se rompe.
- Compatible hacia adelante: `tele`, `state` y `sweep` admiten campos adicionales; `cmd` y `req` **no** (`additionalProperties: false`).
- Añadir un valor a un `enum` de salida es compatible solo si los clientes lo toleran: `mixed` en `tele.source` se añadió así (la insignia de la web lo muestra como BANCO MIXTO).
- Todo cambio de esquema debe traer ejemplos válidos e inválidos nuevos y pasar la prueba de contrato.

## Detrás del contrato (interfaces con el hardware)

El puente traduce entre este contrato y el hardware con dos puertos intercambiables que se eligen en `deploy/bridge.yaml`: `ControllerDriver` (`fake`, `modbus`, `opcua`) y `DaqDriver` (`fake`, `nidaqmx`, `mqtt`). Ver `deploy/hardware/README.md` y `docs/PUESTA_EN_MARCHA.md`.
