-- 05 · EMERGENCIA: RESTAURAR avatar_data DESDE EL RESPALDO — MODIFICA auth.users (requiere autorización)
-- Solo si hay que volver al formato antiguo, por ejemplo tras revertir el código, o si 03 muestra «fallo».
-- Usa la misma clasificación que 03 y SOLO restaura las cuentas cuya foto vigente sigue siendo la migrada:
--   migrada_integra, fallo   → se vuelve a añadir avatar_data (no se borra avatar_path ni nada de Storage).
--   pendiente                → no se toca: ya tiene avatar_data y no se sobrescribe.
--   cambiada_por_usuario     → no se toca: no se sustituye su foto nueva por la antigua.
--   eliminada_por_usuario    → no se toca: no se recupera una foto que el usuario eliminó.
--   cuenta_eliminada, revisar → no se toca.
-- Con el código nuevo, las cuentas restauradas repetirán la migración, que es idempotente. Con el código
-- anterior vuelven a ver su foto, aunque su JWT vuelve a ser grande y la cookie no se crea.
-- Ejecuta 03 antes y después para ver qué cuentas se restauran. Repetirlo no cambia nada más.

begin;

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
update auth.users u
   set raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('avatar_data', o.avatar_data)
  from estado e
  join original o on o.user_id = e.user_id
 where u.id = e.user_id
   and e.estado in ('migrada_integra', 'fallo');

commit;
