// Archivo de verificación de Google Search Console: público sin sesión, solo él, sin ampliar el acceso a nada más.
// Se sirve como asset estático (exclusión exacta en run_worker_first); el resto de rutas sigue pasando por el Worker.
// Ejecutar: node --test tests/verificacion-google.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, publishedAssets, llamarWorker } from './harness/real-harness.mjs';

const ARCHIVO = 'google1b21e3143523d810.html';
const CONTENIDO = 'google-site-verification: google1b21e3143523d810.html';   // tal como lo descarga Google (53 bytes, sin salto final)
const wrangler = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
const reglas = wrangler.assets.run_worker_first;
// Misma semántica que Cloudflare: las exclusiones «!» prevalecen sobre las inclusiones.
const glob = g => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const pasaPorWorker = ruta => { let si = false; for (const r of reglas) { if (r.startsWith('!')) { if (glob(r.slice(1)).test(ruta)) return false; } else if (glob(r).test(ruta)) si = true; } return si; };

test('el archivo se publica con el contenido exacto descargado de Google', () => {
  const bytes = readFileSync(join(root, 'disenador-web', ARCHIVO));
  assert.equal(bytes.toString('utf8'), CONTENIDO);
  assert.equal(bytes.length, 53);
  assert.ok(publishedAssets.has(ARCHIVO), 'forma parte de los assets (no lo excluye .assetsignore)');
});

test('solo esa ruta exacta se sirve sin pasar por el Worker; no se amplía el acceso a nada más', () => {
  assert.equal(reglas.filter(r => r === '!/' + ARCHIVO).length, 1);
  assert.equal(pasaPorWorker('/' + ARCHIVO), false);
  for (const r of reglas.filter(r => r.startsWith('!'))) assert.doesNotMatch(r, /\*.*\.html|google\*|\.html\*/, 'sin comodines que abran otros HTML: ' + r);
  for (const ruta of ['/', '/editor', '/index.html', '/acceso.html', '/google1b21e3143523d810.html.bak', '/google0000000000000000.html',
    '/sub/google1b21e3143523d810.html', '/inventario-modelos-3d.json', '/catalogo/productos-comerciales.json', '/api/editor'])
    assert.equal(pasaPorWorker(ruta), true, ruta + ' sigue protegida por el Worker');
});

test('sin sesión: el resto del sitio, incluido otro HTML de verificación inventado, sigue redirigiendo a /acceso', async () => {
  for (const ruta of ['/', '/editor', '/index.html', '/google0000000000000000.html']) {
    const r = await llamarWorker(ruta);
    assert.equal(r.status, 302, ruta); assert.equal(r.headers.get('location'), '/acceso', ruta);
  }
});
