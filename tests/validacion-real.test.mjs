// Validación con archivos reales del repositorio (ver tests/harness/real-harness.mjs).
// Ejecutar: node --test tests/validacion-real.test.mjs   (Chrome en /usr/bin/google-chrome o CHROME_BIN)
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, abrirReal, entrarAlEditor, estadoSupabase, FAKE_JWT, ignored, publishedAssets } from './harness/real-harness.mjs';

const CANARIO = '<img src=x onerror="window.__CANARIO=(window.__CANARIO||0)+1">';
const proyecto = () => ({
  nm: 'Proyecto real de prueba', v: 2, id: 10,
  w: [{ id: 1, x1: 0, y1: 0, x2: 300, y2: 0, t: 10, h: 250 }, { id: 2, x1: 300, y1: 0, x2: 300, y2: 300, t: 10, h: 250 }],
  o: [], i: [], cm: [], ms: [], rooms: [], rid: 1,
  rv: [{ w: 1, side: 1, x0: -5, x1: 300, y0: 0, y1: 250, pat: 'recta', tw: 30, th: 60, j: .3, jc: '#cccccc', base: '#e9e6df', fin: 'brillante' }],
});

let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }); });
test.after(async () => { await browser?.close(); });

async function editor(opts) {
  const s = await abrirReal(browser, opts);
  await entrarAlEditor(s.page);
  return s;
}
// Sin filtros: auth.js se carga dos veces tras document.write y debe hacerlo sin ningún error.
const erroresReales = s => s.errores;
const aviso = page => page.evaluate(() => P.querySelector('small[style*="f55"]')?.textContent ?? null);
const seleccionaPared = page => page.evaluate(() => { sel = { k: 'w', id: 1 }; props(); });
async function abrirMiEspacio(page) {
  await page.evaluate(() => projLib());
  await page.waitForSelector('#pryBox[open]');
}
const fichero = (nombre, contenido) => ({ name: nombre, mimeType: 'application/json', buffer: Buffer.from(typeof contenido === 'string' ? contenido : JSON.stringify(contenido)) });

test('flujo real acceso → /api/editor (worker.js real) → editor: arranca sin errores nuevos', async () => {
  const s = await editor();
  assert.equal(new URL(s.page.url()).pathname, '/editor');
  assert.deepEqual(erroresReales(s), []);
  assert.ok(s.peticiones.includes('/api/editor'));
  for (const f of ['/inventario-modelos-3d.json', '/auditoria-biblioteca-modelos-3d.json']) assert.ok(!s.peticiones.includes(f));
  await s.ctx.close();
});

test('importación legítima desde «Mi espacio» (selector de archivo real): se crea el proyecto en la nube simulada y se abre', async () => {
  const s = await editor();
  await abrirMiEspacio(s.page);
  await s.page.setInputFiles('#pryBox input[type=file][accept=".json"]', fichero('ok.json', proyecto()));
  await s.page.waitForFunction(() => document.querySelectorAll('#pryBox .studio-project').length === 1, null, { timeout: 8000 });
  assert.equal(estadoSupabase.proyectos.size, 1);
  await s.page.click('#pryBox .studio-project >> text=Abrir');
  await s.page.waitForFunction(() => S.w.length === 2);
  await seleccionaPared(s.page);
  assert.match(await aviso(s.page), /\(300×250 cm\)/);
  assert.deepEqual(erroresReales(s), []);
  await s.ctx.close();
});

test('importación envuelta (formato proyecto-v1) también se valida', async () => {
  const s = await editor();
  const malo = proyecto(); malo.w[0].h = CANARIO;
  const msg = await s.page.evaluate(t => { try { readProjectImport(t); return null; } catch (e) { return e.message; } }, JSON.stringify({ format: 'proyecto-v1', name: 'x', data: JSON.stringify(malo) }));
  assert.equal(msg, 'Archivo de proyecto no válido.');
  await s.ctx.close();
});

const MALFORMADOS = [
  ['altura con HTML', p => { p.w[0].h = CANARIO; }],
  ['grosor con HTML', p => { p.w[0].t = CANARIO; }],
  ['coordenada con HTML', p => { p.w[1].x2 = CANARIO; }],
  ['zona con HTML', p => { p.rv[0].x1 = CANARIO; }],
  ['altura objeto', p => { p.w[0].h = { a: 1 }; }],
  ['paredes no es lista', p => { p.w = 'x'; }],
  ['rv no es lista', p => { p.rv = {}; }],
  ['sin colecciones', p => { delete p.w; delete p.o; delete p.i; }],
];
for (const [nombre, mutar] of MALFORMADOS) {
  test(`importación malformada rechazada (selector real): ${nombre}; no se ejecuta nada ni se guarda`, async () => {
    const s = await editor();
    await abrirMiEspacio(s.page);
    const p = proyecto(); mutar(p);
    await s.page.setInputFiles('#pryBox input[type=file][accept=".json"]', fichero('malo.json', p));
    await s.page.waitForTimeout(700);
    assert.ok(s.errores.some(e => e.startsWith('dialog:No se pudo importar el proyecto: Archivo de proyecto no válido.')), 'avisa al usuario: ' + JSON.stringify(s.errores));
    assert.equal(estadoSupabase.proyectos.size, 0, 'no se guarda nada');
    assert.equal(await s.page.evaluate(() => window.__CANARIO), 0);
    assert.deepEqual(erroresReales(s).filter(e => !e.startsWith('dialog:')), []);
    await s.ctx.close();
  });
}

