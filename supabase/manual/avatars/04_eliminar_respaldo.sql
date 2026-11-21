-- 04 · ELIMINAR EL RESPALDO — MODIFICA LA BASE DE DATOS (requiere autorización)
-- Solo al terminar la observación, con 03_verificar_integridad.sql dando integra = true en todas las cuentas
-- migradas. Borra únicamente la tabla y el esquema de respaldo; no toca auth.users ni Storage.
-- Se niega a borrar si alguna cuenta del respaldo no tiene todavía una copia íntegra en Storage.

begin;

do $$
declare
  pendientes int;
begin
  select count(*) into pendientes
    from respaldo.avatar_data_20261121 r
    join auth.users u on u.id = r.user_id
    left join storage.objects ob on ob.bucket_id = 'avatars' and ob.name = u.raw_user_meta_data->>'avatar_path'
   where ob.id is null
      or md5(decode(split_part(r.avatar_data, ',', 2), 'base64')) is distinct from trim(both '"' from ob.metadata->>'eTag');
  if pendientes > 0 then
    raise exception 'Hay % cuentas sin copia íntegra en Storage: no se elimina el respaldo.', pendientes;
  end if;
end $$;

drop table respaldo.avatar_data_20261121;
drop schema respaldo;

commit;
