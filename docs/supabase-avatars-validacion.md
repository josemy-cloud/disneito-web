# Fotos de perfil en Storage: configuración, validación y reversión

Cambio: `supabase/migrations/20261118120000_avatars_privados.sql` (bucket privado `avatars` y RLS) junto con `auth.js` y `worker.js` de la rama `seguridad-cookie-sesion`.
Proyecto: `APP dise` (`aqfqwvzbsbjrixzgxtro`), la URL que usan `auth.js` y `worker.js`.
**Nada de esto se ha ejecutado contra Supabase real.** Cada paso marcado con ✋ necesita autorización expresa.

Estado real auditado:
- 21/11/2026: no hay buckets en Storage ni políticas en `storage.objects`, y RLS está activo.
- Hay 3 cuentas, 2 de ellas con `avatar_data`.
- Inventario 01 (solo lectura, ejecutado): las dos fotos son JPEG (11.234 y 7.796 bytes), con `formato_migrable = true` y sin `avatar_path`.

La migración es compatible con este estado: la precondición pasa, se crea el bucket y no hay políticas previas con las que interferir.

Los scripts SQL, la migración y la reversión se **ejecutan** en las pruebas sobre PostgreSQL 16 en memoria, con una réplica mínima de `auth` y `storage` y RLS real (`tests/sql-*-pglite.test.mjs`). Eso no sustituye la validación contra Supabase real del paso 6.

Scripts manuales en `supabase/manual/avatars/`. **No** son migraciones: se ejecutan a mano y de uno en uno, cada uno completo (`begin … commit`) en una sola ejecución.

| Script | Efecto |
|---|---|
| `01_inventario_solo_lectura.sql` | Solo lectura: formato, tamaño y huellas MD5 y SHA-256 de cada foto incrustada. Un `avatar_data` con valor `null` no cuenta como foto |
| `02_crear_respaldo.sql` ✋ | Copia `avatar_data` en `nuhio_respaldo.avatar_data_20261121`. Se niega si ya existe un esquema `nuhio_respaldo` ajeno o expuesto por la API. Retira y comprueba todos los permisos de `anon` y `authenticated`, y verifica la copia |
| `03_verificar_integridad.sql` | Solo lectura: el estado de cada foto respaldada (tabla siguiente) y si el bucket sigue siendo privado |
| `04_eliminar_respaldo.sql` ✋ | Borra el respaldo. Solo se niega si hay cuentas en `fallo` o `revisar` |
| `05_restaurar_desde_respaldo.sql` ✋ | Emergencia: vuelve a añadir `avatar_data` solo a las cuentas en `migrada_integra` o `fallo` |

Estados (idénticos en 03, 04 y 05):

| Estado | Significado | Bloquea 04 | 05 restaura |
|---|---|---|---|
| `migrada_integra` | En la ruta de migración y coincide con el original (tamaño, MD5/eTag, tipo y propietario) | No | Sí |
| `fallo` | En la ruta de migración, pero el objeto falta o no coincide | **Sí** | Sí |
| `pendiente` | `avatar_data` sigue en `auth.users`, ya cubierto por las copias de la base de datos | No | No (no se sobrescribe) |
| `cambiada_por_usuario` | El usuario ha puesto otra foto, que existe | No | No |
| `eliminada_por_usuario` | Sin `avatar_path` ni `avatar_data` (clave ausente o `null`) | No | No |
| `cuenta_eliminada` | La cuenta ya no existe; al borrar el respaldo desaparece también su foto | No | No |
| `revisar` | `avatar_path` apunta a otra foto que no existe | **Sí** | No |

## Procedimiento

### Fase A · Preparación (sin publicar código)
1. **Inventario (solo lectura).** Hecho: 2 fotos JPEG migrables. Conserva sus MD5 y SHA-256.
2. ✋ **Respaldo.**
   1. Comprueba en Settings → API → *Exposed schemas* que `nuhio_respaldo` no aparece.
   2. Ejecuta `02_crear_respaldo.sql`. Debe terminar con `Respaldo correcto: 2 cuentas copiadas, sin permisos para anon ni authenticated`.
   3. Comprueba que los MD5 de la consulta del final del script coinciden con el inventario.
