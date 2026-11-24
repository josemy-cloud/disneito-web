// EJECUTA la migración del bucket `avatars` y su reversión en PostgreSQL real en memoria (PGlite), con las
// políticas RLS aplicándose de verdad a anon/authenticated. Parte del estado real auditado: sin buckets, sin
// políticas en storage.objects y RLS activo. Requiere @electric-sql/pglite (NODE_PATH); si no está, se omite.
// No sustituye scripts/validar-avatars-supabase.mjs contra Supabase real (API de Storage, CORS, límites).
// Ejecutar: node --test tests/sql-migracion-pglite.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite, crearBase, ejecutarArchivo, como, crearObjeto, uuid } from './harness/pglite-supabase.mjs';

const omitir = !PGlite && 'PGlite no disponible';
const MIG = 'supabase/migrations/20261118120000_avatars_privados.sql';
const DOWN = 'supabase/rollback/20261118120000_avatars_privados.down.sql';
const A = uuid(1), B = uuid(2);
const politicas = async db => (await db.query(`select policyname, permissive, roles::text r, cmd from pg_policies where schemaname = 'storage' and tablename = 'objects' order by policyname`)).rows;
const total = async (db, bucket = 'avatars') => (await db.query('select count(*)::int n from storage.objects where bucket_id = $1', [bucket])).rows[0].n;
// Operaciones como un usuario concreto (o anon): devuelven filas afectadas, o 'denegado' si RLS lo impide.
const ver = (db, rol, uid, bucket = 'avatars') => como(db, rol, uid, `select name from storage.objects where bucket_id = $1 order by name`, [bucket]).then(r => r.rows.map(x => x.name));
const subir = (db, rol, uid, nombre, bucket = 'avatars') => como(db, rol, uid, `insert into storage.objects (bucket_id, name, owner_id, metadata) values ($1, $2, $3, '{}')`, [bucket, nombre, uid]).then(() => 'ok', e => /row-level security/.test(e.message) ? 'denegado' : Promise.reject(e));
const renombrar = (db, rol, uid, de, a) => como(db, rol, uid, `update storage.objects set name = $2 where bucket_id = 'avatars' and name = $1`, [de, a]).then(r => r.affectedRows, e => /row-level security/.test(e.message) ? 'denegado' : Promise.reject(e));
const borrar = (db, rol, uid, nombre) => como(db, rol, uid, `delete from storage.objects where bucket_id = 'avatars' and name = $1`, [nombre]).then(r => r.affectedRows);

async function conFotos() {
  const db = await crearBase();
  await ejecutarArchivo(db, MIG);
  await crearObjeto(db, `${A}/avatar-migrado.jpg`, Buffer.from('a'));
  await crearObjeto(db, `${B}/avatar-migrado.jpg`, Buffer.from('b'));
  return db;
}

