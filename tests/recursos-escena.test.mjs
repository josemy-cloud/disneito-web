// R1.1 · Liberación de recursos en las reconstrucciones de la escena 3D (build3d y addRealisticDetails).
// Antes: root.clear() y realisticDetails.clear() dejaban geometrías y materiales vivos en el renderer y en la GPU
// (medido: +~1.500 geometrías por ciclo de modo en un proyecto mediano). Ahora se liberan solo los recursos que ya
// no usa ningún objeto de las escenas y que no pertenecen a una caché compartida. Las texturas no se tocan.
// Ejecutar: node --test tests/recursos-escena.test.mjs   (Chrome en CHROME_BIN)
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, abrirReal, entrarAlEditor } from './harness/real-harness.mjs';
import { prepararProyecto } from './harness/glb-prueba.mjs';

let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }); });
test.after(async () => { await browser?.close(); });

async function editor(tamano = [2, 1, 8]) {
  const s = await abrirReal(browser);
  await entrarAlEditor(s.page);
  await prepararProyecto(s.page, tamano);
  // Espías de dispose (cuántas veces se libera cada recurso) y utilidades de inspección en la página.
  await s.page.evaluate(() => {
    window.__liberados = new Map();
    // El espía guarda referencias fuertes: las pruebas de memoria lo desactivan (window.__liberados = null).
    const espiar = (proto) => { const original = proto.dispose; proto.dispose = function () { window.__liberados?.set(this, (__liberados.get(this) || 0) + 1); return original.apply(this, arguments); }; };
    espiar(T.BufferGeometry.prototype); espiar(T.Material.prototype);
    window.__vivos = () => { const g = new Set(), m = new Set(); for (const escena of [sc, sc4]) escena.traverse(o => { if (o.geometry) g.add(o.geometry); for (const x of [].concat(o.material || [])) if (x) m.add(x); }); return { g, m }; };
    window.__compartidos = () => { const r = new Set([GLS, trayM, contactGeometry, contactMaterial, ...BOX_GEO_CACHE.values()]); for (const { obj } of Object.values(MODS)) obj.traverse(o => { if (o.geometry) r.add(o.geometry); for (const x of [].concat(o.material || [])) if (x) r.add(x); }); r.delete(undefined); return r; };
    window.__fotograma = () => new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));
  });
  return s;
}
const recursos = page => page.evaluate(() => ({ geometrias: r3.info.memory.geometries, texturas: r3.info.memory.textures, programas: r3.info.programs.length }));
const modo = (page, m) => page.evaluate(async m => { if (m === '2d') setMode('2d'); else { if (mode !== '3d') setMode('3d'); $('#sq').value = m; setQ(); } await __fotograma(); }, m);

