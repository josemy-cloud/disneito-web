-- 05 · EMERGENCIA: RESTAURAR avatar_data DESDE EL RESPALDO — MODIFICA auth.users (requiere autorización)
-- Solo si hay que volver al formato antiguo, por ejemplo tras revertir el código y comprobar que alguna foto
-- migrada no es válida. Vuelve a añadir avatar_data a user_metadata de las cuentas del respaldo:
--  * no borra avatar_path ni ningún objeto de Storage;
--  * con el código nuevo, esas cuentas repetirán la migración, que es idempotente;
--  * con el código anterior, vuelven a ver su foto como antes, aunque su JWT vuelve a ser grande y la
--    cookie no se crea, igual que antes de la corrección.

begin;

update auth.users u
   set raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('avatar_data', r.avatar_data)
  from respaldo.avatar_data_20261121 r
 where u.id = r.user_id
   and (u.raw_user_meta_data->>'avatar_data') is distinct from r.avatar_data;

commit;

-- Comprobación (solo lectura): todas las cuentas del respaldo vuelven a tener exactamente su avatar_data.
--   select count(*) from respaldo.avatar_data_20261121 r join auth.users u on u.id = r.user_id
--    where u.raw_user_meta_data->>'avatar_data' is distinct from r.avatar_data;   -- esperado: 0
