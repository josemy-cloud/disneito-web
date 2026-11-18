// Compatibilidad de readProjectImport con proyectos antiguos y formatos históricos.
// Documenta el comportamiento actual (no lo cambia). Ejecutar:
//   NUHIO_VENDOR_DIR=<dir con three.min.js 0.128> node --test tests/compatibilidad-importacion.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, abrirEditor } from './harness/nuhio-harness.mjs';
import { proyectoBase } from './harness/payloads.mjs';

let browser, s;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  s = await abrirEditor(browser);
  await s.page.waitForTimeout(600);
});
test.after(async () => { await s?.ctx.close(); await browser?.close(); });

// Devuelve { ok, data } o { ok:false, error } sin abrir el proyecto.
const importar = texto => s.page.evaluate(t => {
  try { return { ok: true, data: JSON.parse(readProjectImport(t).data) }; } catch (e) { return { ok: false, error: e.message }; }
}, texto);
const NO_VALIDO = 'Archivo de proyecto no válido.';

test('valores ausentes: paredes y zonas sin medidas se aceptan y no se inventan campos', async () => {
  const p = proyectoBase();
  delete p.w[0].h; delete p.w[0].t; delete p.rv[0].y1;
  const r = await importar(JSON.stringify(p));
  assert.equal(r.ok, true);
  assert.equal('h' in r.data.w[0], false);
  assert.equal('t' in r.data.w[0], false);
  assert.equal('y1' in r.data.rv[0], false);
});

test('null (lo que produce JSON.stringify con NaN/Infinity) se acepta y se conserva', async () => {
  const p = proyectoBase();
  p.w[0].h = NaN; p.rv[0].x1 = Infinity;           // al serializar se convierten en null
  const r = await importar(JSON.stringify(p));
  assert.equal(r.ok, true);
  assert.equal(r.data.w[0].h, null);
  assert.equal(r.data.rv[0].x1, null);
});

test('cadenas numéricas (enteros, decimales, negativos, exponentes, espacios) se normalizan a número', async () => {
  const p = proyectoBase();
  Object.assign(p.w[0], { x1: '-12.5', y1: '0', x2: '3e2', t: ' 10 ', h: '250.0' });
  Object.assign(p.rv[0], { x0: '-5', y1: '1e2' });
  const r = await importar(JSON.stringify(p));
  assert.equal(r.ok, true);
  assert.deepEqual([r.data.w[0].x1, r.data.w[0].y1, r.data.w[0].x2, r.data.w[0].t, r.data.w[0].h], [-12.5, 0, 300, 10, 250]);
  assert.deepEqual([r.data.rv[0].x0, r.data.rv[0].y1], [-5, 100]);
});

test('medidas vacías ("" o solo espacios) se rechazan: el editor nunca las genera (row() guarda +valor → 0)', async () => {
  for (const v of ['', '   ']) {
    const a = proyectoBase(); a.w[0].h = v;
    const b = proyectoBase(); b.rv[0].x0 = v;
    assert.deepEqual(await importar(JSON.stringify(a)), { ok: false, error: NO_VALIDO });
    assert.deepEqual(await importar(JSON.stringify(b)), { ok: false, error: NO_VALIDO });
  }
});

test('el editor convierte un campo de medida vaciado en 0, no en cadena (por eso "" no aparece en exportaciones reales)', async () => {
  const r = await s.page.evaluate(() => {
    openDraft(JSON.stringify({ w: [{ id: 1, x1: 0, y1: 0, x2: 300, y2: 0, t: 10, h: 250 }], o: [], i: [] }));
    sel = { k: 'w', id: 1 }; props();
    const input = [...P.querySelectorAll('label.r')].find(l => l.textContent.startsWith('Altura (cm)'))?.querySelector('input');
    input.value = ''; input.onchange();
    return { h: S.w[0].h, tipo: typeof S.w[0].h };
  });
  assert.deepEqual(r, { h: 0, tipo: 'number' });
});

