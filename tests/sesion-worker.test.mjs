// Cookie de sesión __Host-disenito-session en el worker.js REAL (sin navegador): creación, límites, caducidad,
// cierre y rutas protegidas con una sesión válida. Supabase y ASSETS son simulados (ver tests/harness/real-harness.mjs).
// Ejecutar: node --test tests/sesion-worker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { llamarWorker, supa, crearUsuario, emitirSesion, reiniciarSupabase, estadoSupabase, USER, SUPABASE_HOST } from './harness/real-harness.mjs';

const ORIGEN = { Origin: 'https://nuhio.test' };
const bearer = t => ({ ...ORIGEN, Authorization: 'Bearer ' + t });
const crearCookie = token => llamarWorker('/api/sesion', { method: 'POST', headers: bearer(token) });
const atributos = sc => Object.fromEntries(sc.split(';').slice(1).map(p => p.trim().split('=')).map(([k, v]) => [k.toLowerCase(), v ?? true]));
const valorCookie = sc => sc.split(';')[0].split('=').slice(1).join('=');
const cookieDe = sc => sc.split(';')[0];
// Usuario cuyo JWT mide lo que se pida (relleno en user_metadata, como hacía avatar_data).
function tokenConRelleno(relleno, id = 'relleno-' + relleno) { crearUsuario(id, { user_metadata: { relleno: 'x'.repeat(relleno) } }); return emitirSesion(id).access_token; }
const FOTO_INCRUSTADA = 'data:image/jpeg;base64,' + Buffer.alloc(11250, 7).toString('base64'); // ≈15 KB, como en producción

test.beforeEach(() => reiniciarSupabase());

test('crea la cookie con atributos seguros y Max-Age igual a la vida restante del token', async () => {
  const s = emitirSesion(USER.id, { expiraEn: 3600 });
  const r = await crearCookie(s.access_token);
  assert.equal(r.status, 204);
  const sc = r.headers.get('set-cookie');
  assert.equal(cookieDe(sc), '__Host-disenito-session=' + s.access_token);
  const a = atributos(sc);
  assert.equal(a.path, '/'); assert.equal(a.secure, true); assert.equal(a.httponly, true); assert.equal(a.samesite, 'Lax');
  assert.ok(!('domain' in a), 'el prefijo __Host- exige que no haya Domain');
  assert.ok(Number(a['max-age']) > 3590 && Number(a['max-age']) <= 3600, 'Max-Age=' + a['max-age']);
  assert.ok(cookieDe(sc).length <= 4000);
  assert.match(r.headers.get('cache-control'), /no-store/);
});

test('un token que caduca pronto produce una cookie que caduca a la vez', async () => {
  const s = emitirSesion(USER.id, { expiraEn: 90 });
  const a = atributos((await crearCookie(s.access_token)).headers.get('set-cookie'));
  assert.ok(Number(a['max-age']) <= 90 && Number(a['max-age']) > 80);
});

test('rechaza con 413 (sin Set-Cookie y sin consultar Supabase) un token cuya cookie el navegador descartaría', async () => {
  crearUsuario('con-foto', { user_metadata: { full_name: 'Ana', avatar_data: FOTO_INCRUSTADA } });
  const s = emitirSesion('con-foto');
  assert.ok(s.access_token.length > 20000, 'reproduce el tamaño real (~21 KB)');
  estadoSupabase.reqs = [];
  const r = await crearCookie(s.access_token);
  assert.equal(r.status, 413);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal((await r.json()).code, 'session_too_large');
  assert.deepEqual(estadoSupabase.reqs, [], 'se rechaza antes de llamar a Supabase');
});

test('límite exacto: se acepta la cookie más grande que cabe en 4000 caracteres y se rechaza la siguiente', async () => {
  let dentro = null, fuera = null;
  for (let n = 2400; n < 3200 && !fuera; n++) {
    const t = tokenConRelleno(n), largo = '__Host-disenito-session='.length + t.length;
    if (largo <= 4000) dentro = t; else fuera = t;
  }
  assert.ok(dentro && fuera);
  assert.equal((await crearCookie(dentro)).status, 204);
  assert.equal((await crearCookie(fuera)).status, 413);
});

