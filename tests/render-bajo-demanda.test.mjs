// R1.2 · Renderizado bajo demanda: con la escena quieta no se dibuja; cualquier cambio (cámara, edición, carga
// asíncrona, sol, tamaño, interacción) vuelve a dibujar en el siguiente fotograma; durante las interacciones se dibuja
// cada fotograma. Cubre el editor 3D, la vista dual, las sombras, la vista previa de muebles y «Ver en Realidad».
// Ejecutar: node --test tests/render-bajo-demanda.test.mjs   (Chrome en CHROME_BIN)
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, abrirReal, entrarAlEditor } from './harness/real-harness.mjs';
import { prepararProyecto } from './harness/glb-prueba.mjs';

let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }); });
test.after(async () => { await browser?.close(); });

async function editor(tamano = [2, 1, 6]) {
  const s = await abrirReal(browser);
  await s.ctx.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    window.__raf = {}; window.__pendientes = {};
    window.requestAnimationFrame = cb => { const k = cb.name || 'anónima'; window.__pendientes[k] = (window.__pendientes[k] || 0) + 1; return raf(t => { window.__pendientes[k]--; window.__raf[k] = (window.__raf[k] || 0) + 1; cb(t); }); };
  });
  await entrarAlEditor(s.page);
  await prepararProyecto(s.page, tamano);
  await s.page.evaluate(() => {
    // En three r128 render() es propiedad de cada instancia: se envuelve cada renderer, también los que se creen después.
    window.__renders = new Map();
    const envolver = r => { if (!r || __renders.has(r)) return r; __renders.set(r, 0); const o = r.render; r.render = function () { __renders.set(r, __renders.get(r) + 1); return o.apply(this, arguments); }; return r; };
    envolver(r3); envolver(r4);
    const crear = window.createWebGLRenderer; window.createWebGLRenderer = function () { return envolver(crear.apply(this, arguments)); };
    window.__n = r => __renders.get(r) || 0;
    window.__esperar = ms => new Promise(ok => setTimeout(ok, ms));
    window.__fotogramas = n => new Promise(ok => { let i = 0; const f = () => ++i >= n ? ok() : requestAnimationFrame(f); requestAnimationFrame(f); });
    window.__modo = async m => { if (m === '2d') setMode('2d'); else if (m === 'dual') setMode('dual'); else { if (mode !== '3d' || dualView) setMode('3d'); $('#sq').value = m; setQ(); } await __fotogramas(2); };
    // Fotogramas (callbacks de animate) hasta el siguiente dibujo de r3 tras un cambio.
    window.__hastaDibujo = async (cambio, renderer = r3) => { await __esperar(400); const r0 = __n(renderer), a0 = __raf.animate || 0; await cambio(); for (let i = 0; i < 90; i++) { await new Promise(ok => requestAnimationFrame(ok)); if (__n(renderer) > r0) return (__raf.animate || 0) - a0; } return Infinity; };
  });
  return s;
}
const reposo = (page, ms = 2500, renderer = 'r3') => page.evaluate(async ([ms, renderer]) => { await __esperar(1500); const r = eval(renderer), a = __n(r), b = __raf.animate || 0; await __esperar(ms); return { dibujos: __n(r) - a, callbacks: (__raf.animate || 0) - b }; }, [ms, renderer]);

