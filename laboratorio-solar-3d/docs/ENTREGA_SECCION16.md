# Entrega final · Simulador Solar UNACH (versión 2.0.0-fase-D)

Entorno de las pruebas: Chromium sin cabeza (Playwright) con render por software (SwiftShader), Node 22 en un contenedor Linux. **No se probó** con GPU real, pantalla táctil real, lector de pantalla, impresora ni personas usuarias. Resultado de la última pasada completa: **482 comprobaciones, 482 correctas** en 12 suites (registros de esa pasada: Dominio 80, Fase C dominio 28, Controles del tiempo 12, Fase A 64, Fase B 56, Fase B flujos 50, Fase C interfaz 26, Fase C guía y reporte 24, Fase D·C20 14, Fase D·C19 24, Espacial 84, Espacial prácticas 20).

Un criterio sin prueba real se marca **pendiente**; «parcial» significa que se hizo una parte y se dice cuál falta.

## 1. Código actualizado

`/mnt/project-files/laboratorio-solar-3d/laboratorio-solar-3d.zip` (abrir `index.html`; no necesita servidor ni internet).

## 2. Tabla de requisitos C01–C20

| ID | Estado | Qué se hizo / qué falta | Evidencia |
|---|---|---|---|
| C01 Superposiciones y espacio | Implementado | Cuadrícula con separadores móviles (teclado y puntero), disposición ancha/media/estrecha, anchos recordados, `?panels=0`. Probado en 9 tamaños: 1920×1080, 1536×864, 1366×768, 1024×768, 960×540, 900×520, 894×668, 768×1024, 390×844. Límite: en 390×844 y 900×520 la escena 3D queda pequeña. | test_phaseB, capturas |
| C02 Contexto de simulación | Implementado | Indicador «SIMULACIÓN» siempre visible, rol rotulado «de demostración». | T01 |
| C03 Ocultar guía vs abandonar | Implementado | Ocultar conserva la práctica; Escape cierra una capa por pulsación; foco coherente. | T03 |
| C04 Respuesta no se completa al escribir | Implementado | Escribir solo guarda borrador; se registra con su botón. | T04 |
| C05 P2–P4 con evidencia y respuesta | Implementado | Sin respuesta la práctica queda «en curso». | T06 |
| C06 Pasos alineados con comprobaciones | Implementado | P1 explica la condición pendiente (POA, viento), cámara exige entrar y salir. | T07, T08 |
| C07 Conservar datos al reiniciar energía | Implementado | Reiniciar abre un segmento; no borra muestras ni lluvia. | T10 |
| C08 Aislar sesiones, corridas, adquisición | Implementado | Id de sesión, corrida y segmento; la sesión nueva no hereda corridas; 1 muestra/s real; límite 20 000 sin truncar. | T11–T13 |
| C09 Semántica del tiempo | Implementado | Reloj solar separado de adquisición y seguidor; saltos abren segmento y cortan la línea. | T14, T15 |
| C10 Atajos y teclado | Implementado | Espacio en un botón no dispara el atajo global; sin teclas atascadas en cámara libre. | T16, T17 |
| C11 Consignas vs mediciones y permisos | Implementado | Consigna y viento instantáneo separados; validación sin mutar el modelo. | T18, T19 |
| C12 Escenarios comparables | Implementado | Cada segmento guarda acumuladores y condiciones; comparabilidad por escenario, semilla, fecha, nubes y viento; corridas alteradas no se mezclan. Escenario P3 con semilla fija. Falta: alinear el texto de P3 con un horario real del banco (no existe aún). | T20 |
| C13 Magnitud comparada | Implementado | «Diferencia de potencia ahora» y «Ganancia de energía de esta corrida» separadas, con fórmulas y unidades; «No disponible» con motivo; nunca −0.0 %. | T20, test_phaseC |
| C14 Barridos | Implementado | Todos se conservan, se eligen hasta 2, se advierte si las condiciones difieren; curva calculada ≠ barrido simulado registrado. Limitación: solo se guardan G y T al inicio y al final, no una serie en el tiempo. | T21 |
| C15 Gráficas como análisis | **Parcial** | La pestaña «Corrida» tiene cursor, zoom, desplazamiento, escala auto/fija, series, anotaciones, tabla paginada, PNG y CSV del tramo. Las pestañas Potencia, Día, I‑V y Energía **no** tienen zoom ni cursor. | test_phaseC_ui |
| C16 Guía y reporte | Implementado (impresión sin verificar) | Paso actual, pistas progresivas, vista de todos los pasos (también con guía minimizada), reporte HTML autocontenido + Markdown, borrador marcado, evidencia congelada, «Siguiente práctica». Falta probar la impresión/PDF real (solo se verificó que el botón llama a la impresión del navegador). | T30 |
| C17 Texto del usuario y archivos como datos | Implementado | Todo texto se escapa; importación validada (7 casos corruptos/versión desconocida rechazados). | T23, T25 |
| C18 Accesibilidad | **Parcial** | Teclado completo, foco atrapado en diálogos, roles y `aria-live`, tablas equivalentes. **Pendiente**: auditoría con lector de pantalla real y verificación formal de contraste. | T26 |
| C19 Entrada guiada y ayuda física | Implementado (sin prueba con personas) | Tres entradas, recorrido opcional de 5 pasos (se omite y se reabre), glosario con 9 términos obligatorios + otros 4, clasificación consigna/medida/derivada, DNI y DHI declaradas derivadas, ayudas 3D (normal, rayo, ángulo de incidencia, arco de azimut) por tarea u ocultas. **Pendiente**: comprobar con personas sin experiencia que identifican A/B y su siguiente acción sin instructor. | test_phaseD_c19 |
| C20 Recuperación gráfica | **Parcial** | Mensaje claro si no hay WebGL (con detalle técnico, reintentar y calidad baja), pérdida/restauración de contexto verificadas, calidad baja con `?q=low` y botón, sin fuentes ni recursos externos. **Falta**: si WebGL no inicia, la aplicación no ofrece los paneles de datos sin 3D (solo el mensaje); no se midió rendimiento en equipos reales. | T27 |

