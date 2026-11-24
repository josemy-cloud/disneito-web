# Pruebas aisladas de NuHio
Chrome real con toda la red interceptada (host ficticio `nuhio.test`); `auth.js`, OrbitControls, loaders y pdf.js son sustitutos locales; three.min.js 0.128 se lee de `NUHIO_VENDOR_DIR`.
    NUHIO_VENDOR_DIR=/ruta/con/three.min.js node --test tests/seguridad-importacion.test.mjs
La carga de prueba solo incrementa `window.__CANARIO`; no accede a datos, red ni almacenamiento reales.

## Sesión, cookie y fotos de perfil
`tests/harness/real-harness.mjs` ejecuta los archivos reales (`acceso.html`, `auth.js`, `index.html`, `worker.js`) con Supabase Auth y Storage simulados. El Storage reproduce las reglas de `supabase/migrations/20261118120000_avatars_privados.sql`, y los fallos se pueden inyectar con `supa.fallos`.
    CHROME_BIN=/ruta/a/chrome node --test tests/sesion-worker.test.mjs tests/sesion-navegador.test.mjs tests/avatars-politicas.test.mjs
`tests/assets-manifiesto-wrangler.test.mjs` compara los assets simulados con los de `wrangler deploy --dry-run`, que no despliega. Solo se ejecuta con `WRANGLER_BIN` definido.
Las pruebas de navegador necesitan el paquete `playwright`, accesible por `NODE_PATH`.

## SQL de Supabase ejecutado en PostgreSQL en memoria
`tests/sql-respaldo-pglite.test.mjs` y `tests/sql-migracion-pglite.test.mjs` ejecutan los scripts de `supabase/manual/avatars`, la migración y la reversión en PostgreSQL 16 en memoria (PGlite). Usan una réplica mínima de `auth` y `storage` (`tests/harness/pglite-supabase.mjs`) con RLS real para `anon` y `authenticated`. Necesitan el paquete `@electric-sql/pglite`, accesible por `NODE_PATH`; si no está, se omiten. No sustituyen `scripts/validar-avatars-supabase.mjs` contra Supabase real.
