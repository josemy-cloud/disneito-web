// Revisión estática del bucket privado `avatars` (migración SQL y su reversión) y del uso que hace auth.js.
// No ejecuta nada contra Supabase: la validación real está en scripts/validar-avatars-supabase.mjs.
// Ejecutar: node --test tests/avatars-politicas.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const leer = p => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = s => s.replace(/--.*$/gm, '');
const sql = sinComentarios(leer('supabase/migrations/20261118120000_avatars_privados.sql'));
const down = sinComentarios(leer('supabase/rollback/20261118120000_avatars_privados.down.sql'));
const auth = leer('disenador-web/auth.js');
const espacios = s => s.replace(/\s+/g, ' ').trim();
const permisivas = [...sql.matchAll(/create policy "([^"]+)"\s+on storage\.objects\s+for (\w+)\s+to (\w+)\s+([\s\S]*?);/g)]
  .map(([, nombre, op, rol, cuerpo]) => ({ nombre, op, rol, cuerpo }));
const CARPETA_PROPIA = "bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text";
const RESTRICTIVA = "bucket_id <> 'avatars' or (storage.foldername(name))[1] = (select auth.uid())::text";

test('el bucket se crea privado (512 KB; JPEG, PNG, WebP) y nunca modifica un bucket existente', () => {
  assert.match(sql, /insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)\s+values \('avatars', 'avatars', false, 524288, array\['image\/jpeg', 'image\/png', 'image\/webp'\]\)\s+on conflict \(id\) do nothing;/);
  assert.doesNotMatch(sql, /do update|update storage\.buckets|public\s*=\s*true/);
  // Precondición: si ya existe con otra configuración, la migración aborta sin cambiar nada.
  assert.match(espacios(sql), /select \* into b from storage\.buckets where id = 'avatars'; if found and \(b\.public is distinct from false or b\.file_size_limit is distinct from 524288 or b\.allowed_mime_types is distinct from array\['image\/jpeg', 'image\/png', 'image\/webp'\]\) then raise exception/);
});