test('reposo: con la escena quieta no se dibuja en 3D materiales, Realista ni vista dual (el bucle sigue vivo y es único)', async () => {
  const s = await editor();
  for (const m of ['m', 'q', 'dual']) {
    await s.page.evaluate(m => __modo(m), m);
    const r = await reposo(s.page);
    assert.equal(r.dibujos, 0, `${m}: dibujos en reposo`);
    assert.ok(r.callbacks > 3, `${m}: el bucle de animate sigue activo (${r.callbacks})`);
    assert.equal(await s.page.evaluate(() => __pendientes.animate), 1, `${m}: un solo bucle de animate`);
  }
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('reactivación: cámara, edición, textura asíncrona, sol, tamaño, objetos añadidos y capas vuelven a dibujar al instante', async () => {
  const s = await editor();
  await s.page.evaluate(() => __modo('q'));
  const r = await s.page.evaluate(async () => ({
    camara: await __hastaDibujo(() => { cam.position.x += 15; }),
    edicion: await __hastaDibujo(() => { S.i[0].x += 3; commit(); }),
    textura: await __hastaDibujo(() => { let t = null; root.traverse(o => [].concat(o.material || []).forEach(m => { if (!t && m?.map) t = m.map; })); t.needsUpdate = true; }),
    material: await __hastaDibujo(() => { let m = null; root.traverse(o => { if (!m && o.isMesh && !Array.isArray(o.material)) m = o.material; }); m.needsUpdate = true; }),
    sol: await __hastaDibujo(() => { $('#sa').value = String((+$('#sa').value + 25) % 360); setSun(); }),
    tamano: await __hastaDibujo(() => { d3.style.width = (d3.clientWidth - 30) + 'px'; resize(); }),
    objeto: await __hastaDibujo(() => { root.add(new T.Mesh(new T.BoxGeometry(10, 10, 10), new T.MeshStandardMaterial())); }),
    sombrasInteriores: await __hastaDibujo(() => invalidateInteriorShadows()),
  }));
  for (const [k, v] of Object.entries(r)) assert.ok(v <= 2, `${k}: se dibuja en ≤2 fotogramas (fueron ${v})`);
  await s.page.evaluate(() => { d3.style.width = ''; resize(); });
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('interacción: durante el arrastre de la cámara se dibuja en cada fotograma, y al soltar vuelve al reposo', async () => {
  const s = await editor();
  await s.page.evaluate(() => __modo('m')); await s.page.waitForTimeout(1500);
  const c = await s.page.evaluate(() => { const r = r3.domElement.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  // La ventana de medida queda dentro del arrastre (antes de pulsar no hay nada que dibujar).
  await s.page.mouse.move(c.x, c.y); await s.page.mouse.down(); await s.page.mouse.move(c.x + 5, c.y);
  const a = await s.page.evaluate(() => ({ d: __n(r3), c: __raf.animate }));
  for (let i = 0; i < 60; i++) { await s.page.mouse.move(c.x + 100 * Math.sin(i / 5), c.y + 30 * Math.cos(i / 7)); await s.page.waitForTimeout(16); }
  const b = await s.page.evaluate(() => ({ d: __n(r3), c: __raf.animate }));
  await s.page.mouse.up();
  assert.ok(b.c - a.c > 5, 'hubo fotogramas durante el arrastre');
  assert.ok(b.d - a.d >= (b.c - a.c) * .9, `se dibuja en cada fotograma del arrastre (${b.d - a.d} dibujos / ${b.c - a.c} fotogramas)`);
  // La inercia de la órbita se amortigua por fotograma (≈200 fotogramas: ~3 s con GPU real, más en SwiftShader):
  // mientras dura, la cámara se mueve de verdad y debe dibujarse. Se espera a que se detenga y entonces debe cesar.
  const quieta = await s.page.evaluate(async () => {
    const p = cam.position.clone(), q = cam.quaternion.clone(); let seguidos = 0, fotogramas = 0;
    while (seguidos < 10 && fotogramas < 3000) { await new Promise(ok => requestAnimationFrame(ok)); fotogramas++;
      const movida = p.distanceToSquared(cam.position) > 1e-12 || 1 - Math.abs(q.dot(cam.quaternion)) > 1e-14; seguidos = movida ? 0 : seguidos + 1; p.copy(cam.position); q.copy(cam.quaternion); }
    return seguidos >= 10;
  });
  assert.ok(quieta, 'la inercia de la órbita termina');
  const r = await reposo(s.page, 2000);
  assert.equal(r.dibujos, 0, 'con la cámara detenida vuelve al reposo');
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('navegación con teclado (WASD): dibuja mientras se mueve y se detiene al soltar', async () => {
  const s = await editor();
  await s.page.evaluate(() => __modo('m')); await s.page.waitForTimeout(1500);
  await s.page.evaluate(() => r3.domElement.focus());
  // La ventana de medida queda dentro de la pulsación (antes de pulsar no hay nada que dibujar).
  await s.page.keyboard.down('w'); await s.page.waitForTimeout(150);
  const a = await s.page.evaluate(() => ({ d: __n(r3), c: __raf.animate, x: cam.position.x, z: cam.position.z }));
  await s.page.waitForTimeout(1500);
  const b = await s.page.evaluate(() => ({ d: __n(r3), c: __raf.animate, x: cam.position.x, z: cam.position.z }));
  await s.page.keyboard.up('w');
  assert.ok(Math.hypot(b.x - a.x, b.z - a.z) > 1, 'la cámara avanzó');
  assert.ok(b.d - a.d >= (b.c - a.c) * .8, `dibuja mientras se mueve (${b.d - a.d}/${b.c - a.c})`);
  const r = await reposo(s.page, 2000);
  assert.equal(r.dibujos, 0, 'al soltar la tecla vuelve al reposo');
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('sombras bajo demanda (Realista): mover la cámara no recalcula sombras; editar sí; la imagen no cambia al volver', async () => {
  const s = await editor([1, 1, 6]);
  await s.page.evaluate(() => __modo('q')); await s.page.waitForTimeout(1500);
  const r = await s.page.evaluate(async () => {
    let sombras = 0; const o = r3.shadowMap.render.bind(r3.shadowMap);
    r3.shadowMap.render = function () { if (this.enabled && (this.autoUpdate || this.needsUpdate)) sombras++; return o.apply(this, arguments); };
    const foto = async () => { await __fotogramas(3); const c = document.createElement('canvas'); c.width = r3.domElement.width; c.height = r3.domElement.height; const x = c.getContext('2d'); x.drawImage(r3.domElement, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
    const p0 = cam.position.clone(), a = await foto();
    sombras = 0; cam.position.x += 40; await __fotogramas(3); cam.position.copy(p0); const b = await foto();
    const porCamara = sombras;
    sombras = 0; S.i[0].x += 2; commit(); await __fotogramas(3);
    let distintos = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) distintos++;
    return { porCamara, porEdicion: sombras, distintos, sombrasActivas: r3.shadowMap.enabled && sun.castShadow };
  });
  assert.ok(r.sombrasActivas, 'el Realista usa sombras');
  assert.equal(r.porCamara, 0, 'mover la cámara no recalcula los mapas de sombras');
  assert.ok(r.porEdicion >= 1, 'una edición sí los recalcula');
  assert.equal(r.distintos, 0, 'tras mover y devolver la cámara la imagen es idéntica (sin sombras obsoletas)');
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('vista previa de muebles: no dibuja en reposo, dibuja al girarla y al cambiar el mueble', async () => {
  const s = await editor([1, 1, 2]);
  await s.page.evaluate(async () => { openPrevObj(LIB.find(x => x.t === 'sofa') || LIB[0]); await __esperar(1500); });
  const quieto = await reposo(s.page, 2000, 'r4');
  assert.equal(quieto.dibujos, 0, 'vista previa quieta: sin dibujos');
  const r = await s.page.evaluate(async () => ({
    giro: await __hastaDibujo(() => { cam4.position.x += 20; }, r4),
    cambio: await __hastaDibujo(() => { pvIt.col = '#336699'; buildPrev(pvIt, 1); }, r4),
  }));
  assert.ok(r.giro <= 2 && r.cambio <= 2, JSON.stringify(r));
  assert.equal(await s.page.evaluate(() => __pendientes.pvLoop || 0), 1, 'un solo bucle de vista previa');
  await s.page.evaluate(() => closePreview()); await s.page.waitForTimeout(300);
  assert.equal(await s.page.evaluate(() => __pendientes.pvLoop || 0), 0, 'al cerrar, el bucle termina');
  assert.deepEqual(s.errores.filter(e => !e.startsWith('dialog:')), []);
  await s.ctx.close();
});

test('Ver en Realidad: la vista en vivo no dibuja en reposo, sí al cambiar un ajuste; el editor de debajo no dibuja', async () => {
  const s = await editor([1, 1, 4]);
  await s.page.evaluate(() => __modo('m'));
  await s.page.evaluate(async () => { realMode(); await __esperar(2000); });
  const r = await s.page.evaluate(async () => {
    const rr = [...__renders.keys()].find(x => x !== r3 && x !== r4 && x.domElement.closest('.nuhio-render-stage'));
    await __esperar(1500);
    const a = __n(rr), a3 = __n(r3); await __esperar(2000);
    const reposoRR = __n(rr) - a, reposoR3 = __n(r3) - a3;
    const ajuste = document.querySelector('.nuhio-render-settings input[type=range]');
    const cambio = await __hastaDibujo(() => { ajuste.value = String(+ajuste.min + (+ajuste.max - +ajuste.min) * .37); ajuste.dispatchEvent(new Event('input', { bubbles: true })); }, rr);
    const antesDeSalir = __n(r3);
    document.querySelector('.nuhio-render-exit').click(); await __fotogramas(3);
    return { hayRenderer: !!rr, reposoRR, reposoR3, cambio, cerrado: !RVo, redibujaAlSalir: __n(r3) > antesDeSalir };
  });
  assert.ok(r.hayRenderer, 'existe el renderer de Ver en Realidad');
  assert.equal(r.reposoRR, 0, 'vista en vivo quieta: sin dibujos');
  assert.equal(r.reposoR3, 0, 'el editor de debajo no dibuja mientras Ver en Realidad está abierto y quieto');
  assert.ok(r.cambio <= 2, 'un ajuste vuelve a dibujar al instante: ' + r.cambio);
  assert.ok(r.cerrado);
  assert.ok(r.redibujaAlSalir, 'al volver, el editor dibuja la escena reconstruida sin esperar a una interacción');
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});
