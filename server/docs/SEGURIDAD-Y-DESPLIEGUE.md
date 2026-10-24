# Seguridad y despliegue

Servidor pensado para infraestructura institucional (UNACH): una sola entrada web, todo lo demás en redes internas. Este documento es la lista de verificación para TI antes de abrir el sitio.

## 1. Puertos

| Puerto | Protocolo | Dónde | Quién lo ve |
|---|---|---|---|
| **443/TCP** | HTTPS + WebSocket seguro | Nginx del servidor | Internet / red universitaria (**único puerto de servicio**) |
| **80/TCP** | HTTP | Nginx | Solo redirige a 443 y atiende la renovación del certificado |
| 22/TCP | SSH | Servidor | Solo la VPN o la red de administración de TI, nunca internet |
| 8883/TCP | MQTT con TLS | Mosquitto | **Red interna de contenedores.** No se publica |
| 5432/TCP | PostgreSQL | Base de datos | **Red interna.** No se publica |
| 8000/TCP | Pasarela (HTTP interno) | Pasarela | Solo Nginx |
| 8554, 8888, 8889 | RTSP / HLS / WebRTC | MediaMTX | Solo Nginx y la red de cámaras |
| 502/TCP | Modbus TCP | PLC | **Solo el puente**, en la red de campo aislada. Jamás hacia internet |
| 4840/TCP | OPC UA | PLC | Igual que Modbus, si se usa OPC UA en lugar de Modbus |
| 123/UDP | NTP | Servidor | Salida hacia el NTP institucional (hora confiable: las muestras llevan marca de tiempo) |

Si WebRTC necesita puertos UDP para las cámaras, se abre un rango acotado solo si TI lo aprueba; la opción por omisión es HLS sobre 443.

## 2. Redes

```
Internet ──443──▶ [nginx] ──front──▶ [gateway] ──core──▶ [mosquitto] ◀── [recorder] [twin]
                     │                                       ▲
                     └──front──▶ [mediamtx] ──cams──▶ cámaras IP     [db]
                                                              [bridge] ──field──▶ PLC
```

- `core`, `field` y `cams` son redes **internas** de Docker (sin salida a internet). Solo `bridge` toca `field`.
- El PLC y el equipo de adquisición (NI cDAQ) viven en una VLAN de campo sin ruta a internet; el servidor llega a ellos por un único puerto desde el puente. Si el servidor no está físicamente junto al banco, el enlace va por **VPN WireGuard** (el servidor inicia; el banco no acepta conexiones entrantes de internet).

## 3. Lo que ya hace el software

