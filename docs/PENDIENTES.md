# Lo que falta y lo que no está verificado

## Tareas Opus (O1–O8) — sin implementar
El plan solo enumera sus entregables, no su especificación cerrada, así que **no se inventaron**. El código deja el lugar listo para cada una:

| Tarea | Estado | Dónde engancha |
|---|---|---|
| O1–O8 (especificaciones de ingeniería, control, falla, calibración térmica…) | **Pendientes de Opus** | ver abajo |
| O2 ajuste térmico con datos reales | Pendiente | `physics.json` (C, U0, U1); `server/labsolar/twin` |
| O5 control y seguridad del PLC | Pendiente | `server/labsolar/bridge/registers.py` (mapa provisional), `control_law.py` (ley provisional) |
| O6 catálogo de fallas | Pendiente | inyección de fallas (S8) depende de él |
| O3 | Pendiente | prácticas B4/B5 dependen de O3/O2 |

## Datos que solo puede dar el banco real (plantillas listas, valores POR_DEFINIR)
Ver `server/deploy/hardware/README.md`: especificación del PLC (watchdog, rampas, fallas), mapa de registros confirmado, calibración e incertidumbre por canal, límites eléctricos de la carga, direcciones de red. Con `mode: real` el puente no arranca hasta que estén completos, y `tests/test_hardware.py` lo exige.

## Falta del plan Sonnet
Prácticas B2, B3, B8, gráficas de análisis, corrida de calibración A=B, B4/B5 (dependen de O2/O3), inyección de fallas (depende de O6), cámaras con el equipo real y S28 (datos pendientes).

## No verificado con hardware (todo se probó contra el banco virtual)
- PLC real (Siemens S7-1200 recomendado, **no confirmado**) por Modbus/OPC UA: los controladores se probaron contra servidores simulados con pymodbus y asyncua.
- NI-DAQmx en Linux con el cDAQ-9184: soporte **sin verificar**; alternativa prevista: equipo Windows que publique por MQTT.
- Cámaras IP y MediaMTX: el visor HLS de la interfaz (`js/ui/camviewer.js`) se probó con un HLS de prueba generado con ffmpeg, **no con una cámara real**; sin flujo muestra «Sin flujo de video» y reintenta cada 5 s. La ruta `/cam/<cam1|cam2>/index.m3u8` sigue el `mediamtx.yml` y el Nginx del despliegue.
- Despliegue con Docker en el servidor institucional: `docker compose config`, Nginx (TLS, cabeceras, límites) y Mosquitto con TLS y ACL se probaron fuera de contenedor; `docker compose up` no se pudo ejecutar (sin demonio de Docker).
- Rendimiento con carga real de usuarios.

## Decisiones que son de ustedes
- Ubicación del servidor y enlace al banco (¿VPN?).
- Modelo definitivo de PLC.
- Inicio de sesión propio o institucional (SSO).
- Qué hacer con el giro diario del seguidor (ver `FISICA.md`).
