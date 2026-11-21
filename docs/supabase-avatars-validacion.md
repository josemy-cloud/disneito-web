# Fotos de perfil en Storage: configuración, validación y reversión

Cambio: `supabase/migrations/20261118120000_avatars_privados.sql` (bucket privado `avatars` y RLS) junto con `auth.js` y `worker.js` de la rama `seguridad-cookie-sesion`.
Proyecto: `APP dise` (`aqfqwvzbsbjrixzgxtro`), la URL que usan `auth.js` y `worker.js`.
**Nada de esto se ha ejecutado contra Supabase real.** Cada paso marcado con ✋ necesita autorización expresa.

Estado real auditado (21/11/2026):
- No hay buckets en Storage ni políticas en `storage.objects`.
- RLS está activo.
- Hay 3 cuentas, 2 de ellas con `avatar_data`.

La migración es compatible con este estado: la precondición pasa, se crea el bucket y no hay políticas previas con las que interferir.

Scripts manuales en `supabase/manual/avatars/`. **No** son migraciones: se ejecutan a mano y de uno en uno en el SQL Editor.

| Script | Efecto |
|---|---|
| `01_inventario_solo_lectura.sql` | Solo lectura: formato, tamaño y huellas MD5 y SHA-256 de cada foto incrustada |
| `02_crear_respaldo.sql` ✋ | Copia `avatar_data` en `respaldo.avatar_data_20261121`, un esquema no expuesto y sin permisos para anon ni authenticated. Verifica la copia |
| `03_verificar_integridad.sql` | Solo lectura: compara cada foto original con su objeto en Storage (tamaño, MD5/eTag, carpeta y propietario) |
| `04_eliminar_respaldo.sql` ✋ | Borra el respaldo. Se niega si falta alguna copia íntegra |
| `05_restaurar_desde_respaldo.sql` ✋ | Emergencia: vuelve a añadir `avatar_data` desde el respaldo |

## Procedimiento

### Fase A · Preparación (sin publicar código)
1. **Inventario (solo lectura).** Ejecuta `01_inventario_solo_lectura.sql` y guarda el resultado. Esperado: 2 filas con `formato_migrable = true`.
2. ✋ **Respaldo.**
   1. Comprueba en Settings → API → *Exposed schemas* que `respaldo` no aparece.
   2. Ejecuta `02_crear_respaldo.sql`. Debe terminar con `Respaldo correcto: 2 cuentas copiadas`.
   3. Haz las comprobaciones del final del script: los MD5 coinciden con el inventario y `anon`/`authenticated` no tienen acceso al esquema.
3. **Copias de seguridad.** En Database → Backups, comprueba qué ofrece tu plan. El respaldo del paso 2 queda dentro de esas copias; los archivos de Storage no.
4. ✋ **Cuentas de prueba.** En Authentication → Users → *Add user*, crea A y B con el correo confirmado y sin foto.
5. ✋ **Migración SQL.**
   - Pega **solo** `supabase/migrations/20261118120000_avatars_privados.sql` en el SQL Editor y ejecútalo.
   - **No uses `supabase db push`**: intentaría aplicar también otras migraciones de la carpeta que no estén en el historial del proyecto.
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
6. **Validación de seguridad real**, con A y B todavía sin foto:
   ```bash
   NUHIO_PRUEBA_A_EMAIL='…' NUHIO_PRUEBA_A_PASSWORD='…' NUHIO_PRUEBA_B_EMAIL='…' NUHIO_PRUEBA_B_PASSWORD='…' node scripts/validar-avatars-supabase.mjs
   ```
   Debe dar todas las comprobaciones correctas y código de salida 0. Cubre:
   - acceso a la carpeta propia;
   - sin URL pública ni acceso anónimo;
   - B no lee, firma, sube, sobrescribe, borra, mueve, copia ni enumera nada de A, ni ve su UID;
   - los límites de tamaño y tipo;
   - la fusión de `user_metadata` con `null`;
   - el rechazo de un token de una sesión cerrada;
   - la limpieza.

   Cualquier FALLO detiene el proceso: aplica la reversión SQL (sección «Reversión»).
7. **Foto antigua de prueba.** Con el código publicado ahora en la URL de pruebas, entra con A y añade una foto en Cuenta. Así A queda con `avatar_data`, igual que las cuentas reales. Vuelve a ejecutar `01_inventario_solo_lectura.sql` y anota el MD5 de A.

### Fase B · Código en la URL de pruebas (`desarrollo-cloudflare`) ✋
8. Publica el código en `desarrollo-cloudflare` y espera a que Workers Builds termine correctamente.
9. **Con A** (foto antigua), en Chrome:
   1. Al entrar, la foto se migra: aparece `avatars/<uid de A>/avatar-migrado.jpg`, `avatar_data` desaparece y la foto se sigue viendo en Cuenta.
   2. Integridad: comprueba que el tamaño y el eTag del objeto coinciden con el tamaño y el MD5 anotados en el paso 7:
      ```sql
      select name, metadata->>'size' as bytes, trim(both '"' from metadata->>'eTag') as md5
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
10. **Con B** (sin foto): añade una foto nueva y luego elimínala. En Storage aparece y desaparece en `avatars/<uid de B>/` y `user_metadata` no contiene `avatar_data`.
11. Repite `node scripts/validar-avatars-supabase.mjs`. Ahora también comprueba que el JWT de A, ya migrado, cabe en la cookie.

### Fase C · Cuentas reales
12. Las dos cuentas reales migran solas al entrar con el código nuevo. Después, ejecuta `03_verificar_integridad.sql`. En cada cuenta migrada, todo debe dar `true` e `integra = true`. Si una cuenta no ha entrado todavía, sigue con `sigue_incrustada = true`, y es lo normal.
13. Observa durante 24–48 h. Producción (`main`) requiere una autorización aparte.
14. ✋ Al terminar, con `03` correcto en todas las cuentas, ejecuta `04_eliminar_respaldo.sql`.

## Reversión, siempre en este orden
1. **Código:** revierte los commits de `auth.js` y `worker.js` y publica.
   - Las cuentas siguen entrando: el código anterior usa el token en la cabecera `Authorization` y no necesita la cookie ni Storage.
   - Las cuentas ya migradas muestran sus iniciales en lugar de la foto. La foto se conserva en Storage y en el respaldo.
2. ✋ **Fotos en formato antiguo**, si se quiere: ejecuta `05_restaurar_desde_respaldo.sql`. Vuelve a añadir `avatar_data` sin borrar nada.
3. ✋ **SQL, solo si hace falta:** ejecuta `supabase/rollback/20261118120000_avatars_privados.down.sql`.
   - No borra fotos.
   - Retira las políticas permisivas.
   - Mantiene la restrictiva mientras exista el bucket.
   - Solo elimina el bucket si está vacío.
