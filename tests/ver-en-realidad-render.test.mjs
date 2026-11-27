// Ver en Realidad · botones 360° y Foto: funcionan directamente desde la vista en vivo, con la posición y orientación
// actuales de la cámara, reutilizan el motor si la cámara no cambió y nunca dejan dos motores vivos. Cancelar, Seguir,
// Cerrar render y Generar render se conservan. Aviso discreto cuando el navegador pausa el render en segundo plano.
// El motor de path tracing real (three 0.163 desde CDN) no se carga en el arnés: se sustituye por un doble que
// registra creaciones, llamadas y liberaciones.
// Ejecutar: node --test tests/ver-en-realidad-render.test.mjs   (Chrome en CHROME_BIN)
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, abrirReal, entrarAlEditor } from './harness/real-harness.mjs';
import { prepararProyecto } from './harness/glb-prueba.mjs';

let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }); });
test.after(async () => { await browser?.close(); });

async function verEnRealidad() {
  const s = await abrirReal(browser);
  await entrarAlEditor(s.page);
  await prepararProyecto(s.page, [1, 1, 3]);
  await s.page.evaluate(async () => {
    $('#sq').value = 'm'; setQ(); realMode();
    window.__motores = [];
    window.__vivos = () => __motores.filter(m => !m.liberado).length;
    window.__maxVivos = 0;
    window.__fallar = false;
    window.RENDER_ENGINE = { createRender: async (contenedor, j, opt, cb) => {
      await new Promise(ok => setTimeout(ok, 80));               // carga asíncrona como la real
      if (__fallar) throw new Error('fallo simulado');
      const m = { cam: j.cam, modo: opt.mode, cb, llamadas: [], liberado: false, gpu: 'GPU de prueba', state: 'renderizando', warnings: [], samples: 0,
        pano() { m.llamadas.push('pano'); m.state = 'renderizando'; }, photo() { m.llamadas.push('foto'); m.state = 'renderizando'; },
        cancel() { m.llamadas.push('cancelar'); m.state = 'cancelado'; }, resume() { m.llamadas.push('seguir'); m.state = 'renderizando'; },
        save() {}, setExposure() {}, setKelvin() {}, setLight() {}, setLens() {}, dispose() { m.liberado = true; } };
      __motores.push(m); __maxVivos = Math.max(__maxVivos, __vivos());
      cb({ state: 'renderizando', samples: 0, target: 64 });
      return m;
    } };
    window.__boton = texto => [...document.querySelectorAll('.nuhio-render-actions button')].find(b => b.textContent.includes(texto));
    window.__pulsar = texto => { __boton(texto).click(); document.activeElement?.blur(); };
    window.__esperar = ms => new Promise(ok => setTimeout(ok, ms));
    // Espera a que se cree un motor nuevo (exportar la escena tarda) y un margen para detectar motores de más.
    window.__esperarMotor = async () => { const n = __motores.length, t = performance.now(); while (__motores.length === n && performance.now() - t < 8000) await __esperar(20); await __esperar(300); };
    window.__resumen = () => __motores.map(m => ({ cam: JSON.stringify(m.cam), modo: m.modo, llamadas: m.llamadas.join(','), liberado: m.liberado }));
  });
  return s;
}
// Mueve la cámara de Ver en Realidad con el teclado (como el usuario) hasta que cambie de posición.
async function moverCamara(page) {
  for (const tecla of ['s', 's', 'a', 'a']) await page.keyboard.press(tecla);
}