test('cuatro políticas permisivas (select, insert, update, delete), solo para authenticated y solo sobre la carpeta propia', () => {
  assert.deepEqual(permisivas.map(p => p.op).sort(), ['delete', 'insert', 'select', 'update']);
  for (const p of permisivas) {
    assert.equal(p.rol, 'authenticated', p.nombre);
    const condiciones = [...p.cuerpo.matchAll(/(using|with check) \(([\s\S]*?)\)\s*(?=with check|$)/g)];
    assert.ok(condiciones.length >= 1, p.nombre);
    for (const [, , cond] of condiciones) assert.equal(espacios(cond), CARPETA_PROPIA, p.nombre);
  }
  const upd = permisivas.find(p => p.op === 'update').cuerpo;
  assert.match(upd, /using \(/); assert.match(upd, /with check \(/);
  assert.doesNotMatch(sql, /\bto anon\b/);
});

test('política RESTRICTIVE: exige la carpeta propia en avatars a cualquier rol y deja igual el resto de buckets', () => {
  const r = /create policy "avatars: solo la carpeta propia \(restrictiva\)"\s+on storage\.objects as restrictive for all to public\s+using \(([^;]*?)\)\s+with check \(([^;]*?)\);/.exec(sql);
  assert.ok(r, 'existe la política restrictiva');
  assert.equal(espacios(r[1]), RESTRICTIVA);
  assert.equal(espacios(r[2]), RESTRICTIVA);
  assert.equal((sql.match(/\bto public\b/g) || []).length, 1, 'solo la restrictiva se aplica a todos los roles');
});

test('la migración es idempotente y solo crea o sustituye objetos propios de avatars', () => {
  const sentencias = sql.replace(/do \$\$[\s\S]*?\$\$;/g, 'PRECONDICION;').split(';').map(espacios).filter(Boolean);
  for (const st of sentencias) {
    assert.ok(/^(begin|commit|PRECONDICION|insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\) values \('avatars'.*on conflict \(id\) do nothing|drop policy if exists "avatars: [^"]+" on storage\.objects|create policy "avatars: [^"]+" on storage\.objects .*)$/.test(st), 'sentencia no prevista: ' + st.slice(0, 90));
  }
  assert.doesNotMatch(sql, /\b(alter (table|policy|bucket)|grant |revoke |truncate |delete from|update (storage|public|auth)\.)/i);
  assert.doesNotMatch(/do \$\$([\s\S]*?)\$\$;/.exec(sql)[1], /\b(insert|update|delete|alter|drop|create)\b/i, 'la precondición solo lee');
  // Cada política se elimina (si existe) justo antes de crearse: ejecutar dos veces da el mismo resultado.
  const creadas = [...sql.matchAll(/create policy "([^"]+)"/g)].map(m => m[1]);
  const borradas = [...sql.matchAll(/drop policy if exists "([^"]+)"/g)].map(m => m[1]);
  assert.equal(creadas.length, 5);
  // Además retira el bloqueo que deja la reversión, para poder volver a migrar.
  assert.deepEqual([...borradas].sort(), [...creadas, 'avatars: bloqueo tras la reversión (restrictiva)'].sort());
  assert.match(sql, /^begin;/m); assert.match(sql, /^commit;/m);
});

test('la reversión no borra fotos, retira las permisivas y bloquea todo avatars mientras exista el bucket', () => {
  for (const p of permisivas) assert.ok(down.includes(`drop policy if exists "${p.nombre}" on storage.objects;`), p.nombre);
  assert.doesNotMatch(down, /delete from storage\.objects|truncate|update storage/i);
  const d = espacios(down);
  // El bucket solo se borra vacío, y un fallo (trigger de protección de storage) no deshace el resto.
  assert.match(d, /begin delete from storage\.buckets b where b\.id = 'avatars' and not exists \(select 1 from storage\.objects o where o\.bucket_id = 'avatars'\); exception when others then raise notice/);
  // Con el bucket: bloqueo total RESTRICTIVE para todos los roles (ninguna permisiva futura lo abre).
  assert.match(d, /if exists \(select 1 from storage\.buckets where id = 'avatars'\) then drop policy if exists "avatars: bloqueo tras la reversión \(restrictiva\)" on storage\.objects; create policy "avatars: bloqueo tras la reversión \(restrictiva\)" on storage\.objects as restrictive for all to public using \(bucket_id <> 'avatars'\) with check \(bucket_id <> 'avatars'\);/);
  assert.match(d, /raise warning 'El bucket "avatars" es PÚBLICO/);
  // Sin el bucket: se retiran las dos restrictivas, y en ningún otro caso.
  assert.match(d, /else drop policy if exists "avatars: bloqueo tras la reversión \(restrictiva\)" on storage\.objects; drop policy if exists "avatars: solo la carpeta propia \(restrictiva\)" on storage\.objects; end if;/);
  assert.equal((down.match(/carpeta propia \(restrictiva\)" on storage\.objects/g) || []).length, 1);
});

test('auth.js no vuelve a incrustar fotos en el JWT ni usa URLs públicas o firmadas', () => {
  assert.doesNotMatch(auth, /toDataURL\(/, 'la foto nueva se sube como Blob');
  assert.doesNotMatch(auth, /avatar_data\s*:\s*(?!null)[A-Za-z_'"]/, 'solo se escribe avatar_data: null');
  assert.doesNotMatch(auth, /\/object\/(public|sign)\//);
  assert.match(auth, /avatarURL\('authenticated'/, 'lectura autenticada');
  assert.match(auth, /URL\.createObjectURL/, 'se muestra como blob: local');
  assert.match(auth, /user\.id\+'\/'\+/, 'la ruta empieza por el uid del usuario (carpeta propia)');
  assert.match(auth, /removeOnFailure:!migration/, 'la ruta compartida de migración nunca se borra tras un fallo');
});

test('auth.js: cookie acotada, renovación coordinada entre pestañas y declaraciones compatibles con la doble carga', () => {
  assert.match(auth, /if\(!sessionCookieFits\(token\)\)\{migrateAvatar\(\)/);
  assert.match(auth, /var SESSION_COOKIE_LIMIT=4000/);
  assert.match(auth, /navigator\.locks\.request\('nuhio-sesion'/);
  assert.match(auth, /document\.close\(\);[\s\S]{0,300}?listenSessionStorage\(\);\s*SESSION_SYNC=/, 'se vuelve a registrar tras document.open()');
  // Doble carga: sin const/let de nivel superior y el estado de sesión solo se inicializa la primera vez.
  assert.doesNotMatch(auth, /^(const|let) /m, 'una segunda declaración const/let abortaría la segunda copia');
  assert.match(auth, /if\(typeof AVATAR_MIGRATION_TRIES!=='number'\)\{SESSION_SYNC=null;SESSION_REFRESH_TIMER=0;AVATAR_MIGRATION=null;AVATAR_MIGRATION_TRIES=0;AVATAR_OBJECT_URL=''\}/);
  assert.match(auth, /if\(typeof window!=='undefined'&&!window\.NUHIO_SESSION_LISTENER\)listenSessionStorage\(\);/);
  assert.equal((auth.match(/(?<!function )initAccountButton\(\)/g) || []).length, 1, 'una sola llamada: la del final del archivo');
  assert.doesNotMatch(auth.match(/var sesSave=[^\n]*/)[0], /localStorage\.removeItem\('sbSes'\);sessionStorage/, 'no vacía el almacén antes de escribir');
  for (const nombre of ['syncSessionCookie', 'scheduleSessionRefresh', 'migrateAvatar', 'setAvatar', 'uploadAvatarVerified', 'avatarSource', 'refreshSessionNow', 'adoptStoredSession', 'onSessionStorage'])
    assert.match(auth, new RegExp('(async )?function ' + nombre + '\\('), nombre);
});
