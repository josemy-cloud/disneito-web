-- 03 · ESTADO E INTEGRIDAD DE LAS FOTOS RESPALDADAS (SOLO LECTURA)
-- Para cada cuenta del respaldo, compara la foto original (JPEG, PNG o WebP) con su situación actual en
-- auth.users y Storage. No descarga ni muestra imágenes.
-- La aplicación ya verifica cada copia por SHA-256 antes de retirar avatar_data. Esta es una comprobación
-- independiente desde el servidor.
--
-- Estados (la misma clasificación usan 04 y 05):
--   migrada_integra        avatar_path es la ruta de migración y el objeto coincide con el original
--                          (tamaño, MD5 = eTag, tipo y propietario).
--   fallo                  avatar_path es la ruta de migración, pero el objeto falta o no coincide.  ⇒ REVISAR
--   pendiente              avatar_data sigue en auth.users (aún no ha entrado con el código nuevo).
--   cambiada_por_usuario   el usuario ha puesto otra foto, que existe en Storage.
--   eliminada_por_usuario  sin avatar_path y sin avatar_data (clave ausente o con valor null).
--   cuenta_eliminada       la cuenta ya no existe.
--   revisar                avatar_path apunta a otra foto que no existe en Storage.               ⇒ REVISAR

-- <clasificacion> Bloque idéntico en 03, 04 y 05 (lo comprueba tests/respaldo-avatars.test.mjs).
with original as (
  select r.user_id, r.avatar_data,
         decode(split_part(r.avatar_data, ',', 2), 'base64') as bytes,
         substring(r.avatar_data from '^data:([^;,]+)') as tipo
    from nuhio_respaldo.avatar_data_20261121 r
),
estado as (
  select o.user_id,
         u.raw_user_meta_data->>'avatar_path' as avatar_path,
         case when u.id is null then 'sin_cuenta'
              when not (u.raw_user_meta_data ? 'avatar_data') then 'ausente'
              when jsonb_typeof(u.raw_user_meta_data->'avatar_data') = 'null' then 'null'
              else 'presente' end as avatar_data_actual,
         o.tipo as tipo_original, ob.metadata->>'mimetype' as tipo_storage,
         octet_length(o.bytes) as bytes_original, (ob.metadata->>'size')::bigint as bytes_storage,
         md5(o.bytes) as md5_original, trim(both '"' from ob.metadata->>'eTag') as etag_storage,
         coalesce(ob.owner_id, ob.owner::text) as propietario_storage,
         case
           when u.id is null then 'cuenta_eliminada'
           when jsonb_typeof(u.raw_user_meta_data->'avatar_data') = 'string' then 'pendiente'
           when (u.raw_user_meta_data->>'avatar_path') is null then 'eliminada_por_usuario'
           when (u.raw_user_meta_data->>'avatar_path') !~ ('^' || o.user_id::text || '/avatar-migrado\.(jpg|png|webp)$')
             then case when ob.id is null then 'revisar' else 'cambiada_por_usuario' end
           when ob.id is null
             or octet_length(o.bytes) is distinct from (ob.metadata->>'size')::bigint
             or md5(o.bytes) is distinct from trim(both '"' from ob.metadata->>'eTag')
             or o.tipo is distinct from ob.metadata->>'mimetype'
             or coalesce(ob.owner_id, ob.owner::text) is distinct from o.user_id::text
             then 'fallo'
           else 'migrada_integra'
         end as estado
    from original o
    left join auth.users u on u.id = o.user_id
    left join storage.objects ob on ob.bucket_id = 'avatars' and ob.name = u.raw_user_meta_data->>'avatar_path'
)
-- </clasificacion>
select user_id, estado, avatar_data_actual, avatar_path, tipo_original, tipo_storage,
       bytes_original, bytes_storage, md5_original, etag_storage, propietario_storage
  from estado
 order by estado, user_id;

-- El bucket debe seguir siendo privado: una URL pública no pasa por RLS.
select id as bucket, public as publico from storage.buckets where id = 'avatars';   -- esperado: publico = false

-- Nota: en subidas de una sola parte, el eTag de Storage es el MD5 del contenido. Si aparece «fallo» con
-- los tamaños iguales y un eTag sin formato MD5 (32 hexadecimales; p. ej. «…-1» en subidas por partes),
-- compara el SHA-256 descargando el objeto en un entorno de administración. No borres el respaldo hasta
-- aclararlo.
