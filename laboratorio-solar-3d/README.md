# Laboratorio Solar Remoto UNACH · Gemelo digital 3D

Interfaz preliminar (simulada) del banco remoto de seguimiento solar del proyecto EU-COLMEV WP3.
Los alumnos practican aquí con la misma interfaz que usarán después con el banco real.

## Cómo abrirlo
Doble clic en `index.html` (Chrome/Edge/Firefox con WebGL). No necesita servidor ni internet: todas las librerías están en `js/lib/`.

## Estructura
- `js/config.js` configuración del sitio (Tuxtla, módulo 500 Wp) y utilidades
- `js/sim/` motor físico: posición solar, nubes, modelo de diodo único, seguidor, seguridad, engine
- `js/data/dataSource.js` capa de datos intercambiable (`sim` hoy, `MqttSource` pendiente del banco real)
- `js/scene/` escena 3D (entorno, módulos, seguidor, estación, equipos, etiquetas, cámaras)
- `js/ui/` paneles, gráficas, prácticas guiadas
- `data/pvlib_tuxtla.js` datos generados con pvlib
- `tools/` generador pvlib y pruebas automáticas

## Parámetros en la URL
`time, speed, cloud, wind, view, pip, labels, q (high|medium|low|auto), session, practice, tab (power|day|iv|energy|run), panels, glfail (simula falla de WebGL en pruebas)`
Ejemplo: `index.html?session=student&practice=p2&q=low`

## Pruebas
`node tools/test_domain.js`, `test_phaseC.js` (sin navegador) y, con Playwright: `test_clock`, `test_phaseA_ui`, `test_phaseB`, `test_phaseB_flows`, `test_phaseC_ui`, `test_phaseC_guide`, `test_phaseD`, `test_phaseD_c19`, `test_spatial`, `test_spatial_practices`. Variable `LAB_ROOT` para probar otra copia. Todas devuelven código distinto de cero si algo falla.

## Documentos
`docs/ENTREGA_SECCION16.md` (requisitos, matriz de pruebas, limitaciones), `CONTRATO_DATOS.md`, `FORMATO_PERSISTIDO.md`, `DISTRIBUCION_ESPACIAL.md`.

## Regenerar datos pvlib
`python3 tools/gen_pvlib_data.py` (requiere pvlib 0.16+). Validación: `node tools/test_solar.js` (posición solar JS vs pvlib, error máx. 0.006°).

## Conectar el banco real
Implementar `MqttSource` en `js/data/dataSource.js` con la misma interfaz: `telemetry`, `send(cmd)`, `on('log'|'sweep')`. La UI no cambia.

## Supuestos y límites
- Coordenadas aproximadas de Tuxtla, panel genérico de 500 Wp, cielo despejado Solis simplificado (AOD 0.08).
- Parámetros del diodo ajustados a mano (EgRef calibrado), no a una hoja de datos real: sustituir al tener el módulo definitivo.
- Rendimiento en GPU real no verificado (se probó con render por software). La calidad se adapta sola o con `q=`.
