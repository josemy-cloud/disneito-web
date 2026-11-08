# Escanear habitación

## Alcance

Reconstrucción métrica asistida en el navegador. Acceso desde **Archivo → Escanear habitación**. No requiere un servidor propio, servicios de IA de pago, claves adicionales ni subir fotos o vídeos. El editor guarda únicamente la habitación y los elementos revisados con el proyecto.

1. Captura vistas con la cámara o importa fotos o un vídeo. En el vídeo se toman hasta 24 muestras temporales y se conservan hasta 16 vistas entre todas las fuentes.
2. Marca cuatro esquinas de una referencia rectangular horizontal y escribe el ancho y el fondo medidos. Usa el mismo rectángulo, con el mismo orden, en las otras vistas. Se puede intentar encontrar esas marcas en vistas cercanas, pero hay que confirmarlas.
3. Si la referencia es el perímetro completo, genera el rectángulo con sus medidas. Para una forma irregular, marca las esquinas de pared en orden y a ras del suelo. Cambia a otra vista calibrada si es necesario.
4. Marca los extremos de los huecos y el centro de los muebles a ras del suelo. Elige el modelo de biblioteca. Revisa las dimensiones, giro, elevación y color, y confirma las piezas que quieras importar.
5. Revisa el plano y crea la habitación. Se incorpora al lado de la geometría existente, con paredes, aperturas asociadas y muebles del editor. Deshacer revierte la incorporación en un paso.

La altura inicial de 250 cm y el grosor de pared de 10 cm son supuestos. El perímetro obtenido por proyección, los anchos de hueco y las posiciones de objetos son estimaciones. Una muestra de color refleja la iluminación de la captura; la sugerencia PBR por color tiene confianza baja y se aplica solo si se elige. Los huecos y muebles pendientes quedan fuera de la importación.

## Proponer el perímetro desde el vídeo o las fotos

**Analizar vídeo o fotos** busca en cada toma una región inferior de color continuo, comprueba sus cuatro bordes y descarta las regiones que tocan el borde de la imagen, son ambiguas o no forman un cuadrilátero suficientemente completo. Si otra vista distinta contiene los mismos puntos, la propuesta se etiqueta con confianza media; una propuesta de una sola vista tiene confianza baja. La forma azul debe coincidir con el suelo de pared a pared, no con una alfombra, una encimera u otra superficie similar.

El usuario mide la arista roja. En una perspectiva oblicua suficientemente estable, el análisis usa las dos direcciones ortogonales proyectadas para estimar la relación ancho/fondo; de lo contrario solicita también el fondo. Si la escala resulta estimada, el formulario y el plano lo indican. Solo al confirmar se crea un borrador; la importación en Disenito sigue siendo un paso separado.

El análisis automático de esta etapa cubre **contornos rectangulares visibles y cerrados**. Un tramo oculto, una estancia irregular, un suelo que continúa fuera de la foto o un encuadre estrecho pueden requerir una captura distinta o el trazado asistido. Los huecos y el mobiliario se siguen confirmando manualmente. La estimación de proporción presupone perspectiva rectilínea, píxeles cuadrados y centro óptico cerca del centro de la imagen. El recorte y los grandes angulares pueden sesgarla.

