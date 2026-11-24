-- Reversión de 20261118120000_avatars_privados.sql (NO ejecutada).
--
-- Orden: primero revierte el código (auth.js y worker.js) y después, si hace falta, ejecuta esto.
-- El código anterior no usa Storage: las cuentas siguen entrando y se muestran las iniciales.
--
-- Garantías:
--  * No borra ninguna foto: los objetos de storage.objects se conservan.
--  * Retira las cuatro políticas permisivas de la migración.
--  * Mientras el bucket exista, crea un BLOQUEO TOTAL: una política RESTRICTIVE para todos los roles que
--    niega leer, crear, modificar o borrar cualquier objeto de `avatars`. Las políticas restrictivas se
--    combinan con AND, así que ninguna política permisiva, actual o FUTURA, puede abrir el acceso.
--    Solo service_role (servidor) omite RLS, como en cualquier bucket.
--  * Mantiene también la restrictiva de «carpeta propia» (redundante con el bloqueo).
--  * Solo elimina el bucket si está vacío, y entonces también las dos políticas restrictivas. Si Supabase
--    impide el borrado directo (trigger de protección de storage), se avisa y el resto se aplica igual.
--  * Avisa si el bucket es público: las URL públicas no pasan por RLS. Debe seguir siendo privado.
--  * Es idempotente. Volver a aplicar la migración retira el bloqueo.

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
  if exists (select 1 from storage.buckets where id = 'avatars') then
    drop policy if exists "avatars: bloqueo tras la reversión (restrictiva)" on storage.objects;
    create policy "avatars: bloqueo tras la reversión (restrictiva)"
      on storage.objects as restrictive for all to public
      using (bucket_id <> 'avatars')
      with check (bucket_id <> 'avatars');
    if (select public from storage.buckets where id = 'avatars') then
      raise warning 'El bucket "avatars" es PÚBLICO: sus URL públicas no pasan por RLS. Vuelve a hacerlo privado.';
    end if;
  else
    drop policy if exists "avatars: bloqueo tras la reversión (restrictiva)" on storage.objects;
    drop policy if exists "avatars: solo la carpeta propia (restrictiva)" on storage.objects;
  end if;
end $$;

commit;
