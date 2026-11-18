// Arnés "real": ejecuta en Chrome el flujo acceso → /api/editor → document.write con los ARCHIVOS REALES del repositorio
// (index.html, auth.js, acceso.html, worker.js, three, OrbitControls, loaders, pdf.min.js) y sin salir a Internet.
//  - worker.js real se importa en Node y recibe las peticiones; ASSETS lo simula un lector de disenador-web/ que respeta
//    .assetsignore y _headers (SIMULACIÓN: no es el empaquetado real de Cloudflare).
//  - Supabase (Auth y REST) es un servidor falso en memoria; cualquier otro host se bloquea.
import { readFileSync, readdirSync, statSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, extname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, '../..');
const assetsDir = join(root, 'disenador-web');
const require = createRequire(import.meta.url);
export const chromium = (() => { for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright']) { try { return require(p).chromium; } catch {} } throw new Error('Playwright no disponible'); })();

export const SUPABASE_HOST = 'aqfqwvzbsbjrixzgxtro.supabase.co';
export const USER = { id: 'usuario-de-prueba-local', email: 'prueba@local.invalid' };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
export const FAKE_JWT = `${b64({ alg: 'none' })}.${b64({ sub: USER.id })}.firma`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown', '.webp': 'image/webp', '.png': 'image/png' };

function walk(dir, out = []) { for (const n of readdirSync(dir)) { const p = join(dir, n); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; }
const files = walk(assetsDir).map(p => relative(assetsDir, p).split(sep).join('/'));
// .assetsignore evaluado con el motor gitignore de git (misma sintaxis que usa Cloudflare)
function ignoredSet() {
  const d = mkdtempSync(join(tmpdir(), 'asig-')); execFileSync('git', ['init', '-q'], { cwd: d });
  copyFileSync(join(assetsDir, '.assetsignore'), join(d, '.gitignore'));
  try { return new Set(execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: d, input: files.join('\n'), encoding: 'utf8' }).split('\n').filter(Boolean)); }
  catch (e) { if (e.status === 1) return new Set(); throw e; }
}
export const ignored = ignoredSet();
const published = new Set(files.filter(f => !ignored.has(f) && f !== '.assetsignore' && f !== '_headers'));
export const publishedAssets = published;
const baseHeaders = (() => { const h = {}; for (const l of readFileSync(join(assetsDir, '_headers'), 'utf8').split('\n').slice(1)) { const m = /^\s+([^:]+):\s*(.*)$/.exec(l); if (m) h[m[1]] = m[2]; } return h; })();

function assetFetch(pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/' || p === '') p = '/index.html';
  const rel = p.replace(/^\//, '');
  if (!published.has(rel)) return new Response('Not found', { status: 404 });
  return new Response(readFileSync(join(assetsDir, rel)), { status: 200, headers: { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream', ...baseHeaders } });
}

// ---- Worker real ----
const wrangler = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
const rules = wrangler.assets.run_worker_first;
const glob = g => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const workerFirst = path => { let hit = false; for (const r of rules) { if (r.startsWith('!')) { if (glob(r.slice(1)).test(path)) return false; } else if (glob(r).test(path)) hit = true; } return hit; };
const kv = { list: async () => ({ keys: [], list_complete: true }), get: async () => null, put: async () => {} };
const env = { ASSETS: { fetch: req => assetFetch(new URL(req.url).pathname) }, MASTER_USER_ID: 'no-es-este-usuario', CATALOG_APPROVALS: kv };
const worker = (await import(pathToFileURL(join(root, 'worker.js')).href)).default;
// Llamada directa al worker real (para comprobar redirecciones, que el enrutado de Playwright no vuelve a interceptar)
export const llamarWorker = (ruta, { cookie = '', method = 'GET', headers = {} } = {}) => worker.fetch(new Request('https://nuhio.test' + ruta, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: '__Host-disenito-session=' + cookie } : {}), ...headers } }), env);
export const estadoSupabase = { proyectos: new Map(), reqs: [] };

// ---- Supabase simulado (Auth + Storage + REST), con el comportamiento documentado que usa NuHio ----
//  * Auth: el access_token es un JWT que COPIA user_metadata (como Supabase), caduca (exp) y se puede revocar.
//    PUT /auth/v1/user fusiona `data` con user_metadata y una clave con null se elimina (semántica de GoTrue).
//  * Storage: bucket privado `avatars` con las mismas reglas que las políticas RLS de
//    supabase/migrations/20261118120000_avatars_privados.sql: solo `authenticated`, solo "<uid>/…".
//  * `supa.fallos` inyecta errores (subida, copia corrupta, actualización de metadatos) para probar la migración.
const PASSWORD_PRUEBA = 'Prueba-Local-1';
//  * Rotación de refresh tokens con detección de reutilización: dentro de `intervaloReutilizacion` segundos se
//    devuelve la misma sesión hija; después, Supabase revoca la sesión entera (aquí, todas las del usuario).
//  * `fallos.red` corta la conexión de una subida; `fallos.respuestaPerdida` aplica el cambio de metadatos y
//    corta la conexión antes de responder (el cliente no sabe si se aplicó).
export const supa = { usuarios: new Map(), tokens: new Map(), refresh: new Map(), usados: new Map(), objetos: new Map(), fallos: {}, intervaloReutilizacion: 10, n: 0 };
export function reiniciarSupabase() {
  supa.usuarios = new Map([[USER.id, { ...USER, password: PASSWORD_PRUEBA, user_metadata: {} }]]);
  supa.tokens = new Map([[FAKE_JWT, { userId: USER.id, exp: null }]]);
  supa.refresh = new Map([['r', USER.id]]);
  supa.usados = new Map();
  supa.intervaloReutilizacion = 10;
  supa.storageBloqueado = false;
  supa.reutilizaciones = 0;
  supa.objetos = new Map();
  supa.fallos = { subida: 0, corromper: 0, metadatos: 0, red: 0, respuestaPerdida: 0 };
}
reiniciarSupabase();
export function crearUsuario(id, { email = id + '@local.invalid', user_metadata = {} } = {}) {
  supa.usuarios.set(id, { id, email, password: PASSWORD_PRUEBA, user_metadata: structuredClone(user_metadata) });
  return supa.usuarios.get(id);
}
// Emite una sesión como /auth/v1/token: el JWT lleva user_metadata en el momento de emitirse.
export function emitirSesion(userId, { expiraEn = 3600 } = {}) {
  const u = supa.usuarios.get(userId), exp = Math.floor(Date.now() / 1e3) + expiraEn;
  const payload = { sub: u.id, email: u.email, exp, iat: exp - expiraEn, role: 'authenticated', aud: 'authenticated', session_id: 's' + (++supa.n), user_metadata: u.user_metadata, app_metadata: { provider: 'email' } };
  const access_token = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(payload)}.firma${supa.n}`;
  const refresh_token = 'refresh-' + supa.n;
  supa.tokens.set(access_token, { userId, exp });
  supa.refresh.set(refresh_token, userId);
  return { access_token, refresh_token, expires_in: expiraEn, expires_at: exp, token_type: 'bearer', user: publico(u) };
}
const publico = u => ({ id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', user_metadata: structuredClone(u.user_metadata), app_metadata: { provider: 'email' } });
function usuarioDeToken(headers) {
  const auth = headers.authorization || headers.Authorization || '';
  const rec = supa.tokens.get(auth.replace(/^Bearer\s+/i, ''));
  if (!rec || rec.revocado || (rec.exp && rec.exp * 1e3 < Date.now())) return null;
  return supa.usuarios.get(rec.userId) || null;
}
const texto = body => body == null ? '' : Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
const AVATAR_TIPOS = ['image/jpeg', 'image/png', 'image/webp'];

function supabase(method, url, headers, body) {
  estadoSupabase.reqs.push(method + ' ' + url.pathname + url.search);
  const json = (status, data) => ({ status, body: data === undefined ? '' : JSON.stringify(data), contentType: 'application/json' });
  const p = url.pathname;
  if (p === '/auth/v1/token') {
    const datos = JSON.parse(texto(body) || '{}'), tipo = url.searchParams.get('grant_type');
    if (tipo === 'refresh_token') {
      const id = supa.refresh.get(datos.refresh_token);
      if (!id) {
        const usado = supa.usados.get(datos.refresh_token);
        if (!usado) return json(400, { error_description: 'Invalid Refresh Token: Refresh Token Not Found' });
        if (Date.now() - usado.en <= supa.intervaloReutilizacion * 1e3) return json(200, usado.hija);
        // Reutilización fuera del margen: se revoca la sesión entera.
        for (const rec of supa.tokens.values()) if (rec.userId === usado.userId) rec.revocado = true;
        for (const [r, uid] of supa.refresh) if (uid === usado.userId) supa.refresh.delete(r);
        supa.reutilizaciones = (supa.reutilizaciones || 0) + 1;
        return json(400, { error_description: 'Invalid Refresh Token: Already Used' });
      }
      supa.refresh.delete(datos.refresh_token);                     // rotación como en Supabase
      const hija = emitirSesion(id);
      supa.usados.set(datos.refresh_token, { userId: id, hija, en: Date.now() });
      return json(200, hija);
    }
    if (tipo === 'password') {
      const u = [...supa.usuarios.values()].find(x => x.email === datos.email && x.password === datos.password);
      return u ? json(200, emitirSesion(u.id)) : json(400, { error_description: 'Invalid login credentials' });
    }
    return json(400, { error_description: 'grant_type no simulado' });
  }
  const user = usuarioDeToken(headers);
  if (p === '/auth/v1/logout') { const t = (headers.authorization || '').replace(/^Bearer\s+/i, ''); if (supa.tokens.has(t)) supa.tokens.get(t).revocado = true; return json(204); }
  if (p === '/auth/v1/user') {
    if (!user) return json(401, { msg: 'JWT inválido o caducado' });
    if (method === 'GET') return json(200, publico(user));
    if (method === 'PUT') {
      if (supa.fallos.metadatos > 0) { supa.fallos.metadatos--; return json(500, { msg: 'Fallo simulado al actualizar metadatos' }); }
      const datos = JSON.parse(texto(body) || '{}');
      for (const [k, v] of Object.entries(datos.data || {})) v === null ? delete user.user_metadata[k] : user.user_metadata[k] = v;
      if (datos.email) user.email = datos.email;
      if (supa.fallos.respuestaPerdida > 0) { supa.fallos.respuestaPerdida--; return { abortar: true }; }
      return json(200, publico(user));
    }
  }
  const st = /^\/storage\/v1\/object\/(?:(authenticated|public|sign)\/)?([^/]+)\/(.+)$/.exec(p);
  if (st) {
    const [, modo, bucket, ruta] = st, clave = decodeURIComponent(ruta);
    if (bucket !== 'avatars') return json(400, { statusCode: '404', error: 'Bucket not found' });
    if (modo === 'public') return json(400, { statusCode: '404', error: 'Bucket not found', message: 'El bucket es privado' });
    // SQL revertido (sin políticas permisivas): ningún usuario puede leer ni escribir.
    if (supa.storageBloqueado) return json(400, { statusCode: '403', error: 'Unauthorized', message: 'sin políticas (migración revertida)' });
    if (!user) return json(400, { statusCode: '403', error: 'Unauthorized', message: 'anon no tiene políticas en avatars' });
    if (clave.split('/')[0] !== user.id) return json(400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
    if ((method === 'POST' || method === 'PUT') && !modo) {
      if (supa.fallos.red > 0) { supa.fallos.red--; return { abortar: true }; }
      if (supa.fallos.subida > 0) { supa.fallos.subida--; return json(500, { error: 'Fallo simulado de Storage' }); }
      const tipo = headers['content-type'] || '';
      if (!AVATAR_TIPOS.includes(tipo)) return json(400, { statusCode: '415', error: 'invalid_mime_type' });
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(texto(body));
      if (bytes.length > 524288) return json(400, { statusCode: '413', error: 'Payload too large' });
      if (supa.objetos.has(clave) && headers['x-upsert'] !== 'true') return json(400, { statusCode: '409', error: 'Duplicate' });
      let guardado = bytes;
      if (supa.fallos.corromper > 0) { supa.fallos.corromper--; guardado = Buffer.concat([bytes.subarray(0, Math.max(0, bytes.length - 1)), Buffer.from([0])]); }
      supa.objetos.set(clave, { bytes: guardado, tipo, dueño: user.id });
      return json(200, { Key: 'avatars/' + clave });
    }
    if (method === 'GET' && (modo === 'authenticated' || !modo)) {
      const o = supa.objetos.get(clave);
      return o ? { status: 200, body: o.bytes, contentType: o.tipo } : json(400, { statusCode: '404', error: 'not_found' });
    }
    if (method === 'DELETE' && !modo) { supa.objetos.delete(clave); return json(200, [{ name: clave }]); }
    return json(400, { error: 'operación de Storage no simulada' });
  }
  if (!user) return json(401, { message: 'JWT inválido' });
  if (p === '/rest/v1/proyectos') {
    if (method === 'GET') {
      const id = /^eq\.(.*)$/.exec(url.searchParams.get('id') || '')?.[1];
      if (id) return json(200, estadoSupabase.proyectos.has(id) ? [estadoSupabase.proyectos.get(id)] : []);
      return json(200, [...estadoSupabase.proyectos.values()].map(({ id, name, updated }) => ({ id, name, updated })));
    }
    if (method === 'POST') { const r = JSON.parse(texto(body)); estadoSupabase.proyectos.set(r.id, r); return json(204); }
    if (method === 'DELETE') { const id = /^eq\.(.*)$/.exec(url.searchParams.get('id') || '')?.[1]; estadoSupabase.proyectos.delete(id); return json(204); }
  }
  if (p === '/rest/v1/rpc/foto_ia_estadisticas') return json(200, { hoy: 0, limite: 2, disponibles: 2, fecha: '2026-11-18' });
  return json(404, { message: 'no simulado: ' + p });
}
// fetch de Node (lo usa worker.js para validar la sesión) → mismo Supabase falso
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== SUPABASE_HOST) throw new Error('Red bloqueada en pruebas: ' + url.href);
  const h = Object.fromEntries(new Headers(init.headers || {}));
  const r = supabase(init.method || 'GET', url, h, init.body);
  if (r.abortar) throw new TypeError('fetch failed (corte simulado)');
  return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: { 'Content-Type': r.contentType } });
};

export async function abrirReal(browser, { sesion = true, guardado = {}, post = null, sustituir = {} } = {}) {
  // sustituir: { '/auth.js': 'contenido' } sirve otra versión de un asset (p. ej. el auth.js anterior, para probar la reversión).
  // sesion: true (usuario de prueba con FAKE_JWT), false (sin sesión) u objeto devuelto por emitirSesion().
  // post(pathname, headers, bodyBuffer) -> { headers, body }: permite a las pruebas de CSP añadir cabeceras/nonces SIN tocar el código del repositorio.
  estadoSupabase.proyectos = new Map(Object.entries(guardado)); estadoSupabase.reqs = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const bloqueadas = [], errores = [], peticiones = [], redirecciones = [];
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  await ctx.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname === SUPABASE_HOST) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const r = supabase(req.method(), u, req.headers(), req.postDataBuffer());
      if (r.abortar) return route.abort('connectionreset');
      return route.fulfill({ status: r.status, body: r.body, contentType: r.contentType, headers: cors });
    }
    if (u.hostname !== 'nuhio.test') { bloqueadas.push(u.href); return route.abort(); }
    peticiones.push(u.pathname);
    if (u.pathname in sustituir) return route.fulfill({ status: 200, contentType: TYPES[extname(u.pathname)] || 'text/plain', body: sustituir[u.pathname] });
    let res;
    if (workerFirst(u.pathname)) {
      const hdr = new Headers(req.headers()); const body = ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer();
      const cookies = await ctx.cookies('https://nuhio.test'); if (cookies.length) hdr.set('Cookie', cookies.map(c => c.name + '=' + c.value).join('; '));
      res = await worker.fetch(new Request(u.href, { method: req.method(), headers: hdr, body, redirect: 'manual' }), env);
    } else res = assetFetch(u.pathname);
    // Playwright no intercepta el destino de un 3xx simulado; en navegaciones se emula la redirección en el
    // cliente (location.replace, sin entrada en el historial) y queda registrada en `redirecciones`.
    const destino = res.headers.get('location');
    if (req.isNavigationRequest() && res.status >= 300 && res.status < 400 && destino) {
      redirecciones.push(u.pathname + ' ' + res.status + ' ' + destino);
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><script>location.replace(' + JSON.stringify(destino) + ')</script>' });
    }
    let headers = Object.fromEntries(res.headers); delete headers['content-length'];
    let body = Buffer.from(await res.arrayBuffer());
    if (post) ({ headers, body } = post(u.pathname, headers, body, res.status));
    return route.fulfill({ status: res.status, headers, body });
  });
  const ses = sesion === true ? { access_token: FAKE_JWT, refresh_token: 'r', expires_at: Math.floor(Date.now() / 1e3) + 36000, email: USER.email } : sesion ? { access_token: sesion.access_token, refresh_token: sesion.refresh_token, expires_at: sesion.expires_at, email: sesion.user?.email || '' } : null;
  // Una sola inyección por contexto: tras un cierre de sesión no se vuelve a poner la sesión.
  if (ses) await ctx.addInitScript(s => { try { if (!localStorage.getItem('__sesionInyectada')) { localStorage.setItem('__sesionInyectada', '1'); localStorage.setItem('sbSes', JSON.stringify(s)); } } catch {} }, ses);
  await ctx.addInitScript(() => { window.__CANARIO = 0; });
  const page = await ctx.newPage();
  page.on('pageerror', e => errores.push(String(e)));
  page.on('dialog', d => { errores.push('dialog:' + d.message()); d.dismiss(); });
  return { ctx, page, bloqueadas, errores, peticiones, redirecciones };
}
export async function entrarAlEditor(page) {
  await page.goto('https://nuhio.test/acceso', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof S === 'object' && typeof openDraft === 'function' && document.getElementById('c2'), null, { timeout: 20000 });
  await page.waitForTimeout(600);
}