test('ida y vuelta: lo exportado con «Exportar» (JSON.stringify(S)) se vuelve a importar idéntico', async () => {
  const r = await s.page.evaluate(() => {
    openDraft(JSON.stringify({ nm: 'Ida y vuelta', w: [{ id: 1, x1: 0, y1: 0, x2: 300, y2: 0, t: 10, h: 250 }], o: [], i: [],
      rv: [{ w: 1, side: 1, x0: 0, x1: 300, y0: 0, y1: 250, pat: 'recta', tw: 30, th: 60, j: .3, jc: '#cccccc', base: '#e9e6df', fin: 'brillante' }] }));
    const exportado = JSON.stringify(S);
    return { exportado, reimportado: readProjectImport(exportado).data };
  });
  assert.deepEqual(JSON.parse(r.reimportado), JSON.parse(r.exportado));
});

test('formato envuelto proyecto-v1 de «Mi espacio» (data como cadena y como objeto)', async () => {
  const p = proyectoBase(); p.w[0].h = '260';
  const comoCadena = await importar(JSON.stringify({ format: 'proyecto-v1', name: 'Casa', data: JSON.stringify(p) }));
  const comoObjeto = await importar(JSON.stringify({ format: 'proyecto-v1', name: 'Casa', data: p }));
  for (const r of [comoCadena, comoObjeto]) { assert.equal(r.ok, true); assert.equal(r.data.w[0].h, 260); }
  const malo = proyectoBase(); malo.w[0].h = 'abc';
  assert.deepEqual(await importar(JSON.stringify({ format: 'proyecto-v1', name: 'x', data: JSON.stringify(malo) })), { ok: false, error: NO_VALIDO });
});

test('proyectos antiguos sin v, rv, rooms, ms, cm ni showMeasures se importan y migran al abrir', async () => {
  const antiguo = { nm: 'Antiguo', w: [{ id: 1, x1: 0, y1: 0, x2: 400, y2: 0, t: 10, h: 250 }], o: [], i: [] };
  assert.equal((await importar(JSON.stringify(antiguo))).ok, true);
  const r = await s.page.evaluate(t => { openDraft(readProjectImport(t).data); return { v: S.v, rooms: Array.isArray(S.rooms), ms: Array.isArray(S.ms), paredes: S.w.length }; }, JSON.stringify(antiguo));
  assert.deepEqual(r, { v: 2, rooms: true, ms: true, paredes: 1 });
});

test('proyectos solo con muebles (i) o solo con aperturas (o), sin paredes, siguen siendo válidos', async () => {
  assert.equal((await importar(JSON.stringify({ nm: 'Solo muebles', i: [] }))).ok, true);
  assert.equal((await importar(JSON.stringify({ nm: 'Solo aperturas', o: [] }))).ok, true);
});

test('rv: null o ausente se acepta; rv que no es lista de objetos se rechaza', async () => {
  const a = proyectoBase(); a.rv = null;
  const b = proyectoBase(); delete b.rv;
  const c = proyectoBase(); c.rv = [1, 2];
  assert.equal((await importar(JSON.stringify(a))).ok, true);
  assert.equal((await importar(JSON.stringify(b))).ok, true);
  assert.deepEqual(await importar(JSON.stringify(c)), { ok: false, error: NO_VALIDO });
});

test('solo se validan medidas de paredes y zonas: otros campos (nombre, colores, materiales) no cambian', async () => {
  const p = proyectoBase();
  p.w[0].mat = 'yeso'; p.w[0].col = '#ffffff'; p.rv[0].pat = 'espiga'; p.i = [{ id: 9, n: 'Sofá', x: '100', y: 50 }];
  const r = await importar(JSON.stringify(p));
  assert.equal(r.ok, true);
  assert.equal(r.data.w[0].mat, 'yeso'); assert.equal(r.data.rv[0].pat, 'espiga');
  assert.equal(r.data.i[0].x, '100', 'los muebles no se tocan (fuera del alcance de esta corrección)');
});
