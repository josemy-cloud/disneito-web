// GET /api/ia/estado: el análisis de catálogos PDF con IA solo existía en la antigua versión local de escritorio
// y no está implementado en la web. El Worker lo declara de forma explícita (antes: 404 «Ruta API no encontrada»)
// y el panel de PDF ya no remite a iniciar.bat, localhost ni config.json. Foto IA no cambia.
// Ejecutar: node --test tests/ia-estado.test.mjs   (Chrome en CHROME_BIN)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, abrirReal, entrarAlEditor, llamarWorker, crearUsuario, emitirSesion, reiniciarSupabase, root } from './harness/real-harness.mjs';

const MOTIVO = 'El análisis de PDF con IA todavía no está disponible en la versión web.';
test.beforeEach(() => reiniciarSupabase());

test('GET /api/ia/estado: exige sesión (token o cookie) y declara la funcionalidad como no disponible', async () => {
  crearUsuario('ia-usuario');
  const t = emitirSesion('ia-usuario').access_token;
  let r = await llamarWorker('/api/ia/estado');
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  for (const opciones of [{ headers: { Authorization: 'Bearer ' + t } }, { cookie: t }]) {
    r = await llamarWorker('/api/ia/estado', opciones);
    assert.equal(r.status, 200, JSON.stringify(Object.keys(opciones)));
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(await r.json(), { servicio: false, configurada: false, motivo: MOTIVO });
  }
  assert.equal((await llamarWorker('/api/ia/estado', { method: 'POST', headers: { Authorization: 'Bearer ' + t } })).status, 405);
  // Foto IA y el resto de /api/ siguen igual.
  assert.equal((await llamarWorker('/api/ia/estadisticas')).status, 401);
  assert.equal((await llamarWorker('/api/ia/analizar', { method: 'POST', headers: { Authorization: 'Bearer ' + t } })).status, 404, 'el análisis no se implementa');
  assert.equal((await llamarWorker('/api/no-existe')).status, 404);
});

test('el panel de PDF ya no remite a la antigua versión local', () => {
  const html = readFileSync(join(root, 'disenador-web', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /iniciar\.bat|localhost:8765|config\.json|LEEME\.txt/);
  assert.match(html, /todavía no está disponible en la versión web/);
});

test('editor real: /api/ia/estado responde 200 con sesión, el panel lo explica y no hay errores en la consola', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const s = await abrirReal(browser);
    const respuestas = [];
    s.page.on('response', r => { if (new URL(r.url()).pathname.startsWith('/api/')) respuestas.push(new URL(r.url()).pathname + ' ' + r.status()); });
    await entrarAlEditor(s.page);
    const ia = await s.page.waitForFunction(() => typeof IA === 'object' && IA && 'motivo' in IA && IA, null, { timeout: 15000 }).then(h => h.jsonValue());
    assert.deepEqual(ia, { servicio: false, configurada: false, motivo: MOTIVO });
    assert.ok(respuestas.includes('/api/ia/estado 200'), respuestas.join(', '));
    assert.ok(!respuestas.some(r => / (4|5)\d\d$/.test(r)), 'ninguna petición /api/ con error: ' + respuestas.join(', '));
    await s.page.evaluate(() => catUI());
    const texto = await s.page.evaluate(() => document.getElementById('cat').textContent);
    assert.match(texto, /Análisis con IA: no disponible\. El análisis de PDF con IA todavía no está disponible en la versión web\./);
    assert.doesNotMatch(texto, /iniciar\.bat|localhost|config\.json/);
    assert.deepEqual(s.errores, []);
    await s.ctx.close();
  } finally { await browser.close(); }
});
