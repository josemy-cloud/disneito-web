begin;

-- Verify the existing RPC and history schema before running this migration.
create or replace function public.foto_ia_cupo_cuenta(
  p_user_id uuid, p_operacion text, p_reserva text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fecha date := (pg_catalog.clock_timestamp() at time zone 'Europe/Madrid')::date;
  v_inicio timestamptz;
  v_fin timestamptz;
  v_hoy integer;
  v_reserva jsonb;
begin
  if p_user_id is null or p_operacion is null or p_operacion not in ('consultar','reservar','cancelar') then
    raise exception 'Operación de cupo inválida';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('disenito:fotoia:' || p_user_id::text, 0));
  v_fecha := (pg_catalog.clock_timestamp() at time zone 'Europe/Madrid')::date;
  v_inicio := v_fecha::timestamp at time zone 'Europe/Madrid';
  v_fin := (v_fecha + 1)::timestamp at time zone 'Europe/Madrid';

  if p_operacion = 'cancelar' then
    delete from public.foto_ia_generaciones
    where user_id = p_user_id and id::text = p_reserva;
    return pg_catalog.jsonb_build_object('ok', found);
  end if;

  select count(*) into v_hoy from public.foto_ia_generaciones
  where user_id = p_user_id and created_at >= v_inicio and created_at < v_fin;

  if p_operacion = 'reservar' and v_hoy < 2 then
    -- The existing reservation routine supplies the same row format and ID as before.
    perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
    perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
    perform pg_catalog.set_config('request.jwt.claims',
      pg_catalog.jsonb_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
    select pg_catalog.to_jsonb(public.foto_ia_reservar_generacion(p_user_id)) into v_reserva;
    if (v_reserva->>'ok') is distinct from 'true' or v_reserva->>'id' is null then
      raise exception 'La reserva de Foto IA no devolvió un identificador válido';
    end if;
    if not exists (
      select 1 from public.foto_ia_generaciones
      where id::text = v_reserva->>'id' and user_id = p_user_id
        and created_at >= v_inicio and created_at < v_fin
    ) then
      raise exception 'La reserva de Foto IA no quedó asociada a la cuenta';
    end if;
    v_hoy := v_hoy + 1;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', p_operacion = 'consultar' or v_reserva is not null,
    'id', v_reserva->>'id', 'hoy', v_hoy, 'limite', 2,
    'disponibles', greatest(0, 2 - v_hoy), 'fecha', v_fecha, 'renuevaEn', v_fin
  );
end;
$$;

revoke all on function public.foto_ia_cupo_cuenta(uuid,text,text) from public, anon, authenticated;
grant execute on function public.foto_ia_cupo_cuenta(uuid,text,text) to service_role;

-- Stop direct PostgREST calls from creating or cancelling reservations.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('foto_ia_reservar_generacion','foto_ia_cancelar_generacion','foto_ia_estadisticas')
  loop
    execute pg_catalog.format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end;
$$;
revoke insert, update, delete, truncate on public.foto_ia_generaciones from public, anon, authenticated;

commit;
