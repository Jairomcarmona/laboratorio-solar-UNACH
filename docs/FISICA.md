# Modelo físico del simulador (y de su gemelo en el servidor)

Fuente única de parámetros: `server/contract/v1/physics.json`, generado por `laboratorio-solar-3d/tools/gen_pvlib_data.py`. El simulador (JavaScript) y el gemelo (Python, pvlib) se comprueban entre sí en las pruebas.

| Parte | Modelo |
|---|---|
| Módulo | Diodo único De Soto, **66 celdas** (antes 132), EgRef 1.121 |
| Plano inclinado | Hay-Davies (como `pvlib.irradiance.haydavies`) |
| Pérdidas angulares | Martin-Ruiz, a_r = 0.16 |
| Temperatura | **Dinámica**: C·dT/dt = (U0 + U1·v)(T_ss − T). T es la del **módulo (cara posterior)**; la de celda es T + 3·G/1000 |
| Sensores | Modelo de POA medida (celda de referencia / piranómetro), con ruido y su propia respuesta |
| Sombra | Indicador analítico de sombra mutua entre módulos |
| Carga | Banco discreto de resistencias; el barrido I-V recorre el banco |
| Seguidor | Ley astronómica con histéresis del lado norte |

## Las tres correcciones físicas

1. **66 celdas, no 132.** Cambia Voc, Vmp y la curva I-V; los valores de referencia de las pruebas se regeneraron.
2. **Temperatura de módulo vs. de celda.** Estaban intercambiadas: el sensor del banco mide la cara posterior del módulo, no la celda.
3. **Giro de ~180° del seguidor (3 mayo – 8 agosto).** Con el Sol al norte del cenit, el seguidor debe cambiar de lado. La ley nueva lo hace una sola vez por día, con histéresis (sin chisporroteo).
   **Limitación honesta:** con los límites de azimut 90°–270° el giro diario único es **inherente**; no se elimina. Si hay que evitarlo (otra mecánica, otros límites o apuntar sin seguir al Sol en esas fechas), lo decide la especificación **O5**.

## Parámetros provisionales

- Capacidad térmica C = 9300 J/(m²·K) y U0/U1: **provisionales**. Se ajustan con datos reales (tarea O2, pendiente).
- Altitud, albedo y datos de sitio: Tuxtla Gutiérrez (FCFM-UNACH), albedo configurable.

## Cómo se verificó

`laboratorio-solar-3d/tools/test_pv_vs_pvlib.js`, `test_poa_vs_pvlib.js`, `test_physics_models.js` (paso térmico, sensor, sombra, banco, ley astronómica, validación de comandos). El gemelo del servidor usa pvlib directamente (`server/labsolar/physics.py`).
