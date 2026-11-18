-- Reversión de 20261118120000_avatars_privados.sql (NO ejecutada).
--
-- Orden: primero revierte el código (auth.js y worker.js) y después, si hace falta, ejecuta esto.
-- El código anterior no usa Storage: las cuentas siguen entrando y se muestran las iniciales.
--
-- Garantías:
--  * No borra ninguna foto: los objetos de storage.objects se conservan.
--  * Retira las cuatro políticas permisivas: nadie (salvo service_role) puede leer ni escribir en
--    `avatars` hasta volver a aplicar la migración.
--  * MANTIENE la política restrictiva mientras exista el bucket. Si se retirara y existiera alguna
--    política amplia anterior sobre storage.objects, las fotos conservadas quedarían expuestas.
--  * Solo elimina el bucket (y entonces la política restrictiva) si está vacío. Si Supabase impide el
--    borrado directo (trigger de protección de storage), se avisa y el resto de la reversión se aplica igual.
--  * Es idempotente: se puede ejecutar varias veces.

begin;

drop policy if exists "avatars: leer la carpeta propia" on storage.objects;
drop policy if exists "avatars: subir a la carpeta propia" on storage.objects;
drop policy if exists "avatars: sobrescribir en la carpeta propia" on storage.objects;
drop policy if exists "avatars: borrar de la carpeta propia" on storage.objects;

do $$
begin
  begin
    delete from storage.buckets b
     where b.id = 'avatars'
       and not exists (select 1 from storage.objects o where o.bucket_id = 'avatars');
  exception when others then
    raise notice 'No se pudo eliminar el bucket vacío (%). Elimínalo desde el panel si lo deseas.', sqlerrm;
  end;
  if not exists (select 1 from storage.buckets where id = 'avatars') then
    drop policy if exists "avatars: solo la carpeta propia (restrictiva)" on storage.objects;
  end if;
end $$;

commit;
