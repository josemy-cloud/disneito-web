// EJECUTA los scripts de supabase/manual/avatars (01–05) en PostgreSQL real en memoria (PGlite) con una réplica
// mínima de auth y storage. Requiere el paquete @electric-sql/pglite (NODE_PATH); si no está, se omite.
// Ejecutar: node --test tests/sql-respaldo-pglite.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PGlite, crearBase, ejecutarArchivo, como, dataURL, crearUsuario, metadatos, fijarMetadatos, crearObjeto, uuid } from './harness/pglite-supabase.mjs';

const omitir = !PGlite && 'PGlite no disponible';
const S = 'supabase/manual/avatars/';
const JPG = Buffer.from('foto-jpeg-de-prueba-1'), JPG2 = Buffer.from('otra-foto-jpeg'), PNG = Buffer.from('foto-png-de-prueba');
const md5 = b => createHash('md5').update(b).digest('hex');
const U = Object.fromEntries(['integraJpg', 'integraPng', 'pendiente', 'cambiada', 'eliminadaNull', 'eliminadaAusente', 'cuentaBorrada', 'falloSinObjeto', 'falloCorrupta', 'revisar', 'nullPrevio'].map((k, i) => [k, uuid(i + 1)]));
const migrado = (id, ext = 'jpg') => `${id}/avatar-migrado.${ext}`;

async function base() {
  const db = await crearBase();
  await db.exec(`insert into storage.buckets (id, name, public) values ('avatars', 'avatars', false), ('otro', 'otro', false)`);
  for (const [k, id] of Object.entries(U)) {
    const foto = k === 'integraPng' ? dataURL(PNG, 'image/png') : dataURL(JPG);
    await crearUsuario(db, id, k === 'nullPrevio' ? { full_name: k, avatar_data: null } : { full_name: k, avatar_data: foto });
  }
  return db;
}
// Lleva cada cuenta al estado que indica su nombre, como habría quedado tras la observación.
async function simularObservacion(db) {
  const meta = async (k, m) => fijarMetadatos(db, U[k], { full_name: k, ...m });
  await crearObjeto(db, migrado(U.integraJpg), JPG); await meta('integraJpg', { avatar_path: migrado(U.integraJpg) });
  await crearObjeto(db, migrado(U.integraPng, 'png'), PNG, { tipo: 'image/png' }); await meta('integraPng', { avatar_path: migrado(U.integraPng, 'png') });
  await crearObjeto(db, `${U.cambiada}/avatar-1790000000000.jpg`, JPG2); await meta('cambiada', { avatar_path: `${U.cambiada}/avatar-1790000000000.jpg` });
  await meta('eliminadaNull', { avatar_data: null, avatar_path: null });
  await meta('eliminadaAusente', {});
  await db.query('delete from auth.users where id = $1', [U.cuentaBorrada]);
  await meta('falloSinObjeto', { avatar_path: migrado(U.falloSinObjeto) });
  await crearObjeto(db, migrado(U.falloCorrupta), Buffer.from('bytes-distintos-xx')); await meta('falloCorrupta', { avatar_path: migrado(U.falloCorrupta) });
  await meta('revisar', { avatar_path: `${U.revisar}/avatar-1790000000001.jpg` });
}
const estados = async db => Object.fromEntries((await ejecutarArchivo(db, S + '03_verificar_integridad.sql'))[0].rows.map(r => [r.user_id, r]));

test('01: inventario de solo lectura; ignora avatar_data con valor null y no cambia nada', { skip: omitir }, async () => {
  const db = await base();
  const antes = (await db.query('select id, raw_user_meta_data from auth.users order by id')).rows;
  const [r] = await ejecutarArchivo(db, S + '01_inventario_solo_lectura.sql');
  assert.equal(r.rows.length, 10, 'todas menos la de valor null');
  assert.ok(!r.rows.some(x => x.user_id === U.nullPrevio));
  const jpg = r.rows.find(x => x.user_id === U.integraJpg);
  assert.equal(jpg.formato_migrable, true); assert.equal(jpg.md5, md5(JPG)); assert.equal(jpg.bytes, JPG.length);
  assert.equal(r.rows.find(x => x.user_id === U.integraPng).tipo_declarado, 'image/png');
  assert.deepEqual((await db.query('select id, raw_user_meta_data from auth.users order by id')).rows, antes);
});

