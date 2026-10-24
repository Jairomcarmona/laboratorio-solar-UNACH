# Laboratorio Remoto Solar UNACH

Gemelo digital y laboratorio remoto de un banco fotovoltaico (módulo fijo A y módulo B con seguidor de dos ejes) de la Facultad de Ciencias en Física y Matemáticas, UNACH. EU-COLMEV · WP3.

El **mismo navegador** puede mostrar cuatro fuentes de datos: el simulador local (sin red), el banco real (a través del servidor), el gemelo (modelo con el ambiente medido) y la reproducción de una corrida registrada.

```
Navegador ──HTTPS/WSS──▶ Nginx ──▶ Pasarela (login, reservas, comandos) ──MQTT/TLS──▶ Puente ──Modbus/OPC UA──▶ PLC ──▶ banco
                                          │                                        └── adquisición (NI-DAQmx / MQTT)
                                          └─▶ PostgreSQL ◀── Registrador ◀── MQTT          Gemelo (pvlib) ◀── MQTT
```

**El PLC es la autoridad de seguridad** (paros, límites, viento, watchdog). Ni el navegador, ni la pasarela, ni Python deciden por él.

## Estructura

| Carpeta | Contenido |
|---|---|
| `laboratorio-solar-3d/` | Simulador 3D en JavaScript (sin compilación), prácticas guiadas, fuentes de red, acceso y reservas |
| `server/contract/v1/` | **Contrato** (JSON Schema) de tópicos MQTT, WebSocket y `physics.json` |
| `server/labsolar/` | Contrato, puente, banco virtual, pasarela FastAPI, registrador, gemelo |
| `server/deploy/` | docker-compose, Nginx/TLS, Mosquitto (ACL), respaldos |
| `server/docs/`, `docs/` | Seguridad y despliegue, mapa de registros (provisional), física, pendientes |

## Probar todo en una máquina, sin hardware

```bash
cd server
pip install -r requirements.lock pytest pytest-asyncio httpx && pip install --no-deps -e .
python -m labsolar.devstack --port 8000 --static ../laboratorio-solar-3d --solar-start 2026-10-23T17:30:00
# abrir http://127.0.0.1:8000/login.html  (cuentas de desarrollo: ana / beto / vera / root, clave dev-password-123)
```
`devstack` corre bus, banco virtual, puente, registrador, gemelo y pasarela en un proceso; la insignia del navegador dice **BANCO VIRTUAL** para que nadie confunda esos datos con mediciones.

Sin servidor: abrir `laboratorio-solar-3d/index.html` en el navegador (modo simulador).

## Pruebas

```bash
cd server && python -m pytest -m "not integration"     # contrato, puente, controladores, pasarela, registrador, gemelo
cd server && python -m pytest -m integration           # PostgreSQL 16 y Mosquitto reales, si están instalados
cd laboratorio-solar-3d && node tools/test_physics_models.js && node tools/test_sources.js
cd laboratorio-solar-3d && node tools/test_ws_e2e.js   # con devstack en el puerto 8765; navegador real de extremo a extremo
```

## Despliegue y seguridad

Ver [`server/docs/SEGURIDAD-Y-DESPLIEGUE.md`](server/docs/SEGURIDAD-Y-DESPLIEGUE.md) (puertos, redes, lista de verificación). Ver también [`docs/PENDIENTES.md`](docs/PENDIENTES.md): qué falta, qué no se verificó con hardware y qué decisiones quedan abiertas. Mapa de registros del PLC (provisional): [`server/docs/REGISTROS.md`](server/docs/REGISTROS.md). Física: [`docs/FISICA.md`](docs/FISICA.md). Acople del banco físico: plantillas en [`server/deploy/hardware/`](server/deploy/hardware/README.md) y lista de puesta en marcha en [`server/docs/PUESTA_EN_MARCHA.md`](server/docs/PUESTA_EN_MARCHA.md). Contrato: [`server/contract/v1/README.md`](server/contract/v1/README.md).