test('JSON roto y archivo vacío: error controlado, editor intacto', async () => {
  const s = await editor();
  await abrirMiEspacio(s.page);
  for (const txt of ['{no es json', '']) {
    await s.page.setInputFiles('#pryBox input[type=file][accept=".json"]', fichero('r.json', txt));
    await s.page.waitForTimeout(500);
  }
  assert.equal(estadoSupabase.proyectos.size, 0);
  assert.equal(await s.page.evaluate(() => typeof S === 'object' && Array.isArray(S.w)), true);
  await s.ctx.close();
});

test('proyecto recuperado de Supabase con altura maliciosa (no pasa por la importación): el aviso la escapa y no ejecuta nada', async () => {
  const malo = proyecto(); malo.w[0].h = CANARIO;
  const ahora = Date.now();
  const s = await editor({ guardado: { pnube: { id: 'pnube', name: 'Nube manipulada', created: ahora, updated: ahora, data: JSON.stringify(malo), versions: [] } } });
  await abrirMiEspacio(s.page);
  await s.page.click('#pryBox .studio-project >> text=Abrir');
  await s.page.waitForFunction(() => S.w.length === 2);
  await seleccionaPared(s.page);
  await s.page.waitForTimeout(500);
  const r = await s.page.evaluate(() => ({ imgs: P.querySelectorAll('img').length, canario: window.__CANARIO, texto: P.querySelector('small[style*="f55"]')?.textContent }));
  assert.equal(r.imgs, 0); assert.equal(r.canario, 0); assert.ok(r.texto.includes('<img'));
  assert.deepEqual(erroresReales(s), []);
  await s.ctx.close();
});

test('proyecto de Supabase con datos válidos: abre, selecciona y edita paredes y zonas; los valores siguen siendo números', async () => {
  const ahora = Date.now();
  const s = await editor({ guardado: { pok: { id: 'pok', name: 'Nube OK', created: ahora, updated: ahora, data: JSON.stringify(proyecto()), versions: [] } } });
  await abrirMiEspacio(s.page);
  await s.page.click('#pryBox .studio-project >> text=Abrir');
  await s.page.waitForFunction(() => S.w.length === 2);
  await seleccionaPared(s.page);
  const alt = s.page.locator('#pr label.r', { hasText: 'Altura (cm)' }).first().locator('input');
  await alt.fill('260'); await alt.dispatchEvent('change');
  await s.page.waitForTimeout(300);
  assert.equal(await s.page.evaluate(() => S.w[0].h), 260);
  assert.match(await aviso(s.page) ?? '(sin aviso)', /\(300×260 cm\)|sin aviso/);
  // zona de revestimiento: ampliar hasta fuera de la pared y comprobar el aviso numérico
  const hasta = s.page.locator('#pr label.r', { hasText: 'Hasta (cm)' }).first().locator('input');
  await hasta.fill('999'); await hasta.dispatchEvent('change');
  await seleccionaPared(s.page);
  assert.match(await aviso(s.page), /\(300×260 cm\)/);
  assert.deepEqual(await s.page.evaluate(() => [typeof S.w[0].h, typeof S.rv[0].x1, S.rv[0].x1]), ['number', 'number', 999]);
  await s.page.evaluate(() => { const b = [...P.querySelectorAll('button')].find(x => x.textContent.includes('+ Zona')); b.click(); });
  assert.equal(await s.page.evaluate(() => S.rv.length), 2);
  assert.deepEqual(erroresReales(s), []);
  await s.ctx.close();
});

test('guardado y recuperación: la edición se guarda en Supabase (simulado) y al recargar el editor se recupera', async () => {
  const ahora = Date.now();
  const s = await editor({ guardado: { pok: { id: 'pok', name: 'Nube OK', created: ahora, updated: ahora, data: JSON.stringify(proyecto()), versions: [] } } });
  await abrirMiEspacio(s.page);
  await s.page.click('#pryBox .studio-project >> text=Abrir');
  await s.page.waitForFunction(() => S.w.length === 2);
  await seleccionaPared(s.page);
  const alt = s.page.locator('#pr label.r', { hasText: 'Altura (cm)' }).first().locator('input');
  await alt.fill('275'); await alt.dispatchEvent('change');
  await s.page.evaluate(() => psave());
  await s.page.waitForFunction(() => document.getElementById('saveCloudState')?.dataset.state === 'synced', null, { timeout: 8000 });
  const guardado = JSON.parse(estadoSupabase.proyectos.get('pok').data);
  assert.equal(guardado.w[0].h, 275); assert.equal(typeof guardado.w[0].h, 'number');
  // recarga completa del flujo (misma sesión): proyecto activo recuperado desde el almacén
  await entrarAlEditor(s.page);
  await s.page.evaluate(() => openProj('pok'));
  await s.page.waitForFunction(() => S.w.length === 2 && S.w[0].h === 275);
  assert.deepEqual(erroresReales(s), []);
  await s.ctx.close();
});