test('reconstrucción: libera lo que deja de usarse, una sola vez, y nunca lo que sigue en uso o es compartido', async () => {
  const s = await editor();
  await modo(s.page, 'q');
  const r = await s.page.evaluate(async () => {
    const antes = __vivos();
    __liberados.clear();
    commit(); await __fotograma();
    const despues = __vivos(), compartidos = __compartidos();
    const liberadosEnUso = [...__liberados.keys()].filter(x => despues.g.has(x) || despues.m.has(x)).length;
    const compartidosLiberados = [...__liberados.keys()].filter(x => compartidos.has(x)).length;
    const dobles = [...__liberados.values()].filter(n => n > 1).length;
    const retirados = [...antes.g, ...antes.m].filter(x => !despues.g.has(x) && !despues.m.has(x) && !compartidos.has(x));
    const retiradosSinLiberar = retirados.filter(x => !__liberados.has(x)).length;
    const reutilizados = [...antes.g].filter(x => despues.g.has(x)).length;
    return { liberados: __liberados.size, liberadosEnUso, compartidosLiberados, dobles, retirados: retirados.length, retiradosSinLiberar, reutilizados };
  });
  assert.ok(r.liberados > 100, 'se liberan los recursos de la escena anterior: ' + r.liberados);
  assert.equal(r.liberadosEnUso, 0, 'nada que siga en uso (evita volver a subirlo a la GPU)');
  assert.equal(r.compartidosLiberados, 0, 'nada compartido: modelos importados, caché de cajas, vidrio, bandejas, contacto');
  assert.equal(r.dobles, 0, 'cada recurso se libera una sola vez');
  assert.equal(r.retiradosSinLiberar, 0, `todo lo retirado se libera (${r.retirados})`);
  assert.ok(r.reutilizados > 0, 'los recursos reutilizados (caché) siguen vivos');
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('sin crecimiento: 30 ediciones y 20 ciclos 2D → materiales → Realista mantienen estables geometrías y heap', async () => {
  const s = await editor();
  const cdp = await s.ctx.newCDPSession(s.page);
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize / 1048576; };
  await s.page.evaluate(() => { window.__liberados = null; });
  await modo(s.page, 'm'); await modo(s.page, 'q'); await modo(s.page, '2d');
  const g0 = await recursos(s.page), h0 = await heap();
  for (let c = 0; c < 20; c++) for (const m of ['m', 'q', '2d']) await modo(s.page, m);
  await modo(s.page, 'm');
  for (let i = 0; i < 30; i++) await s.page.evaluate(async i => { S.i[i % S.i.length].x += i % 2 ? -1 : 1; commit(); await __fotograma(); }, i);
  await modo(s.page, 'q'); await modo(s.page, '2d');
  const g1 = await recursos(s.page), h1 = await heap();
  assert.ok(g1.geometrias <= g0.geometrias + 10, `geometrías ${g0.geometrias} → ${g1.geometrias}`);
  assert.equal(g1.texturas, g0.texturas, 'texturas estables (no se tocan)');
  assert.equal(g1.programas, g0.programas, 'programas estables');
  assert.ok(h1 - h0 < 3, `heap tras GC ${h0.toFixed(1)} → ${h1.toFixed(1)} MB`);
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('sin recompilar shaders: liberar materiales no destruye programas que la escena nueva vuelve a necesitar', async () => {
  const s = await editor([3, 2, 6]);
  for (const q of ['m', 'q']) {
    await modo(s.page, q);
    const r = await s.page.evaluate(async () => {
      for (let i = 0; i < 2; i++) { commit(); await __fotograma(); }        // calentamiento
      // Las ediciones en 2D no cuentan: el plano 2D se dibuja con r3 y ya compilaba sus propios shaders antes de R1.1
      // (6 en materiales y 11 en Realista, igual con el código anterior). Se mide lo que R1.1 puede romper.
      const gl = r3.getContext(), original = gl.linkProgram; let enlaces3D = 0, enlacesVuelta = 0, fase = '3d';
      gl.linkProgram = function () { if (fase === '3d') enlaces3D++; else if (fase === 'vuelta') enlacesVuelta++; return original.apply(this, arguments); };
      for (let i = 0; i < 10; i++) { commit(); await __fotograma(); }
      const programas = r3.info.programs.length;
      fase = '2d'; setMode('2d'); for (let i = 0; i < 3; i++) { commit(); await __fotograma(); }
      fase = 'vuelta'; setMode('3d'); await __fotograma();
      gl.linkProgram = original;
      return { enlaces3D, enlacesVuelta, programas, programasDespues: r3.info.programs.length };
    });
    assert.equal(r.enlaces3D, 0, `${q}: shaders enlazados en 10 reconstrucciones en 3D`);
    assert.equal(r.enlacesVuelta, 0, `${q}: shaders enlazados al volver de 2D a 3D`);
    assert.ok(r.programasDespues >= r.programas, `${q}: ningún programa de la escena 3D se destruye (${r.programas} → ${r.programasDespues})`);
  }
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('modelo GLB importado: sus clones comparten geometría y material, que sobreviven a todas las reconstrucciones', async () => {
  const s = await editor([2, 1, 4]);
  await modo(s.page, 'm');
  const r = await s.page.evaluate(async () => {
    const fuente = new Set(); MODS['glb-prueba'].obj.traverse(o => { if (o.geometry) fuente.add(o.geometry); for (const x of [].concat(o.material || [])) if (x) fuente.add(x); });
    for (let i = 0; i < 10; i++) { commit(); await __fotograma(); }
    const enEscena = []; root.traverse(o => { if (o.isMesh && fuente.has(o.geometry)) enEscena.push(o); });
    return { recursosModelo: fuente.size, instanciasCompartiendo: enEscena.length, liberados: [...fuente].filter(x => __liberados.has(x)).length, intactos: [...fuente].filter(x => !x.isBufferGeometry || x.attributes.position.array.length > 0).length };
  });
  assert.ok(r.recursosModelo >= 4, 'dos geometrías y dos materiales');
  assert.equal(r.instanciasCompartiendo, 4, 'las dos instancias (dos mallas cada una) usan la geometría del modelo importado');
  assert.equal(r.liberados, 0, 'nunca se libera lo del modelo importado');
  assert.equal(r.intactos, r.recursosModelo);
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('BOX_GEO_CACHE: al vaciarse (más de 280 cajas) libera las desalojadas, nunca las que siguen en uso', async () => {
  const s = await editor([1, 1, 2]);
  await modo(s.page, 'm');
  const r = await s.page.evaluate(async () => {
    // Muebles de cocina con medidas distintas: más de 280 cajas biseladas distintas llenan y vacían la caché.
    const base = LIB.find(x => x.t === 'base'), g0 = r3.info.memory.geometries, cache0 = [...BOX_GEO_CACHE.values()];
    for (let i = 0; i < 150; i++) S.i.push(Object.assign(JSON.parse(JSON.stringify(base)), { id: nid(), w: 40 + i * .5, x: 40 + (i % 10) * 35, y: 40 + Math.floor(i / 10) * 20, r: 0, op: [] }));
    __liberados.clear(); commit(); await __fotograma();
    const vivos = __vivos(), enUso = [...__liberados.keys()].filter(x => vivos.g.has(x) || vivos.m.has(x)).length;
    const enCache = new Set(BOX_GEO_CACHE.values()), desalojadas = cache0.filter(g => !enCache.has(g));
    S.i.splice(-150); commit(); await __fotograma(); commit(); await __fotograma();
    const vivos2 = __vivos(), cacheFinal = new Set(BOX_GEO_CACHE.values());
    const desalojadasSinLiberar = desalojadas.filter(g => !vivos2.g.has(g) && !cacheFinal.has(g) && !__liberados.has(g)).length;
    return { enUso, desalojadas: desalojadas.length, desalojadasSinLiberar, cache: BOX_GEO_CACHE.size, geometriasAntes: g0, geometriasDespues: r3.info.memory.geometries };
  });
  assert.equal(r.enUso, 0, 'no se libera ninguna caja en uso');
  assert.ok(r.desalojadas > 0, 'la caché llegó a vaciarse');
  assert.equal(r.desalojadasSinLiberar, 0, 'las cajas desalojadas que ya nadie usa se liberan');
  assert.ok(r.cache <= 281, 'la caché sigue acotada: ' + r.cache);
  assert.ok(r.geometriasDespues - r.geometriasAntes <= r.cache, `lo vivo de más cabe en la caché acotada: ${r.geometriasAntes} → ${r.geometriasDespues} (caché ${r.cache})`);
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('imagen idéntica: reconstruir tres veces no cambia ni un píxel en vista rápida, materiales y Realista', async () => {
  const s = await editor([1, 1, 6]);
  for (const q of ['f', 'm', 'q']) {
    await modo(s.page, q);
    const r = await s.page.evaluate(async () => {
      const foto = () => { cam.position.set(560, 520, 760); oc.target.set(200, 60, 175); cam.lookAt(oc.target); cam.updateMatrixWorld(); sun.shadow.needsUpdate = true; r3.render(sc, cam); r3.render(sc, cam); const c = document.createElement('canvas'); c.width = r3.domElement.width; c.height = r3.domElement.height; const x = c.getContext('2d'); x.drawImage(r3.domElement, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
      // Estado estable: una reconstrucción previa y tiempo para las texturas que se cargan de forma asíncrona.
      commit(); await __fotograma(); await new Promise(ok => setTimeout(ok, 800)); foto();
      const a = foto();
      for (let i = 0; i < 3; i++) { commit(); await __fotograma(); }
      await new Promise(ok => setTimeout(ok, 800));
      const b = foto();
      let distintos = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) distintos++;
      let noFondo = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== a[0] || a[i + 1] !== a[1] || a[i + 2] !== a[2]) noFondo++;
      return { distintos, noFondo, pixeles: a.length / 4 };
    });
    assert.ok(r.noFondo > r.pixeles * .2, `${q}: la imagen contiene la escena`);
    assert.equal(r.distintos, 0, `${q}: píxeles distintos tras reconstruir`);
  }
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('selección, movimiento, cambio de color y transiciones entre todos los modos siguen funcionando', async () => {
  const s = await editor([2, 1, 6]);
  await modo(s.page, 'm');
  const r = await s.page.evaluate(async () => {
    const it = S.i.find(x => x.t !== 'model');
    sel = { k: 'i', id: it.id }; commit(); await __fotograma();
    const seleccion = root.children.some(o => o.isBoxHelper || (o.type === 'BoxHelper'));
    it.x += 37; commit(); await __fotograma();
    const grupo = root.children.find(o => o.userData.id === it.id);
    const movido = grupo && Math.abs(grupo.position.x - it.x) < .001;
    it.col = '#123456'; commit(); await __fotograma();
    let color = false; root.children.find(o => o.userData.id === it.id)?.traverse(o => { for (const m of [].concat(o.material || [])) if (m?.color?.getHexString() === '123456') color = true; });
    const transiciones = [];
    for (const paso of [() => setMode('2d'), () => setMode('3d'), () => setMode('dual'), () => setMode('2d'), () => setMode('3d'), () => { $('#sq').value = 'f'; setQ(); }, () => { $('#sq').value = 'q'; setQ(); }, () => { $('#sq').value = 'm'; setQ(); }]) { paso(); await __fotograma(); transiciones.push(root.children.length > 0); }
    realMode(); await new Promise(ok => setTimeout(ok, 600));
    const realistaAbierto = RVo;
    document.querySelector('.nuhio-render-exit')?.click(); await __fotograma();
    sel = null; commit(); await __fotograma();
    return { seleccion, movido, color, transiciones, realistaAbierto, realistaCerrado: !RVo, objetos: root.children.length };
  });
  assert.ok(r.seleccion, 'el recuadro de selección aparece');
  assert.ok(r.movido, 'el mueble se mueve');
  assert.ok(r.color, 'el color nuevo llega al material');
  assert.ok(r.transiciones.every(Boolean), 'la escena existe tras cada transición');
  assert.ok(r.realistaAbierto && r.realistaCerrado, 'Ver en Realidad se abre y se cierra');
  assert.ok(r.objetos > 10);
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});
