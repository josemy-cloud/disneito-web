-- 02 · RESPALDO DE LAS FOTOS INCRUSTADAS ANTES DE MIGRAR — MODIFICA LA BASE DE DATOS (requiere autorización)
--
-- Motivo: las copias de seguridad de la base de datos no incluyen los archivos de Storage. Mientras dure la
-- observación, se guarda una copia exacta de avatar_data en una tabla privada, sí cubierta por esas copias.
--
-- Qué hace (una sola transacción; si algo falla, no queda nada):
--  1. Precondiciones; si alguna falla, se detiene sin cambiar nada:
--     * si ya existe un esquema "nuhio_respaldo" que no es exactamente este respaldo (otra tabla, una función
--       o el esquema vacío), lo considera ajeno y no lo reutiliza ni le cambia los permisos;
--     * si la configuración de PostgREST guardada en la base de datos expone "nuhio_respaldo".
--  2. Crea el esquema "nuhio_respaldo" y la tabla avatar_data_20261121 con user_id y avatar_data de las
--     cuentas cuya avatar_data es un texto. Las claves con valor null no son fotos. Solo LEE auth.users.
--  3. Retira todos los permisos a public, anon y authenticated, incluidos los que concedieran los privilegios
--     por defecto, y activa RLS sin políticas.
--  4. Comprueba que la copia es idéntica y que anon y authenticated no tienen ningún permiso sobre el
--     esquema ni sobre la tabla. Así no hay acceso aunque el esquema se expusiera por error.
-- Repetirlo antes de migrar es seguro: no sobrescribe la tabla y vuelve a comprobarla. Después de que
-- alguna cuenta haya migrado, la comprobación fallará (es lo esperado) y no se cambia nada.
--
-- Comprueba además en Settings → API → «Exposed schemas» que "nuhio_respaldo" no aparece: en el panel
-- alojado, esa lista puede no estar en la base de datos.
-- Contiene fotos personales: bórralo con 04_eliminar_respaldo.sql al terminar la observación.

begin;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'nuhio_respaldo') then
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'nuhio_respaldo' and c.relname = 'avatar_data_20261121' and c.relkind = 'r') then
      raise exception 'Ya existe un esquema "nuhio_respaldo" que no es este respaldo. No se modifica: revísalo.';
    end if;
    if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'nuhio_respaldo' and c.relname not in ('avatar_data_20261121', 'avatar_data_20261121_pkey'))
       or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'nuhio_respaldo') then
      raise exception 'El esquema "nuhio_respaldo" contiene otros objetos. No se modifica: revísalo.';
    end if;
  end if;
  if exists (select 1 from pg_roles r, unnest(coalesce(r.rolconfig, '{}'::text[])) cfg
              where r.rolname = 'authenticator' and cfg like 'pgrst.db_schemas=%'
                and cfg ~ '[=,]\s*"?nuhio_respaldo"?\s*(,|$)') then
    raise exception 'El esquema "nuhio_respaldo" figura entre los expuestos por la API (pgrst.db_schemas). Quítalo antes.';
  end if;
end $$;

create schema if not exists nuhio_respaldo;
revoke all on schema nuhio_respaldo from public, anon, authenticated;

create table if not exists nuhio_respaldo.avatar_data_20261121 as
  select u.id as user_id,
         u.raw_user_meta_data->>'avatar_data' as avatar_data,
         now() as copiado_en
    from auth.users u
   where jsonb_typeof(u.raw_user_meta_data->'avatar_data') = 'string';

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'nuhio_respaldo.avatar_data_20261121'::regclass and contype = 'p') then
    alter table nuhio_respaldo.avatar_data_20261121 add primary key (user_id);
  end if;
end $$;
alter table nuhio_respaldo.avatar_data_20261121 enable row level security;
revoke all on table nuhio_respaldo.avatar_data_20261121 from public, anon, authenticated;

-- Comprobaciones finales. Si alguna falla, se deshace todo.
do $$
declare
  n_origen int; n_copia int; distintas int;
begin
  select count(*) into n_origen from auth.users where jsonb_typeof(raw_user_meta_data->'avatar_data') = 'string';
  select count(*) into n_copia from nuhio_respaldo.avatar_data_20261121;
  select count(*) into distintas
    from nuhio_respaldo.avatar_data_20261121 r
    left join auth.users u on u.id = r.user_id
   where r.avatar_data is distinct from u.raw_user_meta_data->>'avatar_data';
  if n_origen <> n_copia or distintas <> 0 then
    raise exception 'Respaldo no coincide: origen=%, copia=%, distintas=%', n_origen, n_copia, distintas;
  end if;
  if has_schema_privilege('anon', 'nuhio_respaldo', 'usage') or has_schema_privilege('authenticated', 'nuhio_respaldo', 'usage')
     or has_table_privilege('anon', 'nuhio_respaldo.avatar_data_20261121', 'select,insert,update,delete,truncate,references,trigger')
     or has_table_privilege('authenticated', 'nuhio_respaldo.avatar_data_20261121', 'select,insert,update,delete,truncate,references,trigger') then
    raise exception 'anon o authenticated conservan permisos sobre el respaldo.';
  end if;
  raise notice 'Respaldo correcto: % cuentas copiadas, sin permisos para anon ni authenticated.', n_copia;
end $$;

commit;

-- Comprobación posterior (solo lectura):
--   select user_id, length(avatar_data), md5(decode(split_part(avatar_data, ',', 2), 'base64')) from nuhio_respaldo.avatar_data_20261121;
--   Los MD5 deben coincidir con los del inventario 01.
