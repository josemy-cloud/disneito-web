// R1.4 · Reconstrucciones 3D innecesarias: seleccionar, deseleccionar y cambiar de vista no reconstruyen la escena si
// está al día; solo se actualizan los recuadros de selección (sin duplicados ni fugas y sin liberar recursos que
// siguen en uso). Las ediciones, los cambios del proyecto, las piezas seleccionadas y los modelos nuevos sí
// reconstruyen. En el arranque no se repite la reconstrucción de setQ().
// Ejecutar: node --test tests/reconstrucciones-3d.test.mjs   (Chrome en CHROME_BIN)
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, abrirReal, entrarAlEditor } from './harness/real-harness.mjs';
import { prepararProyecto, glbPrueba } from './harness/glb-prueba.mjs';

let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }); });
test.after(async () => { await browser?.close(); });

async function editor(tamano = [2, 1, 6]) {
  const s = await abrirReal(browser);
  await entrarAlEditor(s.page);
  await prepararProyecto(s.page, tamano);
  await s.page.evaluate(async () => {
    window.__esperar = ms => new Promise(ok => setTimeout(ok, ms));
    window.__builds = 0;
    const original = build3d; window.build3d = function () { __builds++; return original.apply(this, arguments); };
    window.__dibujos = 0;
    const render = r3.render; r3.render = function () { __dibujos++; return render.apply(this, arguments); };
    window.__recuadros = () => root.children.filter(n => n.userData.selectionOverlay).map(n => n.object?.userData.id);
    window.__items = () => S.i.filter(i => !i.hid).map(i => i.id);
    // Mide builds de una acción (y deja que se asienten dibujos y temporizadores).
    window.__builds_de = async f => { const b0 = __builds; await f(); await __esperar(150); return __builds - b0; };
    build3d(); await __esperar(200);
  });
  return s;
}
const sinErrores = s => s.errores.filter(e => !e.startsWith('dialog:'));

test('seleccionar y deseleccionar en 2D, 3D y dual no reconstruye y muestra los recuadros correctos', { timeout: 180000 }, async () => {
  const s = await editor();
  const r = await s.page.evaluate(async () => {
    const res = {};
    for (const vista of ['2d', '3d', 'dual']) {
      setMode(vista); await __esperar(300);
      const [a, b, c] = __items();
      const v = {};
      v.seleccionar = await __builds_de(() => { sel = { k: 'i', id: a }; selPart = null; refreshSelection(); });
      v.recuadrosTrasSeleccionar = __recuadros();
      v.cambiar = await __builds_de(() => { sel = { k: 'i', id: b }; refreshSelection(); });
      v.recuadrosTrasCambiar = __recuadros();
      v.multiple = await __builds_de(() => { selectPlanItems(new Set([a, b, c])); refreshSelection(); });
      v.recuadrosMultiple = __recuadros().sort();
      v.deseleccionar = await __builds_de(() => { sel = null; refreshSelection(); });
      v.recuadrosTrasDeseleccionar = __recuadros();
      v.esperado = { a, b, abc: [a, b, c].sort() };
      res[vista] = v;
    }
    return res;
  });
  for (const [vista, v] of Object.entries(r)) {
    assert.equal(v.seleccionar + v.cambiar + v.multiple + v.deseleccionar, 0, vista + ': ninguna reconstrucción');
    assert.deepEqual(v.recuadrosTrasSeleccionar, [v.esperado.a], vista + ': un recuadro del seleccionado');
    assert.deepEqual(v.recuadrosTrasCambiar, [v.esperado.b], vista + ': el recuadro anterior se retira');
    assert.deepEqual(v.recuadrosMultiple, v.esperado.abc, vista + ': selección múltiple');
    assert.deepEqual(v.recuadrosTrasDeseleccionar, [], vista + ': sin recuadros al deseleccionar');
  }
  assert.deepEqual(sinErrores(s), []);
  await s.ctx.close();
});

