-- 02 · RESPALDO DE LAS FOTOS INCRUSTADAS ANTES DE MIGRAR — MODIFICA LA BASE DE DATOS (requiere autorización)
--
-- Motivo: las copias de seguridad de la base de datos no incluyen los archivos de Storage. Mientras dure la
-- observación, se guarda una copia exacta de avatar_data en una tabla privada, sí cubierta por esas copias.
--
-- Qué hace (una sola transacción; si algo no cuadra, no queda nada):
--  * Crea el esquema `respaldo`, no expuesto por la API, y le retira todos los permisos a public, anon y
--    authenticated.
--  * Copia user_id y avatar_data de las cuentas que los tengan. Solo LEE auth.users; no lo modifica.
--  * Activa RLS sin políticas en la tabla (defensa adicional) y comprueba que la copia es idéntica.
-- Idempotente: si la tabla ya existe, no la sobrescribe y solo repite la comprobación.
--
-- Antes de ejecutarlo: comprueba en Settings → API → «Exposed schemas» que `respaldo` NO aparece.
-- Contiene fotos personales: bórralo con 04_eliminar_respaldo.sql al terminar la observación.

begin;

create schema if not exists respaldo;
revoke all on schema respaldo from public, anon, authenticated;

create table if not exists respaldo.avatar_data_20261121 as
  select u.id as user_id,
         u.raw_user_meta_data->>'avatar_data' as avatar_data,
         now() as copiado_en
    from auth.users u
   where u.raw_user_meta_data ? 'avatar_data';

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'respaldo.avatar_data_20261121'::regclass and contype = 'p') then
    alter table respaldo.avatar_data_20261121 add primary key (user_id);
  end if;
end $$;
alter table respaldo.avatar_data_20261121 enable row level security;
revoke all on respaldo.avatar_data_20261121 from public, anon, authenticated;

-- Comprobación: misma cantidad de cuentas y contenido idéntico byte a byte. Si no, se deshace todo.
do $$
declare
  n_origen int; n_copia int; distintas int;
begin
  select count(*) into n_origen from auth.users where raw_user_meta_data ? 'avatar_data';
  select count(*) into n_copia from respaldo.avatar_data_20261121;
  select count(*) into distintas
    from respaldo.avatar_data_20261121 r
    left join auth.users u on u.id = r.user_id
   where r.avatar_data is distinct from u.raw_user_meta_data->>'avatar_data';
  if n_origen <> n_copia or distintas <> 0 then
    raise exception 'Respaldo no coincide: origen=%, copia=%, distintas=%', n_origen, n_copia, distintas;
  end if;
  raise notice 'Respaldo correcto: % cuentas copiadas.', n_copia;
end $$;

commit;

-- Comprobación posterior (solo lectura):
--   select user_id, length(avatar_data), md5(decode(split_part(avatar_data, ',', 2), 'base64')) from respaldo.avatar_data_20261121;
--   Los MD5 deben coincidir con los del inventario 01.
--   select has_schema_privilege('anon', 'respaldo', 'usage'), has_schema_privilege('authenticated', 'respaldo', 'usage');
--   Ambos deben ser false.
