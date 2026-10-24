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

## Falta del plan Sonnet
Prácticas B2, B3, B8, gráficas de análisis, corrida de calibración A=B, B4/B5 (dependen de O2/O3), inyección de fallas (depende de O6), cámaras con el equipo real y S28 (datos pendientes).

## No verificado con hardware (todo se probó contra el banco virtual)
- PLC real (Siemens S7-1200 recomendado, **no confirmado**) por Modbus/OPC UA: los controladores se probaron contra servidores simulados con pymodbus y asyncua.
- NI-DAQmx en Linux con el cDAQ-9184: soporte **sin verificar**; alternativa prevista: equipo Windows que publique por MQTT.
- Cámaras IP y MediaMTX.
- Despliegue con Docker en el servidor institucional (los archivos están, no se ejecutó `docker compose` aquí).
- Rendimiento con carga real de usuarios.

## Decisiones que son de ustedes
- Ubicación del servidor y enlace al banco (¿VPN?).
- Modelo definitivo de PLC.
- Inicio de sesión propio o institucional (SSO).
- Qué hacer con el giro diario del seguidor (ver `FISICA.md`).
