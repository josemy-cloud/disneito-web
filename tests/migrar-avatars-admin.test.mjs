// scripts/migrar-avatars-admin.mjs contra el Supabase simulado del arnés, que reproduce el límite real de cabeceras
// de Storage (medido el 25/11/2026) y la API de administración. Sin red: el fetch de Node está interceptado.
// Ejecutar: node --test tests/migrar-avatars-admin.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, supa, crearUsuario, emitirSesion, reiniciarSupabase, estadoSupabase, SERVICE_KEY, SUPABASE_HOST } from './harness/real-harness.mjs';
import { migrarAvatarsAdmin, leerArgumentos, validarClave, leerProyecto, sha256 } from '../scripts/migrar-avatars-admin.mjs';

const URL_SB = 'https://' + SUPABASE_HOST;
const SCRIPT = join(root, 'scripts', 'migrar-avatars-admin.mjs');
const uid = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const foto = n => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + 7) % 256)); // bytes no triviales
const dataURL = (b, tipo = 'image/jpeg') => `data:${tipo};base64,${b.toString('base64')}`;
const GRANDE = foto(11234), PEQUENA = foto(7796);
function cuentaConFoto(n, bytes = GRANDE, extra = {}) {
  crearUsuario(uid(n), { user_metadata: { full_name: 'Cuenta ' + n, email_verified: true, ...extra, avatar_data: dataURL(bytes) } });
  return { uid: uid(n), sha256: sha256(bytes) };
}
async function migrar(objetivos, ejecutar = true) {
  const lineas = [];
  const res = await migrarAvatarsAdmin({ url: URL_SB, clave: SERVICE_KEY, objetivos, ejecutar, log: l => lineas.push(l) });
  return { res, lineas, estado: res.map(r => r.estado), detalle: res.map(r => r.detalle).join(' | ') };
}
const meta = n => supa.usuarios.get(uid(n)).user_metadata;
const escrituras = () => estadoSupabase.reqs.filter(r => /^(POST|PUT|DELETE) /.test(r));
test.beforeEach(() => { reiniciarSupabase(); estadoSupabase.reqs = []; });

test('el arnés reproduce el límite real de Storage: un JWT de ~21 KB recibe 400 HTML; uno de ~13 KB pasa', async () => {
  const grande = cuentaConFoto(1);
  const t = emitirSesion(grande.uid).access_token;
  assert.ok(t.length > 20000, 'JWT como el de la cuenta real: ' + t.length);
  const ruta = `${URL_SB}/storage/v1/object/avatars/${grande.uid}/avatar-migrado.jpg`;
  const r = await fetch(ruta, { method: 'POST', headers: { apikey: 'anon', Authorization: 'Bearer ' + t, 'Content-Type': 'image/jpeg' }, body: GRANDE });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /<title>400 Bad Request<\/title>/);
  assert.equal(supa.objetos.size, 0);
  crearUsuario(uid(2), { user_metadata: { avatar_data: dataURL(foto(7124)) } });
  const t2 = emitirSesion(uid(2)).access_token;
  assert.ok(t2.length < 15200, 'JWT como el de la cuenta A: ' + t2.length);
  const r2 = await fetch(`${URL_SB}/storage/v1/object/avatars/${uid(2)}/avatar-migrado.jpg`, { method: 'POST', headers: { apikey: 'anon', Authorization: 'Bearer ' + t2, 'Content-Type': 'image/jpeg' }, body: foto(7124) });
  assert.equal(r2.status, 200);
});

test('argumentos y clave: solo UID y SHA-256 válidos; la clave debe ser service_role de este proyecto', () => {
  assert.deepEqual(leerArgumentos(['--uid', uid(1) + '=' + 'A'.repeat(64)]), { objetivos: [{ uid: uid(1), sha256: 'a'.repeat(64) }], ejecutar: false });
  assert.equal(leerArgumentos(['--uid', uid(1) + '=' + 'a'.repeat(64), '--ejecutar']).ejecutar, true);
  for (const malo of [[], ['--uid', 'no-es-uuid=' + 'a'.repeat(64)], ['--uid', uid(1) + '=abc'], ['--uid', uid(1) + '=' + 'a'.repeat(64), '--uid', uid(1) + '=' + 'b'.repeat(64)], ['--todo']])
    assert.throws(() => leerArgumentos(malo), undefined, JSON.stringify(malo));
  const { ref, url } = leerProyecto();
  assert.equal(ref, 'aqfqwvzbsbjrixzgxtro'); assert.equal(url, URL_SB);
  assert.equal(validarClave(SERVICE_KEY, ref), 'service_role');
  const anon = /SBK='([^']+)'/.exec(readFileSync(join(root, 'disenador-web', 'auth.js'), 'utf8'))[1];
  assert.throws(() => validarClave(anon, ref), /no es service_role/);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.throws(() => validarClave(`${b64({ alg: 'HS256' })}.${b64({ role: 'service_role', ref: 'otro' })}.x`, ref), /otro proyecto/);
  assert.throws(() => validarClave('', ref), /Falta la variable/);
});