test('POST /api/sesion exige el mismo origen y un token válido y vigente', async () => {
  const s = emitirSesion(USER.id);
  assert.equal((await llamarWorker('/api/sesion', { method: 'POST', headers: { Authorization: 'Bearer ' + s.access_token } })).status, 403);
  assert.equal((await llamarWorker('/api/sesion', { method: 'POST', headers: { Origin: 'https://otro.example', Authorization: 'Bearer ' + s.access_token } })).status, 403);
  assert.equal((await crearCookie('no-es-un-jwt')).status, 401);
  assert.equal((await crearCookie('a.b.c')).status, 401);
  const caducado = emitirSesion(USER.id, { expiraEn: -30 });
  const r = await crearCookie(caducado.access_token);
  assert.equal(r.status, 401); assert.equal(r.headers.get('set-cookie'), null);
});

test('GET /api/sesion confirma que la cookie guardada corresponde al token actual', async () => {
  const s = emitirSesion(USER.id), otro = emitirSesion(USER.id);
  const cookie = valorCookie((await crearCookie(s.access_token)).headers.get('set-cookie'));
  assert.equal((await llamarWorker('/api/sesion', { cookie, headers: { Authorization: 'Bearer ' + s.access_token } })).status, 204);
  assert.equal((await llamarWorker('/api/sesion', { cookie, headers: { Authorization: 'Bearer ' + otro.access_token } })).status, 401);
});

test('cierre de sesión: borra la cookie (Max-Age=0) y revoca el token en Supabase', async () => {
  const s = emitirSesion(USER.id);
  const cookie = valorCookie((await crearCookie(s.access_token)).headers.get('set-cookie'));
  const r = await llamarWorker('/api/sesion', { method: 'DELETE', cookie, headers: bearer(s.access_token) });
  assert.equal(r.status, 204);
  assert.equal(atributos(r.headers.get('set-cookie'))['max-age'], '0');
  assert.equal(valorCookie(r.headers.get('set-cookie')), '');
  assert.equal(supa.tokens.get(s.access_token).revocado, true);
  assert.equal((await llamarWorker('/inventario-modelos-3d.json', { cookie })).status, 302, 'la cookie antigua ya no sirve');
});

test('rutas protegidas CON sesión válida: los dos JSON internos dan 404 real; lo legítimo, 200', async () => {
  const s = emitirSesion(USER.id);
  const cookie = valorCookie((await crearCookie(s.access_token)).headers.get('set-cookie'));
  for (const ruta of ['/inventario-modelos-3d.json', '/auditoria-biblioteca-modelos-3d.json', '/no-existe-xyz123.json']) {
    const r = await llamarWorker(ruta, { cookie });
    assert.equal(r.status, 404, ruta); assert.equal(r.headers.get('location'), null, ruta);
  }
  for (const ruta of ['/', '/editor', '/index.html', '/catalogo/productos-comerciales.json', '/acceso']) {
    assert.equal((await llamarWorker(ruta, { cookie })).status, 200, ruta);
  }
});

test('rutas protegidas SIN sesión válida: redirección de autenticación (302 → /acceso), sin revelar si el archivo existe', async () => {
  const caducado = emitirSesion(USER.id, { expiraEn: -5 }).access_token;
  for (const cookie of ['', 'a.b.c', caducado]) {
    for (const ruta of ['/inventario-modelos-3d.json', '/auditoria-biblioteca-modelos-3d.json', '/index.html', '/no-existe-xyz123.json']) {
      const r = await llamarWorker(ruta, { cookie });
      assert.equal(r.status, 302, ruta + ' cookie=' + cookie.slice(0, 8)); assert.equal(r.headers.get('location'), '/acceso');
    }
  }
});

