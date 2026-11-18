// Validación del bucket privado `avatars` contra Supabase REAL, después de aplicar
// supabase/migrations/20261118120000_avatars_privados.sql. Las simulaciones de tests/ no sustituyen esta prueba.
//
// Usa DOS CUENTAS DE PRUEBA (nunca cuentas de clientes). Solo escribe en sus propias carpetas, borra al terminar
// lo que crea y no imprime contraseñas ni tokens. Sale con código 1 si alguna comprobación falla.
//
//   NUHIO_PRUEBA_A_EMAIL=… NUHIO_PRUEBA_A_PASSWORD=… NUHIO_PRUEBA_B_EMAIL=… NUHIO_PRUEBA_B_PASSWORD=… \
//     node scripts/validar-avatars-supabase.mjs
//
// SUPABASE_URL y SUPABASE_ANON_KEY se leen de disenador-web/auth.js (son públicos) si no se definen.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const auth = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../disenador-web/auth.js'), 'utf8');
const URL_SB = process.env.SUPABASE_URL || /SBU='([^']+)'/.exec(auth)[1];
const ANON = process.env.SUPABASE_ANON_KEY || /SBK='([^']+)'/.exec(auth)[1];
const cuentas = ['A', 'B'].map(k => ({ k, email: process.env[`NUHIO_PRUEBA_${k}_EMAIL`], password: process.env[`NUHIO_PRUEBA_${k}_PASSWORD`] }));
if (cuentas.some(c => !c.email || !c.password)) { console.error('Define NUHIO_PRUEBA_A_EMAIL/PASSWORD y NUHIO_PRUEBA_B_EMAIL/PASSWORD (cuentas de prueba).'); process.exit(2); }
if (cuentas[0].email === cuentas[1].email) { console.error('A y B deben ser cuentas distintas.'); process.exit(2); }

const resultados = [];
const comprobar = (nombre, ok, detalle = '') => { resultados.push({ nombre, ok }); console.log(`${ok ? 'OK   ' : 'FALLO'} ${nombre}${detalle ? ' — ' + detalle : ''}`); };
const aviso = (nombre, detalle) => console.log(`AVISO ${nombre} — ${detalle}`);
const h = (token, extra = {}) => ({ apikey: ANON, Authorization: 'Bearer ' + (token || ANON), ...extra });
const obj = (modo, ruta) => `${URL_SB}/storage/v1/object/${modo ? modo + '/' : ''}avatars/${ruta.split('/').map(encodeURIComponent).join('/')}`;
async function sesion({ email, password }) {
  const r = await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  if (!r.ok) throw new Error('No se pudo iniciar sesión con una cuenta de prueba (' + r.status + ').');
  return j;
}
const subir = (token, ruta, bytes, tipo = 'image/jpeg', upsert = false) =>
  fetch(obj('', ruta), { method: 'POST', headers: h(token, { 'Content-Type': tipo, ...(upsert ? { 'x-upsert': 'true' } : {}) }), body: bytes });
const leer = async (token, ruta, modo = 'authenticated') => { const r = await fetch(obj(modo, ruta), { headers: h(token) }); return { status: r.status, bytes: r.ok ? Buffer.from(await r.arrayBuffer()) : null }; };
const json = async (url, token, body, method = 'POST') => { const r = await fetch(url, { method, headers: h(token, { 'Content-Type': 'application/json' }), body: body && JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };
const ok2xx = s => s >= 200 && s < 300;

const marca = Date.now();
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('validacion-nuhio-' + marca), 0xff, 0xd9]);
const creados = [];

