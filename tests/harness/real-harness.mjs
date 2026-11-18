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

function supabase(method, url, headers, body) {
  estadoSupabase.reqs.push(method + ' ' + url.pathname + url.search);
  const ok = (headers.authorization || headers.Authorization) === 'Bearer ' + FAKE_JWT;
  const json = (status, data) => ({ status, body: data === undefined ? '' : JSON.stringify(data), contentType: 'application/json' });
  if (url.pathname === '/auth/v1/user') return ok ? json(200, { ...USER, user_metadata: {} }) : json(401, { msg: 'no' });
  if (!ok) return json(401, { message: 'JWT inválido' });
  if (url.pathname === '/rest/v1/proyectos') {
    if (method === 'GET') {
      const id = /^eq\.(.*)$/.exec(url.searchParams.get('id') || '')?.[1];
      if (id) return json(200, estadoSupabase.proyectos.has(id) ? [estadoSupabase.proyectos.get(id)] : []);
      return json(200, [...estadoSupabase.proyectos.values()].map(({ id, name, updated }) => ({ id, name, updated })));
    }
    if (method === 'POST') { const r = JSON.parse(body); estadoSupabase.proyectos.set(r.id, r); return json(204); }
    if (method === 'DELETE') { const id = /^eq\.(.*)$/.exec(url.searchParams.get('id') || '')?.[1]; estadoSupabase.proyectos.delete(id); return json(204); }
  }
  if (url.pathname === '/rest/v1/rpc/foto_ia_estadisticas') return json(200, { hoy: 0, limite: 2, disponibles: 2, fecha: '2026-11-18' });
  return json(404, { message: 'no simulado: ' + url.pathname });
}
// fetch de Node (lo usa worker.js para validar la sesión) → mismo Supabase falso
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== SUPABASE_HOST) throw new Error('Red bloqueada en pruebas: ' + url.href);
  const h = Object.fromEntries(new Headers(init.headers || {}));
  const r = supabase(init.method || 'GET', url, h, init.body);
  return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: { 'Content-Type': r.contentType } });
};

export async function abrirReal(browser, { sesion = true, guardado = {}, post = null } = {}) {
  // post(pathname, headers, bodyBuffer) -> { headers, body }: permite a las pruebas de CSP añadir cabeceras/nonces SIN tocar el código del repositorio.
  estadoSupabase.proyectos = new Map(Object.entries(guardado)); estadoSupabase.reqs = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const bloqueadas = [], errores = [], peticiones = [];
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  await ctx.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname === SUPABASE_HOST) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const r = supabase(req.method(), u, req.headers(), req.postData());
      return route.fulfill({ status: r.status, body: r.body, contentType: r.contentType, headers: cors });
    }
    if (u.hostname !== 'nuhio.test') { bloqueadas.push(u.href); return route.abort(); }
    peticiones.push(u.pathname);
    let res;
    if (workerFirst(u.pathname)) {
      const hdr = new Headers(req.headers()); const body = ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer();
      const cookies = await ctx.cookies('https://nuhio.test'); if (cookies.length) hdr.set('Cookie', cookies.map(c => c.name + '=' + c.value).join('; '));
      res = await worker.fetch(new Request(u.href, { method: req.method(), headers: hdr, body, redirect: 'manual' }), env);
    } else res = assetFetch(u.pathname);
    let headers = Object.fromEntries(res.headers); delete headers['content-length'];
    let body = Buffer.from(await res.arrayBuffer());
    if (post) ({ headers, body } = post(u.pathname, headers, body, res.status));
    return route.fulfill({ status: res.status, headers, body });
  });
  if (sesion) await ctx.addInitScript(jwt => { try { if (!localStorage.getItem('sbSes')) localStorage.setItem('sbSes', JSON.stringify({ access_token: jwt, refresh_token: 'r', expires_at: Math.floor(Date.now() / 1e3) + 36000, email: 'prueba@local.invalid' })); } catch {} }, FAKE_JWT);
  await ctx.addInitScript(() => { window.__CANARIO = 0; });
  const page = await ctx.newPage();
  page.on('pageerror', e => errores.push(String(e)));
  page.on('dialog', d => { errores.push('dialog:' + d.message()); d.dismiss(); });
  return { ctx, page, bloqueadas, errores, peticiones };
}
export async function entrarAlEditor(page) {
  await page.goto('https://nuhio.test/acceso', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof S === 'object' && typeof openDraft === 'function' && document.getElementById('c2'), null, { timeout: 20000 });
  await page.waitForTimeout(600);
}