test('migración sobre el estado real (sin buckets ni políticas): bucket privado y 5 políticas; repetirla no cambia nada', { skip: omitir }, async () => {
  const db = await crearBase();
  assert.deepEqual(await politicas(db), []);
  await ejecutarArchivo(db, MIG);
  assert.deepEqual((await db.query(`select id, public, file_size_limit::int l, allowed_mime_types from storage.buckets`)).rows,
    [{ id: 'avatars', public: false, l: 524288, allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'] }]);
  const p = await politicas(db);
  assert.deepEqual(p.map(x => [x.policyname, x.permissive, x.r, x.cmd]), [
    ['avatars: borrar de la carpeta propia', 'PERMISSIVE', '{authenticated}', 'DELETE'],
    ['avatars: leer la carpeta propia', 'PERMISSIVE', '{authenticated}', 'SELECT'],
    ['avatars: sobrescribir en la carpeta propia', 'PERMISSIVE', '{authenticated}', 'UPDATE'],
    ['avatars: solo la carpeta propia (restrictiva)', 'RESTRICTIVE', '{public}', 'ALL'],
    ['avatars: subir a la carpeta propia', 'PERMISSIVE', '{authenticated}', 'INSERT'],
  ]);
  await ejecutarArchivo(db, MIG);
  assert.deepEqual(await politicas(db), p);
  assert.equal((await db.query('select count(*)::int n from storage.buckets')).rows[0].n, 1);
});

test('migración: si ya existe un bucket avatars distinto, se detiene sin cambiar nada', { skip: omitir }, async () => {
  const db = await crearBase();
  await db.exec(`insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)`);
  await assert.rejects(ejecutarArchivo(db, MIG), /Ya existe un bucket "avatars" con otra configuración/);
  assert.deepEqual(await politicas(db), []);
  assert.equal((await db.query(`select public from storage.buckets where id = 'avatars'`)).rows[0].public, true);
});

test('RLS: cada usuario solo lee, sube, modifica y borra en su carpeta; anon no hace nada', { skip: omitir }, async () => {
  const db = await conFotos();
  assert.deepEqual(await ver(db, 'authenticated', A), [`${A}/avatar-migrado.jpg`]);
  assert.deepEqual(await ver(db, 'authenticated', B), [`${B}/avatar-migrado.jpg`], 'B no ve ni enumera lo de A');
  assert.deepEqual(await ver(db, 'anon', null), []);
  assert.equal(await subir(db, 'authenticated', A, `${A}/nueva.jpg`), 'ok');
  assert.equal(await subir(db, 'authenticated', B, `${A}/intrusa.jpg`), 'denegado', 'B no sube a la carpeta de A');
  assert.equal(await subir(db, 'authenticated', A, 'raiz.jpg'), 'denegado', 'fuera de una carpeta de usuario');
  assert.equal(await subir(db, 'anon', null, `${A}/anon.jpg`), 'denegado');
  assert.equal(await renombrar(db, 'authenticated', B, `${A}/avatar-migrado.jpg`, `${B}/robada.jpg`), 0, 'B no puede mover la de A');
  assert.equal(await renombrar(db, 'authenticated', A, `${A}/nueva.jpg`, `${B}/regalo.jpg`), 'denegado', 'A no puede dejar nada en la carpeta de B');
  assert.equal(await borrar(db, 'authenticated', B, `${A}/avatar-migrado.jpg`), 0, 'B no borra la de A');
  assert.equal(await borrar(db, 'anon', null, `${A}/avatar-migrado.jpg`), 0);
  assert.equal(await borrar(db, 'authenticated', A, `${A}/nueva.jpg`), 1, 'A borra la suya');
  assert.equal(await total(db), 2);
});

test('con una política permisiva amplia previa, la restrictiva sigue impidiendo el acceso a fotos ajenas sin afectar a otros buckets', { skip: omitir }, async () => {
  const db = await crearBase();
  await db.exec(`insert into storage.buckets (id, name) values ('otro', 'otro');
    create policy "amplia previa" on storage.objects for all to authenticated using (true) with check (true);`);
  await ejecutarArchivo(db, MIG);
  await crearObjeto(db, `${A}/avatar-migrado.jpg`, Buffer.from('a'));
  await crearObjeto(db, 'compartido/doc.txt', Buffer.from('x'), { bucket: 'otro', dueño: 'x' });
  assert.deepEqual(await ver(db, 'authenticated', B), [], 'B no ve la foto de A pese a la política amplia');
  assert.equal(await subir(db, 'authenticated', B, `${A}/intrusa.jpg`), 'denegado');
  assert.deepEqual(await ver(db, 'authenticated', B, 'otro'), ['compartido/doc.txt'], 'el otro bucket sigue igual');
  assert.equal(await subir(db, 'authenticated', B, 'compartido/nuevo.txt', 'otro'), 'ok');
  assert.ok((await politicas(db)).some(p => p.policyname === 'amplia previa'), 'no toca políticas ajenas');
});

test('reversión con fotos: bloqueo total; ninguna política permisiva, presente o futura, abre el acceso a avatars', { skip: omitir }, async () => {
  const db = await crearBase();
  await db.exec(`insert into storage.buckets (id, name) values ('otro', 'otro');
    create policy "amplia previa" on storage.objects for select to authenticated using (true);`);
  await ejecutarArchivo(db, MIG);
  await crearObjeto(db, `${A}/avatar-migrado.jpg`, Buffer.from('a'));
  await crearObjeto(db, 'compartido/doc.txt', Buffer.from('x'), { bucket: 'otro', dueño: 'x' });
  await ejecutarArchivo(db, DOWN);
  const nombres = (await politicas(db)).map(p => p.policyname);
  assert.deepEqual(nombres, ['amplia previa', 'avatars: bloqueo tras la reversión (restrictiva)', 'avatars: solo la carpeta propia (restrictiva)']);
  await db.exec(`create policy "futura" on storage.objects for all to anon, authenticated using (true) with check (true);`);
  for (const [rol, uid] of [['authenticated', A], ['authenticated', B], ['anon', null]]) {
    assert.deepEqual(await ver(db, rol, uid), [], `${rol} ${uid ?? ''}: sin lectura, ni siquiera de lo propio`);
    assert.equal(await subir(db, rol, uid, `${uid ?? 'x'}/nueva.jpg`), 'denegado');
    assert.equal(await borrar(db, rol, uid, `${A}/avatar-migrado.jpg`), 0);
  }
  assert.equal(await total(db), 1, 'la foto se conserva');
  assert.deepEqual(await ver(db, 'authenticated', B, 'otro'), ['compartido/doc.txt'], 'el otro bucket no se ve afectado');
  // Repetir la reversión no cambia nada; volver a migrar retira el bloqueo y restaura el acceso propio.
  await ejecutarArchivo(db, DOWN);
  await db.exec(`drop policy "futura" on storage.objects`);
  await ejecutarArchivo(db, MIG);
  assert.ok(!(await politicas(db)).some(p => p.policyname.includes('bloqueo')));
  assert.deepEqual(await ver(db, 'authenticated', A), [`${A}/avatar-migrado.jpg`]);
  assert.deepEqual(await ver(db, 'authenticated', B), []);
});

test('reversión con el bucket vacío: lo elimina y no deja políticas de avatars', { skip: omitir }, async () => {
  const db = await crearBase();
  await ejecutarArchivo(db, MIG);
  await ejecutarArchivo(db, DOWN);
  assert.equal((await db.query(`select count(*)::int n from storage.buckets where id = 'avatars'`)).rows[0].n, 0);
  assert.deepEqual(await politicas(db), []);
});

test('reversión cuando Supabase impide borrar el bucket (trigger de protección): se aplica el resto y queda bloqueado', { skip: omitir }, async () => {
  const db = await crearBase();
  await ejecutarArchivo(db, MIG);
  await db.exec(`create function storage.proteger() returns trigger language plpgsql as $$ begin raise exception 'Direct deletion from storage tables is not allowed'; end $$;
    create trigger proteger before delete on storage.buckets for each row execute function storage.proteger();`);
  await ejecutarArchivo(db, DOWN);
  assert.equal((await db.query(`select count(*)::int n from storage.buckets where id = 'avatars'`)).rows[0].n, 1);
  assert.deepEqual((await politicas(db)).map(p => p.policyname), ['avatars: bloqueo tras la reversión (restrictiva)', 'avatars: solo la carpeta propia (restrictiva)']);
  assert.equal(await subir(db, 'authenticated', A, `${A}/x.jpg`), 'denegado');
});

test('reversión con el bucket público por error: se aplica igual y no lo cambia (solo avisa)', { skip: omitir }, async () => {
  const db = await conFotos();
  await db.exec(`update storage.buckets set public = true where id = 'avatars'`);
  await ejecutarArchivo(db, DOWN);
  assert.ok((await politicas(db)).some(p => p.policyname.includes('bloqueo')));
  assert.equal((await db.query(`select public from storage.buckets where id = 'avatars'`)).rows[0].public, true);
  assert.equal(await total(db), 2);
});
