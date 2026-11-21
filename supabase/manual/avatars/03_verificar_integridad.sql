-- 03 · INTEGRIDAD DE LAS FOTOS DESPUÉS DE MIGRAR (SOLO LECTURA)
-- Compara, para cada cuenta del respaldo, la foto original (avatar_data) con el objeto de Storage que
-- referencia ahora avatar_path. No descarga ni muestra imágenes.
-- La aplicación ya verifica cada copia por SHA-256 antes de retirar avatar_data. Esta es una comprobación
-- independiente desde el servidor.

with original as (
  select r.user_id, decode(split_part(r.avatar_data, ',', 2), 'base64') as bytes
    from respaldo.avatar_data_20261121 r
)
select
  o_.user_id,
  u.raw_user_meta_data->>'avatar_path'                         as avatar_path,
  u.raw_user_meta_data ? 'avatar_data'                         as sigue_incrustada,
  ob.id is not null                                            as objeto_existe,
  split_part(ob.name, '/', 1) = o_.user_id::text               as en_carpeta_propia,
  coalesce(ob.owner_id, ob.owner::text) = o_.user_id::text     as propietario_correcto,
  ob.metadata->>'mimetype'                                     as tipo,
  octet_length(o_.bytes)                                       as bytes_original,
  (ob.metadata->>'size')::bigint                               as bytes_storage,
  md5(o_.bytes)                                                as md5_original,
  trim(both '"' from ob.metadata->>'eTag')                     as etag_storage,
  (ob.id is not null
   and octet_length(o_.bytes) = (ob.metadata->>'size')::bigint
   and md5(o_.bytes) = trim(both '"' from ob.metadata->>'eTag')) as integra
from original o_
join auth.users u on u.id = o_.user_id
left join storage.objects ob on ob.bucket_id = 'avatars' and ob.name = u.raw_user_meta_data->>'avatar_path'
order by o_.user_id;

-- Esperado para cada cuenta migrada: sigue_incrustada = false, objeto_existe = en_carpeta_propia =
-- propietario_correcto = true, tipo = image/jpeg e integra = true.
-- Una cuenta que aún no ha entrado con el código nuevo seguirá con sigue_incrustada = true y
-- avatar_path vacío: es lo normal.
-- Nota: en subidas de una sola parte, el eTag de Storage es el MD5 del contenido. Si integra = false pero
-- los tamaños coinciden y el eTag no tiene formato MD5 (32 hexadecimales; p. ej. «…-1» en subidas por
-- partes), compara el SHA-256 descargando el objeto en un entorno de administración. No borres el
-- respaldo hasta aclararlo.
