// Regresión: XSS por importación de proyectos (zona de revestimiento fuera de la pared, e.h sin escapar).
// Ejecutar: NUHIO_VENDOR_DIR=<dir con three.min.js 0.128> node --test tests/seguridad-importacion.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, abrirEditor } from './harness/nuhio-harness.mjs';
import { CANARIO, proyectoBase } from './harness/payloads.mjs';

let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] }); });
test.after(async () => { await browser?.close(); });

async function sesion() {
  const s = await abrirEditor(browser);
  await s.page.waitForTimeout(600);
  return s;
}
const fuera = () => { const p = proyectoBase(); p.rv[0].x0 = -5; return p; };

test('el editor arranca sin errores y sin salir a la red', async () => {
  const { page, errores, bloqueadas, ctx } = await sesion();
  assert.deepEqual(errores, []);
  assert.equal(await page.evaluate(() => typeof openDraft), 'function');
  assert.ok(bloqueadas.every(u => new URL(u).hostname === 'images.pexels.com'), 'solo se intentan imágenes de catálogo: ' + bloqueadas);
  await ctx.close();
});

test('importación legítima: se conserva el proyecto y el aviso muestra medidas numéricas', async () => {
  const { page, ctx } = await sesion();
  const r = await page.evaluate(txt => {
    openDraft(readProjectImport(txt).data); sel = { k: 'w', id: 1 }; props();
    return { paredes: S.w.length, aviso: P.querySelector('small[style*="f55"]')?.textContent, tipoH: typeof S.w[0].h };
  }, JSON.stringify(fuera()));
  assert.equal(r.paredes, 2);
  assert.equal(r.tipoH, 'number');
  assert.match(r.aviso, /\(300×250 cm\)/);
  await ctx.close();
});

for (const [campo, valor] of [['h', CANARIO], ['t', CANARIO], ['x1', CANARIO], ['h', 'abc'], ['h', {}], ['h', [1]], ['h', true], ['h', 'Infinity']]) {
  test(`importación rechaza pared.${campo} no numérico: ${JSON.stringify(valor).slice(0, 30)}`, async () => {
    const { page, ctx } = await sesion();
    const p = fuera(); p.w[0][campo] = valor;
    const msg = await page.evaluate(txt => { try { readProjectImport(txt); return null; } catch (e) { return e.message; } }, JSON.stringify(p));
    assert.equal(msg, 'Archivo de proyecto no válido.');
    await ctx.close();
  });
}

test('importación rechaza zona.x0 no numérica y rv no array', async () => {
  const { page, ctx } = await sesion();
  const a = fuera(); a.rv[0].x0 = CANARIO;
  const b = fuera(); b.rv = 'x';
  for (const p of [a, b]) {
    const msg = await page.evaluate(txt => { try { readProjectImport(txt); return null; } catch (e) { return e.message; } }, JSON.stringify(p));
    assert.equal(msg, 'Archivo de proyecto no válido.');
  }
  await ctx.close();
});

test('cadenas numéricas se normalizan a número', async () => {
  const { page, ctx } = await sesion();
  const p = fuera(); p.w[0].h = '250'; p.rv[0].x1 = ' 300 ';
  const r = await page.evaluate(txt => { const d = JSON.parse(readProjectImport(txt).data); return [d.w[0].h, d.rv[0].x1]; }, JSON.stringify(p));
  assert.deepEqual(r, [250, 300]);
  await ctx.close();
});

test('defensa en profundidad: aunque el estado llegue sin validar (nube/borrador), el aviso escapa el valor y no ejecuta nada', async () => {
  const { page, ctx, errores } = await sesion();
  const p = fuera(); p.w[0].h = CANARIO;
  const r = await page.evaluate(txt => {
    window.__CANARIO = 0; openDraft(txt); sel = { k: 'w', id: 1 }; props();   // openDraft directo: salta readProjectImport
    return { imgs: P.querySelectorAll('img').length, texto: P.querySelector('small[style*="f55"]')?.textContent };
  }, JSON.stringify(p));
  await page.waitForTimeout(400);
  assert.equal(r.imgs, 0);
  assert.ok(r.texto.includes('<img'), 'el texto se muestra literal, escapado');
  assert.equal(await page.evaluate(() => window.__CANARIO || 0), 0);
  assert.deepEqual(errores, []);
  await ctx.close();
});