Referencias: [detección de líneas y bordes](https://docs.opencv.org/4.x/d9/db0/tutorial_hough_lines.html) y [metrología desde una vista](https://www.microsoft.com/en-us/research/publication/single-view-metrology/).

## Cuando el suelo queda oculto

Si el análisis no encuentra el suelo completo en las capturas, intenta localizar la unión con el techo en la vista seleccionada. También puedes pulsar **Desde techo y paredes** directamente. La posible pared del fondo se muestra en rojo y las posibles uniones laterales, en azul discontinuo. Son candidatos por contraste y continuidad de borde, con confianza baja. Usa **Corregir pared del fondo** para marcar sus dos extremos superiores si la detección incluye una moldura o un tramo vecino.

Introduce el ancho interior real de la pared del fondo y el fondo real de la habitación. **Crear borrador desde el techo** dibuja un rectángulo provisional con esos datos. Los demás tramos se muestran discontinuos en la revisión. Puedes corregir el plano antes de importarlo. La línea del techo no se reutiliza como calibración del suelo y no localiza muebles, huecos ni retranqueos ocultos. Se guarda el método de reconstrucción en los metadatos de la estancia.

## Auditoría e integración

- `index.html` sigue siendo el editor. Su modelo guarda paredes en `S.w`, huecos vinculados a paredes en `S.o` y muebles independientes en `S.i`. El escáner crea estos registros con identificadores nuevos y usa `detectRooms`, `roomsUpdate` y el guardado normal. El importador convierte el perímetro interior en ejes de pared para que el grosor no reste medidas al interior.
- `scan-room.mjs` controla las capturas, permisos, revisión y limpieza. `scan-core.mjs` contiene la transformación proyectiva y las validaciones. `scan-worker.mjs` procesa luminancia, detalle y correspondencias, con alternativa local si falla el Worker. `scan-room.css` solo afecta al diálogo.
- No se modifica el Worker de Cloudflare, la autenticación ni el esquema de persistencia. Los metadatos añadidos a la habitación son opcionales.

## Investigación y decisiones

| Tecnología | Evaluación |
| --- | --- |
| [MediaDevices y getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) | Entrada HTTPS con permiso explícito y detección de capacidad. En iOS y Android la cámara depende del navegador, permisos y hardware. Se usa una pista de vídeo, sin audio. Importar archivos es la alternativa. |
| [WebXR de Google](https://developers.google.com/ar/develop/webxr), [Depth API de ARCore](https://developers.google.com/ar/develop/depth), [compatibilidad WebXR](https://web-platform-dx.github.io/web-features-explorer/features/webxr-device/) | WebXR depende del navegador y del dispositivo; WebXR básico no garantiza `immersive-ar` ni profundidad. Safari de iOS y Windows requieren alternativas. Una eventual integración debe comprobar sesión, funciones y datos reales antes de usarlos. |
| [Apple RoomPlan](https://developer.apple.com/augmented-reality/roomplan/) | API Swift de ARKit para dispositivos compatibles con LiDAR; no se invoca desde Safari. Una aplicación auxiliar nativa o la importación de una exportación estructurada serían rutas distintas. |
| [Homografías de OpenCV](https://docs.opencv.org/5.0/tutorials/features/homography/homography.html) | Transformación de un plano a otro. Implementación pequeña en JS, sin dependencia externa. Permite combinar marcas coplanares de diferentes vistas registradas con la misma referencia; no recupera altura o profundidad volumétrica. OpenCV actual usa Apache 2.0. |
| [COLMAP](https://colmap.github.io/), [licencia BSD](https://github.com/colmap/colmap/blob/main/doc/license.rst), [ORB-SLAM3](https://github.com/UZ-SLAMLab/ORB_SLAM3) | SfM estima cámaras y estructura dispersa; MVS densifica geometría; SLAM visual/inercial puede seguir movimiento. Requieren imágenes solapadas y suficiente textura. Una nube o malla no proporciona paredes semánticas ni escala fiable por sí sola. COLMAP es BSD; ORB-SLAM3 es GPLv3 y requiere revisión de integración. No se incorporaron sus binarios. |
| [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) | La variante Small tiene licencia Apache 2.0; otras variantes tienen restricciones distintas. Profundidad relativa y modelos métricos son cosas distintas. Hay que contrastar la escala con referencias físicas. |
| [COCO-SSD](https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd), [Segment Anything](https://ai.meta.com/research/publications/segment-anything/) | Un detector da clases y rectángulos; un segmentador delimita siluetas. Ninguno aporta por sí mismo medidas o posiciones 3D, ni separa de forma fiable todos los electrodomésticos y materiales de una cocina. Antes de integrar hay que verificar licencias del código, pesos y datos, rendimiento y calidad con capturas reales. |
| [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) | WASM ofrece alternativa a WebGPU para una futura inferencia local. La compatibilidad se comprueba por navegador, proveedor y operador del modelo. El tamaño de los pesos y la memoria de móviles requieren una prueba específica. |
| [Límites de Cloudflare Workers](https://developers.cloudflare.com/workers/platform/limits/) | Los límites de memoria y CPU desaconsejan ejecutar SfM/MVS de vídeo en el Worker actual. Si una etapa posterior necesita cómputo especializado, debe ser optativa, con consentimiento y presupuesto aparte. |

## Validación y pendientes

```
node --test tests/scan-core.test.mjs tests/scan-auto.test.mjs
```

Las pruebas reproducibles cubren calibración en perspectiva, huecos, colisiones de huecos, anotaciones de mobiliario, geometría irregular, capturas ambiguas y correspondencia de imágenes sintéticas. No son un banco de imágenes de viviendas reales.

La fase asistida no incluye reconocimiento semántico automático, poses 3D libres, fusión de profundidad, segmentación de materiales ni reconstrucción volumétrica. Un piloto siguiente debe medir error dimensional frente a cinta o láser y probar Safari en iPhone, Chrome en Android y varios códecs de cámara, antes de activar inferencia o sensores de profundidad.