- **Acceso:** contraseñas con argon2id; mismo mensaje si el usuario no existe o la clave es mala; bloqueo temporal tras 5 fallos; límite de intentos por IP (en la aplicación y en Nginx); sesión en cookie `HttpOnly`, `SameSite=Strict`, `Secure`; caducidad y revocación al salir.
- **Roles:** visitante, estudiante, docente, técnico, administración. El rol lo fija el servidor; el navegador no puede cambiarlo. La administración no opera el banco.
- **Turnos:** solo opera quien tiene una reserva vigente; una sola persona controla a la vez; al terminar el turno se retira el control. Las reservas no se traslapan: lo comprueba la aplicación y, en PostgreSQL, **una restricción de exclusión en la propia base** (migración 0002).
- **Comandos:** esquema JSON estricto, 5 por segundo por sesión, rechazo de los que solo existen en el simulador, tamaño máximo de mensaje. Las órdenes se validan en la pasarela, en el puente y en el PLC; el PLC es la autoridad final. Un navegador que se queda sin señal 6 s pierde el control y el banco va a posición segura.
- **WebSocket:** boleto de un solo uso (30 s) emitido a una sesión ya autenticada; el token de sesión nunca viaja en la URL. Se comprueba `Origin`.
- **CSRF/CORS:** cookie `SameSite=Strict` + comprobación de `Origin` en toda petición que cambia estado; sin CORS abierto (`LABSOLAR_ALLOWED_ORIGINS`).
- **Cabeceras:** HSTS, CSP estricta (sin scripts ajenos ni `unsafe-eval`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`. La política está en un solo lugar y una prueba exige que Nginx y la pasarela coincidan.
- **MQTT:** sin acceso anónimo, un usuario por servicio, **ACL de mínimo privilegio** (solo el puente publica telemetría; solo la pasarela da órdenes) y TLS. Probado contra un Mosquitto real, incluida la suplantación.
- **Auditoría:** accesos, denegaciones, comandos rechazados, altas y cambios de cuentas, en la tabla `audit` (nada se borra).
- **Secretos:** solo por variables de entorno / archivo `.env` (fuera del repositorio, `chmod 600`). `bridge.yaml` usa `${VAR}`.
- **Contenedores:** servicios Python sin privilegios, sistema de archivos de solo lectura, sin capacidades, `no-new-privileges`. Dependencias fijadas (`requirements.lock`).
- **Datos:** respaldo diario con `pg_dump`, retención 30 días (`deploy/scripts/backup.sh`).

## 4. Puesta en marcha

1. Servidor Linux con Docker y Compose, hora sincronizada (`chrony` contra el NTP institucional).
2. Certificado TLS (el de la institución, o Let's Encrypt si el dominio es público) en `deploy/certs/web/{fullchain,privkey}.pem`. Certificado propio para MQTT: `deploy/certs/mqtt/{ca.crt,server.crt,server.key}`.
3. `cp deploy/.env.example deploy/.env`, completar y `chmod 600`. Contraseñas MQTT: `deploy/mosquitto/gen-passwd.sh` (imprime las variables y crea `passwd`).
4. Revisar `deploy/bridge.yaml` (PLC y adquisición reales) y las cámaras en `.env`.
5. `docker compose --env-file .env up -d` (aplica migraciones, crea la cuenta de administración inicial).
6. Crear cuentas: `docker compose run --rm gateway labsolar-gateway create-user USUARIO student` (o desde la administración). Cambiar la contraseña inicial del administrador.
7. Probar con `deploy/scripts/` y `nmap` desde fuera: solo deben verse 80 y 443.

## 5. Lo que NO está resuelto (decisión de TI o pendiente)

- **Inicio de sesión institucional (LDAP/SAML/OIDC):** hoy las cuentas son propias del sistema. Si la UNACH exige SSO, solo cambia el módulo de acceso; reservas, roles y turnos se conservan.
- **Doble factor** para docentes y administración: no incluido.
- **Revisión externa:** esto sigue buenas prácticas estándar pero **no sustituye** una revisión de seguridad ni una prueba de penetración por parte de TI antes de abrirlo a internet.
- **Ubicación del servidor y enlace al banco** (¿mismo edificio o VPN?): sin decidir.
- **Seguridad del PLC** (contraseña del PLC, OPC UA con certificados, protección de acceso del programa): depende del modelo definitivo y de la especificación O5.
- **Restauración de respaldos:** ensayar una restauración (`pg_restore`) antes de producción y copiar los respaldos fuera del servidor.

## Administración global y roles (admin.html)

- **admin:** todo: control en vivo, liberar el control, bloqueo por mantenimiento, usuarios (alta, rol, activar/desactivar, contraseña), reservas de todos, auditoría con filtros.
- **tech (técnico):** ve el control en vivo, libera el control, bloquea/reabre el banco por mantenimiento y puede pedir el paro por software. No gestiona usuarios ni ve la auditoría. No opera el banco desde la pasarela.
- **Paro de emergencia por software:** solo el operador con el control vigente, `teacher`, `admin` y `tech`. Visitantes y alumnos sin turno son rechazados (pasarela y puente).
- **Cortes inmediatos:** desactivar una cuenta, restablecer su contraseña, cambiar su rol a uno que no opera, cancelar su reserva en curso, «liberar el control» y el mantenimiento retiran el control al instante y el puente pide al PLC la posición segura (modo de pérdida de enlace; el siguiente operador lo reconoce con `safety.ack`).
- **Mantenimiento:** se guarda en la tabla `settings` (migración 0003) y sobrevive a reinicios de la pasarela.
- **Sesión huérfana:** si pasarela y puente discrepan sobre quién tiene el control durante más de `session_reconcile_s` (4 s), el que no es reconocido se libera solo.
- `/api/health` sin sesión solo responde `{"ok": true}`.
- La pasarela mantiene el estado de control en memoria: corre un solo proceso (no escalar horizontalmente).
