# Prueba de punta a punta contra el banco simulado

Base probada: punta de la pila de PR (#4, `bc8ac27`) fusionada localmente con `feat/integracion-final` (`b694a25`). Al momento de la prueba los PR #1 a #4 seguían abiertos, así que no era `main`; hay que repetir el chequeo rápido (sección 5) cuando se fusionen. No se cambió ningún archivo del repositorio.

## 1. Qué se ejecutó y resultado

| Prueba | Resultado |
|---|---|
| `pytest -m "not integration"` (contrato, puente, controladores, pasarela, registrador, gemelo) | 121 pasan |
| `pytest -m integration` (Mosquitto 2.0.18 real con usuarios y ACL, más PostgreSQL) | 4 pasan |
| `test_ws_e2e.js` contra `devstack` (todo en un proceso, bus en memoria) | 18/18 |
| `test_ws_e2e.js` con **procesos separados** sobre Mosquitto real con contraseñas y ACL de `deploy/mosquitto/acl`: navegador (Chromium) → pasarela FastAPI → MQTT → puente → banco virtual, más registrador y gemelo | 18/18 |
| Lo mismo cambiando solo `controller: fake` por `controller: modbus` (puente habla Modbus TCP con un servidor Modbus del banco virtual) | 17/18 (la que falla es la insignia, ver hallazgo H2) |

El registrador guardó en SQLite: 59 muestras, 10 comandos, 2 eventos, 1 corrida, 1 sesión. El CSV se descargó del servidor con muestras reales.

## 2. Hallazgos (fallas reales, no corregidas)

**H1. La ACL impide que la pasarela publique eventos (alta).** La pasarela publica en `labsolar/v1/<banco>/event` cuando revoca el control (`hub.py:166`, `_revoke_control`), pero `deploy/mosquitto/acl` solo le da lectura sobre `event`. Mosquitto lo rechazó (PUBACK rc135, visto en el log). Efecto en producción: el evento de «control revocado» no llega al registrador ni a otros clientes (el navegador sí lo recibe directo). La prueba pasa porque no verifica ese camino. Arreglo propuesto: dar a `gateway` `topic write labsolar/v1/+/event`, aceptando que la pasarela podría falsificar eventos del puente; mejor alternativa: que la pasarela use un tópico propio (`.../event/gw`) con su propia línea en la ACL y que el registrador lo lea. Hay que decidirlo; no es trivial.

**H2. La insignia «BANCO REAL» depende solo del controlador (media).** `bridge/app.py:258` pone `source: "fake"` solo si el controlador es fake. Con PLC real y adquisición falsa (o al revés) el navegador dice BANCO REAL aunque parte de los datos sean simulados. Es justo el escenario de una puesta en marcha por etapas. Arreglo propuesto: `source = "real"` solo si controlador **y** adquisición son reales; si no, `"mixed"` y que la insignia lo diga.

**H3. Tópico de adquisición por MQTT incoherente (media).** El docstring de `daq/mqtt.py` dice `labsolar/field/<banco>/daq`, pero la ACL solo permite `labsolar/v1/+/daq/#` (usuario `daq` escribe, `bridge` lee) y `bridge.yaml` no trae ejemplo. Quien configure un cDAQ en Windows con el docstring será rechazado. Arreglo: corregir el docstring y poner el ejemplo en `bridge.yaml`.

**H4. `contract/v1/README.md` no existe**, aunque la ACL y la documentación lo citan como el contrato. Los JSON Schema sí están (ver sección 3).

## 3. Frontera de acoplamiento: estado

Lo que ya está bien definido y funcionó en la prueba:

- **Contrato versionado** en `server/contract/v1/*.schema.json` (cmd, req, ack, tele, state, event, sweep, hb, hello, twin) con ejemplos válidos e inválidos que las pruebas validan. La web y la pasarela solo conocen esto.
- **Tópicos MQTT** `labsolar/v1/<banco>/{tele,state,event,cmd/req,cmd/ack,sweep,twin,hb/gateway,daq/#}` con ACL de mínimo privilegio por servicio (verificada con Mosquitto real).
- **Dos puertos intercambiables en el puente:** `ControllerDriver` (PLC: `fake`, `modbus`, `opcua`) y `DaqDriver` (`fake`, `nidaqmx`, `mqtt`). Se eligen en `bridge.yaml`.
- **Comprobación del intercambio:** cambiar el controlador fake por Modbus TCP se hizo solo en el YAML; pasarela, navegador y registrador no se tocaron y 17 de 18 comprobaciones pasaron (la otra es H2, una etiqueta).
- **Enclavamientos en tres capas** (navegador, pasarela, puente) con el PLC como autoridad final; latido pasarela→puente→PLC (watchdog), paro de emergencia, y pérdida de enlace llevan a posición segura. Probado: paro, comando fuera de rango rechazado con motivo, telemetría obsoleta bloquea la operación.
- **Mapa de registros** en `registers.py` y `server/docs/REGISTROS.md` (generado), con offsets configurables para cambiar de PLC.

## 4. Lo que falta definir antes de conectar hardware

Esto no se inventó; son datos que solo el banco real o ingeniería puede dar.

1. **PLC definitivo** (S7-1200 recomendado, sin confirmar) y su mapa real: direcciones, tipos, orden de bytes, escalas. El mapa actual es provisional.
2. **Especificación O5 del PLC:** tiempo del watchdog, rampas, códigos de falla y de rechazo (`IR_FAULT_CODE`, `IR_REJECT_CODE`), histéresis de viento, comportamiento al reiniciar.
3. **Calibraciones por canal:** hoy `nidaqmx` solo aplica `lectura*scale+offset`. Faltan: divisor de tensión y derivación/transductor de corriente de cada módulo, sensibilidad de cada piranómetro/celda de referencia, tipo y compensación de termopares/RTD, anemómetro y veleta.
4. **Incertidumbres del sensor:** no hay un lugar en el contrato para la incertidumbre ni la fecha de calibración de cada canal. La práctica P4 (calidad e incertidumbre) las necesitará. Propuesta: bloque `calib` en `bridge.yaml` y campo opcional `u` en `tele`.
5. **Límites eléctricos de la carga:** corriente y tensión máximas, tiempo mínimo y máximo del barrido, qué hace el banco si se pasa. Hoy la carga solo valida el rango del simulador.
6. **Direccionamiento de red:** IP del PLC, del cDAQ, de las cámaras, VLAN y VPN. `NI-DAQmx` en Linux con el cDAQ-9184 sigue sin verificar (alternativa: equipo Windows publicando por MQTT, que además requiere H3).
7. **Muestreo:** frecuencia de lectura y de telemetría reales frente a 1 Hz actual, y marca de tiempo de la medida (hoy la pone el puente al leer).
8. **Identidad:** acceso propio o institucional, y quién restablece el paro (llave en sitio).

## 5. Qué no se probó

- `docker compose`, Nginx/TLS y Mosquitto con TLS en 8883 (se usó puerto plano local, mismas ACL).
- PLC, cDAQ y cámaras reales; OPC UA solo con pruebas unitarias existentes.
- Carga de varios usuarios simultáneos.
- Esta prueba no corrió sobre `main` porque los PR siguen abiertos.

## Cómo repetirlo

`pip install -r server/requirements.lock pytest pytest-asyncio httpx && pip install --no-deps -e server`, instalar `mosquitto`, y seguir `README.md`. Para la variante distribuida: broker con la ACL de `deploy/mosquitto/acl`, un proceso por servicio (`labsolar-bridge --config`, `labsolar-gateway serve`, `labsolar-recorder`, `labsolar-twin`) y `E2E_URL=http://127.0.0.1:<puerto> node laboratorio-solar-3d/tools/test_ws_e2e.js`.

---
## Repetición sobre `main` limpio (1da712c, PR #1 a #4 fusionados)

| Prueba | Resultado |
|---|---|
| `pytest` completo (normales + integración) | 125 pasan |
| `test_ws_e2e.js` con `devstack` | 18/18 |
| `test_ws_e2e.js` con procesos separados, Mosquitto con ACL | 18/18 |
| Igual con `controller: modbus` | 17/18 (solo la etiqueta de H2) |

H1 a H4 siguen exactamente igual: Mosquitto volvió a denegar la publicación de la pasarela en `.../event`; `app.py:258` sigue decidiendo `source` solo por el controlador; el docstring de `daq/mqtt.py` sigue citando `labsolar/field/...`; sigue sin existir `contract/v1/README.md`.

### Recomendación
- **H1:** darle a la pasarela su propio tópico `labsolar/v1/+/event/gw` (escritura solo para `gateway`, lectura para `recorder`), en vez de abrirle `event`; así no puede suplantar eventos del puente.
- **H2:** `source` = `real` solo si controlador y adquisición son reales; si no, `mixed`, y la insignia lo dice. Arreglarlo antes de cualquier puesta en marcha por etapas.
- **H3:** corregir el docstring al tópico `labsolar/v1/<banco>/daq/...` que ya permite la ACL y añadir ejemplo en `bridge.yaml`.
- **H4:** escribir el README del contrato (tópicos, sobres, versionado).
Orden sugerido: H2, H1, H3, H4 en un solo PR pequeño con una prueba nueva para H1 (publicar un evento de la pasarela contra Mosquitto real) y otra para H2.