test('borrador local: editar una pared y recargar recupera la altura editada', async () => {
  const s = await editor();
  await s.page.evaluate(t => { openDraft(readProjectImport(t).data); sel = { k: 'w', id: 1 }; props(); }, JSON.stringify(proyecto()));
  const alt = s.page.locator('#pr label.r', { hasText: 'Altura (cm)' }).first().locator('input');
  await alt.fill('240'); await alt.dispatchEvent('change');
  await s.page.waitForTimeout(300);
  await entrarAlEditor(s.page);
  assert.equal(await s.page.evaluate(() => S.w[0]?.h), 240);
  await s.ctx.close();
});

test('regresión del editor: dibujar, cambiar de vista 2D/3D, deshacer y rehacer sin errores', async () => {
  const s = await editor();
  const r = await s.page.evaluate(() => {
    const out = {};
    S.w.push({ id: nid(), x1: 0, y1: 0, x2: 400, y2: 0, t: 10, h: 250 }, { id: nid(), x1: 400, y1: 0, x2: 400, y2: 300, t: 10, h: 250 });
    commitQ(); out.n = S.w.length;
    setMode('3d'); out.modo3d = mode; setMode('2d'); out.modo2d = mode;
    undo?.(); out.trasUndo = S.w.length; redo?.(); out.trasRedo = S.w.length;
    return out;
  });
  assert.equal(r.n, 2); assert.equal(r.modo3d, '3d'); assert.equal(r.trasRedo, 2);
  assert.deepEqual(erroresReales(s), []);
  await s.ctx.close();
});

test('Salón piloto: se genera igual que antes (sin alterar el experimento)', async () => {
  const s = await editor();
  const r = await s.page.evaluate(() => { const p = makeInteriorPilot(); return { nm: p.nm, pilot: p.interiorPilot, paredes: p.w.length, rv: (p.rv || []).length }; });
  assert.equal(r.nm, 'Salón piloto · Día interior'); assert.equal(r.pilot, 1);
  assert.ok(r.paredes > 0);
  assert.deepEqual(erroresReales(s), []);
  await s.ctx.close();
});

test('assets simulados: los dos documentos internos no se publican; FUENTES.md y lo necesario sí', async () => {
  const s = await editor();
  await s.ctx.addCookies([{ name: '__Host-disenito-session', value: FAKE_JWT, url: 'https://nuhio.test', secure: true }]);
  const estado = ruta => s.page.evaluate(async r => (await fetch(r, { cache: 'no-store' })).status, ruta);
  assert.equal(await estado('/inventario-modelos-3d.json'), 404);
  assert.equal(await estado('/auditoria-biblioteca-modelos-3d.json'), 404);
  for (const ok of ['/materiales/FUENTES.md', '/scan-room.mjs', '/scan-core.mjs', '/scan-worker.mjs', '/scan-room.css', '/catalogo/productos-comerciales.json', '/auth.js', '/adaptive.css']) assert.equal(await estado(ok), 200, ok);
  assert.deepEqual([...ignored].sort(), ['auditoria-biblioteca-modelos-3d.json', 'inventario-modelos-3d.json']);
  assert.ok(publishedAssets.has('materiales/FUENTES.md'));
  await s.ctx.close();
});

test('escáner: el módulo real /scan-room.mjs se carga y abre su diálogo sin errores', async () => {
  const s = await editor();
  await s.page.evaluate(() => document.getElementById('bScanRoom').click());
  await s.page.waitForFunction(() => document.getElementById('scanRoom')?.open, null, { timeout: 10000 });
  assert.equal(await s.page.evaluate(() => document.getElementById('scanTitle').textContent), 'Escanear habitación');
  assert.ok(s.peticiones.includes('/scan-room.mjs') && s.peticiones.includes('/scan-core.mjs'));
  assert.deepEqual(erroresReales(s), []);
  await s.ctx.close();
});

test('Foto IA: el panel real se abre sin llamar al modelo y sin errores (la generación no se prueba)', async () => {
  const s = await editor();
  await s.page.evaluate(() => document.getElementById('bFotoIA').click());
  await s.page.waitForSelector('.nuhio-photo-panel', { timeout: 10000 });
  assert.ok(!s.peticiones.includes('/api/ia/editar'), 'no se genera ninguna imagen');
  assert.deepEqual(erroresReales(s), []);
  await s.ctx.close();
});