3. **Copias de seguridad.** En Database → Backups, comprueba qué ofrece tu plan. El respaldo del paso 2 queda dentro de esas copias; los archivos de Storage no.
4. **Margen de reutilización del refresh token.** En Authentication → Settings (Sessions), comprueba que *Refresh token reuse interval* no es 0. Por defecto es 10 s. Ese margen permite que dos pestañas que renuevan casi a la vez reciban la misma sesión, en lugar de que Supabase la revoque.
5. ✋ **Cuentas de prueba.** En Authentication → Users → *Add user*, crea A y B con el correo confirmado y sin foto.
6. ✋ **Migración SQL.**
   - Ejecuta **solo** `supabase/migrations/20261118120000_avatars_privados.sql`, completo, en una sola ejecución.
   - **No uses `supabase db push`** ni ninguna opción de «aplicar migraciones»: intentaría aplicar también otras migraciones de la carpeta que no estén en el historial del proyecto.
   - El código publicado hoy no usa Storage, así que este paso no lo afecta.

   Comprobación:
   ```sql
   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'avatars';
   -- Esperado: avatars | false | 524288 | {image/jpeg,image/png,image/webp}
   select policyname, permissive, roles, cmd from pg_policies
    where schemaname = 'storage' and tablename = 'objects' order by policyname;
   -- Esperado: exactamente 5 filas, todas «avatars: …». Cuatro PERMISSIVE para {authenticated}
   -- (SELECT, INSERT, UPDATE, DELETE) y una RESTRICTIVE para {public} con cmd ALL.
   ```
7. **Validación de seguridad real**, con A y B todavía sin foto. Se ejecuta en tu ordenador (Node 18 o superior), no desde un chat ni un conector. En una ventana nueva de PowerShell, desde la carpeta del repositorio, las contraseñas se escriben ocultas, solo existen en esa ventana y se borran al terminar:
   ```powershell
   $env:NUHIO_PRUEBA_A_EMAIL = Read-Host 'Correo de la cuenta de prueba A'
   $env:NUHIO_PRUEBA_A_PASSWORD = [Net.NetworkCredential]::new('', (Read-Host 'Contraseña A' -AsSecureString)).Password
   $env:NUHIO_PRUEBA_B_EMAIL = Read-Host 'Correo de la cuenta de prueba B'
   $env:NUHIO_PRUEBA_B_PASSWORD = [Net.NetworkCredential]::new('', (Read-Host 'Contraseña B' -AsSecureString)).Password
   node scripts/validar-avatars-supabase.mjs; $codigo = $LASTEXITCODE
   Remove-Item Env:NUHIO_PRUEBA_A_PASSWORD, Env:NUHIO_PRUEBA_B_PASSWORD, Env:NUHIO_PRUEBA_A_EMAIL, Env:NUHIO_PRUEBA_B_EMAIL
   "Código de salida: $codigo"
   ```
   El script no imprime contraseñas ni tokens. Solo crea y borra objetos en las carpetas de A y B, añade y retira la clave temporal `nuhio_validacion` en A, y abre y cierra una sesión adicional de A. La URL y la clave anónima, ambas públicas, las lee de `disenador-web/auth.js`.
   Debe dar las 27 comprobaciones correctas y código de salida 0. Cubre:
   - acceso a la carpeta propia;
   - sin URL pública ni acceso anónimo;
   - B no lee, firma, sube, sobrescribe, borra, mueve, copia ni enumera nada de A, ni ve su UID;
   - los límites de tamaño y tipo;
   - la fusión de `user_metadata` con `null`;
   - el cierre de sesión, en tres partes:
     - el refresh token queda invalidado;
     - `/auth/v1/user`, y por tanto el Worker, rechaza el access token al instante;
     - otra sesión del mismo usuario no se ve afectada;
   - la limpieza.

   Puede mostrar dos **AVISOS** de vigencia residual: REST y Storage solo verifican la firma y la caducidad del JWT, así que aceptan el access token de una sesión cerrada hasta su `exp`. Es el comportamiento de Supabase. El script comprueba que está acotado a 1 h como máximo, y el Worker no lo acepta.

   Cualquier FALLO detiene el proceso: aplica la reversión SQL (sección «Reversión»).
