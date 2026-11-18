-- Reversión de 20261118120000_avatars_privados.sql (NO ejecutada).
--
-- Antes de revertir, publica la versión anterior de auth.js. Si no, el cliente nuevo no podrá
-- leer ni subir fotos.
-- Las fotos ya migradas siguen en storage.objects; este script no las borra para evitar pérdidas
-- de datos. Para volver al formato antiguo, cada usuario puede subir de nuevo su foto con la
-- versión anterior de la aplicación. Solo después se podrían borrar los objetos a mano.

begin;

drop policy if exists "avatars: leer la carpeta propia" on storage.objects;
drop policy if exists "avatars: subir a la carpeta propia" on storage.objects;
drop policy if exists "avatars: sobrescribir en la carpeta propia" on storage.objects;
drop policy if exists "avatars: borrar de la carpeta propia" on storage.objects;

-- El bucket solo se elimina si está vacío. Si tiene objetos, la sentencia no borra nada y se
-- conserva el bucket (privado y sin políticas: inaccesible para anon y authenticated).
-- En las versiones recientes de Supabase, un trigger impide borrar directamente de las tablas de
-- storage. Si este DELETE falla, elimina el bucket vacío desde el panel o con la API de Storage.
delete from storage.buckets b
 where b.id = 'avatars'
   and not exists (select 1 from storage.objects o where o.bucket_id = 'avatars');

commit;
