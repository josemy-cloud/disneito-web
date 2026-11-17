# Pruebas aisladas de NuHio
Chrome real con toda la red interceptada (host ficticio `nuhio.test`); `auth.js`, OrbitControls, loaders y pdf.js son sustitutos locales; three.min.js 0.128 se lee de `NUHIO_VENDOR_DIR`.
    NUHIO_VENDOR_DIR=/ruta/con/three.min.js node --test tests/seguridad-importacion.test.mjs
La carga de prueba solo incrementa `window.__CANARIO`; no accede a datos, red ni almacenamiento reales.