## 3. Matriz T01–T30 (resultado realmente observado)

Todas las filas se ejecutaron en el entorno descrito arriba y pasaron; «parcial» se aclara en la última columna.

| ID | Resultado | Dónde se comprobó | Observación |
|---|---|---|---|
| T01 | Aprobada | Fase A (navegador) | Con y sin parámetros; los inválidos se ignoran con aviso en la bitácora. |
| T02 | Aprobada | Fase B, 9 tamaños | Sin desplazamiento horizontal, controles alcanzables, sin superposición entre regiones. |
| T03 | Aprobada | Fase B | Escape cierra bitácora y ficha; el foco vuelve a su botón. |
| T04 | Aprobada | Fase A | 380 caracteres escritos sin perder foco ni texto. |
| T05 | Aprobada | Fase A | Se recupera el avance; no se reanudan movimiento ni adquisición. |
| T06 | Aprobada | Fase A | P1–P4 sin respuesta quedan «en curso». |
| T07 | Aprobada | Fase A | Con POA 285 W/m² el paso no se marca y se explica. |
| T08 | Aprobada | Fase A | Entrar y salir de la cámara completa el paso. |
| T09 | Aprobada | Dominio y Fase A | Sin muestras: mensaje y sin evidencia falsa. |
| T10 | Aprobada | Dominio | Muestras 10→10, segmento nuevo, lluvia intacta. |
| T11 | Aprobada | Dominio | Sesión B sin corridas heredadas. |
| T12 | Aprobada | Dominio y Fase A | Muestras crecen solo mientras graba. |
| T13 | Aprobada | Dominio | Se detiene exactamente en el límite, con advertencia. |
| T14 | Aprobada | Dominio | Reloj en pausa: el seguidor se mueve y la adquisición sigue. |
| T15 | Aprobada | Dominio | Salto: segmento, evento y corte en la gráfica. |
| T16 | Aprobada | Fase A y B | 19 botones activados con Tab/Espacio sin atajos extra. |
| T17 | Aprobada | Fase A | Sin teclas atascadas al perder el foco. |
| T18 | Aprobada | Fase A | Consigna y viento instantáneo separados. |
| T19 | Aprobada | Dominio y Fase A | 17 comandos inválidos rechazados sin cambiar el modelo. |
| T20 | Aprobada | Dominio, Fase C (dominio e interfaz) | E_A idéntica en 3 estrategias (3118.6 Wh), metadatos y fórmulas consistentes; otro clima = experimento distinto. |
| T21 | Aprobada | Dominio y Fase C interfaz | Dos barridos (897 vs 400 W/m²) conservados, seleccionables, con advertencia. |
| T22 | Aprobada | Dominio y Fase A | Respuestas y evidencia conservadas al cerrar, reabrir y cambiar de práctica. |
| T23 | Aprobada | Dominio | 7 archivos corruptos/versión desconocida rechazados sin sobrescribir. |
| T24 | Aprobada | Dominio | Cuota agotada y almacenamiento bloqueado: aviso y modo memoria. |
| T25 | Aprobada | Dominio y Fase A | Texto literal; el CSV no se rompe. |
| T26 | Aprobada | Fase B flujos | Recorrido solo con teclado hasta el reporte. |
| T27 | **Parcial** | Fase D C20 | Verificado: mensaje sin WebGL, pérdida y restauración del contexto (la simulación sigue, el dibujo vuelve), aviso persistente, sin errores. **No** se afirma explícitamente en una prueba que las respuestas queden intactas durante la pérdida; el estado vive fuera del contexto gráfico. |
| T28 | Aprobada | Dominio y Fase A | Viento, watchdog y paro conservan sus enclavamientos. |
| T29 | Aprobada | Dominio y Fase A | Adquisición detenida, estado final sin inventar posición si seguía en movimiento. |
| T30 | Aprobada | Fase C | Reporte final idéntico (4025 = 4025 caracteres) tras cambiar nubes, hora, viento y generar una alarma. Lo encontró la prueba: las alarmas eran en vivo y ya se congelan. |