test('la línea de comandos se detiene (código 2) sin clave o con una clave no válida, antes de cualquier petición', () => {
  for (const env of [{}, { NUHIO_SUPABASE_SERVICE_ROLE_KEY: 'no-es-una-clave' }]) {
    let error;
    try { execFileSync(process.execPath, [SCRIPT, '--uid', uid(1) + '=' + 'a'.repeat(64)], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { error = e; }
    assert.equal(error?.status, 2, JSON.stringify(env));
    assert.doesNotMatch(error.stderr + error.stdout, /no-es-una-clave/, 'no muestra la clave');
  }
});

test('simulación por defecto: no escribe nada y confirma bytes y SHA-256', async () => {
  const a = cuentaConFoto(1);
  const antes = structuredClone(meta(1));
  const { estado, detalle } = await migrar([a], false);
  assert.deepEqual(estado, ['simulacion-lista']);
  assert.match(detalle, /11234 bytes image\/jpeg, SHA-256 coincide/);
  assert.deepEqual(escrituras(), []);
  assert.deepEqual(meta(1), antes);
  assert.equal(supa.objetos.size, 0);
});

test('migración real: bytes exactos en Storage, avatar_data retirado, resto de metadatos intactos y JWT pequeño', async () => {
  const a = cuentaConFoto(1, GRANDE, { tema: 'oscuro' });
  const otra = cuentaConFoto(2, PEQUENA);                 // no autorizada: no se toca
  const otraAntes = structuredClone(meta(2));
  const { estado, lineas } = await migrar([a]);
  assert.deepEqual(estado, ['migrada']);
  const destino = uid(1) + '/avatar-migrado.jpg';
  const o = supa.objetos.get(destino);
  assert.ok(o.bytes.equals(GRANDE)); assert.equal(o.tipo, 'image/jpeg'); assert.equal(o.dueño, uid(1));
  assert.deepEqual(meta(1), { full_name: 'Cuenta 1', email_verified: true, tema: 'oscuro', avatar_path: destino });
  const t = emitirSesion(uid(1)).access_token;
  assert.ok(t.length < 1500, 'el JWT nuevo cabe en la cookie: ' + t.length);
  assert.deepEqual(meta(2), otraAntes, 'la cuenta no autorizada sigue igual');
  assert.ok(!supa.objetos.has(uid(2) + '/avatar-migrado.jpg'));
  // Sin claves ni contenido de fotos en la salida.
  const salida = lineas.join('\n');
  assert.ok(!salida.includes(SERVICE_KEY) && !salida.includes(GRANDE.toString('base64').slice(0, 40)) && !salida.includes('data:image'));
});

test('idempotente: repetirlo verifica la copia y no escribe nada', async () => {
  const a = cuentaConFoto(1);
  await migrar([a]);
  estadoSupabase.reqs = [];
  const { estado, detalle } = await migrar([a]);
  assert.deepEqual(estado, ['ya-migrada']);
  assert.match(detalle, /SHA-256 verificado/);
  assert.deepEqual(escrituras(), []);
});

test('SHA-256 no autorizado o foto cambiada: se detiene sin tocar nada', async () => {
  const a = cuentaConFoto(1);
  const antes = structuredClone(meta(1));
  const { estado, detalle } = await migrar([{ uid: a.uid, sha256: sha256(PEQUENA) }]);
  assert.deepEqual(estado, ['DETENIDA']);
  assert.match(detalle, /no coinciden con el SHA-256 autorizado/);
  assert.deepEqual(escrituras(), []);
  assert.deepEqual(meta(1), antes);
});

test('objeto existente con otro contenido: no se sobrescribe y avatar_data sigue intacto', async () => {
  const a = cuentaConFoto(1);
  const ajeno = foto(500);
  supa.objetos.set(uid(1) + '/avatar-migrado.jpg', { bytes: ajeno, tipo: 'image/jpeg', dueño: uid(1) });
  for (const ejecutar of [false, true]) {
    const { estado, detalle } = await migrar([a], ejecutar);
    assert.deepEqual(estado, ['DETENIDA']);
    assert.match(detalle, /con otro contenido.*No se sobrescribe/);
  }
  assert.ok(supa.objetos.get(uid(1) + '/avatar-migrado.jpg').bytes.equals(ajeno));
  assert.equal(meta(1).avatar_data, dataURL(GRANDE));
  assert.deepEqual(escrituras(), []);
});

test('objeto existente idéntico (intento anterior a medias): se reutiliza sin volver a subir', async () => {
  const a = cuentaConFoto(1);
  supa.objetos.set(uid(1) + '/avatar-migrado.jpg', { bytes: Buffer.from(GRANDE), tipo: 'image/jpeg', dueño: uid(1) });
  const { estado } = await migrar([a]);
  assert.deepEqual(estado, ['migrada']);
  assert.ok(!escrituras().some(r => r.startsWith('POST ')), 'sin subida');
  assert.equal(meta(1).avatar_path, uid(1) + '/avatar-migrado.jpg');
});

test('fallo de subida o copia corrupta: avatar_data intacto, sin copias dañadas; al repetirlo termina', async () => {
  const a = cuentaConFoto(1);
  supa.fallos.subida = 1;
  let r = await migrar([a]);
  assert.deepEqual(r.estado, ['DETENIDA']); assert.match(r.detalle, /HTTP 500\). avatar_data sigue intacto/);
  assert.equal(meta(1).avatar_data, dataURL(GRANDE));
  supa.fallos.corromper = 1;
  r = await migrar([a]);
  assert.deepEqual(r.estado, ['DETENIDA']); assert.match(r.detalle, /no coincide con el original/);
  assert.equal(supa.objetos.size, 0, 'la copia corrupta subida en esta ejecución se borra');
  assert.equal(meta(1).avatar_data, dataURL(GRANDE));
  r = await migrar([a]);
  assert.deepEqual(r.estado, ['migrada']);
  assert.ok(supa.objetos.get(uid(1) + '/avatar-migrado.jpg').bytes.equals(GRANDE));
});

test('el usuario cambia su foto o sus datos durante el proceso: se detiene antes de retirar avatar_data', async () => {
  const a = cuentaConFoto(1);
  supa.ganchos.despuesDeSubir = () => { meta(1).full_name = 'Nombre nuevo'; };
  let r = await migrar([a]);
  assert.deepEqual(r.estado, ['DETENIDA']); assert.match(r.detalle, /ha cambiado su foto o sus datos/);
  assert.equal(meta(1).avatar_data, dataURL(GRANDE)); assert.equal(meta(1).avatar_path, undefined);
  const b = cuentaConFoto(2);
  supa.ganchos.despuesDeSubir = () => { meta(2).avatar_data = dataURL(PEQUENA); };
  r = await migrar([b]);
  assert.deepEqual(r.estado, ['DETENIDA']); assert.match(r.detalle, /ha cambiado su foto o sus datos/);
  assert.equal(meta(2).avatar_data, dataURL(PEQUENA), 'se respeta la foto nueva del usuario');
});

test('el usuario ya había cambiado o eliminado su foto: no se hace nada', async () => {
  const a = { uid: uid(1), sha256: sha256(GRANDE) };
  crearUsuario(uid(1), { user_metadata: { avatar_path: uid(1) + '/avatar-1790000000000.jpg' } });
  supa.objetos.set(uid(1) + '/avatar-1790000000000.jpg', { bytes: PEQUENA, tipo: 'image/jpeg', dueño: uid(1) });
  crearUsuario(uid(2), { user_metadata: { full_name: 'Sin foto' } });
  const { estado, detalle } = await migrar([a, { uid: uid(2), sha256: sha256(GRANDE) }]);
  assert.deepEqual(estado, ['DETENIDA', 'DETENIDA']);
  assert.match(detalle, /ya tiene otra foto.*No se hace nada \| .*la eliminó o nunca la tuvo/);
  assert.deepEqual(escrituras(), []);
});

test('fallo o respuesta perdida al actualizar los metadatos: estado coherente y la repetición termina', async () => {
  const a = cuentaConFoto(1);
  supa.fallos.metadatos = 1;
  let r = await migrar([a]);
  assert.deepEqual(r.estado, ['DETENIDA']); assert.match(r.detalle, /no se aplicó el cambio de metadatos \(HTTP 500\)/);
  assert.equal(meta(1).avatar_data, dataURL(GRANDE));
  assert.ok(supa.objetos.get(uid(1) + '/avatar-migrado.jpg').bytes.equals(GRANDE), 'la copia verificada se conserva');
  r = await migrar([a]);
  assert.deepEqual(r.estado, ['migrada']);
  const b = cuentaConFoto(2, PEQUENA);
  supa.fallos.respuestaPerdida = 1;
  r = await migrar([b]);
  assert.deepEqual(r.estado, ['migrada']); assert.match(r.detalle, /la respuesta se perdió; comprobado releyendo/);
  assert.equal(meta(2).avatar_path, uid(2) + '/avatar-migrado.jpg'); assert.equal('avatar_data' in meta(2), false);
});

test('el script no usa URL públicas ni firmadas y solo habla con el proyecto de auth.js', async () => {
  const a = cuentaConFoto(1);
  await migrar([a]);
  assert.ok(!estadoSupabase.reqs.some(r => /\/object\/(public|sign)\//.test(r)));
  const src = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /console\.log\([^)]*clave/);
  assert.doesNotMatch(src, /https?:\/\/(?!\(\[a-z0-9\]\+\))[a-z]/i, 'sin otros hosts escritos en el script');
});
