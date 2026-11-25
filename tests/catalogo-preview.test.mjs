// Catálogo compartido en las Previews (desarrollo-cloudflare). Las Previews de Workers no heredan los bindings de
// producción: sin `previews.kv_namespaces`, /api/catalogo/* respondía 503. La Preview usa su propio KV
// (DISENITO_CATALOGO_PREVIEW), nunca el de producción (DISENITO_CATALOGO).
// Se ejecuta worker.js real con un KV en memoria (sin red: Supabase simulado del arnés).
// Ejecutar: node --test tests/catalogo-preview.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, crearUsuario, emitirSesion, reiniciarSupabase } from './harness/real-harness.mjs';

const wrangler = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
const worker = (await import(pathToFileURL(join(root, 'worker.js')).href)).default;
const KV_PRODUCCION = '28ff3950582f420e8fcdfc0c343b11b1', KV_PREVIEW = 'd91aee67ce274a47871af8b9c4769196';
const MASTER = wrangler.previews.vars.MASTER_USER_ID;

// KV en memoria con la semántica que usa worker.js: list por prefijo y paginada con cursor.
function kvMemoria() {
  const datos = new Map();
  return {
    datos,
    async get(k) { return datos.has(k) ? datos.get(k) : null; },
    async put(k, v) { datos.set(k, String(v)); },
    async delete(k) { datos.delete(k); },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const todas = [...datos.keys()].filter(k => k.startsWith(prefix)).sort();
      const desde = cursor ? Number(cursor) : 0, hasta = Math.min(desde + limit, todas.length);
      return { keys: todas.slice(desde, hasta).map(name => ({ name })), list_complete: hasta >= todas.length, cursor: hasta >= todas.length ? undefined : String(hasta) };
    },
  };
}
const estatico = { products: [{ id: 'sofa-estatico', name: 'Sofá', model: { type: 'sofa' } }] };
const entorno = kv => ({
  ...(kv ? { CATALOG_APPROVALS: kv } : {}), MASTER_USER_ID: MASTER,
  ASSETS: { fetch: async req => new URL(req.url).pathname === '/catalogo/productos-comerciales.json' ? Response.json(estatico) : new Response('Not found', { status: 404 }) },
});
const llamar = (env, ruta, { token, method = 'GET', body } = {}) => worker.fetch(new Request('https://nuhio.test' + ruta, {
  method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);
let master, usuario;
test.beforeEach(() => {
  reiniciarSupabase();
  crearUsuario(MASTER, { user_metadata: { full_name: 'Master' } });
  crearUsuario('usuario-normal');
  master = emitirSesion(MASTER).access_token;
  usuario = emitirSesion('usuario-normal').access_token;
});

test('configuración: la Preview declara su propio KV del catálogo, distinto del de producción', () => {
  const prod = wrangler.kv_namespaces.find(k => k.binding === 'CATALOG_APPROVALS');
  const prev = (wrangler.previews.kv_namespaces || []).find(k => k.binding === 'CATALOG_APPROVALS');
  assert.equal(prod?.id, KV_PRODUCCION, 'el KV de producción no cambia');
  assert.equal(prev?.id, KV_PREVIEW, 'la Preview usa DISENITO_CATALOGO_PREVIEW');
  assert.notEqual(prev.id, prod.id, 'nunca el KV de producción');
});

test('configuración: cada binding que lee worker.js está declarado también para las Previews', () => {
  const src = readFileSync(join(root, 'worker.js'), 'utf8');
  const usados = new Set([...src.matchAll(/env\.([A-Z_]+)/g)].map(m => m[1]));
  const secretos = new Set(['SUPABASE_SERVICE_ROLE_KEY']);          // secretos: no van en el archivo de configuración
  const p = wrangler.previews;
  const declarados = new Set([
    ...(p.kv_namespaces || []).map(k => k.binding), ...Object.keys(p.vars || {}),
    ...(p.ai ? [p.ai.binding] : []), wrangler.assets.binding,          // assets se hereda en las Previews
  ]);
  for (const b of usados) if (!secretos.has(b)) assert.ok(declarados.has(b), 'falta en previews: ' + b);
});

test('sin el binding el Worker lo sigue diciendo con un 503 explícito (no se oculta)', async () => {
  const r = await llamar(entorno(null), '/api/catalogo/productos', { token: usuario });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /no está configurado/);
});

test('catálogo vacío (KV nuevo): lecturas correctas para cualquier usuario autenticado', async () => {
  const env = entorno(kvMemoria());
  for (const token of [usuario, master]) {
    let r = await llamar(env, '/api/catalogo/aprobaciones', { token });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), {});
    r = await llamar(env, '/api/catalogo/productos', { token });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { products: [] });
    r = await llamar(env, '/api/catalogo/modelos', { token });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { models: [] });
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal((await llamar(env, '/api/catalogo/productos')).status, 401, 'sin sesión no hay catálogo');
  assert.equal((await llamar(env, '/api/catalogo/modelo/no-existe', { token: usuario })).status, 404);
});