8. **Foto antigua de prueba.** Con el código publicado ahora en la URL de pruebas, entra con A y añade una foto en Cuenta. Así A queda con `avatar_data`, igual que las cuentas reales. Vuelve a ejecutar `01_inventario_solo_lectura.sql` y anota el MD5 de A.

### Fase B · Código en la URL de pruebas (`desarrollo-cloudflare`) ✋
9. Publica el código en `desarrollo-cloudflare` y espera a que Workers Builds termine correctamente.
10. **Con A** (foto antigua), en Chrome:
    1. Al entrar, la foto se migra: aparece `avatars/<uid de A>/avatar-migrado.jpg`, `avatar_data` desaparece y la foto se sigue viendo en Cuenta.
    2. Integridad: el tamaño y el eTag del objeto coinciden con los anotados en el paso 8:
       ```sql
       select name, metadata->>'size' as bytes, trim(both '"' from metadata->>'eTag') as md5, metadata->>'mimetype' as tipo
         from storage.objects where bucket_id = 'avatars';
       ```
    3. DevTools → Application → Cookies: `__Host-disenito-session` existe, con HttpOnly, Secure y SameSite=Lax, y su tamaño es inferior a 4096.
    4. En la consola del editor:
       ```js
       (async()=>{const r={};for(const p of ['/inventario-modelos-3d.json','/auditoria-biblioteca-modelos-3d.json','/index.html','/catalogo/productos-comerciales.json']){const x=await fetch(p,{cache:'no-store',redirect:'manual'});r[p]=x.status||x.type}console.table(r)})()
       ```
       Esperado: 404, 404, 200 y 200.
    5. Abre un proyecto de prueba, edítalo y comprueba que se guarda («sincronizado»).
    6. Con dos pestañas abiertas, fuerza o espera una renovación del token: ninguna debe recargarse. Cierra sesión en una: la otra vuelve a /acceso y la cookie desaparece.
11. **Con B** (sin foto): añade una foto nueva y luego elimínala. En Storage aparece y desaparece en `avatars/<uid de B>/` y `user_metadata` no contiene `avatar_data`.
12. Repite `node scripts/validar-avatars-supabase.mjs`. Ahora también comprueba que el JWT de A, ya migrado, cabe en la cookie.

### Fase C · Cuentas reales
13. Las dos cuentas reales migran solas al entrar con el código nuevo. Después, ejecuta `03_verificar_integridad.sql`:
    - cada cuenta que haya entrado debe estar en `migrada_integra`;
    - las que no hayan entrado siguen en `pendiente`, y es lo normal;
    - el bucket debe aparecer como `publico = false`.
14. Observa durante 24–48 h. Producción (`main`) requiere una autorización aparte.
15. ✋ Al terminar, ejecuta `04_eliminar_respaldo.sql`. Se negará mientras alguna cuenta esté en `fallo` o `revisar`.

## Reversión, siempre en este orden
1. **Código:** revierte los commits de `auth.js` y `worker.js` y publica.
   - Las cuentas siguen entrando: el código anterior usa el token en la cabecera `Authorization` y no necesita la cookie ni Storage.
   - Las cuentas ya migradas muestran sus iniciales en lugar de la foto. La foto se conserva en Storage y en el respaldo.
2. ✋ **Fotos en formato antiguo**, si se quiere: ejecuta `05_restaurar_desde_respaldo.sql`.
   - Solo afecta a las cuentas cuya foto vigente sigue siendo la migrada.
   - No sobrescribe fotos nuevas ni recupera fotos que el usuario eliminó.
3. ✋ **SQL, solo si hace falta:** ejecuta `supabase/rollback/20261118120000_avatars_privados.down.sql`.
   - No borra fotos y retira las políticas permisivas.
   - Mientras exista el bucket, deja un **bloqueo total**: una política restrictiva que deniega cualquier operación sobre `avatars` a todos los roles, también frente a políticas permisivas futuras.
   - Avisa si el bucket es público: las URL públicas no pasan por RLS.
   - Solo elimina el bucket si está vacío.
   - Volver a aplicar la migración retira el bloqueo.