try {
  const A = await sesion(cuentas[0]), B = await sesion(cuentas[1]);
  const uidA = A.user.id, uidB = B.user.id;
  const rutaA = `${uidA}/validacion-${marca}.jpg`;

  // 1. Acceso a la carpeta propia
  let r = await subir(A.access_token, rutaA, BYTES); if (ok2xx(r.status)) creados.push(rutaA);
  comprobar('A sube a su carpeta', ok2xx(r.status), 'HTTP ' + r.status);
  let l = await leer(A.access_token, rutaA);
  comprobar('A lee su foto (lectura autenticada) y es idéntica', l.status === 200 && l.bytes?.equals(BYTES), 'HTTP ' + l.status);
  r = await subir(A.access_token, rutaA, BYTES, 'image/jpeg', true);
  comprobar('A sobrescribe su foto con x-upsert (política UPDATE)', ok2xx(r.status), 'HTTP ' + r.status);

  // 2. Sin URL pública ni acceso anónimo
  comprobar('URL pública no disponible (bucket privado)', !ok2xx((await leer(null, rutaA, 'public')).status));
  comprobar('anon no puede leer', !ok2xx((await leer(null, rutaA)).status));
  const listaAnon = await json(`${URL_SB}/storage/v1/object/list/avatars`, null, { prefix: '', limit: 100 });
  comprobar('anon no puede enumerar', !ok2xx(listaAnon.status) || (Array.isArray(listaAnon.data) && listaAnon.data.length === 0), 'HTTP ' + listaAnon.status);

  // 3. B no puede tocar nada de A
  comprobar('B no puede leer la foto de A', !ok2xx((await leer(B.access_token, rutaA)).status));
  comprobar('B no puede firmar una URL de la foto de A', !ok2xx((await json(obj('sign', rutaA), B.access_token, { expiresIn: 60 })).status));
  r = await subir(B.access_token, `${uidA}/intruso-${marca}.jpg`, BYTES);
  if (ok2xx(r.status)) creados.push(`${uidA}/intruso-${marca}.jpg`);
  comprobar('B no puede subir a la carpeta de A', !ok2xx(r.status), 'HTTP ' + r.status);
  r = await subir(B.access_token, rutaA, Buffer.from([0xff, 0xd8, 0, 0xff, 0xd9]), 'image/jpeg', true);
  l = await leer(A.access_token, rutaA);
  comprobar('B no puede sobrescribir la foto de A', !ok2xx(r.status) && l.bytes?.equals(BYTES), 'HTTP ' + r.status);
  await fetch(obj('', rutaA), { method: 'DELETE', headers: h(B.access_token) });
  await json(`${URL_SB}/storage/v1/object/avatars`, B.access_token, { prefixes: [rutaA] }, 'DELETE');
  comprobar('B no puede borrar la foto de A (comprobado leyendo después)', (await leer(A.access_token, rutaA)).status === 200);
  const mover = await json(`${URL_SB}/storage/v1/object/move`, B.access_token, { bucketId: 'avatars', sourceKey: rutaA, destinationKey: `${uidB}/robada-${marca}.jpg` });
  comprobar('B no puede mover la foto de A a su carpeta', !ok2xx(mover.status) && (await leer(A.access_token, rutaA)).status === 200, 'HTTP ' + mover.status);
  const copiar = await json(`${URL_SB}/storage/v1/object/copy`, B.access_token, { bucketId: 'avatars', sourceKey: rutaA, destinationKey: `${uidB}/copia-${marca}.jpg` });
  if (ok2xx(copiar.status)) creados.push(`${uidB}/copia-${marca}.jpg`);
  comprobar('B no puede copiar la foto de A', !ok2xx(copiar.status), 'HTTP ' + copiar.status);
  const raiz = await json(`${URL_SB}/storage/v1/object/list/avatars`, B.access_token, { prefix: '', limit: 1000 });
  comprobar('B no ve la carpeta de A al enumerar la raíz (no se filtran UID)', !JSON.stringify(raiz.data ?? '').includes(uidA), 'HTTP ' + raiz.status);
  const carpeta = await json(`${URL_SB}/storage/v1/object/list/avatars`, B.access_token, { prefix: uidA + '/', limit: 1000 });
  comprobar('B no ve el contenido de la carpeta de A', !ok2xx(carpeta.status) || (Array.isArray(carpeta.data) && carpeta.data.length === 0), 'HTTP ' + carpeta.status);

  // 4. Límites del bucket
  r = await subir(A.access_token, `${uidA}/grande-${marca}.jpg`, Buffer.alloc(600 * 1024, 1));
  if (ok2xx(r.status)) creados.push(`${uidA}/grande-${marca}.jpg`);
  comprobar('rechaza más de 512 KB', !ok2xx(r.status), 'HTTP ' + r.status);
  r = await subir(A.access_token, `${uidA}/tipo-${marca}.gif`, BYTES, 'image/gif');
  if (ok2xx(r.status)) creados.push(`${uidA}/tipo-${marca}.gif`);
  comprobar('rechaza tipos no permitidos (GIF)', !ok2xx(r.status), 'HTTP ' + r.status);
  r = await subir(A.access_token, `raiz-${marca}.jpg`, BYTES);
  if (ok2xx(r.status)) creados.push(`raiz-${marca}.jpg`);
  comprobar('rechaza objetos fuera de una carpeta de usuario', !ok2xx(r.status), 'HTTP ' + r.status);

  // 5. Supuestos de Auth que usa auth.js
  const antes = (await json(`${URL_SB}/auth/v1/user`, A.access_token, null, 'GET')).data.user_metadata || {};
  await json(`${URL_SB}/auth/v1/user`, A.access_token, { data: { nuhio_validacion: 'x' } }, 'PUT');
  const tras = (await json(`${URL_SB}/auth/v1/user`, A.access_token, { data: { nuhio_validacion: null } }, 'PUT')).data.user_metadata || {};
  if (!('nuhio_validacion' in tras)) comprobar('PUT /auth/v1/user con null elimina la clave', true);
  else aviso('PUT /auth/v1/user con null', 'la clave queda con valor null (auth.js lo tolera, pero quedan claves vacías)');
  const { nuhio_validacion, ...resto } = tras;
  comprobar('PUT /auth/v1/user fusiona: no se pierden otras claves de user_metadata', JSON.stringify(Object.keys(resto).sort()) === JSON.stringify(Object.keys(antes).filter(k => k !== 'nuhio_validacion').sort()));
  const largo = A.access_token.length;
  comprobar('el JWT de A cabe en la cookie (≤ 3976 caracteres)', largo <= 4000 - '__Host-disenito-session='.length, largo + ' caracteres');
  const otra = await sesion(cuentas[0]);
  await fetch(`${URL_SB}/auth/v1/logout?scope=local`, { method: 'POST', headers: h(otra.access_token) });
  const tras_logout = await fetch(`${URL_SB}/auth/v1/user`, { headers: h(otra.access_token) });
  comprobar('un token de una sesión cerrada ya no se acepta en /auth/v1/user (el Worker lo rechaza)', !tras_logout.ok, 'HTTP ' + tras_logout.status);
} catch (e) {
  comprobar('ejecución', false, e.message);
} finally {
  // Limpieza: cada cuenta borra lo suyo; se comprueba que no queda nada creado por esta validación.
  try {
    const A = await sesion(cuentas[0]), B = await sesion(cuentas[1]);
    for (const ruta of creados) {
      const dueño = ruta.startsWith(A.user.id + '/') ? A : ruta.startsWith(B.user.id + '/') ? B : A;
      await fetch(obj('', ruta), { method: 'DELETE', headers: h(dueño.access_token) });
    }
    const quedan = [];
    for (const ruta of creados) if ((await leer(A.access_token, ruta)).status === 200 || (await leer(B.access_token, ruta)).status === 200) quedan.push(ruta);
    comprobar('limpieza: no quedan objetos de la validación', quedan.length === 0, quedan.join(', '));
  } catch (e) { comprobar('limpieza', false, e.message); }
}
const fallos = resultados.filter(x => !x.ok).length;
console.log(`\n${resultados.length - fallos}/${resultados.length} comprobaciones correctas.`);
process.exit(fallos ? 1 : 0);