test('permisos: solo MASTER escribe; un usuario normal recibe 403 y el KV no cambia', async () => {
  const kv = kvMemoria(), env = entorno(kv);
  const producto = { id: 'mesa-1', nombre: 'Mesa' };
  const modelo = { id: 'silla-1', name: 'Silla', ext: 'glb', data: 'AAAA' };
  for (const [ruta, body] of [['/api/catalogo/productos', producto], ['/api/catalogo/modelos', modelo], ['/api/catalogo/aprobar', { productId: 'sofa-estatico', status: 'approved' }]]) {
    const r = await llamar(env, ruta, { token: usuario, method: 'POST', body });
    assert.equal(r.status, 403, ruta);
    assert.match((await r.json()).error, /Solo la cuenta MASTER/);
  }
  assert.equal(kv.datos.size, 0);
  const p = await (await llamar(env, '/api/catalogo/permisos', { token: usuario })).json();
  assert.equal(p.master, false);
  assert.equal((await (await llamar(env, '/api/catalogo/permisos', { token: master })).json()).master, true);
});

test('escritura y lectura por MASTER: productos, aprobaciones y modelos 3D', async () => {
  const kv = kvMemoria(), env = entorno(kv);
  let r = await llamar(env, '/api/catalogo/productos', { token: master, method: 'POST', body: { id: 'mesa-1', nombre: 'Mesa', fotos: ['x'], docId: 'd' } });
  assert.equal(r.status, 200);
  const productos = (await (await llamar(env, '/api/catalogo/productos', { token: usuario })).json()).products;
  assert.equal(productos.length, 1);
  assert.equal(productos[0].visual_review, 'pending');
  assert.equal(productos[0].updatedBy, MASTER);
  assert.ok(!('fotos' in productos[0]) && !('docId' in productos[0]), 'no se guardan campos internos');
  // Aprobar una ficha compartida y una del catálogo estático; una inexistente da 404.
  for (const id of ['mesa-1', 'sofa-estatico']) assert.equal((await llamar(env, '/api/catalogo/aprobar', { token: master, method: 'POST', body: { productId: id, status: 'approved' } })).status, 200, id);
  assert.equal((await llamar(env, '/api/catalogo/aprobar', { token: master, method: 'POST', body: { productId: 'no-existe', status: 'approved' } })).status, 404);
  assert.equal((await llamar(env, '/api/catalogo/aprobar', { token: master, method: 'POST', body: { productId: 'mesa-1', status: 'otro' } })).status, 400);
  const aprobaciones = await (await llamar(env, '/api/catalogo/aprobaciones', { token: usuario })).json();
  assert.deepEqual(Object.keys(aprobaciones).sort(), ['mesa-1', 'sofa-estatico']);
  assert.equal(aprobaciones['mesa-1'].status, 'approved');
  // Modelos: el listado solo da metadatos; la descarga, el modelo completo.
  r = await llamar(env, '/api/catalogo/modelos', { token: master, method: 'POST', body: { id: 'silla-1', name: 'Silla', ext: 'glb', data: 'AAAA' } });
  assert.equal(r.status, 200);
  assert.equal((await llamar(env, '/api/catalogo/modelos', { token: master, method: 'POST', body: { id: 'x', ext: 'exe', data: '' } })).status, 413);
  const modelos = (await (await llamar(env, '/api/catalogo/modelos', { token: usuario })).json()).models;
  assert.deepEqual(modelos.map(m => m.id), ['silla-1']);
  assert.ok(!('data' in modelos[0]));
  assert.equal((await (await llamar(env, '/api/catalogo/modelo/silla-1', { token: usuario })).json()).data, 'AAAA');
});

test('listados paginados: se leen todas las páginas del KV', async () => {
  const kv = kvMemoria(), env = entorno(kv);
  for (let i = 0; i < 1005; i++) await kv.put('product:p' + String(i).padStart(4, '0'), JSON.stringify({ id: 'p' + i, nombre: 'P' }));
  const productos = (await (await llamar(env, '/api/catalogo/productos', { token: usuario })).json()).products;
  assert.equal(productos.length, 1005);
});