test('selecciones repetidas: sin acumulación de recursos ni recuadros, sin liberar materiales en uso y con dibujo bajo demanda', { timeout: 180000 }, async () => {
  const s = await editor();
  const r = await s.page.evaluate(async () => {
    setMode('3d'); await __esperar(300);
    const [a, b] = __items();
    // Materiales y geometrías que siguen en la escena: no deben recibir dispose.
    const liberados = new Set();
    root.traverse(o => { if (!o.isMesh || o.userData.selectionOverlay) return; for (const m of [].concat(o.material)) m?.addEventListener('dispose', () => liberados.add(m)); o.geometry?.addEventListener('dispose', () => liberados.add(o.geometry)); });
    sel = { k: 'i', id: a }; refreshSelection(); await __esperar(200);
    const g0 = r3.info.memory.geometries, b0 = __builds;
    for (let i = 0; i < 50; i++) { sel = i % 2 ? null : { k: 'i', id: i % 4 ? a : b }; refreshSelection(); }
    sel = { k: 'i', id: a }; refreshSelection();
    await __esperar(300); r3.render(sc, cam);
    const res = { builds: __builds - b0, recuadros: __recuadros(), geometriasAntes: g0, geometriasDespues: r3.info.memory.geometries, liberadosEnUso: liberados.size };
    // R1.2/R1.3: tras un reposo, cambiar la selección dibuja sin interacción.
    await __esperar(1500); const d0 = __dibujos; sel = { k: 'i', id: b }; refreshSelection();
    const t0 = performance.now(); while (__dibujos === d0 && performance.now() - t0 < 2000) await __esperar(10);
    res.msHastaDibujo = Math.round(performance.now() - t0);
    return res;
  });
  assert.equal(r.builds, 0, '50 cambios de selección sin reconstruir');
  assert.equal(r.recuadros.length, 1, 'un único recuadro al final (sin duplicados)');
  assert.equal(r.geometriasDespues, r.geometriasAntes, 'las geometrías de la GPU no crecen');
  assert.equal(r.liberadosEnUso, 0, 'no se liberan materiales ni geometrías que siguen en uso');
  assert.ok(r.msHastaDibujo < 500, 'la nueva selección se dibuja al momento: ' + r.msHastaDibujo + ' ms');
  assert.deepEqual(sinErrores(s), []);
  await s.ctx.close();
});

test('sí reconstruye: ediciones, cambios del proyecto antes de seleccionar, piezas, calidad y modelos nuevos', { timeout: 180000 }, async () => {
  const s = await editor();
  const glb = glbPrueba().toString('base64');
  const r = await s.page.evaluate(async glb => {
    setMode('3d'); await __esperar(300);
    const [a] = __items(), res = {};
    res.edicion = await __builds_de(() => { S.i[0].x += 5; commit(); });
    res.cambioSinCommit = await __builds_de(() => { S.i[0].x += 5; sel = { k: 'i', id: a }; refreshSelection(); });
    res.pieza = await __builds_de(() => { sel = { k: 'i', id: a }; selPart = { id: a, t: 'puerta', i: 0 }; refreshSelection(); });
    res.quitarPieza = await __builds_de(() => { selPart = null; refreshSelection(); });
    res.recuadrosTrasQuitarPieza = __recuadros().length;
    res.calidad = await __builds_de(() => { $('#sq').value = 'q'; setQ(); });
    res.seleccionTrasCalidad = await __builds_de(() => { sel = null; refreshSelection(); });
    const bin = atob(glb), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const antes = scene3dState();
    await addModel({ id: 'glb-prueba-r14', name: 'Aparador GLB 2', ext: 'glb', data: bytes.buffer, units: 1 });
    res.claveCambiaConModelo = scene3dState() !== antes;
    res.seleccionTrasModelo = await __builds_de(() => { sel = { k: 'i', id: a }; refreshSelection(); });
    return res;
  }, glb);
  assert.equal(r.edicion, 1, 'una edición reconstruye');
  assert.equal(r.cambioSinCommit, 1, 'si el proyecto cambió, la selección reconstruye');
  assert.equal(r.pieza, 1, 'seleccionar una pieza reconstruye (su resaltado está en la geometría)');
  assert.equal(r.quitarPieza, 0, 'quitar la pieza solo actualiza los recuadros');
  assert.equal(r.recuadrosTrasQuitarPieza, 1, 'queda solo el recuadro del objeto');
  assert.equal(r.calidad, 1, 'el cambio de calidad reconstruye');
  assert.equal(r.seleccionTrasCalidad, 0);
  assert.ok(r.claveCambiaConModelo, 'un modelo nuevo cambia la clave');
  assert.equal(r.seleccionTrasModelo, 1, 'tras un modelo nuevo la siguiente selección reconstruye');
  assert.deepEqual(sinErrores(s), []);
  await s.ctx.close();
});