Pruebas adicionales (Espacial 104, Controles del tiempo 12) cubren la redistribución espacial E01–E20 y el reloj.

## 4. Contrato de datos, comandos y formato persistido

- `docs/CONTRATO_DATOS.md`: comandos (`sim.play` con `toggle`, `scenario.apply`, `acq.*`), telemetría, fórmulas de comparación y comparabilidad, funciones de `js/core/analysis.js`.
- `docs/FORMATO_PERSISTIDO.md`: progreso, corridas, copia de seguridad y los campos aditivos de la fase C (`segments[].start/end/ctx`, `hints`, `closure.incidents/sweepIds/runs`). No suben `schemaVersion`; las corridas anteriores cargan y su resumen dice «No disponible» en vez de inventar.
- `docs/DISTRIBUCION_ESPACIAL.md`: coordenadas y reglas de la escena.
- Parámetros de URL: `time, speed, cloud, wind, view, pip, labels, q, session, practice, tab (power|day|iv|energy|run), panels, glfail` (`glfail=1` simula la falla de WebGL para pruebas).

## 5. Abrir, guardar, recuperar y exportar

- **Abrir**: doble clic en `index.html` (navegador reciente con WebGL). Inicia una sesión de demostración (el rol es local, no es autenticación).
- **Guardar**: el avance se guarda solo en este navegador por perfil (localStorage; las corridas y barridos en IndexedDB). El indicador junto a la guía dice cuándo se guardó o si el almacenamiento falló.
- **Recuperar**: al abrir con el mismo nombre y rol se recupera el avance; no se reanudan movimiento ni adquisición. «Prácticas» → «Copia de seguridad» → «Importar copia» valida el archivo antes de usarlo.
- **Exportar**: CSV de la corrida (botón bajo la gráfica o «Corridas guardadas»), CSV del tramo visible y PNG (pestaña Corrida), CSV de un barrido, copia de seguridad JSON, reporte HTML (imprimir o guardar como PDF desde el diálogo) y Markdown.
- Si WebGL se pierde y no vuelve: pulsa «Recargar»; antes puedes exportar la copia de seguridad.

## 6. Limitaciones reales