test('02: copia exacta en un esquema privado, sin permisos para anon ni authenticated (ni por privilegios por defecto)', { skip: omitir }, async () => {
  const db = await base();
  await db.exec(`alter default privileges grant select on tables to anon, authenticated`);   // p. ej. privilegios por defecto amplios
  await ejecutarArchivo(db, S + '02_crear_respaldo.sql');
  const filas = (await db.query('select user_id, avatar_data from nuhio_respaldo.avatar_data_20261121 order by user_id')).rows;
  assert.equal(filas.length, 10);
  for (const f of filas) assert.equal(f.avatar_data, (await metadatos(db, f.user_id)).avatar_data);
  const p = (await db.query(`select has_schema_privilege('anon','nuhio_respaldo','usage') a, has_schema_privilege('authenticated','nuhio_respaldo','usage') b,
    has_table_privilege('anon','nuhio_respaldo.avatar_data_20261121','select') c, has_table_privilege('authenticated','nuhio_respaldo.avatar_data_20261121','select,insert,update,delete') d,
    (select relrowsecurity from pg_class where oid = 'nuhio_respaldo.avatar_data_20261121'::regclass) rls`)).rows[0];
  assert.deepEqual(p, { a: false, b: false, c: false, d: false, rls: true });
  for (const rol of ['anon', 'authenticated'])
    await assert.rejects(como(db, rol, U.integraJpg, 'select * from nuhio_respaldo.avatar_data_20261121'), /permission denied/);
  // Repetirlo antes de migrar no cambia nada.
  await ejecutarArchivo(db, S + '02_crear_respaldo.sql');
  assert.equal((await db.query('select count(*)::int n from nuhio_respaldo.avatar_data_20261121')).rows[0].n, 10);
});

test('02: no reutiliza un esquema "nuhio_respaldo" ajeno (vacío o con otros objetos) ni le cambia los permisos', { skip: omitir }, async () => {
  for (const preparar of [
    `create schema nuhio_respaldo; grant usage on schema nuhio_respaldo to authenticated`,
    `create schema nuhio_respaldo; create table nuhio_respaldo.otra (x int)`,
  ]) {
    const db = await base();
    await db.exec(preparar);
    await assert.rejects(ejecutarArchivo(db, S + '02_crear_respaldo.sql'), /nuhio_respaldo/);
    assert.equal((await db.query(`select to_regclass('nuhio_respaldo.avatar_data_20261121') t`)).rows[0].t, null, 'no crea nada');
    if (preparar.includes('grant')) assert.equal((await db.query(`select has_schema_privilege('authenticated','nuhio_respaldo','usage') p`)).rows[0].p, true, 'no toca sus permisos');
  }
  // Un esquema con este respaldo y algo más también se rechaza.
  const db = await base();
  await ejecutarArchivo(db, S + '02_crear_respaldo.sql');
  await db.exec('create table nuhio_respaldo.intrusa (x int)');
  await assert.rejects(ejecutarArchivo(db, S + '02_crear_respaldo.sql'), /otros objetos/);
});

test('02: se niega si la configuración de PostgREST expone el esquema', { skip: omitir }, async () => {
  const db = await base();
  await db.exec(`alter role authenticator set pgrst.db_schemas = 'public, graphql_public, nuhio_respaldo'`);
  await assert.rejects(ejecutarArchivo(db, S + '02_crear_respaldo.sql'), /expuestos por la API/);
  assert.equal((await db.query(`select to_regnamespace('nuhio_respaldo') n`)).rows[0].n, null);
  await db.exec(`alter role authenticator set pgrst.db_schemas = 'public, graphql_public'`);
  await ejecutarArchivo(db, S + '02_crear_respaldo.sql');
});

test('02: repetido después de que alguna cuenta haya migrado, falla sin cambiar nada', { skip: omitir }, async () => {
  const db = await base();
  await ejecutarArchivo(db, S + '02_crear_respaldo.sql');
  await fijarMetadatos(db, U.integraJpg, { avatar_path: migrado(U.integraJpg) });
  await assert.rejects(ejecutarArchivo(db, S + '02_crear_respaldo.sql'), /Respaldo no coincide/);
  assert.equal((await db.query('select count(*)::int n from nuhio_respaldo.avatar_data_20261121')).rows[0].n, 10);
});

test('03: clasifica cada cuenta (JPEG/PNG, null frente a ausente, cambios y bajas voluntarias, fallos) sin modificar nada', { skip: omitir }, async () => {
  const db = await base();
  await ejecutarArchivo(db, S + '02_crear_respaldo.sql');
  await simularObservacion(db);
  const antes = (await db.query('select id, raw_user_meta_data from auth.users order by id')).rows;
  const e = await estados(db);
  const esperado = { integraJpg: 'migrada_integra', integraPng: 'migrada_integra', pendiente: 'pendiente', cambiada: 'cambiada_por_usuario',
    eliminadaNull: 'eliminada_por_usuario', eliminadaAusente: 'eliminada_por_usuario', cuentaBorrada: 'cuenta_eliminada',
    falloSinObjeto: 'fallo', falloCorrupta: 'fallo', revisar: 'revisar' };
  for (const [k, est] of Object.entries(esperado)) assert.equal(e[U[k]]?.estado, est, k);
  assert.equal(e[U.eliminadaNull].avatar_data_actual, 'null');
  assert.equal(e[U.eliminadaAusente].avatar_data_actual, 'ausente');
  assert.equal(e[U.pendiente].avatar_data_actual, 'presente');
  assert.equal(e[U.integraPng].tipo_storage, 'image/png');
  assert.equal(e[U.integraJpg].etag_storage, md5(JPG));
  const [, bucket] = await ejecutarArchivo(db, S + '03_verificar_integridad.sql');
  assert.deepEqual(bucket.rows, [{ bucket: 'avatars', publico: false }]);
  assert.deepEqual((await db.query('select id, raw_user_meta_data from auth.users order by id')).rows, antes);
});

