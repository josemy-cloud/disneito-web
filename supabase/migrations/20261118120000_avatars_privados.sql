-- Fotos de perfil fuera del JWT: bucket privado `avatars` con acceso solo a la carpeta propia.
--
-- Motivo: auth.js guardaba la foto como data: URL en user_metadata.avatar_data. Supabase copia
-- user_metadata en cada access_token, el JWT llegaba a ~21 KB y el navegador descartaba la cookie
-- __Host-disenito-session (límite de 4096 caracteres). Tras esta migración, user_metadata solo
-- guarda la ruta corta `avatar_path` ("<uid>/avatar-....jpg").
--
-- PENDIENTE DE AUTORIZACIÓN: no se ha ejecutado contra el proyecto real de Supabase.
-- Reversión: supabase/rollback/20261118120000_avatars_privados.down.sql
--
-- Diseño de seguridad:
--  * El bucket NO es público: no existe URL pública permanente. El cliente descarga la foto con su
--    propio token (GET /storage/v1/object/authenticated/avatars/<ruta>) y la muestra como blob: local.
--  * Solo el rol `authenticated` tiene políticas; `anon` no puede leer, listar ni escribir.
--  * Cada usuario solo puede leer, crear, sobrescribir y borrar objetos bajo "<su uid>/".
--  * Límite de 512 KB y solo JPEG, PNG o WebP (el cliente sube JPEG de 256 px, ~15 KB).

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 524288, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatars: leer la carpeta propia" on storage.objects;
drop policy if exists "avatars: subir a la carpeta propia" on storage.objects;
drop policy if exists "avatars: sobrescribir en la carpeta propia" on storage.objects;
drop policy if exists "avatars: borrar de la carpeta propia" on storage.objects;

create policy "avatars: leer la carpeta propia"
  on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "avatars: subir a la carpeta propia"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- La subida con x-upsert (reintentos de la migración) necesita UPDATE además de INSERT y SELECT.
create policy "avatars: sobrescribir en la carpeta propia"
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "avatars: borrar de la carpeta propia"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

commit;