- Navegador: se requiere WebGL; sin él solo se ve el mensaje de ayuda (los datos guardados no se tocan).
- Almacenamiento: localStorage/IndexedDB del navegador; borrar los datos del sitio borra el avance. No hay servidor ni cuenta.
- Render: las pruebas usaron render por software (~1 fps); no hay cifras de rendimiento en GPU real.
- Escena pequeña en 390×844 y 900×520; en mañanas cercanas al equinoccio el módulo B sombrea parcialmente a A (documentado).
- Todo dato es simulado (pvlib + modelo de un diodo); DNI y DHI son derivadas del modelo.
- Los barridos guardan G y T solo al inicio y al final.
- Gráficas Potencia/Día/I‑V/Energía sin zoom ni cursor (solo «Corrida»).

## 7. Evidencia visual

`/mnt/project-files/entrega/capturas/final_*.png` (1920×1080, 1366×768, 1024×768, 768×1024, 390×844), `/mnt/project-files/faseC/` (pestaña Corrida, barridos I‑V, guía, ayudas 3D) y `/mnt/project-files/espacial/` (antes/después de la redistribución).

## 8. Depende de decisiones de ingeniería o institucionales

- Parámetros del módulo (≈ 500 Wp), coeficientes térmicos, velocidades de motores y umbrales de seguridad (14 m/s, reanudar < 10 m/s tras 120 s simulados, watchdog 6 s) son **provisionales**.
- Posiciones seguras definitivas del seguidor y procedimiento real de rearme del paro.
- Autenticación y reservas reales (hoy solo identidad de demostración).
- Política de retención y privacidad de datos de estudiantes; formato institucional del reporte.
- Horario real de las prácticas (la P3 usa un día simulado de 07:00 a 17:30).
- Validación pedagógica por docentes (glosario, pistas, observaciones esperadas) y prueba con personas sin experiencia (C19).
- Auditoría de accesibilidad con lector de pantalla, medición en equipos reales y conexión con el banco (`MqttSource`).

## 9. Correcciones de la auditoría (H01, H03, H04, H08, H10)

Aplicadas de la auditoría `DISENO_INTEGRAL_SOLAR_V1`; la prueba que las cubre es `tools/test_audit_fixes.js` (corre en CI). Quedan **fuera** H02 (sombras sin efecto eléctrico) y la redistribución física del banco.

- **H01 – tiempo físico independiente de la velocidad.** El motor avanza en pasos físicos de ≤ 0,1 s (`cfg.physics`); acelerar el reloj calcula más pasos, no motores, MPPT ni parpadeo de nubes más rápidos. Con el reloj en pausa el banco (motores, viento, MPPT) sigue a ritmo real y Sol, temperatura y energía se congelan. El watchdog de comunicación sigue en tiempo real. Resultado medido: energía de B a ×1/×60/×600/×3600 coincide dentro de ~0,1 % (antes la energía de motores se duplicaba de ×1 a ×60).
- **H04 – muestreo y segmentos.** El muestreo conserva el residuo del temporizador (sin deriva) y cuenta las muestras vencidas en `missedSamples`. Cada segmento se cierra de forma atómica con los acumuladores vigentes al detener, reanudar, poner energía a cero o aplicar escenario.
- **H10 – validación de escenario.** `scenario.apply` valida forma, azimut, inclinación, nubes, viento, semilla y velocidad **antes** de mutar nada (validador puro en `validate.js` y comprobación en el motor).
- **H03 – comparador.** Dos corridas solo son comparables si coinciden en hora de inicio, duración y modo de carga; cambiar modo de seguimiento o de carga dentro de una corrida, o una duración menor de 60 s, la marcan como alterada. Las tolerancias (`cfg.compare`: inicio 120 s, duración 5 % o 30 s) son **provisionales** y deben validarlas los docentes.
- **H08 – barrido I‑V.** El barrido continuo incluye el punto de cortocircuito (V = 0) al inicio y el de circuito abierto (I = 0) al terminar; un barrido interrumpido no inventa el extremo abierto.
- Efecto en pruebas existentes: `test_analysis_ui.js` ahora usa seguimiento fijo y 60 min simulados para que G varíe (con seguimiento astronómico la irradiancia del módulo B es casi constante y el R² dependía del ruido del sensor).