test('03: un tipo o propietario distinto del original también es «fallo»', { skip: omitir }, async () => {
  const db = await base();
  await ejecutarArchivo(db, S + '02_crear_respaldo.sql');
  await crearObjeto(db, migrado(U.integraJpg), JPG, { tipo: 'image/png' });
  await fijarMetadatos(db, U.integraJpg, { avatar_path: migrado(U.integraJpg) });
  await crearObjeto(db, migrado(U.integraPng, 'png'), PNG, { tipo: 'image/png', dueño: U.pendiente });
  await fijarMetadatos(db, U.integraPng, { avatar_path: migrado(U.integraPng, 'png') });
  const e = await estados(db);
  assert.equal(e[U.integraJpg].estado, 'fallo'); assert.equal(e[U.integraPng].estado, 'fallo');
});

test('04: se niega mientras haya «fallo» o «revisar»; los cambios voluntarios, pendientes y bajas no bloquean', { skip: omitir }, async () => {
  const db = await base();
  await ejecutarArchivo(db, S + '02_crear_respaldo.sql');
  await simularObservacion(db);
  await assert.rejects(ejecutarArchivo(db, S + '04_eliminar_respaldo.sql'), /3 cuentas necesitan revisión/);
  assert.equal((await db.query('select count(*)::int n from nuhio_respaldo.avatar_data_20261121')).rows[0].n, 10, 'no borra nada');
  // Se resuelven los casos: copias correctas y el usuario de «revisar» sube una foto válida.
  await crearObjeto(db, migrado(U.falloSinObjeto), JPG);
  await db.query(`update storage.objects set metadata = metadata || jsonb_build_object('size', $2::int, 'eTag', '"' || $3 || '"') where name = $1`, [migrado(U.falloCorrupta), JPG.length, md5(JPG)]);
  await crearObjeto(db, `${U.revisar}/avatar-1790000000001.jpg`, JPG2);
  const usuarios = (await db.query('select id, raw_user_meta_data from auth.users order by id')).rows;
  const objetos = (await db.query('select bucket_id, name, metadata from storage.objects order by name')).rows;
  await ejecutarArchivo(db, S + '04_eliminar_respaldo.sql');
  assert.equal((await db.query(`select to_regnamespace('nuhio_respaldo') n`)).rows[0].n, null);
  assert.deepEqual((await db.query('select id, raw_user_meta_data from auth.users order by id')).rows, usuarios, 'auth.users intacto');
  assert.deepEqual((await db.query('select bucket_id, name, metadata from storage.objects order by name')).rows, objetos, 'Storage intacto');
});

test('05: solo restaura las cuentas cuya foto vigente es la migrada; no sobrescribe fotos nuevas ni recupera las eliminadas', { skip: omitir }, async () => {
  const db = await base();
  await ejecutarArchivo(db, S + '02_crear_respaldo.sql');
  const original = Object.fromEntries((await db.query('select user_id, avatar_data from nuhio_respaldo.avatar_data_20261121')).rows.map(r => [r.user_id, r.avatar_data]));
  await simularObservacion(db);
  await fijarMetadatos(db, U.pendiente, { full_name: 'pendiente', avatar_data: dataURL(JPG2) });   // pendiente con otra foto: no se pisa
  const antes = Object.fromEntries((await db.query('select id, raw_user_meta_data m from auth.users')).rows.map(r => [r.id, r.m]));
  const objetos = (await db.query('select name, metadata from storage.objects order by name')).rows;
  await ejecutarArchivo(db, S + '05_restaurar_desde_respaldo.sql');
  for (const k of ['integraJpg', 'integraPng', 'falloSinObjeto', 'falloCorrupta']) {
    const m = await metadatos(db, U[k]);
    assert.equal(m.avatar_data, original[U[k]], k + ': restaurada');
    assert.equal(m.avatar_path, antes[U[k]].avatar_path, k + ': conserva avatar_path');
    assert.equal(m.full_name, k);
  }
  for (const k of ['pendiente', 'cambiada', 'eliminadaNull', 'eliminadaAusente', 'revisar'])
    assert.deepEqual(await metadatos(db, U[k]), antes[U[k]], k + ': intacta');
  assert.equal(await metadatos(db, U.cuentaBorrada), undefined, 'no recrea cuentas');
  assert.deepEqual((await db.query('select name, metadata from storage.objects order by name')).rows, objetos, 'Storage intacto');
  const tras = (await db.query('select id, raw_user_meta_data from auth.users order by id')).rows;
  await ejecutarArchivo(db, S + '05_restaurar_desde_respaldo.sql');
  assert.deepEqual((await db.query('select id, raw_user_meta_data from auth.users order by id')).rows, tras, 'idempotente');
});
