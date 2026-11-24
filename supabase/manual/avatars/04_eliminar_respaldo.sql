-- 04 · ELIMINAR EL RESPALDO — MODIFICA LA BASE DE DATOS (requiere autorización)
-- Al terminar la observación. Borra únicamente la tabla y el esquema de respaldo; no toca auth.users ni Storage.
-- Usa la misma clasificación que 03 y solo se niega si alguna cuenta está en «fallo» o «revisar», porque
-- entonces el respaldo es la única copia válida de esa foto. No bloquean:
--   migrada_integra        la copia de Storage está verificada;
--   pendiente              la foto sigue en auth.users, cubierta por las copias de la base de datos;
--   cambiada_por_usuario / eliminada_por_usuario   decisión voluntaria del usuario: no se debe conservar
--                          ni restaurar su foto anterior;
--   cuenta_eliminada       al borrar el respaldo desaparece también su foto, como corresponde.

begin;

do $$
declare
  bloqueantes int; detalle text;
begin
  select count(*), string_agg(x.user_id::text || ' = ' || x.estado, ', ') into bloqueantes, detalle from (
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
  select user_id, estado from estado where estado in ('fallo', 'revisar')) x;
  if bloqueantes > 0 then
    raise exception 'No se elimina el respaldo: % cuentas necesitan revisión (%).', bloqueantes, detalle;
  end if;
end $$;

drop table nuhio_respaldo.avatar_data_20261121;
drop schema nuhio_respaldo;

commit;