test('360° y Foto desde la vista en vivo sin render previo, con la cámara actual y sin motores duplicados', { timeout: 180000 }, async () => {
  const s = await verEnRealidad();
  const p = s.page;
  // 360° directamente: crea un motor que nace en panorama (sin pasar por foto ni recompilar).
  await p.evaluate(async () => { __pulsar('360°'); await __esperarMotor(); });
  let r = await p.evaluate(() => __resumen());
  assert.equal(r.length, 1, '360° crea un motor sin render previo');
  assert.equal(r[0].modo, 'pano', 'el motor se crea directamente en panorama');
  assert.equal(r[0].llamadas, '', 'sin cambio de modo posterior');
  // Mismo punto de vista: 360° y Foto reutilizan el motor.
  await p.evaluate(async () => { __pulsar('360°'); __pulsar('Foto'); await __esperar(200); });
  r = await p.evaluate(() => __resumen());
  assert.equal(r.length, 1, 'con la cámara quieta no se crea otro motor');
  assert.equal(r[0].llamadas, 'pano,foto');
  // Cancelar y Seguir se conservan.
  await p.evaluate(async () => { __pulsar('Cancelar'); __pulsar('Seguir'); await __esperar(100); });
  assert.equal((await p.evaluate(() => __resumen()))[0].llamadas, 'pano,foto,cancelar,seguir');
  // Cancelar, cerrar, mover la cámara y pulsar 360°: motor nuevo con la posición nueva; el anterior, liberado.
  await p.evaluate(async () => { __pulsar('Cancelar'); __pulsar('Cerrar render'); await __esperar(100); });
  await moverCamara(p);
  await p.evaluate(async () => { __pulsar('360°'); await __esperarMotor(); });
  r = await p.evaluate(() => __resumen());
  assert.equal(r.length, 2, 'tras mover la cámara se crea un motor nuevo');
  assert.ok(r[0].liberado, 'el motor anterior se libera');
  assert.notEqual(r[1].cam, r[0].cam, 'el panorama usa la posición y orientación actuales');
  assert.equal(r[1].modo, 'pano');
  assert.equal(r[1].llamadas, '');
  // Foto tras mover la cámara: también motor nuevo, en modo foto (sin pasar por panorama).
  await p.evaluate(async () => { __pulsar('Cerrar render'); await __esperar(50); });
  await moverCamara(p);
  await p.evaluate(async () => { __pulsar('Foto'); await __esperarMotor(); });
  r = await p.evaluate(() => __resumen());
  assert.equal(r.length, 3);
  assert.ok(r[1].liberado);
  assert.notEqual(r[2].cam, r[1].cam, 'la foto usa la posición actual');
  assert.equal(r[2].modo, 'foto');
  assert.equal(r[2].llamadas, '', 'la foto arranca directamente en modo foto');
  // Generar render se conserva: sustituye el motor (libera el anterior).
  await p.evaluate(async () => { __pulsar('Generar render'); await __esperarMotor(); });
  r = await p.evaluate(() => __resumen());
  assert.equal(r.length, 4);
  assert.ok(r[2].liberado && !r[3].liberado);
  assert.equal(r[3].modo, 'foto');
  assert.equal(await p.evaluate(() => __maxVivos), 1, 'nunca hay dos motores vivos a la vez');
  assert.deepEqual(s.errores.filter(e => !e.startsWith('dialog:')), []);
  await s.ctx.close();
});

test('pulsaciones rápidas durante la carga y reapertura de Ver en Realidad: un solo motor vivo', { timeout: 180000 }, async () => {
  const s = await verEnRealidad();
  const p = s.page;
  // 360° y Foto antes de que termine de cargarse el motor: uno solo, con el último modo pedido.
  await p.evaluate(async () => { __pulsar('360°'); __pulsar('Foto'); __pulsar('360°'); __pulsar('Foto'); await __esperarMotor(); });
  let r = await p.evaluate(() => __resumen());
  assert.equal(r.length, 1, 'las pulsaciones durante la carga no crean motores extra');
  assert.equal(r[0].modo, 'foto', 'se crea con el último modo pedido (Foto)');
  assert.equal(r[0].llamadas, '', 'sin cambios de modo extra');
  // Cerrar durante la carga: el motor que llega tarde se libera y no se muestra.
  await p.evaluate(async () => { __pulsar('Cerrar render'); __pulsar('360°'); __pulsar('Cerrar render'); await __esperar(2500); });
  r = await p.evaluate(() => __resumen());
  assert.ok(r.every(m => m.liberado), 'tras cerrar no queda ningún motor vivo');
  // Salir y volver a entrar en Ver en Realidad: 360° funciona a la primera.
  await p.evaluate(async () => { document.querySelector('.nuhio-render-exit').click(); await __esperar(200); realMode(); await __esperar(200); });
  await p.evaluate(async () => { __pulsar('360°'); await __esperarMotor(); });
  r = await p.evaluate(() => __resumen());
  assert.equal(r.at(-1).modo, 'pano', 'tras reabrir, 360° funciona directamente');
  assert.equal(r.filter(m => !m.liberado).length, 1);
  await p.evaluate(async () => { document.querySelector('.nuhio-render-exit').click(); await __esperar(200); });
  assert.ok((await p.evaluate(() => __resumen())).every(m => m.liberado), 'al salir se libera el motor');
  assert.equal(await p.evaluate(() => __maxVivos), 1);
  assert.deepEqual(s.errores.filter(e => !e.startsWith('dialog:')), []);
  await s.ctx.close();
});

