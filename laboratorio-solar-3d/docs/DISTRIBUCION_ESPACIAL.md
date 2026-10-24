# Distribución espacial de la azotea (E01–E20)

**Es una propuesta didáctica de claridad visual. No son distancias de seguridad, de instalación ni de norma.**
Única fuente de coordenadas: `LAB.config.layout` (`js/config.js`). Escena, cámaras IP, cableado, vistas y pruebas leen de ahí.

## Coordenadas finales (m; +X este, +Y arriba, +Z sur)

| Equipo | Antes | Ahora | Ancla de cámara / nota |
|---|---|---|---|
| Módulo A (fijo) | −4.3, 0, 0.4 | **−3.5, 0, 0** | izquierda de B |
| Módulo B (seguidor) | 4.3, 0, 0.4 | **3.5, 0, 0** | volumen barrido: radio real 1.28 m, alturas 1.89–3.06 m |
| Estación meteorológica | 0, 0, −3.6 | **−6.2, 0, −3.4** | lateral izquierda y al fondo |
| Carga CC | 0, 0, 2.6 | **6.6, 0, 0** | junto al gabinete, a la derecha de B |
| Gabinete | 7.4, 0, −4.1 | **6.6, 0, −2.6** | paro local visible desde el frente |
| Cámara IP 1 | −8.4, 0, 3.2 | **−8.0, 0, 4.6** | apunta al centro del conjunto A+B (0, 1.3, 0), ve A y B completos |
| Cámara IP 2 | 8.6, 0, 3.8 | **8.8, 0, 4.6** | apunta al eje de inclinación de B (3.5, 2.47, 0), ve todo su recorrido |
| Azotea | 26 × 18 m | sin cambio | los aires acondicionados (contexto) pasaron de x≈9.4–10.9 a 11.0–12.2 para liberar el pie de la cámara 2 |

Zonas: generación al centro (A izquierda, B derecha), instrumentación (carga + gabinete) a la derecha, estación lateral al fondo, cámaras en los extremos delanteros. El inventario, las dimensiones, los límites angulares y el modelo físico no cambian (`inventario_antes/despues.json`).

## Alternativas evaluadas

1. **Frontal compacto con instrumentación lateral (elegida).** Las zonas se distinguen a simple vista, A y B quedan completos y casi al mismo plano, gabinete y estación no tapan a los módulos.
2. **Instrumentación al fondo, centrada, estación a la derecha (descartada).** El gabinete queda detrás de B, la estación queda a 3 m de los tinacos de la azotea (confunde zonas) y la vista aérea pierde el centro limpio.
3. Variante del 1 con separación de 6 m (la de la propuesta) frente a 7 m y 8 m. Medido con `tools/shade_scan.js` (21/12, 21/3, 21/6 y 23/10, cada 15 min, Sol ≥ 10°): sombra de otros equipos o de la azotea sobre A, antes 195 min; 6 m, 75 min; **7 m, 45 min**; 8 m, 30 min. Se eligió 7 m: ya no hay sombra de la carga ni de la cámara 1, y la de B sobre A en las mañanas de equinoccio se acorta de 4 a 3 muestras. Más separación quitaba compacidad.

## Vistas, cámaras y etiquetas
- `World.buildViews()` deriva cada vista de `LAB.config.envelopes(layout)`; `viewPose(nombre, aspecto)` calcula la distancia para que el sujeto quepa en el área útil, **descontando la franja que ocupa la barra de vistas**. Al cambiar el tamaño la vista predefinida se reencuadra (`CameraRig.refit`) salvo que la persona ya haya movido la cámara. Las coordenadas físicas no dependen del navegador.
- Identificadores conservados: general, moduleA, moduleB, station, load, cabinet, aerial, front. Nuevos, solo para “Abrir componente”: `camFocus1`, `camFocus2`.
- Cámaras IP: la carcasa y la cámara virtual apuntan al mismo objetivo (diferencia < 0.5°, se calcula iterando por el desplazamiento de la lente).
- Etiquetas: las de B (módulo, sensor de irradiancia, eje de inclinación) siguen a la pieza móvil; la del objeto seleccionado pasa al frente.
- Cables: `createCables(layout)`, una sola vez. A→carga rodea por el frente la base de B; B→carga lleva un tramo ondulado de holgura (recurso didáctico, sin afirmar validez mecánica); la estación solo se conecta al gabinete.

## Límites conocidos
- **Sombras.** Es geometría dibujada: el modelo eléctrico no descuenta sombras. En las mañanas de equinoccio (≈ 7:15–7:45, Sol a 13–20°) B proyecta sobre A hasta ~57 % de sus puntos; con Sol bajo, el contexto y la propia horquilla de B también sombrean parte del panel (≈ 3–9 %). Con el Sol ≥ 15° ningún otro equipo ni elemento de la azotea sombrea a A o B (el escaneo cubre 4 fechas, cada 15 min).
- **Despejes.** Se muestrearon 190 poses de B (azimut 90–270° cada 10°, inclinación 0–90° cada 10°): holgura mínima 1.31 m al resto de equipos. Un muestreo no certifica despeje continuo; se conserva el margen y no se cambiaron límites ni el eje.
- Capturas hechas con renderizado por software en Chromium (~1 fps), no con GPU.
