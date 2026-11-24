// PostgreSQL real en memoria (PGlite) con una réplica mínima de lo que usan los scripts de Supabase:
// roles anon/authenticated/service_role, auth.users, auth.uid(), storage.buckets, storage.objects (con RLS) y
// storage.foldername() con su definición original. Sirve para EJECUTAR los scripts SQL y sus políticas RLS.
// No sustituye la validación contra Supabase real (scripts/validar-avatars-supabase.mjs).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
export const PGlite = (() => { try { return require('@electric-sql/pglite').PGlite; } catch { return null; } })();

const ESQUEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role authenticator nologin noinherit;
create schema auth;
create table auth.users (id uuid primary key, raw_user_meta_data jsonb, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text not null, owner uuid, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, owner_id text, metadata jsonb, created_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language plpgsql as $function$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $function$;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
`;

export async function crearBase() {
  if (!PGlite) throw new Error('PGlite no disponible');
  const db = new PGlite();
  await db.exec(ESQUEMA);
  return db;
}
// Ejecuta un archivo .sql completo como lo haría el SQL Editor. Si falla, deshace la transacción abierta.
export async function ejecutarArchivo(db, ruta) {
  const sql = readFileSync(join(root, ruta), 'utf8');
  try { return await db.exec(sql); } catch (e) { await db.exec('rollback').catch(() => {}); throw e; }
}
export const leerArchivo = ruta => readFileSync(join(root, ruta), 'utf8');
// Consulta como un rol concreto (y con su uid en el JWT), igual que PostgREST/Storage aplican RLS.
export async function como(db, rol, uid, sql, params = []) {
  await db.exec(`set role ${rol}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claim.sub', '', false)`); }
}
export const dataURL = (bytes, tipo = 'image/jpeg') => `data:${tipo};base64,${Buffer.from(bytes).toString('base64')}`;
export async function crearUsuario(db, id, meta = {}) {
  await db.query('insert into auth.users (id, raw_user_meta_data) values ($1, $2)', [id, JSON.stringify(meta)]);
}
export async function metadatos(db, id) { return (await db.query('select raw_user_meta_data m from auth.users where id = $1', [id])).rows[0]?.m; }
export async function fijarMetadatos(db, id, meta) { await db.query('update auth.users set raw_user_meta_data = $2 where id = $1', [id, JSON.stringify(meta)]); }
// Objeto de Storage con los metadatos que guarda Supabase (eTag = MD5 entre comillas en subidas simples).
export async function crearObjeto(db, nombre, bytes, { tipo = 'image/jpeg', dueño = nombre.split('/')[0], bucket = 'avatars' } = {}) {
  const md5 = createHash('md5').update(Buffer.from(bytes)).digest('hex');
  await db.query('insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3, $4, $5)',
    [bucket, nombre, /^[0-9a-f-]{36}$/.test(dueño) ? dueño : null, dueño, JSON.stringify({ size: Buffer.from(bytes).length, eTag: `"${md5}"`, mimetype: tipo })]);
}
export const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
