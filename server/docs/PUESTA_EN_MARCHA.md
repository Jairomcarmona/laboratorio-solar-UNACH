# Lista de verificación de puesta en marcha del banco físico

Para seguir en orden cuando llegue el hardware. Marca cada paso; no pases al siguiente si uno falla. Los datos que faltan se escriben en `deploy/hardware/*.yaml` (ver `deploy/hardware/README.md`). Nada de esto exige cambiar código ni la física del simulador.

## 0. Antes de conectar nada
- [ ] Ingeniería entrega y firma la especificación del PLC (`plc_spec.yaml`): watchdog, rampas, límites, viento, reinicio, códigos de falla y de rechazo.
- [ ] Ingeniería aprueba los límites de la carga (`load_limits.yaml`).
- [ ] TI asigna direcciones, VLAN de campo sin ruta a internet y VPN (`network.yaml`, `deploy/.env`: `PLC_HOST`, cámaras).
- [ ] Metrología entrega certificados y fechas de cada sensor (`calibration.yaml`): divisores de tensión, derivaciones/transductores, piranómetros y celdas de referencia, termopares/RTD, anemómetro y veleta.
- [ ] Persona responsable y llave del paro de emergencia: quién lo restablece en sitio.
- [ ] `deploy/.env` completo (contraseñas largas); `deploy/mosquitto/gen-passwd.sh`; certificados TLS (`deploy/certs`).

## 1. Servidor sin hardware (mode sim)
- [ ] `python -m pytest -m "not integration"` en `server/` pasa; `node tools/test_ws_e2e.js` pasa.
- [ ] `docker compose --env-file .env config` sin errores; `docker compose up -d` levanta todos los servicios sanos.
- [ ] `https://<dominio>` carga con certificado válido; HTTP redirige a HTTPS; el único puerto publicado es 443 (y 80).
- [ ] Insignia BANCO VIRTUAL; control revocado se registra (evento `session.lost` en la base).

## 2. PLC solo (mode staged, daq fake)
- [ ] Copiar `plc_spec`, `plc_registers`, `load_limits`, `network` y llenarlos. `plc_registers.yaml`: confirmar cada dirección contra el programa del PLC y poner `confirmed: true`.
- [ ] `labsolar-bridge --config deploy/bridge.yaml --check` → OK.
- [ ] Con el seguidor **sin carga y despejado**: leer estados sin mandar nada (`IR_STATE`, `IR_AZ`, `IR_TILT`).
- [ ] Probar el paro de emergencia físico: el estado pasa a `ESTOP` y ningún comando lo levanta desde la web.
- [ ] Quitar el latido (detener el puente): el PLC pasa a posición segura en el tiempo del watchdog de `plc_spec.yaml`.
- [ ] Mover a una consigna pequeña; comprobar rampa y límites. Un comando fuera de rango se rechaza con el código esperado.
- [ ] Viento: simular o esperar viento sobre `wind.stow_ms` y comprobar `WIND_STOW` y la reanudación con histéresis.
- [ ] Insignia BANCO MIXTO (PLC real, adquisición virtual).

## 3. Adquisición (mode real)
- [ ] Copiar `calibration.yaml` con todos los canales obligatorios (`A.v A.i A.poa A.tback B.v B.i B.poa B.tback env.ghi env.ta`) y sus incertidumbres.
- [ ] Elegir `nidaqmx` (si el cDAQ-9184 funciona en el equipo del servidor) o `mqtt` desde un PC con Windows, con `MQTT_PASSWORD_DAQ` en `.env`.
- [ ] Verificar cada canal contra un instrumento patrón: tensión, corriente, irradiancia, temperaturas. Anotar la desviación; si excede la incertidumbre declarada, corregir escala/offset.
- [ ] Confirmar `sampling` (lectura, telemetría, marca de tiempo) y que `tele_hz` coincide con `tele_period_s`.
- [ ] `labsolar-bridge --config deploy/bridge.yaml --check` → OK con `mode: real`.
- [ ] Insignia BANCO REAL.

## 4. Carga y barrido I-V
- [ ] Con límites bajos primero: circuito abierto y cortocircuito, luego un punto de carga.
- [ ] Un barrido completo dentro de `[sweep_s_min, sweep_s_max]`; comprobar que superar un límite hace lo definido en `on_exceed`.
- [ ] Comparar la curva con el modelo del gemelo.

## 5. Prueba de punta a punta y aceptación
- [ ] `E2E_URL=https://<dominio> node laboratorio-solar-3d/tools/test_ws_e2e.js` (o la variante distribuida de `docs/INFORME_E2E.md`).
- [ ] Reserva, toma de control, comando, acuse y registro de la corrida; el CSV descargado trae muestras reales.
- [ ] Perder la conexión del navegador (6 s): el control se retira y se registra.
- [ ] Respaldo (`deploy/scripts/backup.sh`) y restauración probados.
- [ ] `python -m pytest` completo (incluida `test_configuracion_real_del_despliegue_si_existe`) en verde.
- [ ] Firma de aceptación de la persona responsable de ingeniería.

## Qué se probó ya sin hardware (24-oct-2026) y qué no
- Probado: pila completa en un proceso (`devstack`, 18/18 de punta a punta con navegador); Mosquitto real con TLS 1.2, contraseñas y la ACL de `deploy/mosquitto/acl` (pasarela publica en `event/gw` y no puede suplantar `event`; el usuario `daq` escribe en `daq/#` y el puente lo lee); `docker compose config` válido; Nginx 1.24 (el despliegue usa 1.27) con TLS 1.2/1.3: redirección 80→443, cabeceras de seguridad, TLS 1.1 rechazado, límite de intentos de acceso (503 tras el límite). Esto destapó dos fallos reales, ya corregidos: la ACL no admite comentarios en línea y `proxy_read_timeout` duplicado impedía arrancar Nginx.
- No se pudo: `docker compose up` (el entorno de desarrollo no tiene demonio de Docker, así que no se construyó la imagen ni se arrancaron los contenedores); `http2 on;` con la versión exacta de Nginx del despliegue; certificado real y OCSP stapling; autenticación de cámaras con la pasarela real (solo con un servidor de prueba); PLC, cDAQ y cámaras reales; carga de varios usuarios.
