# Frontera de acople con el banco físico

Aquí viven los archivos que describen el hardware real. Hoy solo hay **plantillas** (`*.template.yaml`) con todo lo desconocido marcado `POR_DEFINIR`; nada está inventado. Cuando llegue el hardware: copiar cada plantilla quitando `.template` (p. ej. `plc_spec.yaml`), llenar los datos, y comprobar con

```
labsolar-bridge --config deploy/bridge.yaml --check
```

Con `mode: real` (o `staged`) en `bridge.yaml` el puente **no arranca** si falta o es inválido algún dato, y la prueba `tests/test_hardware.py::test_configuracion_real_del_despliegue_si_existe` falla en el mismo caso. Esa prueba se salta mientras no existan los archivos reales.

| Archivo (plantilla) | Qué define | Quién lo da |
|---|---|---|
| `plc_spec` | Watchdog, rampas, límites, viento, reinicio, restablecimiento de paro, códigos de rechazo y de falla, firma | Ingeniería / O5 |
| `plc_registers` | Mapa de registros Modbus (provisional de `registers.py`), orden de bytes, corrimientos | Programa real del PLC |
| `calibration` | Por canal: canal físico, escala, desfase, incertidumbre, sensor, certificado, fechas; frecuencia de muestreo y marca de tiempo | Laboratorio de metrología / ficha de cada sensor |
| `load_limits` | Tensión, corriente y potencia máximas de la carga, duración del barrido, qué hace si se supera | Ingeniería eléctrica |
| `network` | IP del PLC, cDAQ y cámaras, VLAN de campo, VPN | TI / UNACH |

Los secretos (contraseñas MQTT, de cámaras, base de datos) van en `deploy/.env`, nunca aquí.

## Cambiar de simulador a hardware real solo con configuración

Se edita `deploy/bridge.yaml`; pasarela, navegador, registrador y gemelo no cambian.

| Pieza | Simulador | Real |
|---|---|---|
| Modo | `mode: sim` | `mode: staged` (una pieza real) o `mode: real` (las dos) |
| PLC | `controller: {driver: fake}` | `driver: modbus` (host `${PLC_HOST}`, puerto 502, unidad, offsets) u `opcua` |
| Adquisición | `daq: {driver: fake}` | `driver: nidaqmx` (canales desde `calibration.yaml`) o `driver: mqtt, topic: labsolar/v1/<banco>/daq/cdaq` |
| Insignia de la web | BANCO VIRTUAL | BANCO REAL solo si PLC **y** adquisición son reales; si no, BANCO MIXTO |

Límites actuales, declarados: el controlador Modbus solo admite un corrimiento constante de direcciones (`ir_offset`, `hr_offset`); un PLC con otro orden de registros exige actualizar `server/labsolar/bridge/registers.py` y regenerar `docs/REGISTROS.md`. La incertidumbre por canal queda documentada en `calibration.yaml` pero aún no viaja en `tele` (propuesta: campo opcional `u` en una v1.x). NI-DAQmx en Linux con el cDAQ-9184 no está verificado y la imagen Docker no instala `nidaqmx` (extra `daq`); la alternativa es un equipo Windows que publique por MQTT.