test('aviso de render en pausa: aparece al ocultarse la página mientras renderiza y se retira al volver', { timeout: 180000 }, async () => {
  const s = await verEnRealidad();
  const r = await s.page.evaluate(async () => {
    let oculta = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => oculta });
    const cambiar = v => { oculta = v; document.dispatchEvent(new Event('visibilitychange')); };
    const aviso = () => document.querySelector('.nuhio-render-paused');
    const estado = () => ({ visible: !aviso().hidden, titulo: document.title.startsWith('⏸') });
    const res = {};
    cambiar(true); res.ocultaSinRender = estado(); cambiar(false);
    __pulsar('Generar render'); await __esperarMotor();
    cambiar(true); res.ocultaRenderizando = estado();
    cambiar(false); res.vuelta = estado();
    __pulsar('Cancelar'); cambiar(true); res.ocultaCancelado = estado(); cambiar(false);
    __pulsar('Seguir'); cambiar(true); __pulsar('Cerrar render'); res.cerradoOculta = estado(); cambiar(false);
    __pulsar('360°'); await __esperarMotor(); cambiar(true);
    document.querySelector('.nuhio-render-exit').click(); res.salirOculta = { titulo: document.title.startsWith('⏸') };
    cambiar(false);
    return res;
  });
  assert.deepEqual(r.ocultaSinRender, { visible: false, titulo: false }, 'sin render no hay aviso');
  assert.deepEqual(r.ocultaRenderizando, { visible: true, titulo: true }, 'renderizando y oculta: aviso y título');
  assert.deepEqual(r.vuelta, { visible: false, titulo: false }, 'al volver se retira');
  assert.deepEqual(r.ocultaCancelado, { visible: false, titulo: false }, 'cancelado: no hay nada en pausa');
  assert.deepEqual(r.cerradoOculta, { visible: false, titulo: false }, 'cerrar el render retira el aviso');
  assert.deepEqual(r.salirOculta, { titulo: false }, 'salir de Ver en Realidad restaura el título');
  assert.deepEqual(s.errores.filter(e => !e.startsWith('dialog:')), []);
  await s.ctx.close();
});

test('estados visibles: preparación, compilación, renderizado, cancelado, listo y error', { timeout: 180000 }, async () => {
  const s = await verEnRealidad();
  const r = await s.page.evaluate(async () => {
    const pm = [...document.querySelectorAll('.nuhio-render-actions [role=status]')].find(e => !e.classList.contains('nuhio-render-paused'));
    const pg = document.querySelector('.nuhio-render-actions progress');
    const ver = () => ({ texto: pm.textContent, estado: pm.dataset.state, barraIndeterminada: !pg.hasAttribute('value') });
    const res = {};
    __pulsar('360°'); await __esperar(0); res.preparando = ver();
    await __esperarMotor(); const m = __motores.at(-1);
    m.cb({ state: 'renderizando', samples: 0, target: 64, compiling: true, mode: 'pano' }); res.compilando = ver();
    m.cb({ state: 'renderizando', samples: 0, target: 64, compiling: false, mode: 'pano' }); res.primeraMuestra = ver();
    m.cb({ state: 'renderizando', samples: 3, target: 64, compiling: false, mode: 'pano' }); res.renderizando = ver();
    m.cb({ state: 'cancelado', samples: 3, target: 64 }); res.cancelado = ver();
    m.cb({ state: 'listo', samples: 64, target: 64, mode: 'pano' }); res.listo = ver();
    res.gpu = [...document.querySelectorAll('.nuhio-render-card')].some(c => c.textContent.includes('GPU: GPU de prueba'));
    __pulsar('Cerrar render'); __fallar = true; __pulsar('Generar render'); await __esperar(2500); res.error = ver();
    return res;
  });
  assert.match(r.preparando.texto, /Preparando la escena/); assert.ok(r.preparando.barraIndeterminada);
  assert.ok(r.compilando.texto.startsWith('Compilando el motor de render (panorama 360°)'), r.compilando.texto); assert.equal(r.compilando.estado, 'compilando'); assert.ok(r.compilando.barraIndeterminada);
  assert.match(r.primeraMuestra.texto, /Preparando la primera muestra/); assert.ok(r.primeraMuestra.barraIndeterminada);
  assert.equal(r.renderizando.texto, 'Renderizando panorama 360° · 3 / 64 muestras'); assert.ok(!r.renderizando.barraIndeterminada);
  assert.ok(r.cancelado.texto.startsWith('Cancelado · 3 / 64 muestras · pulsa «Seguir»'), r.cancelado.texto); assert.equal(r.cancelado.estado, 'cancelado');
  assert.equal(r.listo.texto, 'Listo · 64 / 64 muestras');
  assert.ok(r.gpu, 'la tarjeta del render indica la GPU usada');
  assert.match(r.error.texto, /No se pudo iniciar el render: fallo simulado/); assert.equal(r.error.estado, 'error'); assert.ok(!r.error.barraIndeterminada);
  await s.ctx.close();
});
