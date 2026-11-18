// Revisión estática del bucket privado `avatars` (migración SQL y su reversión) y del uso que hace auth.js.
// No ejecuta nada contra Supabase. Ejecutar: node --test tests/avatars-politicas.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sinComentarios = s => s.replace(/--.*$/gm, '');
const sql = sinComentarios(readFileSync(join(root, 'supabase/migrations/20261118120000_avatars_privados.sql'), 'utf8'));
const down = sinComentarios(readFileSync(join(root, 'supabase/rollback/20261118120000_avatars_privados.down.sql'), 'utf8'));
const auth = readFileSync(join(root, 'disenador-web/auth.js'), 'utf8');
const politicas = [...sql.matchAll(/create policy "([^"]+)"\s+on storage\.objects\s+for (\w+)\s+to (\w+)\s+([\s\S]*?);/g)]
  .map(([, nombre, op, rol, cuerpo]) => ({ nombre, op, rol, cuerpo }));
const CARPETA_PROPIA = "bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text";

test('el bucket se crea (o se fuerza) como privado, con límite de tamaño y tipos de imagen', () => {
  assert.match(sql, /insert into storage\.buckets[\s\S]*values \('avatars', 'avatars', false, 524288, array\['image\/jpeg', 'image\/png', 'image\/webp'\]\)/);
  assert.match(sql, /on conflict \(id\) do update\s+set public = false/);
  assert.doesNotMatch(sql, /public\s*=\s*true|,\s*true\s*,\s*524288/);
});

test('exactamente cuatro políticas (select, insert, update, delete), solo para authenticated y solo sobre la carpeta propia', () => {
  assert.deepEqual(politicas.map(p => p.op).sort(), ['delete', 'insert', 'select', 'update']);
  for (const p of politicas) {
    assert.equal(p.rol, 'authenticated', p.nombre);
    const condiciones = [...p.cuerpo.matchAll(/(using|with check) \(([\s\S]*?)\)\s*(?=with check|$)/g)];
    assert.ok(condiciones.length >= 1, p.nombre);
    for (const [, , cond] of condiciones) assert.equal(cond.replace(/\s+/g, ' ').trim(), CARPETA_PROPIA, p.nombre);
  }
  const upd = politicas.find(p => p.op === 'update').cuerpo;
  assert.match(upd, /using \(/); assert.match(upd, /with check \(/);
  assert.doesNotMatch(sql, /\bto (anon|public)\b/);
  assert.match(sql, /^begin;/m); assert.match(sql, /^commit;/m);
});

test('la reversión elimina las cuatro políticas y solo borra el bucket si está vacío (sin borrar fotos)', () => {
  for (const p of politicas) assert.ok(down.includes(`drop policy if exists "${p.nombre}" on storage.objects;`), p.nombre);
  assert.match(down, /delete from storage\.buckets b\s+where b\.id = 'avatars'\s+and not exists \(select 1 from storage\.objects o where o\.bucket_id = 'avatars'\)/);
  assert.doesNotMatch(down, /delete from storage\.objects/);
});

test('auth.js no vuelve a incrustar fotos en el JWT ni usa URLs públicas o firmadas', () => {
  assert.doesNotMatch(auth, /toDataURL\(/, 'la foto nueva se sube como Blob');
  assert.doesNotMatch(auth, /avatar_data\s*:\s*(?!null)[A-Za-z_'"]/, 'solo se escribe avatar_data: null');
  assert.doesNotMatch(auth, /\/object\/(public|sign)\//);
  assert.match(auth, /avatarURL\('authenticated'/, 'lectura autenticada');
  assert.match(auth, /URL\.createObjectURL/, 'se muestra como blob: local');
  assert.match(auth, /user\.id\+'\/'\+/, 'la ruta empieza por el uid del usuario (carpeta propia)');
});

test('auth.js nunca envía al Worker un token cuya cookie no cabría y declara lo nuevo con var/function (auth.js se carga dos veces)', () => {
  assert.match(auth, /if\(!sessionCookieFits\(token\)\)\{migrateAvatar\(\)/);
  assert.match(auth, /var SESSION_COOKIE_LIMIT=4000/);
  for (const nombre of ['syncSessionCookie', 'scheduleSessionRefresh', 'migrateAvatar', 'setAvatar', 'uploadAvatarVerified', 'avatarSource', 'refreshSessionNow'])
    assert.match(auth, new RegExp('(async )?function ' + nombre + '\\('), nombre);
});