test('/api/editor sigue funcionando con Bearer (también con un token grande) y rechaza tokens inválidos', async () => {
  crearUsuario('con-foto', { user_metadata: { avatar_data: FOTO_INCRUSTADA } });
  const grande = emitirSesion('con-foto').access_token;
  const r = await llamarWorker('/api/editor', { headers: { Authorization: 'Bearer ' + grande } });
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-disenito-editor'), '1');
  assert.equal((await llamarWorker('/api/editor', { headers: { Authorization: 'Bearer a.b.c' } })).status, 401);
});

// Llamadas directas al Supabase simulado (fetch de Node interceptado: sin red).
const sb = (ruta, { token, method = 'GET', body } = {}) => fetch('https://' + SUPABASE_HOST + ruta, {
  method, headers: { apikey: 'anon', 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: body && JSON.stringify(body) });

test('cierre de sesión: el refresh token queda invalidado y el Worker rechaza al instante el access token; REST y Storage lo aceptan solo hasta su caducidad', async () => {
  const ses = emitirSesion(USER.id, { expiraEn: 600 });
  supa.objetos.set(USER.id + '/avatar-migrado.jpg', { bytes: Buffer.from('x'), tipo: 'image/jpeg', dueño: USER.id });
  const cookie = valorCookie((await crearCookie(ses.access_token)).headers.get('set-cookie'));
  assert.equal((await llamarWorker('/api/sesion', { method: 'DELETE', cookie, headers: bearer(ses.access_token) })).status, 204);
  // 1. Refresh token: invalidado (no se pueden obtener tokens nuevos).
  const r = await sb('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: ses.refresh_token } });
  assert.equal(r.status, 400);
  // 2. Access token en /auth/v1/user: rechazado al instante. El Worker valida así la cookie y /api/editor.
  assert.equal((await sb('/auth/v1/user', { token: ses.access_token })).status, 401);
  assert.equal((await llamarWorker('/inventario-modelos-3d.json', { cookie })).status, 302);
  assert.equal((await llamarWorker('/api/editor', { headers: { Authorization: 'Bearer ' + ses.access_token } })).status, 401);
  assert.equal((await crearCookie(ses.access_token)).status, 401, 'no se puede recrear la cookie');
  // 3. Vigencia residual: REST y Storage solo verifican firma y caducidad, como en Supabase.
  assert.equal((await sb('/rest/v1/proyectos?select=id', { token: ses.access_token })).status, 200, 'REST: residual hasta exp');
  assert.equal((await sb('/storage/v1/object/authenticated/avatars/' + USER.id + '/avatar-migrado.jpg', { token: ses.access_token })).status, 200, 'Storage: residual hasta exp');
  // ... y nunca más allá de exp: un token caducado se rechaza en todas partes.
  const caducado = emitirSesion(USER.id, { expiraEn: -1 });
  assert.equal((await sb('/rest/v1/proyectos?select=id', { token: caducado.access_token })).status, 401);
  assert.notEqual((await sb('/storage/v1/object/authenticated/avatars/' + USER.id + '/avatar-migrado.jpg', { token: caducado.access_token })).status, 200);
});

test('cierre de sesión: solo afecta a esa sesión; otra sesión del mismo usuario (otro dispositivo) sigue funcionando', async () => {
  const movil = emitirSesion(USER.id), portatil = emitirSesion(USER.id);
  await sb('/auth/v1/logout?scope=local', { token: movil.access_token, method: 'POST' });
  assert.equal((await sb('/auth/v1/user', { token: movil.access_token })).status, 401);
  assert.equal((await sb('/auth/v1/user', { token: portatil.access_token })).status, 200);
  assert.equal((await sb('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: portatil.refresh_token } })).status, 200);
});

test('tras renovar el token, la sesión sigue siendo la misma: cerrarla invalida también los tokens renovados', async () => {
  const ses = emitirSesion(USER.id);
  const nueva = await (await sb('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: ses.refresh_token } })).json();
  await sb('/auth/v1/logout?scope=local', { token: ses.access_token, method: 'POST' });
  assert.equal((await sb('/auth/v1/user', { token: nueva.access_token })).status, 401);
  assert.equal((await sb('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: nueva.refresh_token } })).status, 400);
});