test('cambios de vista con la escena al día: sin reconstruir, pero con lienzos, cámara y dibujo actualizados', { timeout: 180000 }, async () => {
  const s = await editor();
  const r = await s.page.evaluate(async () => {
    const res = {};
    const estado = () => ({ d3: d3.style.display, c2: c2.style.display, dual: editorView.classList.contains('view-dual'), planoGpu: !planGpuStage.hidden, aspecto: +cam.aspect.toFixed(3), lienzo: [d3.clientWidth, d3.clientHeight].join('x') });
    setMode('2d'); await __esperar(300);
    res.a3D = await __builds_de(async () => { setMode('3d'); await __esperar(300); });
    res.estado3D = estado(); res.aspectoEsperado3D = +(d3.clientWidth / d3.clientHeight).toFixed(3);
    const d0 = __dibujos; await __esperar(300); res.dibujaEn3D = __dibujos > d0 || res.a3D === 0;
    res.aDual = await __builds_de(async () => { setMode('dual'); await __esperar(300); });
    res.estadoDual = estado();
    res.a2D = await __builds_de(async () => { setMode('2d'); await __esperar(300); });
    res.estado2D = estado();
    // Cambio del proyecto sin reconstruir (como un arrastre en el plano): el cambio de vista sí reconstruye.
    S.i[0].x += 7;
    res.a3DTrasCambio = await __builds_de(async () => { setMode('3d'); await __esperar(300); });
    return res;
  });
  assert.equal(r.a3D, 0, '2D → 3D sin reconstruir');
  assert.equal(r.estado3D.d3, 'block'); assert.equal(r.estado3D.c2, 'none');
  assert.equal(r.estado3D.aspecto, r.aspectoEsperado3D, 'la cámara se ajusta al tamaño del lienzo 3D');
  assert.equal(r.aDual, 0, '3D → dual sin reconstruir');
  assert.ok(r.estadoDual.dual && r.estadoDual.d3 === 'block' && r.estadoDual.c2 === 'block', 'dual muestra plano y 3D');
  assert.equal(r.estado2D.d3, 'none'); assert.equal(r.estado2D.c2, 'block');
  assert.equal(r.a3DTrasCambio, 1, 'con el proyecto cambiado, el cambio de vista reconstruye');
  assert.deepEqual(sinErrores(s), []);
  await s.ctx.close();
});

test('arranque: setQ() reconstruye y el refresh siguiente no repite la reconstrucción', { timeout: 180000 }, async () => {
  const s = await abrirReal(browser);
  await s.ctx.addInitScript(() => {
    window.__arranque = []; let real;
    Object.defineProperty(window, 'THREE', { configurable: true, get: () => real, set: v => { real = v; queueMicrotask(() => {
      if (!v.Object3D || v.Object3D.prototype.__r14) return; v.Object3D.prototype.__r14 = true; const clear = v.Object3D.prototype.clear;
      v.Object3D.prototype.clear = function () { if (this.parent?.isScene) { const pila = new Error().stack; window.__arranque.push({ origen: pila.includes('at setQ') ? 'setQ' : pila.includes('at refresh') ? 'refresh' : 'otro', t: performance.now() }); } return clear.apply(this, arguments); };
    }); } });
  });
  await entrarAlEditor(s.page);
  await prepararProyecto(s.page, [2, 1, 6]);
  // Borrador del proyecto para que el arranque cargue una escena real de forma síncrona.
  await s.page.evaluate(() => { localStorage.setItem(draftKey, JSON.stringify(S)); localStorage.removeItem(activeProjectKey); });
  await s.page.reload(); await s.page.waitForTimeout(5000);
  const r = await s.page.evaluate(() => ({ reconstrucciones: [...__arranque], objetos: S.i.length }));
  assert.ok(r.objetos > 0, 'el borrador se cargó');
  const [primera, ...resto] = r.reconstrucciones, lista = r.reconstrucciones.map(x => x.origen + '@' + Math.round(x.t)).join(', ');
  assert.equal(primera.origen, 'setQ', 'la primera reconstrucción es la de setQ(): ' + lista);
  // Las posteriores (modelos de IndexedDB) llegan de forma asíncrona; ninguna en el mismo instante que setQ().
  assert.ok(resto.every(x => x.t - primera.t > 20), 'el refresh inmediato no repite la reconstrucción: ' + lista);
  assert.deepEqual(sinErrores(s), []);
  await s.ctx.close();
});
