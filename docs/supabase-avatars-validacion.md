# Fotos de perfil en Storage: configuración, validación y reversión

Cambio: `supabase/migrations/20261118120000_avatars_privados.sql` (bucket privado `avatars` y RLS) junto con `auth.js` y `worker.js` de la rama `seguridad-cookie-sesion`.
**Nada de esto se ha ejecutado contra Supabase real.** Cada fase necesita autorización expresa.

## 0. Comprobaciones previas (solo lectura, SQL Editor de Supabase)
Confirma que el proyecto tiene copias de seguridad recientes (Database → Backups).

```sql
-- a) No debe existir un bucket `avatars` (0 filas). Si existe, la migración se detendrá: revísalo antes.
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'avatars';

-- b) RLS activo en storage.objects (debe ser true).
select relrowsecurity from pg_class where oid = 'storage.objects'::regclass;

-- c) Políticas actuales sobre storage.objects. Anota cualquier política permisiva amplia, es decir,
--    sin filtro por bucket_id, para «authenticated», «anon» o «public». La política restrictiva de la
--    migración protege `avatars` de ellas, pero conviene conocerlas.
select policyname, permissive, roles, cmd, qual, with_check
  from pg_policies where schemaname = 'storage' and tablename = 'objects' order by policyname;

-- d) Tamaño del problema: cuentas con foto incrustada en el JWT (no muestra las fotos).
select count(*) as cuentas, max(length(raw_user_meta_data->>'avatar_data')) as max_caracteres
  from auth.users where raw_user_meta_data ? 'avatar_data';
```

## 1. Cuentas de prueba
En Authentication → Users → *Add user*, crea dos cuentas de prueba, A y B, con el correo confirmado. No uses cuentas de clientes ni la tuya.

## 2. Aplicar la migración (una sola transacción)
1. Pega el contenido completo de `supabase/migrations/20261118120000_avatars_privados.sql` en el SQL Editor y ejecútalo.
2. Si aparece `Ya existe un bucket "avatars" con otra configuración`, no se ha cambiado nada. Detente y revisa ese bucket.
3. La migración no afecta al código publicado actualmente, que no usa Storage, así que puede aplicarse antes que el código.

Comprobación posterior:
```sql
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'avatars';
-- Esperado: avatars | false | 524288 | {image/jpeg,image/png,image/webp}

select policyname, permissive, roles, cmd from pg_policies
 where schemaname = 'storage' and tablename = 'objects' and policyname like 'avatars:%' order by policyname;
-- Esperado: 5 filas. Cuatro PERMISSIVE para {authenticated} (SELECT, INSERT, UPDATE, DELETE) y
-- una RESTRICTIVE para {public} con cmd ALL.
```

## 3. Validación de seguridad contra Supabase real
```bash
NUHIO_PRUEBA_A_EMAIL='…' NUHIO_PRUEBA_A_PASSWORD='…' NUHIO_PRUEBA_B_EMAIL='…' NUHIO_PRUEBA_B_PASSWORD='…' node scripts/validar-avatars-supabase.mjs
```
Debe terminar con todas las comprobaciones correctas y código de salida 0:
- A lee, sube y sobrescribe en su carpeta.
- No hay URL pública ni acceso anónimo, tampoco para enumerar.
- B no puede leer, firmar, subir, sobrescribir, borrar, mover, copiar ni enumerar nada de A, ni ver su UID.
- Se rechazan los archivos de más de 512 KB, los GIF y los objetos fuera de una carpeta de usuario.
- `PUT /auth/v1/user` fusiona `user_metadata` y `null` elimina la clave. Un AVISO aquí es tolerable.
- El token de una sesión cerrada se rechaza.
- La limpieza no deja objetos.

Cualquier FALLO detiene el despliegue: aplica la reversión SQL (sección 6).

## 4. Validación en la URL de pruebas, tras publicar el código en `desarrollo-cloudflare`
Con la cuenta de prueba A, en Chrome:
1. Cuenta → Añadir foto. La foto se ve y no hay errores CORS en la consola. Comprueba en Storage que el objeto está en `avatars/<uid de A>/`.
2. DevTools → Application → Cookies: `__Host-disenito-session` existe, con HttpOnly, Secure y SameSite=Lax, y su tamaño es inferior a 4096.
3. En la consola del editor:
   ```js
   (async()=>{const r={};for(const p of ['/inventario-modelos-3d.json','/auditoria-biblioteca-modelos-3d.json','/index.html','/catalogo/productos-comerciales.json']){const x=await fetch(p,{cache:'no-store',redirect:'manual'});r[p]=x.status||x.type}console.table(r)})()
   ```
   Esperado: 404, 404, 200 y 200.
4. Con una cuenta que tenga foto incrustada (la tuya, solo cuando A haya pasado todo):
   - al entrar se migra la foto;
   - en Storage aparece `avatars/<uid>/avatar-migrado.jpg`;
   - en `auth.users` ya no está `avatar_data`;
   - la cookie aparece y la comprobación del paso 3 da 404.
5. Abre dos pestañas del editor y espera más de una hora, o fuerza la renovación. Ninguna pestaña debe recargarse ni cerrar la sesión. Cierra sesión en una: la otra vuelve a /acceso.

## 5. Plan de despliegue
| Fase | Acción | Riesgo para los datos |
|---|---|---|
| 0 | Copias de seguridad y comprobaciones previas (sección 0) | Ninguno (solo lectura) |
| 1 | Migración SQL y validación (secciones 2 y 3) | Ninguno: solo crea un bucket nuevo y sus políticas |
| 2 | Código en `desarrollo-cloudflare` (preview) y validación (sección 4) | La foto incrustada solo se borra después de verificar su copia por SHA-256 |
| 3 | Observación en preview (24–48 h) | — |
| 4 | Producción, con autorización aparte | Igual que en la fase 2 |

## 6. Reversión, siempre en este orden
1. **Código:** revierte los commits de `auth.js` y `worker.js` y publica.
   - Las cuentas siguen entrando: el código anterior usa el token en la cabecera `Authorization` y no necesita la cookie ni Storage.
   - Las cuentas ya migradas muestran sus iniciales en lugar de la foto. La foto se conserva en Storage.
2. **SQL, solo si hace falta:** ejecuta `supabase/rollback/20261118120000_avatars_privados.down.sql`.
   - No borra fotos.
   - Retira las políticas permisivas.
   - Mantiene la restrictiva mientras exista el bucket, para no exponer fotos si hubiera políticas amplias.
   - Solo elimina el bucket si está vacío.
3. **Recuperar fotos tras revertir**, si se quiere: cada foto sigue en `avatars/<uid>/…` y `avatar_path` en `user_metadata`. Se pueden descargar con `service_role` desde un entorno de administración. Esto no está automatizado.
